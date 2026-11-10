import { ObjectId } from 'mongodb';
import {
  businessDate,
  fineChargeAmountCents,
  formatIsoDateBR,
  maintenanceRequestCategoryLabels,
  maskPhone,
  type MaintenanceRequest,
  type MaintenanceRequestCreate,
  type PortalFine,
  type PortalInspection,
  type PortalInvoice,
  type PortalInvoices,
  type PortalMe,
  type PortalRental,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../common/errors.js';
import { generateToken, sha256 } from '../common/helpers.js';
import type { DriverDoc, MaintenanceRequestDoc, ReceivableDoc } from '../database/types.js';
import { audit } from './common.js';
import { buildPaymentSchedule, remainingCents } from './finance.js';
import { describeFiles, requireFile } from './files.js';
import { createNotification } from './notifications.js';
import { ensurePublicToken } from './whatsapp-inspection.js';
import { DRIVER_SESSION_TTL_MS, type DriverAuthContext } from '../plugins/driver-auth.js';

/* ------------------------------------------------------------------ *
 * Área do Motorista: tudo é filtrado por organização E motorista da
 * sessão. DTOs próprios e enxutos (sem CPF, sem dados de operador).
 * ------------------------------------------------------------------ */

export const ACCESS_LINK_TTL_MS = 7 * 24 * 3600 * 1000;

/* ------------------------------ acesso ----------------------------- */

export async function createAccessLink(
  ctx: AppContext,
  params: { organizationId: ObjectId; driverId: ObjectId; actorId: ObjectId | null },
): Promise<{ driver: DriverDoc; link: string; expiresAt: Date }> {
  const driver = await ctx.mongo.collections.drivers.findOne({ _id: params.driverId, organizationId: params.organizationId });
  if (!driver || driver.archivedAt || driver.anonymizedAt) throw notFound('Motorista não encontrado.');
  if (driver.status !== 'ACTIVE') throw conflict('Motorista inativo não pode acessar a Área do Motorista.');

  const token = generateToken(24);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ACCESS_LINK_TTL_MS);
  // Um link válido por vez: os anteriores ainda não usados deixam de valer.
  await ctx.mongo.collections.driverAccessTokens.updateMany(
    { organizationId: params.organizationId, driverId: driver._id, usedAt: null },
    { $set: { expiresAt: now, updatedAt: now } },
  );
  await ctx.mongo.collections.driverAccessTokens.insertOne({
    _id: new ObjectId(),
    organizationId: params.organizationId,
    driverId: driver._id,
    tokenHash: sha256(token),
    expiresAt,
    usedAt: null,
    createdBy: params.actorId,
    createdAt: now,
    updatedAt: now,
  });
  await audit(ctx, {
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: 'driverPortal.linkCreated',
    entityType: 'driver',
    entityId: driver._id,
  });
  return { driver, link: `${ctx.env.APP_URL.replace(/\/$/, '')}/motorista/entrar/${token}`, expiresAt };
}

export function accessLinkMessage(driverName: string, companyName: string, link: string): string {
  const first = driverName.split(' ')[0] ?? driverName;
  return [
    `Olá, ${first}! Este é o seu acesso à Área do Motorista da ${companyName || 'locadora'}.`,
    'Por lá você acompanha sua locação, faturas, multas e vistorias, e pode pedir manutenção.',
    `Acesse: ${link}`,
    'O link é pessoal, vale por 7 dias e só pode ser usado uma vez.',
  ].join('\n');
}

/** Troca o link de uso único por uma sessão. */
export async function loginWithToken(
  ctx: AppContext,
  token: string,
  meta: { userAgent: string | null; ip: string | null },
): Promise<{ sessionToken: string; expiresAt: Date }> {
  const now = new Date();
  const claimed = await ctx.mongo.collections.driverAccessTokens.findOneAndUpdate(
    { tokenHash: sha256(token), usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  );
  if (!claimed) throw notFound('Link inválido, expirado ou já utilizado. Peça um novo link à locadora.');
  const driver = await ctx.mongo.collections.drivers.findOne({ _id: claimed.driverId, organizationId: claimed.organizationId });
  if (!driver || driver.status !== 'ACTIVE' || driver.archivedAt || driver.anonymizedAt) {
    throw notFound('Link inválido, expirado ou já utilizado. Peça um novo link à locadora.');
  }
  const sessionToken = generateToken(32);
  const expiresAt = new Date(now.getTime() + DRIVER_SESSION_TTL_MS);
  await ctx.mongo.collections.driverSessions.insertOne({
    _id: new ObjectId(),
    organizationId: claimed.organizationId,
    driverId: claimed.driverId,
    tokenHash: sha256(sessionToken),
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    revokedAt: null,
    userAgent: meta.userAgent?.slice(0, 300) ?? null,
    ip: meta.ip,
  });
  await audit(ctx, {
    organizationId: claimed.organizationId,
    actorId: null,
    action: 'driverPortal.login',
    entityType: 'driver',
    entityId: claimed.driverId,
  });
  return { sessionToken, expiresAt };
}

export async function revokeDriverAccess(
  ctx: AppContext,
  params: { organizationId: ObjectId; driverId: ObjectId; actorId: ObjectId | null },
): Promise<number> {
  const now = new Date();
  const res = await ctx.mongo.collections.driverSessions.updateMany(
    { organizationId: params.organizationId, driverId: params.driverId, revokedAt: null },
    { $set: { revokedAt: now } },
  );
  await ctx.mongo.collections.driverAccessTokens.updateMany(
    { organizationId: params.organizationId, driverId: params.driverId, usedAt: null },
    { $set: { expiresAt: now, updatedAt: now } },
  );
  await audit(ctx, {
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: 'driverPortal.revoked',
    entityType: 'driver',
    entityId: params.driverId,
    after: { sessions: res.modifiedCount },
  });
  return res.modifiedCount;
}

export async function accessStatus(ctx: AppContext, organizationId: ObjectId, driverId: ObjectId) {
  const now = new Date();
  const [sessions, pending] = await Promise.all([
    ctx.mongo.collections.driverSessions
      .find({ organizationId, driverId, revokedAt: null, expiresAt: { $gt: now } })
      .sort({ lastSeenAt: -1 })
      .toArray(),
    ctx.mongo.collections.driverAccessTokens.findOne(
      { organizationId, driverId, usedAt: null, expiresAt: { $gt: now } },
      { sort: { createdAt: -1 } },
    ),
  ]);
  return {
    activeSessions: sessions.length,
    lastAccessAt: sessions[0]?.lastSeenAt.toISOString() ?? null,
    pendingLinkExpiresAt: pending?.expiresAt.toISOString() ?? null,
  };
}

/* ------------------------------- leitura --------------------------- */

async function loadDriver(ctx: AppContext, auth: DriverAuthContext): Promise<DriverDoc> {
  const driver = await ctx.mongo.collections.drivers.findOne({ _id: auth.driverId, organizationId: auth.organizationId });
  if (!driver) throw notFound('Motorista não encontrado.');
  return driver;
}

export async function portalMe(ctx: AppContext, auth: DriverAuthContext): Promise<PortalMe> {
  const [driver, org] = await Promise.all([
    loadDriver(ctx, auth),
    ctx.mongo.collections.organizations.findOne({ _id: auth.organizationId }),
  ]);
  const site = org?.settings.publicSite;
  return {
    driver: {
      id: driver._id.toHexString(),
      fullName: driver.fullName,
      phone: maskPhone(driver.phone),
      email: driver.emailLower,
      cnhExpiresAt: driver.cnh.expiresAt,
      hasIdDocument: Boolean(driver.idDocumentFileId),
      hasAddressProof: Boolean(driver.addressProofFileId),
    },
    organization: {
      name: org?.name ?? '',
      whatsappPhone: site?.whatsappPhone ?? null,
      emergencyPhone: site?.emergencyPhone ?? null,
    },
  };
}

export async function portalRentals(ctx: AppContext, auth: DriverAuthContext): Promise<PortalRental[]> {
  const rentals = await ctx.mongo.collections.rentals
    .find({ organizationId: auth.organizationId, driverId: auth.driverId, status: { $ne: 'CANCELED' } })
    .sort({ status: 1, startDate: -1 })
    .toArray();
  const vehicles = await ctx.mongo.collections.vehicles
    .find({ organizationId: auth.organizationId, _id: { $in: rentals.map((r) => r.vehicleId) } })
    .toArray();
  const vMap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));
  return rentals
    .sort((a, b) => (a.status === b.status ? (a.startDate < b.startDate ? 1 : -1) : a.status === 'ACTIVE' ? -1 : 1))
    .map((r) => {
      const v = vMap.get(r.vehicleId.toHexString());
      return {
        id: r._id.toHexString(),
        rentalNumber: r.rentalNumber,
        status: r.status,
        rentalType: r.rentalType,
        startDate: r.startDate,
        endDate: r.endDate,
        periodicAmountCents: r.periodicAmountCents,
        depositCents: r.depositCents,
        allowedKm: r.allowedKm,
        vehicle: {
          id: r.vehicleId.toHexString(),
          plate: v?.plate ?? '—',
          brand: v?.brand ?? '—',
          model: v?.model ?? '—',
          year: v?.year ?? null,
          color: v?.color ?? null,
        },
      };
    });
}

function receivableInvoiceStatus(r: Pick<ReceivableDoc, 'grossAmountCents' | 'paidAmountCents' | 'dueDate'>, today: string): PortalInvoice['status'] {
  const remaining = remainingCents(r.grossAmountCents, r.paidAmountCents);
  if (remaining === 0) return 'PAID';
  if (r.dueDate < today) return 'OVERDUE';
  return r.paidAmountCents > 0 ? 'PARTIAL' : 'OPEN';
}

export async function portalInvoices(ctx: AppContext, auth: DriverAuthContext, today = businessDate()): Promise<PortalInvoices> {
  const [rentals, receivables] = await Promise.all([
    ctx.mongo.collections.rentals
      .find({ organizationId: auth.organizationId, driverId: auth.driverId, status: { $ne: 'CANCELED' } })
      .toArray(),
    ctx.mongo.collections.receivables
      .find({ organizationId: auth.organizationId, driverId: auth.driverId, status: { $ne: 'CANCELED' } })
      .toArray(),
  ]);
  const rMap = new Map(rentals.map((r) => [r._id.toHexString(), r]));
  const invoices: PortalInvoice[] = [];

  for (const rec of receivables) {
    const rental = rec.rentalId ? rMap.get(rec.rentalId.toHexString()) : undefined;
    if (rec.kind === 'RENT' && rec.expectedPeriod === 'CONTRACT' && rental) {
      // Uma conta por contrato (A-FIN-02): as faturas semanais são o cronograma calculado.
      const { weeks } = buildPaymentSchedule(rental, rec, today);
      for (const w of weeks) {
        invoices.push({
          key: `${rec._id.toHexString()}:${w.number}`,
          kind: 'RENT',
          description: `${rental.rentalType === 'WEEKLY' ? 'Semana' : 'Mês'} ${w.number}`,
          rentalNumber: rental.rentalNumber,
          dueDate: w.dueDate,
          amountCents: w.amountCents,
          paidCents: w.paidCents,
          remainingCents: w.remainingCents,
          status: w.status,
        });
      }
      continue;
    }
    const kind: PortalInvoice['kind'] =
      rec.kind === 'FINE' ? 'FINE' : rec.kind === 'DAMAGE' ? 'DAMAGE' : rec.kind === 'DEPOSIT' ? 'DEPOSIT' : rec.kind === 'OTHER' ? 'EXTRA_KM' : 'RENT';
    invoices.push({
      key: rec._id.toHexString(),
      kind,
      description: kind === 'EXTRA_KM' ? 'KM excedente' : kind === 'DEPOSIT' ? 'Caução' : rec.description,
      rentalNumber: rental?.rentalNumber ?? null,
      dueDate: rec.dueDate,
      amountCents: rec.grossAmountCents,
      paidCents: rec.paidAmountCents,
      remainingCents: remainingCents(rec.grossAmountCents, rec.paidAmountCents),
      status: receivableInvoiceStatus(rec, today),
    });
  }

  invoices.sort((a, b) => (a.dueDate === b.dueDate ? a.key.localeCompare(b.key) : a.dueDate < b.dueDate ? 1 : -1));
  const open = invoices.filter((i) => i.status !== 'PAID');
  const next = [...open].sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0] ?? null;
  return {
    invoices,
    totals: {
      openCents: open.reduce((a, i) => a + i.remainingCents, 0),
      overdueCents: open.filter((i) => i.status === 'OVERDUE').reduce((a, i) => a + i.remainingCents, 0),
      paidCents: invoices.reduce((a, i) => a + i.paidCents, 0),
    },
    next,
  };
}

export async function portalFines(ctx: AppContext, auth: DriverAuthContext, today = businessDate()): Promise<PortalFine[]> {
  const fines = await ctx.mongo.collections.trafficFines
    .find({
      organizationId: auth.organizationId,
      'match.driverId': auth.driverId,
      status: { $nin: ['CANCELED', 'COMPANY_LIABLE', 'RECEIVED'] },
    })
    .sort({ occurredAt: -1 })
    .toArray();
  const recIds = fines.map((f) => f.receivableId).filter((v): v is ObjectId => Boolean(v));
  const [receivables, files] = await Promise.all([
    recIds.length ? ctx.mongo.collections.receivables.find({ organizationId: auth.organizationId, _id: { $in: recIds } }).toArray() : [],
    describeFiles(ctx, auth.organizationId, fines.map((f) => f.noticeFileId).filter((v): v is ObjectId => Boolean(v))),
  ]);
  const recMap = new Map(receivables.map((r) => [r._id.toHexString(), r]));
  return fines.map((f) => {
    const rec = f.receivableId ? recMap.get(f.receivableId.toHexString()) : undefined;
    return {
      id: f._id.toHexString(),
      fineNumber: f.fineNumber,
      aitNumber: f.aitNumber,
      authorityName: f.authority.name,
      infractionDescription: f.infractionDescription,
      occurredAt: f.occurredAt.toISOString(),
      place: f.place,
      plate: f.plateSnapshot,
      points: f.points,
      amountCents: f.amountCents,
      chargeAmountCents: fineChargeAmountCents(f, today),
      discountUntil: f.discountUntil,
      indicationDeadline: f.indicationDeadline,
      indicationStatus: f.indication.status,
      status: f.status,
      noticeUrl: f.noticeFileId ? (files.get(f.noticeFileId.toHexString())?.url ?? null) : null,
      charge:
        rec && rec.status !== 'CANCELED'
          ? {
              dueDate: rec.dueDate,
              amountCents: rec.grossAmountCents,
              remainingCents: remainingCents(rec.grossAmountCents, rec.paidAmountCents),
              status: receivableInvoiceStatus(rec, today),
            }
          : null,
    };
  });
}

export async function portalInspections(ctx: AppContext, auth: DriverAuthContext): Promise<PortalInspection[]> {
  const inspections = await ctx.mongo.collections.inspections
    .find({ organizationId: auth.organizationId, driverId: auth.driverId, status: 'PENDING' })
    .sort({ dueDate: 1 })
    .limit(10)
    .toArray();
  const vehicles = await ctx.mongo.collections.vehicles
    .find({ organizationId: auth.organizationId, _id: { $in: inspections.map((i) => i.vehicleId) } })
    .project<{ _id: ObjectId; plate: string }>({ plate: 1 })
    .toArray();
  const vMap = new Map(vehicles.map((v) => [v._id.toHexString(), v.plate]));
  const base = ctx.env.APP_URL.replace(/\/$/, '');
  const out: PortalInspection[] = [];
  for (const i of inspections) {
    const token = await ensurePublicToken(ctx, i);
    out.push({
      id: i._id.toHexString(),
      plate: vMap.get(i.vehicleId.toHexString()) ?? '—',
      dueDate: i.dueDate,
      status: i.status,
      link: `${base}/vistoria/${token}`,
    });
  }
  return out;
}

/* ------------------------- pedidos de manutenção -------------------- */

export async function toMaintenanceRequestDTOs(
  ctx: AppContext,
  organizationId: ObjectId,
  docs: MaintenanceRequestDoc[],
): Promise<MaintenanceRequest[]> {
  if (docs.length === 0) return [];
  const uniq = (ids: ObjectId[]) => [...new Set(ids.map((i) => i.toHexString()))].map((s) => new ObjectId(s));
  const [vehicles, drivers, rentals, files] = await Promise.all([
    ctx.mongo.collections.vehicles.find({ organizationId, _id: { $in: uniq(docs.map((d) => d.vehicleId)) } }).toArray(),
    ctx.mongo.collections.drivers.find({ organizationId, _id: { $in: uniq(docs.map((d) => d.driverId)) } }).toArray(),
    ctx.mongo.collections.rentals
      .find({ organizationId, _id: { $in: uniq(docs.map((d) => d.rentalId).filter((v): v is ObjectId => Boolean(v))) } })
      .toArray(),
    describeFiles(ctx, organizationId, docs.flatMap((d) => d.photoFileIds)),
  ]);
  const vMap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));
  const dMap = new Map(drivers.map((d) => [d._id.toHexString(), d]));
  const rMap = new Map(rentals.map((r) => [r._id.toHexString(), r]));
  return docs.map((d) => {
    const v = vMap.get(d.vehicleId.toHexString());
    const drv = dMap.get(d.driverId.toHexString());
    return {
      id: d._id.toHexString(),
      category: d.category,
      description: d.description,
      vehicleStopped: d.vehicleStopped,
      status: d.status,
      responseNote: d.responseNote,
      vehicle: { id: d.vehicleId.toHexString(), plate: v?.plate ?? '—', model: v ? `${v.brand} ${v.model}` : '—' },
      driver: { id: d.driverId.toHexString(), fullName: drv?.fullName ?? '—', phone: drv?.phone ?? '' },
      rentalNumber: d.rentalId ? (rMap.get(d.rentalId.toHexString())?.rentalNumber ?? null) : null,
      photos: d.photoFileIds
        .map((id) => files.get(id.toHexString()))
        .filter((f): f is NonNullable<typeof f> => Boolean(f))
        .map((f) => ({ fileId: f.id.toHexString(), url: f.url })),
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
    };
  });
}

export async function createMaintenanceRequest(
  ctx: AppContext,
  auth: DriverAuthContext,
  body: MaintenanceRequestCreate,
): Promise<MaintenanceRequestDoc> {
  const rental = await ctx.mongo.collections.rentals.findOne({
    _id: new ObjectId(body.rentalId),
    organizationId: auth.organizationId,
    driverId: auth.driverId,
    status: 'ACTIVE',
  });
  if (!rental) throw badRequest('Escolha uma locação ativa sua.');
  const photos: ObjectId[] = [];
  for (const id of body.photoFileIds) {
    const file = await requireFile(ctx, auth.organizationId, new ObjectId(id), 'MAINTENANCE_REQUEST_PHOTO');
    if (file.uploadedBy) throw badRequest('Foto inválida.');
    photos.push(file._id);
  }
  const driver = await loadDriver(ctx, auth);
  const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: rental.vehicleId, organizationId: auth.organizationId });
  const now = new Date();
  const doc: MaintenanceRequestDoc = {
    _id: new ObjectId(),
    organizationId: auth.organizationId,
    driverId: auth.driverId,
    rentalId: rental._id,
    vehicleId: rental.vehicleId,
    category: body.category,
    description: body.description,
    vehicleStopped: body.vehicleStopped,
    photoFileIds: photos,
    status: 'OPEN',
    responseNote: null,
    handledBy: null,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.mongo.collections.maintenanceRequests.insertOne(doc);
  await createNotification(ctx, {
    organizationId: auth.organizationId,
    type: 'MAINTENANCE',
    severity: body.vehicleStopped || body.category === 'ACCIDENT' ? 'CRITICAL' : 'WARNING',
    title: body.vehicleStopped ? 'Carro parado: pedido de manutenção' : 'Novo pedido de manutenção',
    message: `${driver.fullName} (${vehicle?.plate ?? 'veículo'}): ${maintenanceRequestCategoryLabels[body.category]} — ${body.description.slice(0, 140)}`,
    subjectLabel: vehicle?.plate ?? null,
    entityType: 'maintenanceRequest',
    entityId: doc._id,
    targetPath: '/dashboard/maintenance?tab=requests',
    dedupeKey: `maintenance-request:${doc._id.toHexString()}`,
  });
  await audit(ctx, {
    organizationId: auth.organizationId,
    actorId: null,
    action: 'driverPortal.maintenanceRequest',
    entityType: 'maintenanceRequest',
    entityId: doc._id,
    after: { driverId: auth.driverId, category: body.category },
  });
  return doc;
}

/* ------------------------------ documentos -------------------------- */

export async function attachDocument(
  ctx: AppContext,
  auth: DriverAuthContext,
  body: { kind: 'CNH' | 'ADDRESS_PROOF'; fileId: string },
): Promise<void> {
  const purpose = body.kind === 'CNH' ? 'DRIVER_ID' : 'DRIVER_ADDRESS_PROOF';
  const file = await requireFile(ctx, auth.organizationId, new ObjectId(body.fileId), purpose);
  if (file.uploadedBy) throw badRequest('Arquivo inválido.');
  const driver = await loadDriver(ctx, auth);
  const field = body.kind === 'CNH' ? 'idDocumentFileId' : 'addressProofFileId';
  await ctx.mongo.collections.drivers.updateOne(
    { _id: driver._id, organizationId: auth.organizationId },
    { $set: { [field]: file._id, updatedAt: new Date() }, $inc: { version: 1 } },
  );
  await createNotification(ctx, {
    organizationId: auth.organizationId,
    type: 'CNH',
    severity: 'INFO',
    title: body.kind === 'CNH' ? 'Motorista enviou a CNH' : 'Motorista enviou comprovante de endereço',
    message: `${driver.fullName} enviou um documento pela Área do Motorista em ${formatIsoDateBR(businessDate())}. Confira o cadastro.`,
    subjectLabel: driver.fullName,
    entityType: 'driver',
    entityId: driver._id,
    targetPath: `/dashboard/drivers/${driver._id.toHexString()}`,
    dedupeKey: `driver-document:${driver._id.toHexString()}:${file._id.toHexString()}`,
  });
  await audit(ctx, {
    organizationId: auth.organizationId,
    actorId: null,
    action: 'driverPortal.document',
    entityType: 'driver',
    entityId: driver._id,
    after: { kind: body.kind },
  });
}
