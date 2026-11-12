import { ObjectId } from 'mongodb';
import {
  addDaysIso,
  businessDate,
  type FuelLog,
  type FuelLogCreate,
  type FuelSummary,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { notFound, unprocessable } from '../common/errors.js';
import type { FuelLogDoc, VehicleDoc } from '../database/types.js';
import { audit } from './common.js';
import { rentalOnDate } from './claims.js';

/* ------------------------------------------------------------------ *
 * Abastecimento: registro, consumo (km/l) e custo por km.
 * ------------------------------------------------------------------ */

interface Actor {
  organizationId: ObjectId;
  userId: ObjectId | null;
}

export interface FuelStats {
  fills: number;
  liters: number;
  totalCents: number;
  distanceKm: number | null;
  kmPerLiter: number | null;
  costPerKmCents: number | null;
}

/**
 * Método do tanque cheio: do 1º abastecimento com tanque cheio ao último, os litros e o
 * dinheiro gastos DEPOIS do primeiro (inclusive o último) cobrem a distância percorrida.
 * Com menos de dois abastecimentos com tanque cheio não dá para calcular.
 */
export function fuelStats(logs: Array<Pick<FuelLogDoc, 'date' | 'liters' | 'totalCents' | 'odometerKm' | 'fullTank'>>): FuelStats {
  const sorted = [...logs].sort((a, b) => a.odometerKm - b.odometerKm || a.date.localeCompare(b.date));
  const base = {
    fills: sorted.length,
    liters: round3(sorted.reduce((s, l) => s + l.liters, 0)),
    totalCents: sorted.reduce((s, l) => s + l.totalCents, 0),
  };
  const fulls = sorted.filter((l) => l.fullTank);
  const first = fulls[0];
  const last = fulls[fulls.length - 1];
  if (!first || !last || first === last) return { ...base, distanceKm: null, kmPerLiter: null, costPerKmCents: null };
  const distanceKm = last.odometerKm - first.odometerKm;
  const window = sorted.slice(sorted.indexOf(first) + 1, sorted.indexOf(last) + 1);
  const liters = window.reduce((s, l) => s + l.liters, 0);
  const cents = window.reduce((s, l) => s + l.totalCents, 0);
  if (distanceKm <= 0 || liters <= 0) return { ...base, distanceKm: distanceKm > 0 ? distanceKm : null, kmPerLiter: null, costPerKmCents: null };
  return { ...base, distanceKm, kmPerLiter: Math.round((distanceKm / liters) * 100) / 100, costPerKmCents: Math.round((cents / distanceKm) * 100) / 100 };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export async function createFuelLog(ctx: AppContext, actor: Actor, body: FuelLogCreate): Promise<FuelLogDoc> {
  const today = businessDate();
  if (body.date > today) throw unprocessable('A data do abastecimento não pode estar no futuro.');
  const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: new ObjectId(body.vehicleId), organizationId: actor.organizationId });
  if (!vehicle) throw notFound('Veículo não encontrado.');

  // O hodômetro só cresce com o tempo: confere o abastecimento anterior e o seguinte do veículo.
  const logs = ctx.mongo.collections.fuelLogs;
  const before = await logs.findOne({ organizationId: actor.organizationId, vehicleId: vehicle._id, date: { $lte: body.date } }, { sort: { date: -1, odometerKm: -1 } });
  if (before && body.odometerKm < before.odometerKm) {
    throw unprocessable(`O hodômetro (${body.odometerKm} km) é menor que o do abastecimento de ${before.date} (${before.odometerKm} km).`);
  }
  const after = await logs.findOne({ organizationId: actor.organizationId, vehicleId: vehicle._id, date: { $gt: body.date } }, { sort: { date: 1, odometerKm: 1 } });
  if (after && body.odometerKm > after.odometerKm) {
    throw unprocessable(`O hodômetro (${body.odometerKm} km) é maior que o do abastecimento seguinte, de ${after.date} (${after.odometerKm} km).`);
  }

  const rental = await rentalOnDate(ctx, actor.organizationId, vehicle._id, body.date);
  const now = new Date();
  const doc: FuelLogDoc = {
    _id: new ObjectId(),
    organizationId: actor.organizationId,
    vehicleId: vehicle._id,
    driverId: rental?.driverId ?? null,
    rentalId: rental?._id ?? null,
    date: body.date,
    fuelType: body.fuelType,
    liters: body.liters,
    totalCents: body.totalCents,
    odometerKm: body.odometerKm,
    fullTank: body.fullTank,
    station: body.station ?? null,
    notes: body.notes ?? null,
    createdBy: actor.userId,
    createdAt: now,
    updatedAt: now,
  };
  await logs.insertOne(doc);
  if (body.odometerKm > vehicle.mileageKm) {
    await ctx.mongo.collections.vehicles.updateOne({ _id: vehicle._id }, { $set: { mileageKm: body.odometerKm, updatedAt: now } });
  }
  await audit(ctx, { organizationId: actor.organizationId, actorId: actor.userId, action: 'fuel.created', entityType: 'fuelLog', entityId: doc._id, after: { vehicleId: vehicle._id, liters: doc.liters, totalCents: doc.totalCents } });
  return doc;
}

export async function deleteFuelLog(ctx: AppContext, actor: Actor, id: ObjectId): Promise<void> {
  const res = await ctx.mongo.collections.fuelLogs.findOneAndDelete({ _id: id, organizationId: actor.organizationId });
  if (!res) throw notFound('Abastecimento não encontrado.');
  await audit(ctx, { organizationId: actor.organizationId, actorId: actor.userId, action: 'fuel.deleted', entityType: 'fuelLog', entityId: id, before: { vehicleId: res.vehicleId, totalCents: res.totalCents } });
}

export async function toFuelLogDTOs(ctx: AppContext, organizationId: ObjectId, docs: FuelLogDoc[]): Promise<FuelLog[]> {
  const [vehicles, drivers] = await Promise.all([
    ctx.mongo.collections.vehicles.find({ organizationId, _id: { $in: docs.map((d) => d.vehicleId) } }).toArray(),
    ctx.mongo.collections.drivers.find({ organizationId, _id: { $in: docs.flatMap((d) => (d.driverId ? [d.driverId] : [])) } }).toArray(),
  ]);
  const vMap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));
  const dMap = new Map(drivers.map((d) => [d._id.toHexString(), d]));
  return docs.map((d) => {
    const v = vMap.get(d.vehicleId.toHexString());
    const driver = d.driverId ? dMap.get(d.driverId.toHexString()) : undefined;
    return {
      id: d._id.toHexString(),
      vehicle: { id: d.vehicleId.toHexString(), plate: v?.plate ?? '—', label: v ? `${v.brand} ${v.model}` : 'Veículo' },
      driver: driver ? { id: driver._id.toHexString(), fullName: driver.fullName } : null,
      date: d.date,
      fuelType: d.fuelType,
      liters: d.liters,
      totalCents: d.totalCents,
      pricePerLiterCents: Math.round(d.totalCents / d.liters),
      odometerKm: d.odometerKm,
      fullTank: d.fullTank,
      station: d.station,
      notes: d.notes,
      createdAt: d.createdAt.toISOString(),
    };
  });
}

/** Resumo por veículo no período (só veículos com abastecimento). */
export async function fuelSummaries(ctx: AppContext, organizationId: ObjectId, days: number, today = businessDate()): Promise<FuelSummary[]> {
  const logs = await ctx.mongo.collections.fuelLogs.find({ organizationId, date: { $gte: addDaysIso(today, -days) } }).toArray();
  const byVehicle = new Map<string, FuelLogDoc[]>();
  for (const l of logs) byVehicle.set(l.vehicleId.toHexString(), [...(byVehicle.get(l.vehicleId.toHexString()) ?? []), l]);
  const vehicles: VehicleDoc[] = await ctx.mongo.collections.vehicles.find({ organizationId, _id: { $in: [...byVehicle.keys()].map((id) => new ObjectId(id)) } }).toArray();
  return vehicles
    .map((v) => ({ vehicleId: v._id.toHexString(), plate: v.plate, label: `${v.brand} ${v.model}`, ...fuelStats(byVehicle.get(v._id.toHexString())!) }))
    .sort((a, b) => b.totalCents - a.totalCents);
}
