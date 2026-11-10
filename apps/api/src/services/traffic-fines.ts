import { ObjectId, type ClientSession } from 'mongodb';
import {
  addDaysIso,
  businessDate,
  businessTime,
  canTransitionFine,
  fineChargeAmountCents,
  formatCentsBRL,
  formatDateTimeBR,
  formatIsoDateBR,
  normalizeAitNumber,
  terminalFineStatuses,
  trafficFineStatusLabels,
  zonedDateTimeToUtc,
  type FineAppealInstance,
  type FineCharge,
  type FineImportResult,
  type FineNotifyResult,
  type TrafficFine,
  type TrafficFineCreate,
  type TrafficFineListQuery,
  type TrafficFineStatus,
  type TrafficFineSummary,
  type TrafficFineUpdate,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound, unprocessable } from '../common/errors.js';
import { escapeRegex, foldAccents } from '../common/helpers.js';
import { withTransaction } from '../database/mongo.js';
import type { IsoDate, ReceivableDoc, TrafficFineDoc } from '../database/types.js';
import { audit, nextNumber } from './common.js';
import { buildPaymentSchedule, deriveReceivableStatus, reversePaymentsOf } from './finance.js';
import { matchFineToRental, type FineMatchResult } from './fine-matching.js';
import { describeFiles, requireFile } from './files.js';

/* ------------------------------------------------------------------ *
 * Multas de trânsito: regras de negócio.
 * Toda mudança de estado passa por `canTransitionFine` (contracts) e por
 * controle otimista de `version`; cada ação entra no `history` e na
 * auditoria. Dinheiro só se move pela conta a receber (kind FINE).
 * ------------------------------------------------------------------ */

export interface Actor {
  organizationId: ObjectId;
  userId: ObjectId | null;
}

const statusLabel = (s: TrafficFineStatus) => trafficFineStatusLabels[s];

/** Estados em que a identificação do motorista ainda pode mudar. */
const IDENTIFIABLE: readonly TrafficFineStatus[] = ['RECEIVED', 'DRIVER_IDENTIFIED'];

/* ------------------------------ helpers ---------------------------- */

async function loadFine(
  ctx: AppContext,
  organizationId: ObjectId,
  id: ObjectId,
  version?: number,
  session?: ClientSession,
): Promise<TrafficFineDoc> {
  const fine = await ctx.mongo.collections.trafficFines.findOne({ _id: id, organizationId }, { session });
  if (!fine) throw notFound('Multa não encontrada.');
  if (version !== undefined && fine.version !== version) {
    throw conflict('A multa foi alterada por outro usuário. Recarregue e tente novamente.');
  }
  return fine;
}

function assertTransition(from: TrafficFineStatus, to: TrafficFineStatus): void {
  if (!canTransitionFine(from, to)) {
    throw conflict(`Não é possível passar a multa de "${statusLabel(from)}" para "${statusLabel(to)}".`);
  }
}

/** Atualiza a multa com controle de versão e registra o histórico. */
async function applyChange(
  ctx: AppContext,
  actor: Actor,
  fine: TrafficFineDoc,
  change: { set: Partial<TrafficFineDoc>; action: string; detail?: string | null },
  session?: ClientSession,
): Promise<TrafficFineDoc> {
  const now = new Date();
  const next = await ctx.mongo.collections.trafficFines.findOneAndUpdate(
    { _id: fine._id, organizationId: actor.organizationId, version: fine.version },
    {
      $set: { ...change.set, updatedAt: now },
      $inc: { version: 1 },
      $push: { history: { at: now, actorId: actor.userId, action: change.action, detail: change.detail ?? null } },
    },
    { returnDocument: 'after', session },
  );
  if (!next) throw conflict('A multa foi alterada por outro usuário. Recarregue e tente novamente.');
  await audit(
    ctx,
    {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: `trafficFine.${change.action}`,
      entityType: 'trafficFine',
      entityId: fine._id,
      before: { status: fine.status },
      after: { status: next.status, detail: change.detail ?? null },
    },
    session,
  );
  return next;
}

function matchFields(result: FineMatchResult, actorId: ObjectId | null): TrafficFineDoc['match'] {
  return {
    rentalId: result.rental?._id ?? null,
    driverId: result.rental?.driverId ?? null,
    confidence: result.confidence,
    candidateRentalIds: result.candidates.map((c) => c._id),
    matchedAt: new Date(),
    matchedBy: actorId,
  };
}

function matchDetail(result: FineMatchResult): string {
  switch (result.confidence) {
    case 'HIGH':
      return 'Motorista identificado automaticamente pela locação da data.';
    case 'MEDIUM':
      return 'Locação encontrada em dia de entrega/devolução: confirme o motorista.';
    case 'AMBIGUOUS':
      return `${result.candidates.length} locações no dia da infração: escolha o motorista.`;
    default:
      return 'Nenhuma locação cobre a data da infração.';
  }
}

/* ------------------------------- DTO ------------------------------- */

export async function toFineDTOs(ctx: AppContext, organizationId: ObjectId, docs: TrafficFineDoc[]): Promise<TrafficFine[]> {
  if (docs.length === 0) return [];
  const c = ctx.mongo.collections;
  const ids = <T extends ObjectId | null | undefined>(values: T[]) =>
    [...new Set(values.filter((v): v is NonNullable<T> => Boolean(v)).map((v) => v!.toHexString()))].map((s) => new ObjectId(s));

  const rentalIds = ids(docs.flatMap((d) => [d.match.rentalId, ...d.match.candidateRentalIds]));
  const rentals = rentalIds.length ? await c.rentals.find({ organizationId, _id: { $in: rentalIds } }).toArray() : [];
  const driverIds = ids([...docs.map((d) => d.match.driverId), ...rentals.map((r) => r.driverId)]);
  const actorIds = ids(docs.flatMap((d) => d.history.map((h) => h.actorId)));

  const [vehicles, drivers, receivables, users, files] = await Promise.all([
    c.vehicles.find({ organizationId, _id: { $in: ids(docs.map((d) => d.vehicleId)) } }).toArray(),
    driverIds.length ? c.drivers.find({ organizationId, _id: { $in: driverIds } }).toArray() : Promise.resolve([]),
    c.receivables.find({ organizationId, _id: { $in: ids(docs.map((d) => d.receivableId)) } }).toArray(),
    actorIds.length ? c.users.find({ _id: { $in: actorIds } }, { projection: { name: 1 } }).toArray() : Promise.resolve([]),
    describeFiles(ctx, organizationId, ids(docs.flatMap((d) => [d.noticeFileId, d.indicationProofFileId]))),
  ]);
  const vMap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));
  const dMap = new Map(drivers.map((d) => [d._id.toHexString(), d]));
  const rMap = new Map(rentals.map((r) => [r._id.toHexString(), r]));
  const recMap = new Map(receivables.map((r) => [r._id.toHexString(), r]));
  const uMap = new Map(users.map((u) => [u._id.toHexString(), u.name]));
  const fileRef = (id: ObjectId | null) => {
    const f = id ? files.get(id.toHexString()) : undefined;
    return f ? { fileId: f.id.toHexString(), url: f.url, originalName: f.originalName, contentType: f.contentType } : null;
  };
  const today = businessDate();

  return docs.map((doc) => {
    const vehicle = vMap.get(doc.vehicleId.toHexString());
    const rental = doc.match.rentalId ? rMap.get(doc.match.rentalId.toHexString()) : undefined;
    const driver = doc.match.driverId ? dMap.get(doc.match.driverId.toHexString()) : undefined;
    const receivable = doc.receivableId ? recMap.get(doc.receivableId.toHexString()) : undefined;
    return {
      id: doc._id.toHexString(),
      fineNumber: doc.fineNumber,
      aitNumber: doc.aitNumber,
      authority: doc.authority,
      infractionCode: doc.infractionCode,
      infractionDescription: doc.infractionDescription,
      gravity: doc.gravity,
      points: doc.points,
      occurredAt: doc.occurredAt.toISOString(),
      occurredOn: doc.occurredOn,
      place: doc.place,
      vehicle: {
        id: doc.vehicleId.toHexString(),
        plate: vehicle?.plate ?? doc.plateSnapshot,
        brand: vehicle?.brand ?? '—',
        model: vehicle?.model ?? '—',
      },
      amountCents: doc.amountCents,
      discountedAmountCents: doc.discountedAmountCents,
      discountUntil: doc.discountUntil,
      adminFeeCents: doc.adminFeeCents,
      chargeAmountCents: fineChargeAmountCents(doc, today),
      noticeDate: doc.noticeDate,
      indicationDeadline: doc.indicationDeadline,
      dueDate: doc.dueDate,
      status: doc.status,
      match: {
        confidence: doc.match.confidence,
        rental: rental
          ? { id: rental._id.toHexString(), rentalNumber: rental.rentalNumber, startDate: rental.startDate, endDate: rental.endDate }
          : null,
        driver: driver
          ? { id: driver._id.toHexString(), fullName: driver.fullName, phone: driver.anonymizedAt ? null : driver.phone }
          : null,
        candidates: doc.match.candidateRentalIds
          .map((id) => rMap.get(id.toHexString()))
          .filter((r): r is NonNullable<typeof r> => Boolean(r))
          .map((r) => ({
            rentalId: r._id.toHexString(),
            rentalNumber: r.rentalNumber,
            driverId: r.driverId.toHexString(),
            driverName: dMap.get(r.driverId.toHexString())?.fullName ?? '—',
            startDate: r.startDate,
            endDate: r.endDate,
          })),
      },
      indication: doc.indication,
      appeal: { status: doc.appeal.status, instance: doc.appeal.instance, filedAt: doc.appeal.filedAt },
      receivable: receivable
        ? {
            id: receivable._id.toHexString(),
            grossAmountCents: receivable.grossAmountCents,
            paidAmountCents: receivable.paidAmountCents,
            dueDate: receivable.dueDate,
            status: receivable.status,
          }
        : null,
      files: { notice: fileRef(doc.noticeFileId), proof: fileRef(doc.indicationProofFileId) },
      notes: doc.notes,
      history: doc.history.map((h) => ({
        at: h.at.toISOString(),
        action: h.action,
        detail: h.detail ?? null,
        actorName: h.actorId ? (uMap.get(h.actorId.toHexString()) ?? null) : null,
      })),
      version: doc.version,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  });
}

/* ------------------------------ listagem --------------------------- */

export async function buildFineFilter(
  ctx: AppContext,
  organizationId: ObjectId,
  query: Omit<TrafficFineListQuery, 'cursor' | 'limit'>,
  today: IsoDate = businessDate(),
): Promise<Record<string, unknown>> {
  const filter: Record<string, unknown> = { organizationId };
  if (query.status) filter.status = query.status;
  else if (query.openOnly === 'true') filter.status = { $nin: [...terminalFineStatuses] };
  if (query.vehicleId) filter.vehicleId = new ObjectId(query.vehicleId);
  if (query.driverId) filter['match.driverId'] = new ObjectId(query.driverId);
  if (query.rentalId) filter['match.rentalId'] = new ObjectId(query.rentalId);
  if (query.deadline) {
    if (!query.status) filter.status = { $in: [...IDENTIFIABLE] };
    if (query.deadline === 'overdue') {
      // Vencida = pendente com prazo passado OU já marcada como perdida pelo job de avisos.
      filter.$and = [
        {
          $or: [
            { 'indication.status': 'PENDING', indicationDeadline: { $lt: today } },
            { 'indication.status': 'MISSED' },
          ],
        },
      ];
    } else {
      filter['indication.status'] = 'PENDING';
      filter.indicationDeadline = { $gte: today, $lte: addDaysIso(today, 7) };
    }
  }
  if (query.q) {
    const term = query.q.trim();
    const rx = new RegExp(escapeRegex(term), 'i');
    const drivers = await ctx.mongo.collections.drivers
      .find({ organizationId, fullNameFold: new RegExp(escapeRegex(foldAccents(term).toLowerCase()), 'i') })
      .project<{ _id: ObjectId }>({ _id: 1 })
      .toArray();
    filter.$or = [
      { fineNumber: rx },
      { aitNumberNorm: new RegExp(escapeRegex(normalizeAitNumber(term) || term), 'i') },
      { plateSnapshot: new RegExp(escapeRegex(term.toUpperCase().replace(/[^A-Z0-9]/g, '') || term), 'i') },
      { infractionDescription: rx },
      { 'match.driverId': { $in: drivers.map((d) => d._id) } },
    ];
  }
  return filter;
}

export async function fineSummary(ctx: AppContext, organizationId: ObjectId, today = businessDate()): Promise<TrafficFineSummary> {
  const open = await ctx.mongo.collections.trafficFines
    .find(
      { organizationId, status: { $nin: [...terminalFineStatuses] } },
      { projection: { status: 1, amountCents: 1, indication: 1, indicationDeadline: 1 } },
    )
    .toArray();
  const soonLimit = addDaysIso(today, 7);
  const pendingIndication = open.filter(
    (f) => IDENTIFIABLE.includes(f.status) && f.indication.status === 'PENDING' && f.indicationDeadline,
  );
  const missed = open.filter((f) => IDENTIFIABLE.includes(f.status) && f.indication.status === 'MISSED').length;
  return {
    openCount: open.length,
    openAmountCents: open.reduce((a, f) => a + f.amountCents, 0),
    indicationOverdueCount: pendingIndication.filter((f) => f.indicationDeadline! < today).length + missed,
    indicationDueSoonCount: pendingIndication.filter((f) => f.indicationDeadline! >= today && f.indicationDeadline! <= soonLimit).length,
    toChargeCount: open.filter((f) => f.status === 'DRIVER_IDENTIFIED' || f.status === 'INDICATED').length,
  };
}

/* ------------------------------ cadastro --------------------------- */

interface NewFineInput {
  vehicleId: ObjectId;
  aitNumber: string;
  authority: TrafficFineDoc['authority'];
  infractionCode: string | null;
  infractionDescription: string;
  gravity: TrafficFineDoc['gravity'];
  points: number | null;
  occurredAt: Date;
  place: string | null;
  amountCents: number;
  discountedAmountCents: number | null;
  discountUntil: IsoDate | null;
  adminFeeCents: number;
  noticeDate: IsoDate | null;
  indicationDeadline: IsoDate | null;
  dueDate: IsoDate | null;
  noticeFileId: ObjectId | null;
  notes: string | null;
  source: TrafficFineDoc['source'];
}

async function insertFine(ctx: AppContext, actor: Actor, input: NewFineInput): Promise<TrafficFineDoc> {
  const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: input.vehicleId, organizationId: actor.organizationId });
  if (!vehicle) throw notFound('Veículo não encontrado.');
  if (input.occurredAt.getTime() > Date.now() + 60_000) {
    throw unprocessable('A data da infração não pode ser futura.');
  }
  const aitNorm = normalizeAitNumber(input.aitNumber);
  if (!aitNorm) throw badRequest('Informe o número do auto de infração (AIT).');
  const duplicated = await ctx.mongo.collections.trafficFines.findOne({ organizationId: actor.organizationId, aitActiveKey: aitNorm });
  if (duplicated) throw conflict(`O auto de infração ${input.aitNumber} já está cadastrado (${duplicated.fineNumber}).`);

  const match = await matchFineToRental(ctx, actor.organizationId, input.vehicleId, input.occurredAt);
  const today = businessDate();

  try {
    return await withTransaction(ctx, async (session) => {
      const { number, sequence } = await nextNumber(ctx, actor.organizationId, 'fine', 'MUL', Number(today.slice(0, 4)), session);
      const now = new Date();
      const doc: TrafficFineDoc = {
        _id: new ObjectId(),
        organizationId: actor.organizationId,
        fineNumber: number,
        sequence,
        aitNumber: input.aitNumber.trim(),
        aitNumberNorm: aitNorm,
        aitActiveKey: aitNorm,
        authority: input.authority,
        source: input.source,
        infractionCode: input.infractionCode,
        infractionDescription: input.infractionDescription,
        gravity: input.gravity,
        points: input.points,
        occurredAt: input.occurredAt,
        occurredOn: businessDate(input.occurredAt),
        place: input.place,
        vehicleId: input.vehicleId,
        plateSnapshot: vehicle.plate,
        amountCents: input.amountCents,
        discountedAmountCents: input.discountedAmountCents,
        discountUntil: input.discountUntil,
        adminFeeCents: input.adminFeeCents,
        noticeDate: input.noticeDate,
        indicationDeadline: input.indicationDeadline,
        dueDate: input.dueDate,
        noticeFileId: input.noticeFileId,
        indicationProofFileId: null,
        status: match.confidence === 'HIGH' ? 'DRIVER_IDENTIFIED' : 'RECEIVED',
        match: matchFields(match, actor.userId),
        indication: { status: 'PENDING', protocol: null, indicatedAt: null },
        appeal: { status: 'NONE', instance: null, filedAt: null, resumeStatus: null },
        receivableId: null,
        notes: input.notes,
        history: [
          { at: now, actorId: actor.userId, action: 'created', detail: input.source === 'PROVIDER' ? 'Importada do provedor' : null },
          { at: now, actorId: null, action: 'matched', detail: matchDetail(match) },
        ],
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await ctx.mongo.collections.trafficFines.insertOne(doc, { session });
      await audit(
        ctx,
        {
          organizationId: actor.organizationId,
          actorId: actor.userId,
          action: 'trafficFine.created',
          entityType: 'trafficFine',
          entityId: doc._id,
          after: { fineNumber: number, aitNumber: doc.aitNumber, amountCents: doc.amountCents, match: match.confidence },
        },
        session,
      );
      return doc;
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw conflict(`O auto de infração ${input.aitNumber} já está cadastrado.`);
    }
    throw err;
  }
}

export async function createFine(ctx: AppContext, actor: Actor, body: TrafficFineCreate): Promise<TrafficFineDoc> {
  const notice = body.noticeFileId
    ? await requireFile(ctx, actor.organizationId, new ObjectId(body.noticeFileId), 'TRAFFIC_FINE_NOTICE')
    : null;
  return insertFine(ctx, actor, {
    vehicleId: new ObjectId(body.vehicleId),
    aitNumber: body.aitNumber,
    authority: { name: body.authorityName, code: body.authorityCode ?? null, state: body.authorityState?.toUpperCase() ?? null },
    infractionCode: body.infractionCode ?? null,
    infractionDescription: body.infractionDescription,
    gravity: body.gravity ?? null,
    points: body.points ?? null,
    occurredAt: zonedDateTimeToUtc(body.occurredDate, body.occurredTime),
    place: body.place ?? null,
    amountCents: body.amountCents,
    discountedAmountCents: body.discountedAmountCents ?? null,
    discountUntil: body.discountUntil ?? null,
    adminFeeCents: body.adminFeeCents,
    noticeDate: body.noticeDate ?? null,
    indicationDeadline: body.indicationDeadline ?? null,
    dueDate: body.dueDate ?? null,
    noticeFileId: notice?._id ?? null,
    notes: body.notes ?? null,
    source: 'MANUAL',
  });
}

export async function updateFine(ctx: AppContext, actor: Actor, id: ObjectId, body: TrafficFineUpdate): Promise<TrafficFineDoc> {
  const fine = await loadFine(ctx, actor.organizationId, id, body.version);
  if (fine.status === 'CANCELED') throw conflict('Multa cancelada não pode ser editada.');
  const moneyChanged =
    (body.amountCents !== undefined && body.amountCents !== fine.amountCents) ||
    (body.discountedAmountCents !== undefined && body.discountedAmountCents !== fine.discountedAmountCents) ||
    (body.adminFeeCents !== undefined && body.adminFeeCents !== fine.adminFeeCents);
  if (moneyChanged && fine.receivableId) {
    throw conflict('A multa já foi cobrada do motorista: o valor não pode mais ser alterado aqui.');
  }

  const set: Partial<TrafficFineDoc> = {};
  if (body.aitNumber !== undefined) {
    const norm = normalizeAitNumber(body.aitNumber);
    if (!norm) throw badRequest('Informe o número do auto de infração (AIT).');
    if (norm !== fine.aitNumberNorm) {
      const dup = await ctx.mongo.collections.trafficFines.findOne({ organizationId: actor.organizationId, aitActiveKey: norm });
      if (dup) throw conflict(`O auto de infração ${body.aitNumber} já está cadastrado (${dup.fineNumber}).`);
    }
    Object.assign(set, { aitNumber: body.aitNumber.trim(), aitNumberNorm: norm, aitActiveKey: norm });
  }
  if (body.authorityName !== undefined || body.authorityCode !== undefined || body.authorityState !== undefined) {
    set.authority = {
      name: body.authorityName ?? fine.authority.name,
      code: body.authorityCode !== undefined ? (body.authorityCode ?? null) : fine.authority.code,
      state: body.authorityState !== undefined ? (body.authorityState?.toUpperCase() ?? null) : fine.authority.state,
    };
  }
  if (body.infractionCode !== undefined) set.infractionCode = body.infractionCode ?? null;
  if (body.infractionDescription !== undefined) set.infractionDescription = body.infractionDescription;
  if (body.gravity !== undefined) set.gravity = body.gravity;
  if (body.points !== undefined) set.points = body.points;
  if (body.place !== undefined) set.place = body.place ?? null;
  if (body.amountCents !== undefined) set.amountCents = body.amountCents;
  if (body.discountedAmountCents !== undefined) set.discountedAmountCents = body.discountedAmountCents;
  if (body.discountUntil !== undefined) set.discountUntil = body.discountUntil ?? null;
  if (body.adminFeeCents !== undefined) set.adminFeeCents = body.adminFeeCents;
  if (body.noticeDate !== undefined) set.noticeDate = body.noticeDate ?? null;
  if (body.indicationDeadline !== undefined) set.indicationDeadline = body.indicationDeadline ?? null;
  if (body.dueDate !== undefined) set.dueDate = body.dueDate ?? null;
  if (body.notes !== undefined) set.notes = body.notes ?? null;
  if (body.noticeFileId !== undefined) {
    const file = await requireFile(ctx, actor.organizationId, new ObjectId(body.noticeFileId), 'TRAFFIC_FINE_NOTICE');
    set.noticeFileId = file._id;
  }
  const amount = set.amountCents ?? fine.amountCents;
  const discounted = set.discountedAmountCents !== undefined ? set.discountedAmountCents : fine.discountedAmountCents;
  if (discounted !== null && discounted > amount) {
    throw unprocessable('O valor com desconto não pode ser maior que o valor da multa.');
  }

  let detail: string | null = null;
  if (body.occurredDate !== undefined || body.occurredTime !== undefined) {
    const date = body.occurredDate ?? fine.occurredOn;
    const time = body.occurredTime ?? businessTime(fine.occurredAt);
    const occurredAt = zonedDateTimeToUtc(date, time);
    if (occurredAt.getTime() > Date.now() + 60_000) throw unprocessable('A data da infração não pode ser futura.');
    set.occurredAt = occurredAt;
    set.occurredOn = businessDate(occurredAt);
    // Data mudou antes da cobrança: refaz a identificação.
    if (IDENTIFIABLE.includes(fine.status) && occurredAt.getTime() !== fine.occurredAt.getTime()) {
      const match = await matchFineToRental(ctx, actor.organizationId, fine.vehicleId, occurredAt);
      set.match = matchFields(match, actor.userId);
      set.status = match.confidence === 'HIGH' ? 'DRIVER_IDENTIFIED' : 'RECEIVED';
      detail = matchDetail(match);
    }
  }

  try {
    return await applyChange(ctx, actor, fine, { set, action: 'updated', detail });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('Este auto de infração já está cadastrado.');
    throw err;
  }
}

/* ------------------------- identificação --------------------------- */

export async function rematchFine(ctx: AppContext, actor: Actor, id: ObjectId, version: number): Promise<TrafficFineDoc> {
  const fine = await loadFine(ctx, actor.organizationId, id, version);
  if (!IDENTIFIABLE.includes(fine.status)) {
    throw conflict('A identificação só pode ser refeita antes da indicação ou cobrança.');
  }
  const match = await matchFineToRental(ctx, actor.organizationId, fine.vehicleId, fine.occurredAt);
  return applyChange(ctx, actor, fine, {
    set: { match: matchFields(match, actor.userId), status: match.confidence === 'HIGH' ? 'DRIVER_IDENTIFIED' : 'RECEIVED' },
    action: 'matched',
    detail: matchDetail(match),
  });
}

export async function identifyDriver(
  ctx: AppContext,
  actor: Actor,
  id: ObjectId,
  body: { driverId: string; rentalId?: string; version: number },
): Promise<TrafficFineDoc> {
  const fine = await loadFine(ctx, actor.organizationId, id, body.version);
  assertTransition(fine.status, 'DRIVER_IDENTIFIED');
  const driver = await ctx.mongo.collections.drivers.findOne({ _id: new ObjectId(body.driverId), organizationId: actor.organizationId });
  if (!driver) throw notFound('Motorista não encontrado.');
  let rentalId: ObjectId | null = null;
  if (body.rentalId) {
    const rental = await ctx.mongo.collections.rentals.findOne({ _id: new ObjectId(body.rentalId), organizationId: actor.organizationId });
    if (!rental) throw notFound('Locação não encontrada.');
    if (!rental.driverId.equals(driver._id)) throw badRequest('A locação escolhida é de outro motorista.');
    if (!rental.vehicleId.equals(fine.vehicleId)) throw badRequest('A locação escolhida é de outro veículo.');
    rentalId = rental._id;
  }
  const confirmsMatch = Boolean(rentalId && fine.match.rentalId?.equals(rentalId));
  return applyChange(ctx, actor, fine, {
    set: {
      status: 'DRIVER_IDENTIFIED',
      match: {
        ...fine.match,
        rentalId,
        driverId: driver._id,
        confidence: confirmsMatch && fine.match.confidence !== 'AMBIGUOUS' ? fine.match.confidence : 'MANUAL',
        matchedAt: new Date(),
        matchedBy: actor.userId,
      },
    },
    action: 'identified',
    detail: `Motorista: ${driver.fullName}`,
  });
}

export async function indicateDriver(
  ctx: AppContext,
  actor: Actor,
  id: ObjectId,
  body: { protocol?: string; indicatedAt: IsoDate; proofFileId?: string; version: number },
): Promise<TrafficFineDoc> {
  const fine = await loadFine(ctx, actor.organizationId, id, body.version);
  assertTransition(fine.status, 'INDICATED');
  if (!fine.match.driverId) throw conflict('Identifique o motorista antes de registrar a indicação.');
  if (body.indicatedAt > businessDate()) throw unprocessable('A data da indicação não pode ser futura.');
  const proof = body.proofFileId
    ? await requireFile(ctx, actor.organizationId, new ObjectId(body.proofFileId), 'TRAFFIC_FINE_PROOF')
    : null;
  return applyChange(ctx, actor, fine, {
    set: {
      status: 'INDICATED',
      indication: { status: 'DONE', protocol: body.protocol ?? null, indicatedAt: body.indicatedAt },
      indicationProofFileId: proof?._id ?? fine.indicationProofFileId,
    },
    action: 'indicated',
    detail: body.protocol ? `Protocolo ${body.protocol}` : null,
  });
}

/* ------------------------------ cobrança --------------------------- */

/** Próximo vencimento de aluguel do motorista (cai no ciclo semanal); senão, daqui a 7 dias. */
async function defaultChargeDueDate(ctx: AppContext, fine: TrafficFineDoc, today: IsoDate): Promise<IsoDate> {
  const fallback = addDaysIso(today, 7);
  if (!fine.match.driverId) return fallback;
  const rental = await ctx.mongo.collections.rentals.findOne(
    { organizationId: fine.organizationId, driverId: fine.match.driverId, status: 'ACTIVE' },
    { sort: { startDate: -1 } },
  );
  if (!rental) return fallback;
  const contract = await ctx.mongo.collections.receivables.findOne({
    organizationId: fine.organizationId,
    rentalId: rental._id,
    expectedPeriod: 'CONTRACT',
  });
  if (contract && contract.status !== 'CANCELED') {
    const { weeks } = buildPaymentSchedule(rental, contract, today);
    const next = weeks.find((w) => w.dueDate >= today);
    if (next) return next.dueDate;
  }
  // Sem cronograma futuro: próximo aniversário do período a partir do início.
  const period = rental.rentalType === 'WEEKLY' ? 7 : 30;
  let due = rental.startDate;
  while (due < today) due = addDaysIso(due, period);
  return due;
}

export async function chargeFine(
  ctx: AppContext,
  actor: Actor,
  id: ObjectId,
  body: FineCharge,
): Promise<{ fine: TrafficFineDoc; alreadyCharged: boolean }> {
  const current = await loadFine(ctx, actor.organizationId, id);
  // Repetição (duplo clique): devolve a cobrança já feita.
  if (current.receivableId && (current.status === 'CHARGED' || current.status === 'PAID')) {
    return { fine: current, alreadyCharged: true };
  }
  if (current.version !== body.version) {
    throw conflict('A multa foi alterada por outro usuário. Recarregue e tente novamente.');
  }
  assertTransition(current.status, 'CHARGED');
  if (!current.match.driverId) throw conflict('Identifique o motorista antes de cobrar.');

  const today = businessDate();
  const amountCents = body.amountCents ?? fineChargeAmountCents(current, today);
  const dueDate = body.dueDate ?? (await defaultChargeDueDate(ctx, current, today));
  if (dueDate < today) throw unprocessable('O vencimento da cobrança não pode estar no passado.');

  const fine = await withTransaction(ctx, async (session) => {
    const now = new Date();
    const description = `Multa ${current.aitNumber} - ${current.plateSnapshot}`;
    const receivable: ReceivableDoc = {
      _id: new ObjectId(),
      organizationId: actor.organizationId,
      description,
      descriptionFold: foldAccents(description).toLowerCase(),
      rentalId: current.match.rentalId,
      driverId: current.match.driverId!,
      grossAmountCents: amountCents,
      paidAmountCents: 0,
      dueDate,
      paymentMethod: null,
      kind: 'FINE',
      installmentNo: null,
      expectedPeriod: `FINE:${current._id.toHexString()}`,
      trafficFineId: current._id,
      status: 'OPEN',
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    receivable.status = deriveReceivableStatus(receivable, today);
    await ctx.mongo.collections.receivables.insertOne(receivable, { session });
    return applyChange(
      ctx,
      actor,
      current,
      {
        set: { status: 'CHARGED', receivableId: receivable._id },
        action: 'charged',
        detail: `${formatCentsBRL(amountCents)} com vencimento em ${formatIsoDateBR(dueDate)}`,
      },
      session,
    );
  });
  return { fine, alreadyCharged: false };
}

/** Cancela a cobrança (estorna o que foi pago e cancela a conta). Usado no cancelamento e no recurso deferido. */
async function voidCharge(ctx: AppContext, actor: Actor, fine: TrafficFineDoc, reason: string, session?: ClientSession): Promise<void> {
  if (!fine.receivableId) return;
  const receivable = await ctx.mongo.collections.receivables.findOne(
    { _id: fine.receivableId, organizationId: actor.organizationId },
    { session },
  );
  if (!receivable || receivable.status === 'CANCELED') return;
  await reversePaymentsOf(
    ctx,
    { organizationId: actor.organizationId, sourceType: 'RECEIVABLE', sourceId: receivable._id, reason, actorId: actor.userId },
    session,
  );
  const res = await ctx.mongo.collections.receivables.updateOne(
    { _id: receivable._id, version: receivable.version },
    { $set: { status: 'CANCELED', paidAmountCents: 0, updatedAt: new Date() }, $inc: { version: 1 } },
    { session },
  );
  if (res.matchedCount === 0) throw conflict('A cobrança foi alterada ao mesmo tempo. Tente novamente.');
}

/* ------------------------- recurso e encerramento ------------------- */

export async function contestFine(
  ctx: AppContext,
  actor: Actor,
  id: ObjectId,
  body: { instance: FineAppealInstance; filedAt: IsoDate; notes?: string; version: number },
): Promise<TrafficFineDoc> {
  const fine = await loadFine(ctx, actor.organizationId, id, body.version);
  assertTransition(fine.status, 'CONTESTED');
  if (body.filedAt > businessDate()) throw unprocessable('A data do recurso não pode ser futura.');
  return applyChange(ctx, actor, fine, {
    set: {
      status: 'CONTESTED',
      appeal: { status: 'FILED', instance: body.instance, filedAt: body.filedAt, resumeStatus: fine.status },
    },
    action: 'contested',
    detail: body.notes ?? null,
  });
}

export async function appealResult(
  ctx: AppContext,
  actor: Actor,
  id: ObjectId,
  body: { result: 'GRANTED' | 'DENIED'; notes?: string; version: number },
): Promise<TrafficFineDoc> {
  const fine = await loadFine(ctx, actor.organizationId, id, body.version);
  if (fine.status !== 'CONTESTED') throw conflict('A multa não está em recurso.');

  if (body.result === 'GRANTED') {
    return withTransaction(ctx, async (session) => {
      await voidCharge(ctx, actor, fine, `Recurso deferido - multa ${fine.fineNumber}`, session);
      return applyChange(
        ctx,
        actor,
        fine,
        { set: { status: 'CANCELED', aitActiveKey: null, appeal: { ...fine.appeal, status: 'GRANTED' } }, action: 'appeal_granted', detail: body.notes ?? null },
        session,
      );
    });
  }

  // Indeferido: volta ao estado anterior; se o motorista pagou durante o recurso, já fica PAGA.
  let resume: TrafficFineStatus = fine.appeal.resumeStatus ?? 'RECEIVED';
  if ((resume === 'CHARGED' || resume === 'PAID') && fine.receivableId) {
    const receivable = await ctx.mongo.collections.receivables.findOne({ _id: fine.receivableId });
    resume = receivable?.status === 'PAID' ? 'PAID' : 'CHARGED';
  }
  return applyChange(ctx, actor, fine, {
    set: { status: resume, appeal: { ...fine.appeal, status: 'DENIED', resumeStatus: null } },
    action: 'appeal_denied',
    detail: body.notes ?? null,
  });
}

export async function markCompanyLiable(
  ctx: AppContext,
  actor: Actor,
  id: ObjectId,
  body: { reason: string; version: number },
): Promise<TrafficFineDoc> {
  const fine = await loadFine(ctx, actor.organizationId, id, body.version);
  assertTransition(fine.status, 'COMPANY_LIABLE');
  return applyChange(ctx, actor, fine, {
    set: {
      status: 'COMPANY_LIABLE',
      indication: fine.indication.status === 'PENDING' ? { ...fine.indication, status: 'NOT_REQUIRED' } : fine.indication,
    },
    action: 'company_liable',
    detail: body.reason,
  });
}

export async function cancelFine(
  ctx: AppContext,
  actor: Actor,
  id: ObjectId,
  body: { reason: string; version: number },
): Promise<TrafficFineDoc> {
  const fine = await loadFine(ctx, actor.organizationId, id, body.version);
  assertTransition(fine.status, 'CANCELED');
  return withTransaction(ctx, async (session) => {
    await voidCharge(ctx, actor, fine, `Cancelamento da multa ${fine.fineNumber}`, session);
    return applyChange(
      ctx,
      actor,
      fine,
      { set: { status: 'CANCELED', aitActiveKey: null }, action: 'canceled', detail: body.reason },
      session,
    );
  });
}

/* --------------------------- aviso ao motorista --------------------- */

export function fineDriverMessage(fine: TrafficFineDoc, driverName: string, companyName: string, today = businessDate()): string {
  const firstName = driverName.split(' ')[0] ?? driverName;
  const amount = formatCentsBRL(fineChargeAmountCents(fine, today));
  const lines = [
    `Olá, ${firstName}! Aqui é da ${companyName || 'locadora'}.`,
    `Recebemos uma multa do veículo ${fine.plateSnapshot} do período em que ele estava com você:`,
    `• ${fine.infractionDescription}`,
    `• Data: ${formatDateTimeBR(fine.occurredAt)}${fine.place ? ` - ${fine.place}` : ''}`,
    `• Auto de infração: ${fine.aitNumber} (${fine.authority.name})`,
    `• Valor: ${amount}`,
  ];
  if (fine.indicationDeadline && fine.indication.status === 'PENDING') {
    lines.push(`Precisamos da sua assinatura no formulário de indicação de condutor até ${formatIsoDateBR(fine.indicationDeadline)}.`);
  }
  lines.push('Qualquer dúvida, é só responder esta mensagem.');
  return lines.join('\n');
}

export async function notifyDriver(ctx: AppContext, actor: Actor, id: ObjectId): Promise<FineNotifyResult> {
  const fine = await loadFine(ctx, actor.organizationId, id);
  if (!fine.match.driverId) throw conflict('Identifique o motorista antes de avisá-lo.');
  if (fine.status === 'CANCELED') throw conflict('Multa cancelada.');
  const [driver, organization] = await Promise.all([
    ctx.mongo.collections.drivers.findOne({ _id: fine.match.driverId, organizationId: actor.organizationId }),
    ctx.mongo.collections.organizations.findOne({ _id: actor.organizationId }),
  ]);
  if (!driver || driver.anonymizedAt) throw notFound('Motorista não encontrado.');
  if (driver.whatsappConsent?.status === 'REVOKED') {
    throw conflict('O motorista revogou o consentimento para mensagens pelo WhatsApp.');
  }
  const message = fineDriverMessage(fine, driver.fullName, organization?.name ?? '');
  const result = await ctx.integrations.whatsapp.send(driver.phone, message, `fine:${fine._id.toHexString()}:v${fine.version}`);
  const now = new Date();
  await ctx.mongo.collections.trafficFines.updateOne(
    { _id: fine._id },
    {
      $push: {
        history: {
          at: now,
          actorId: actor.userId,
          action: 'driver_notified',
          detail: result.delivered ? 'Mensagem enviada pelo WhatsApp' : 'Link manual do WhatsApp gerado',
        },
      },
      $set: { updatedAt: now },
    },
  );
  return { delivered: result.delivered, error: result.delivered ? null : result.error, manualLink: result.manualLink, message };
}

/* ------------------------- importação do provedor ------------------- */

export async function importFromProvider(ctx: AppContext, actor: Actor, vehicleId: ObjectId): Promise<FineImportResult> {
  const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: vehicleId, organizationId: actor.organizationId });
  if (!vehicle) throw notFound('Veículo não encontrado.');
  const status = ctx.integrations.trafficFines.status();
  if (!status.connected) return { available: false, message: status.message, created: 0, skipped: 0 };
  if (!vehicle.registration.state) {
    throw badRequest('Informe a UF de emplacamento do veículo para consultar multas no DETRAN correspondente.');
  }
  const items = await ctx.integrations.trafficFines.query({
    plate: vehicle.plate,
    renavam: vehicle.renavam,
    state: vehicle.registration.state,
  });
  let created = 0;
  let skipped = 0;
  for (const item of items) {
    const occurredAt = item.occurredAt ? new Date(item.occurredAt) : null;
    if (!item.aitNumber || !occurredAt || Number.isNaN(occurredAt.getTime()) || item.amountCents <= 0) {
      skipped += 1;
      continue;
    }
    const exists = await ctx.mongo.collections.trafficFines.findOne({
      organizationId: actor.organizationId,
      aitNumberNorm: normalizeAitNumber(item.aitNumber),
    });
    if (exists) {
      skipped += 1;
      continue;
    }
    try {
      await insertFine(ctx, actor, {
        vehicleId,
        aitNumber: item.aitNumber,
        authority: { name: item.authority ?? 'Órgão não informado', code: null, state: vehicle.registration.state },
        infractionCode: item.code || null,
        infractionDescription: item.description || 'Infração de trânsito',
        gravity: null,
        points: item.points ?? null,
        occurredAt,
        place: null,
        amountCents: item.amountCents,
        discountedAmountCents: null,
        discountUntil: null,
        adminFeeCents: 0,
        noticeDate: null,
        indicationDeadline: item.indicationDeadline ?? null,
        dueDate: item.dueDate ?? null,
        noticeFileId: null,
        notes: null,
        source: 'PROVIDER',
      });
      created += 1;
    } catch (err) {
      if ((err as { code?: string }).code === 'CONFLICT') skipped += 1;
      else throw err;
    }
  }
  return { available: true, message: null, created, skipped };
}
