import { ObjectId, type ClientSession } from 'mongodb';
import {
  addDaysIso,
  businessDate,
  claimKindLabels,
  claimStatusLabels,
  claimTransitions,
  CLAIM_STALE_DAYS,
  diffDaysIso,
  formatCentsBRL,
  formatIsoDateBR,
  type Claim,
  type ClaimCharge,
  type ClaimCreate,
  type ClaimStatusChange,
  type ClaimUpdate,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { foldAccents } from '../common/helpers.js';
import { withTransaction } from '../database/mongo.js';
import type { ClaimDoc, ReceivableDoc } from '../database/types.js';
import { audit, nextNumber } from './common.js';
import { deriveReceivableStatus } from './finance.js';
import { describeFiles, requireFile } from './files.js';
import { createNotification, weekKey } from './notifications.js';

/* ------------------------------------------------------------------ *
 * Sinistros: registro do caso, acompanhamento e cobrança da franquia.
 * ------------------------------------------------------------------ */

export interface Actor {
  organizationId: ObjectId;
  userId: ObjectId | null;
}

const searchText = (parts: Array<string | null | undefined>): string => foldAccents(parts.filter(Boolean).join(' ')).toLowerCase();

export async function loadClaim(ctx: AppContext, organizationId: ObjectId, id: ObjectId): Promise<ClaimDoc> {
  const claim = await ctx.mongo.collections.claims.findOne({ _id: id, organizationId });
  if (!claim) throw notFound('Sinistro não encontrado.');
  return claim;
}

/** Locação do veículo vigente na data (a mais recente que já tinha começado). */
export async function rentalOnDate(ctx: AppContext, organizationId: ObjectId, vehicleId: ObjectId, date: string) {
  return ctx.mongo.collections.rentals.findOne(
    {
      organizationId,
      vehicleId,
      status: { $ne: 'CANCELED' },
      startDate: { $lte: date },
      $or: [{ endDate: null }, { endDate: { $gte: date } }],
    },
    { sort: { startDate: -1 } },
  );
}

async function validatedFileIds(ctx: AppContext, organizationId: ObjectId, ids: string[] | undefined): Promise<ObjectId[]> {
  const out: ObjectId[] = [];
  for (const id of ids ?? []) out.push((await requireFile(ctx, organizationId, new ObjectId(id), 'CLAIM_FILE'))._id);
  return out;
}

export async function createClaim(ctx: AppContext, actor: Actor, body: ClaimCreate): Promise<ClaimDoc> {
  const today = businessDate();
  if (body.occurredOn > today) throw unprocessable('A data do sinistro não pode estar no futuro.');
  const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: new ObjectId(body.vehicleId), organizationId: actor.organizationId });
  if (!vehicle) throw notFound('Veículo não encontrado.');

  let rental = null;
  if (body.rentalId) {
    rental = await ctx.mongo.collections.rentals.findOne({ _id: new ObjectId(body.rentalId), organizationId: actor.organizationId });
    if (!rental || !rental.vehicleId.equals(vehicle._id)) throw unprocessable('A locação informada não é deste veículo.');
  } else {
    rental = await rentalOnDate(ctx, actor.organizationId, vehicle._id, body.occurredOn);
  }
  const driver = rental ? await ctx.mongo.collections.drivers.findOne({ _id: rental.driverId, organizationId: actor.organizationId }) : null;
  const fileIds = await validatedFileIds(ctx, actor.organizationId, body.fileIds);

  const doc = await withTransaction(ctx, async (session) => {
    const { number, sequence } = await nextNumber(ctx, actor.organizationId, 'claim', 'SIN', Number(today.slice(0, 4)), session);
    const now = new Date();
    const claim: ClaimDoc = {
      _id: new ObjectId(),
      organizationId: actor.organizationId,
      claimNumber: number,
      sequence,
      status: 'OPEN',
      kind: body.kind,
      fault: body.fault,
      occurredOn: body.occurredOn,
      location: body.location ?? null,
      description: body.description,
      policeReportNumber: body.policeReportNumber ?? null,
      insurerClaimNumber: body.insurerClaimNumber ?? null,
      deductibleCents: body.deductibleCents ?? null,
      estimatedCostCents: body.estimatedCostCents ?? null,
      finalCostCents: null,
      vehicleId: vehicle._id,
      rentalId: rental?._id ?? null,
      driverId: rental?.driverId ?? null,
      searchFold: searchText([number, vehicle.plate, vehicle.brand, vehicle.model, driver?.fullName, body.policeReportNumber, body.insurerClaimNumber]),
      fileIds,
      receivableId: null,
      history: [{ at: now, actorId: actor.userId, action: 'created', detail: `${claimKindLabels[body.kind]} em ${formatIsoDateBR(body.occurredOn)}` }],
      createdBy: actor.userId,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    await ctx.mongo.collections.claims.insertOne(claim, { session });
    await audit(
      ctx,
      { organizationId: actor.organizationId, actorId: actor.userId, action: 'claim.created', entityType: 'claim', entityId: claim._id, after: { claimNumber: number, vehicleId: vehicle._id } },
      session,
    );
    return claim;
  });
  return doc;
}

async function applyChange(
  ctx: AppContext,
  actor: Actor,
  claim: ClaimDoc,
  version: number,
  change: { set: Partial<ClaimDoc>; action: string; detail?: string | null },
  session?: ClientSession,
): Promise<ClaimDoc> {
  if (claim.version !== version) throw conflict('O sinistro foi alterado por outro usuário. Recarregue e tente novamente.');
  const now = new Date();
  const next = await ctx.mongo.collections.claims.findOneAndUpdate(
    { _id: claim._id, organizationId: actor.organizationId, version },
    {
      $set: { ...change.set, updatedAt: now },
      $inc: { version: 1 },
      $push: { history: { at: now, actorId: actor.userId, action: change.action, detail: change.detail ?? null } },
    },
    { returnDocument: 'after', session },
  );
  if (!next) throw conflict('O sinistro foi alterado por outro usuário. Recarregue e tente novamente.');
  await audit(
    ctx,
    {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      action: `claim.${change.action}`,
      entityType: 'claim',
      entityId: claim._id,
      before: { status: claim.status },
      after: { status: next.status, detail: change.detail ?? null },
    },
    session,
  );
  return next;
}

const FIELD_LABELS: Record<string, string> = {
  fault: 'culpa',
  location: 'local',
  description: 'descrição',
  policeReportNumber: 'B.O.',
  insurerClaimNumber: 'protocolo da seguradora',
  deductibleCents: 'franquia',
  estimatedCostCents: 'custo estimado',
  finalCostCents: 'custo final',
  fileIds: 'arquivos',
};

export async function updateClaim(ctx: AppContext, actor: Actor, id: ObjectId, body: ClaimUpdate): Promise<ClaimDoc> {
  const current = await loadClaim(ctx, actor.organizationId, id);
  if (current.status === 'CLOSED' || current.status === 'CANCELED') throw conflict('Sinistro encerrado ou cancelado não pode ser alterado.');
  const set: Partial<ClaimDoc> = {};
  if (body.fault !== undefined) set.fault = body.fault;
  if (body.location !== undefined) set.location = body.location;
  if (body.description !== undefined) set.description = body.description;
  if (body.policeReportNumber !== undefined) set.policeReportNumber = body.policeReportNumber;
  if (body.insurerClaimNumber !== undefined) set.insurerClaimNumber = body.insurerClaimNumber;
  if (body.deductibleCents !== undefined) set.deductibleCents = body.deductibleCents;
  if (body.estimatedCostCents !== undefined) set.estimatedCostCents = body.estimatedCostCents;
  if (body.finalCostCents !== undefined) set.finalCostCents = body.finalCostCents;
  if (body.fileIds !== undefined) set.fileIds = await validatedFileIds(ctx, actor.organizationId, body.fileIds);
  if (body.policeReportNumber !== undefined || body.insurerClaimNumber !== undefined) {
    const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: current.vehicleId });
    const driver = current.driverId ? await ctx.mongo.collections.drivers.findOne({ _id: current.driverId }) : null;
    set.searchFold = searchText([
      current.claimNumber,
      vehicle?.plate,
      vehicle?.brand,
      vehicle?.model,
      driver?.fullName,
      body.policeReportNumber === undefined ? current.policeReportNumber : body.policeReportNumber,
      body.insurerClaimNumber === undefined ? current.insurerClaimNumber : body.insurerClaimNumber,
    ]);
  }
  return applyChange(ctx, actor, current, body.version, { set, action: 'updated', detail: `Atualizado: ${Object.keys(set).filter((k) => k !== 'searchFold').map((k) => FIELD_LABELS[k] ?? k).join(', ')}` });
}

export async function changeClaimStatus(ctx: AppContext, actor: Actor, id: ObjectId, body: ClaimStatusChange): Promise<ClaimDoc> {
  const current = await loadClaim(ctx, actor.organizationId, id);
  if (!claimTransitions[current.status].includes(body.status)) {
    throw conflict(`Não é possível passar de "${claimStatusLabels[current.status]}" para "${claimStatusLabels[body.status]}".`);
  }
  const detail = `${claimStatusLabels[current.status]} → ${claimStatusLabels[body.status]}${body.note ? `: ${body.note}` : ''}`;
  return applyChange(ctx, actor, current, body.version, { set: { status: body.status }, action: 'status', detail });
}

/** Cobra a franquia do motorista como conta a receber (uma por sinistro; repetir devolve a mesma). */
export async function chargeClaimDriver(
  ctx: AppContext,
  actor: Actor,
  id: ObjectId,
  body: ClaimCharge,
): Promise<{ claim: ClaimDoc; alreadyCharged: boolean }> {
  const current = await loadClaim(ctx, actor.organizationId, id);
  if (current.receivableId) return { claim: current, alreadyCharged: true };
  if (current.status === 'CANCELED') throw conflict('Sinistro cancelado.');
  if (!current.driverId) throw conflict('Este sinistro não tem motorista. Vincule a locação antes de cobrar.');
  if (current.fault === 'THIRD_PARTY') throw conflict('A culpa foi registrada como de terceiro. Altere a culpa antes de cobrar o motorista.');
  const amountCents = body.amountCents ?? current.deductibleCents;
  if (!amountCents || amountCents <= 0) throw unprocessable('Informe o valor da franquia a cobrar.');
  const today = businessDate();
  const dueDate = body.dueDate ?? addDaysIso(today, 7);
  if (dueDate < today) throw unprocessable('O vencimento da cobrança não pode estar no passado.');

  const claim = await withTransaction(ctx, async (session) => {
    const now = new Date();
    const description = `Franquia do sinistro ${current.claimNumber}`;
    const receivable: ReceivableDoc = {
      _id: new ObjectId(),
      organizationId: actor.organizationId,
      description,
      descriptionFold: foldAccents(description).toLowerCase(),
      rentalId: current.rentalId,
      driverId: current.driverId!,
      grossAmountCents: amountCents,
      paidAmountCents: 0,
      dueDate,
      paymentMethod: null,
      kind: 'DAMAGE',
      installmentNo: null,
      expectedPeriod: `CLAIM:${current._id.toHexString()}`,
      claimId: current._id,
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
      body.version,
      { set: { receivableId: receivable._id }, action: 'charged', detail: `Franquia de ${formatCentsBRL(amountCents)} com vencimento em ${formatIsoDateBR(dueDate)}` },
      session,
    );
  });
  return { claim, alreadyCharged: false };
}

export async function toClaimDTOs(ctx: AppContext, organizationId: ObjectId, docs: ClaimDoc[]): Promise<Claim[]> {
  const [vehicles, drivers, rentals, receivables, files] = await Promise.all([
    ctx.mongo.collections.vehicles.find({ organizationId, _id: { $in: docs.map((d) => d.vehicleId) } }).toArray(),
    ctx.mongo.collections.drivers.find({ organizationId, _id: { $in: docs.flatMap((d) => (d.driverId ? [d.driverId] : [])) } }).toArray(),
    ctx.mongo.collections.rentals.find({ organizationId, _id: { $in: docs.flatMap((d) => (d.rentalId ? [d.rentalId] : [])) } }).toArray(),
    ctx.mongo.collections.receivables.find({ organizationId, _id: { $in: docs.flatMap((d) => (d.receivableId ? [d.receivableId] : [])) } }).toArray(),
    describeFiles(ctx, organizationId, docs.flatMap((d) => d.fileIds)),
  ]);
  const byId = <T extends { _id: ObjectId }>(list: T[]) => new Map(list.map((x) => [x._id.toHexString(), x]));
  const vMap = byId(vehicles);
  const dMap = byId(drivers);
  const rMap = byId(rentals);
  const recMap = byId(receivables);
  return docs.map((c) => {
    const v = vMap.get(c.vehicleId.toHexString());
    const d = c.driverId ? dMap.get(c.driverId.toHexString()) : undefined;
    const r = c.rentalId ? rMap.get(c.rentalId.toHexString()) : undefined;
    const rec = c.receivableId ? recMap.get(c.receivableId.toHexString()) : undefined;
    return {
      id: c._id.toHexString(),
      claimNumber: c.claimNumber,
      status: c.status,
      kind: c.kind,
      fault: c.fault,
      occurredOn: c.occurredOn,
      location: c.location,
      description: c.description,
      policeReportNumber: c.policeReportNumber,
      insurerClaimNumber: c.insurerClaimNumber,
      deductibleCents: c.deductibleCents,
      estimatedCostCents: c.estimatedCostCents,
      finalCostCents: c.finalCostCents,
      vehicle: { id: c.vehicleId.toHexString(), plate: v?.plate ?? '—', label: v ? `${v.brand} ${v.model}` : 'Veículo' },
      driver: d ? { id: d._id.toHexString(), fullName: d.fullName } : null,
      rental: r ? { id: r._id.toHexString(), rentalNumber: r.rentalNumber } : null,
      files: c.fileIds.flatMap((fid) => {
        const f = files.get(fid.toHexString());
        return f ? [{ id: f.id.toHexString(), url: f.url, originalName: f.originalName }] : [];
      }),
      receivable: rec
        ? { id: rec._id.toHexString(), status: rec.status, grossAmountCents: rec.grossAmountCents, paidAmountCents: rec.paidAmountCents }
        : null,
      history: c.history.map((h) => ({ at: h.at.toISOString(), action: h.action, detail: h.detail })),
      version: c.version,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  });
}

/** Lembra a equipe de sinistro sem decisão há mais de `CLAIM_STALE_DAYS` (reaviso semanal). */
export async function generateClaimNotifications(ctx: AppContext, organizationId: ObjectId, today = businessDate()): Promise<number> {
  const open = await ctx.mongo.collections.claims
    .find({ organizationId, status: { $in: ['OPEN', 'IN_ANALYSIS', 'IN_REPAIR'] }, occurredOn: { $lte: addDaysIso(today, -CLAIM_STALE_DAYS) } })
    .toArray();
  let created = 0;
  for (const claim of open) {
    const days = diffDaysIso(today, claim.occurredOn);
    const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: claim.vehicleId });
    const ok = await createNotification(ctx, {
      organizationId,
      type: 'VEHICLE',
      severity: 'WARNING',
      title: 'Sinistro sem conclusão',
      message: `O sinistro ${claim.claimNumber} (${vehicle?.plate ?? 'veículo'}) está "${claimStatusLabels[claim.status]}" há ${days} dias.`,
      subjectLabel: vehicle?.plate ?? null,
      entityType: 'claim',
      entityId: claim._id,
      targetPath: `/dashboard/claims/${claim._id.toHexString()}`,
      dedupeKey: `claim-stale:${claim._id.toHexString()}:${weekKey(today)}`,
    });
    if (ok) created += 1;
  }
  return created;
}
