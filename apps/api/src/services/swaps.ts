import { ObjectId } from 'mongodb';
import {
  businessDate,
  type AvailabilityRow,
  type SwapCreate,
  type SwapEnd,
  type VehicleSwap,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { withTransaction } from '../database/mongo.js';
import type { VehicleSwapDoc } from '../database/types.js';
import { audit } from './common.js';

/* ------------------------------------------------------------------ *
 * Carro reserva: troca temporária do veículo de uma locação.
 * A locação continua no veículo original (contrato, cobrança e km não
 * mudam); o reserva fica "locado" enquanto a troca estiver ativa.
 * ------------------------------------------------------------------ */

interface Actor {
  organizationId: ObjectId;
  userId: ObjectId | null;
}

export async function createSwap(ctx: AppContext, actor: Actor, rentalId: ObjectId, body: SwapCreate): Promise<VehicleSwapDoc> {
  const c = ctx.mongo.collections;
  const today = businessDate();
  const startedOn = body.startedOn ?? today;
  if (startedOn > today) throw unprocessable('A data da troca não pode estar no futuro.');

  const rental = await c.rentals.findOne({ _id: rentalId, organizationId: actor.organizationId });
  if (!rental) throw notFound('Locação não encontrada.');
  if (rental.status !== 'ACTIVE') throw conflict('Só uma locação ativa pode ter carro reserva.');
  const replacementId = new ObjectId(body.replacementVehicleId);
  if (replacementId.equals(rental.vehicleId)) throw unprocessable('O carro reserva precisa ser diferente do veículo da locação.');
  const [original, replacement] = await Promise.all([
    c.vehicles.findOne({ _id: rental.vehicleId, organizationId: actor.organizationId }),
    c.vehicles.findOne({ _id: replacementId, organizationId: actor.organizationId }),
  ]);
  if (!original) throw notFound('Veículo da locação não encontrado.');
  if (!replacement || replacement.archivedAt) throw notFound('Carro reserva não encontrado.');
  if (replacement.status !== 'AVAILABLE') throw conflict('O carro reserva precisa estar disponível.');
  if (body.claimId) {
    const claim = await c.claims.findOne({ _id: new ObjectId(body.claimId), organizationId: actor.organizationId });
    if (!claim) throw notFound('Sinistro não encontrado.');
  }

  const now = new Date();
  const swap: VehicleSwapDoc = {
    _id: new ObjectId(),
    organizationId: actor.organizationId,
    rentalId: rental._id,
    driverId: rental.driverId,
    originalVehicleId: original._id,
    replacementVehicleId: replacement._id,
    status: 'ACTIVE',
    reason: body.reason,
    claimId: body.claimId ? new ObjectId(body.claimId) : null,
    startedOn,
    endedOn: null,
    originalStatusBefore: original.status,
    notes: body.notes ?? null,
    createdBy: actor.userId,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  try {
    await withTransaction(ctx, async (session) => {
      const taken = await c.vehicles.updateOne(
        { _id: replacement._id, organizationId: actor.organizationId, status: 'AVAILABLE' },
        { $set: { status: 'RENTED', updatedAt: now } },
        { session },
      );
      if (taken.modifiedCount !== 1) throw conflict('O carro reserva acabou de ser ocupado. Escolha outro.');
      try {
        await c.vehicleSwaps.insertOne(swap, { session });
      } catch (err) {
        // Sem transação, desfaz a reserva do veículo antes de recusar.
        if (!session) await c.vehicles.updateOne({ _id: replacement._id }, { $set: { status: 'AVAILABLE', updatedAt: new Date() } });
        throw err;
      }
      // Em manutenção/sinistro o original sai de circulação; nos demais motivos fica livre.
      await c.vehicles.updateOne(
        { _id: original._id, organizationId: actor.organizationId },
        { $set: { status: body.reason === 'OTHER' ? 'AVAILABLE' : 'MAINTENANCE', updatedAt: now } },
        { session },
      );
      await audit(
        ctx,
        { organizationId: actor.organizationId, actorId: actor.userId, action: 'swap.created', entityType: 'vehicleSwap', entityId: swap._id, after: { rentalId: rental._id, original: original.plate, replacement: replacement.plate, reason: body.reason } },
        session,
      );
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('Esta locação já tem um carro reserva, ou o veículo já é reserva de outra locação.');
    throw err;
  }
  return swap;
}

export async function endSwap(ctx: AppContext, actor: Actor, id: ObjectId, body: SwapEnd): Promise<VehicleSwapDoc> {
  const c = ctx.mongo.collections;
  const swap = await c.vehicleSwaps.findOne({ _id: id, organizationId: actor.organizationId });
  if (!swap) throw notFound('Troca não encontrada.');
  if (swap.status !== 'ACTIVE') throw conflict('Esta troca já foi encerrada.');
  const today = businessDate();
  const endedOn = body.endedOn ?? today;
  if (endedOn > today) throw unprocessable('A data de devolução não pode estar no futuro.');
  if (endedOn < swap.startedOn) throw unprocessable('A devolução não pode ser antes do início da troca.');
  const rental = await c.rentals.findOne({ _id: swap.rentalId, organizationId: actor.organizationId });

  const now = new Date();
  return withTransaction(ctx, async (session) => {
    const next = await c.vehicleSwaps.findOneAndUpdate(
      { _id: swap._id, status: 'ACTIVE', version: swap.version },
      { $set: { status: 'ENDED', endedOn, notes: body.notes ?? swap.notes, updatedAt: now }, $inc: { version: 1 } },
      { returnDocument: 'after', session },
    );
    if (!next) throw conflict('A troca foi alterada por outro usuário. Recarregue e tente novamente.');
    await c.vehicles.updateOne({ _id: swap.replacementVehicleId, organizationId: actor.organizationId }, { $set: { status: 'AVAILABLE', updatedAt: now } }, { session });
    if (body.originalReturned) {
      await c.vehicles.updateOne(
        { _id: swap.originalVehicleId, organizationId: actor.organizationId },
        { $set: { status: rental?.status === 'ACTIVE' ? 'RENTED' : 'AVAILABLE', updatedAt: now } },
        { session },
      );
    }
    await audit(
      ctx,
      { organizationId: actor.organizationId, actorId: actor.userId, action: 'swap.ended', entityType: 'vehicleSwap', entityId: swap._id, after: { endedOn, originalReturned: body.originalReturned } },
      session,
    );
    return next;
  });
}

export async function toSwapDTOs(ctx: AppContext, organizationId: ObjectId, docs: VehicleSwapDoc[]): Promise<VehicleSwap[]> {
  const c = ctx.mongo.collections;
  const vehicleIds = docs.flatMap((d) => [d.originalVehicleId, d.replacementVehicleId]);
  const [vehicles, rentals, drivers] = await Promise.all([
    c.vehicles.find({ organizationId, _id: { $in: vehicleIds } }).toArray(),
    c.rentals.find({ organizationId, _id: { $in: docs.map((d) => d.rentalId) } }).toArray(),
    c.drivers.find({ organizationId, _id: { $in: docs.flatMap((d) => (d.driverId ? [d.driverId] : [])) } }).toArray(),
  ]);
  const vMap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));
  const rMap = new Map(rentals.map((r) => [r._id.toHexString(), r]));
  const dMap = new Map(drivers.map((d) => [d._id.toHexString(), d]));
  const veh = (id: ObjectId) => {
    const v = vMap.get(id.toHexString());
    return { id: id.toHexString(), plate: v?.plate ?? '—', label: v ? `${v.brand} ${v.model}` : 'Veículo' };
  };
  return docs.map((d) => ({
    id: d._id.toHexString(),
    status: d.status,
    reason: d.reason,
    rental: { id: d.rentalId.toHexString(), rentalNumber: rMap.get(d.rentalId.toHexString())?.rentalNumber ?? '—' },
    driver: d.driverId && dMap.get(d.driverId.toHexString()) ? { id: d.driverId.toHexString(), fullName: dMap.get(d.driverId.toHexString())!.fullName } : null,
    original: veh(d.originalVehicleId),
    replacement: veh(d.replacementVehicleId),
    claimId: d.claimId?.toHexString() ?? null,
    startedOn: d.startedOn,
    endedOn: d.endedOn,
    notes: d.notes,
    createdAt: d.createdAt.toISOString(),
  }));
}

/** Quadro de disponibilidade: situação, quem usa, até quando e se serve de reserva agora. */
export async function listAvailability(ctx: AppContext, organizationId: ObjectId): Promise<AvailabilityRow[]> {
  const c = ctx.mongo.collections;
  const [vehicles, rentals, swaps, orders, claims] = await Promise.all([
    c.vehicles.find({ organizationId, archivedAt: null }).sort({ plate: 1 }).toArray(),
    c.rentals.find({ organizationId, status: 'ACTIVE' }).toArray(),
    c.vehicleSwaps.find({ organizationId, status: 'ACTIVE' }).toArray(),
    c.maintenanceOrders.find({ organizationId, status: 'OPEN' }, { projection: { vehicleId: 1 } }).toArray(),
    c.claims.find({ organizationId, status: { $in: ['OPEN', 'IN_ANALYSIS', 'IN_REPAIR'] } }, { projection: { vehicleId: 1 } }).toArray(),
  ]);
  const drivers = await c.drivers.find({ organizationId, _id: { $in: rentals.map((r) => r.driverId) } }, { projection: { fullName: 1 } }).toArray();
  const dName = new Map(drivers.map((d) => [d._id.toHexString(), d.fullName]));
  const plateOf = new Map(vehicles.map((v) => [v._id.toHexString(), v.plate]));
  const rentalByVehicle = new Map(rentals.map((r) => [r.vehicleId.toHexString(), r]));
  const rentalById = new Map(rentals.map((r) => [r._id.toHexString(), r]));
  const swapByReplacement = new Map(swaps.map((s) => [s.replacementVehicleId.toHexString(), s]));
  const swapByOriginal = new Map(swaps.map((s) => [s.originalVehicleId.toHexString(), s]));
  const count = (list: Array<{ vehicleId: ObjectId }>) => {
    const m = new Map<string, number>();
    for (const x of list) m.set(x.vehicleId.toHexString(), (m.get(x.vehicleId.toHexString()) ?? 0) + 1);
    return m;
  };
  const openOrders = count(orders);
  const openClaims = count(claims);

  return vehicles.map((v) => {
    const id = v._id.toHexString();
    const asReplacement = swapByReplacement.get(id);
    const replacedSwap = swapByOriginal.get(id);
    const rental = asReplacement ? rentalById.get(asReplacement.rentalId.toHexString()) : rentalByVehicle.get(id);
    const maintenance = openOrders.get(id) ?? 0;
    const claim = openClaims.get(id) ?? 0;
    return {
      vehicleId: id,
      plate: v.plate,
      label: `${v.brand} ${v.model}`,
      status: v.status,
      driverName: rental ? (dName.get(rental.driverId.toHexString()) ?? null) : null,
      rentalNumber: rental?.rentalNumber ?? null,
      rentalEndsOn: rental?.endDate ?? null,
      asReplacementFor: asReplacement ? (plateOf.get(asReplacement.originalVehicleId.toHexString()) ?? null) : null,
      replacedBy: replacedSwap ? (plateOf.get(replacedSwap.replacementVehicleId.toHexString()) ?? null) : null,
      openMaintenance: maintenance,
      openClaims: claim,
      usableAsReplacement: v.status === 'AVAILABLE' && maintenance === 0 && claim === 0 && !asReplacement,
    };
  });
}
