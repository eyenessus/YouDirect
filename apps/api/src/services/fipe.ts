import type { ObjectId } from 'mongodb';
import type { FipeLink, FipeReportRow, VehicleFipe } from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { conflict, integrationUnavailable, notFound } from '../common/errors.js';
import { FipeError, type FipeItem } from '../integrations/fipe.js';
import type { VehicleDoc } from '../database/types.js';
import { audit } from './common.js';

/* ------------------------------------------------------------------ *
 * Valor de mercado dos veículos (FIPE): vínculo, atualização mensal e
 * relatório de desvalorização e rendimento do aluguel.
 * ------------------------------------------------------------------ */

interface Actor {
  organizationId: ObjectId;
  userId: ObjectId | null;
}

const HISTORY_LIMIT = 24;
/** O job só reconsulta um veículo depois de 25 dias, e poucos por rodada (limite da API pública). */
const REFRESH_AFTER_MS = 25 * 24 * 3600 * 1000;
const REFRESH_PER_RUN = 15;

/** Converte falha do provedor em erro de API com mensagem clara. */
export function fipeFailure(err: unknown): never {
  if (err instanceof FipeError) {
    if (err.status === 404) throw notFound(err.message);
    throw integrationUnavailable(err.message);
  }
  throw err;
}

/* Listas da FIPE mudam uma vez por mês: cache de 24 h poupa o limite diário da API. */
const CACHE_MS = 24 * 3600 * 1000;
const cache = new Map<string, { at: number; value: FipeItem[] }>();
export async function cachedList(key: string, load: () => Promise<FipeItem[]>): Promise<FipeItem[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  try {
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    return fipeFailure(err);
  }
}
export const clearFipeCache = () => cache.clear();

async function quote(ctx: AppContext, link: FipeLink, previous: VehicleDoc['fipe']): Promise<NonNullable<VehicleDoc['fipe']>> {
  let price;
  try {
    price = await ctx.integrations.fipe.price(link.brandId, link.modelId, link.yearId);
  } catch (err) {
    return fipeFailure(err);
  }
  const history = (previous?.history ?? []).filter((h) => h.referenceMonth !== price.referenceMonth);
  history.push({ referenceMonth: price.referenceMonth, priceCents: price.priceCents });
  return {
    link,
    codeFipe: price.codeFipe,
    brandName: price.brand,
    modelName: price.model,
    modelYear: price.modelYear,
    fuel: price.fuel,
    referenceMonth: price.referenceMonth,
    priceCents: price.priceCents,
    fetchedAt: new Date(),
    history: history.slice(-HISTORY_LIMIT),
  };
}

async function loadVehicle(ctx: AppContext, organizationId: ObjectId, id: ObjectId): Promise<VehicleDoc> {
  const v = await ctx.mongo.collections.vehicles.findOne({ _id: id, organizationId });
  if (!v || v.archivedAt) throw notFound('Veículo não encontrado.');
  return v;
}

export async function linkVehicleFipe(ctx: AppContext, actor: Actor, vehicleId: ObjectId, link: FipeLink): Promise<VehicleDoc> {
  const vehicle = await loadVehicle(ctx, actor.organizationId, vehicleId);
  const fipe = await quote(ctx, link, vehicle.fipe?.link.yearId === link.yearId && vehicle.fipe.link.modelId === link.modelId ? vehicle.fipe : null);
  const updated = await ctx.mongo.collections.vehicles.findOneAndUpdate(
    { _id: vehicle._id, organizationId: actor.organizationId },
    { $set: { fipe, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  await audit(ctx, { organizationId: actor.organizationId, actorId: actor.userId, action: 'vehicle.fipe', entityType: 'vehicle', entityId: vehicle._id, after: { codeFipe: fipe.codeFipe, priceCents: fipe.priceCents, referenceMonth: fipe.referenceMonth } });
  return updated!;
}

export async function refreshVehicleFipe(ctx: AppContext, actor: Actor, vehicleId: ObjectId): Promise<VehicleDoc> {
  const vehicle = await loadVehicle(ctx, actor.organizationId, vehicleId);
  if (!vehicle.fipe) throw conflict('Este veículo ainda não está vinculado à tabela FIPE.');
  return linkVehicleFipe(ctx, actor, vehicleId, vehicle.fipe.link);
}

export async function unlinkVehicleFipe(ctx: AppContext, actor: Actor, vehicleId: ObjectId): Promise<void> {
  const vehicle = await loadVehicle(ctx, actor.organizationId, vehicleId);
  await ctx.mongo.collections.vehicles.updateOne({ _id: vehicle._id }, { $set: { fipe: null, updatedAt: new Date() } });
  await audit(ctx, { organizationId: actor.organizationId, actorId: actor.userId, action: 'vehicle.fipe_unlinked', entityType: 'vehicle', entityId: vehicle._id });
}

/** Job: atualiza o valor dos veículos vinculados que não foram consultados há 25 dias. */
export async function refreshStaleFipe(ctx: AppContext, organizationId: ObjectId, now = new Date()): Promise<{ updated: number; failed: number }> {
  const out = { updated: 0, failed: 0 };
  if (!ctx.integrations.fipe.status().connected) return out;
  const stale = await ctx.mongo.collections.vehicles
    .find({ organizationId, archivedAt: null, 'fipe.fetchedAt': { $lt: new Date(now.getTime() - REFRESH_AFTER_MS) } })
    .sort({ 'fipe.fetchedAt': 1 })
    .limit(REFRESH_PER_RUN)
    .toArray();
  for (const v of stale) {
    try {
      const fipe = await quote(ctx, v.fipe!.link, v.fipe);
      await ctx.mongo.collections.vehicles.updateOne({ _id: v._id }, { $set: { fipe, updatedAt: now } });
      out.updated += 1;
    } catch {
      // Falha de um veículo (ou limite da API) não impede os demais; tenta de novo na próxima rodada.
      out.failed += 1;
    }
  }
  return out;
}

export function toVehicleFipeDTO(fipe: VehicleDoc['fipe']): VehicleFipe | null {
  if (!fipe) return null;
  return { ...fipe, fetchedAt: fipe.fetchedAt.toISOString() };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function fipeReport(ctx: AppContext, organizationId: ObjectId): Promise<FipeReportRow[]> {
  const vehicles = await ctx.mongo.collections.vehicles.find({ organizationId, archivedAt: null, fipe: { $ne: null } }).toArray();
  const rentals = await ctx.mongo.collections.rentals.find({ organizationId, status: 'ACTIVE', vehicleId: { $in: vehicles.map((v) => v._id) } }).toArray();
  const rentalByVehicle = new Map(rentals.map((r) => [r.vehicleId.toHexString(), r]));
  return vehicles
    .map((v) => {
      const fipe = v.fipe!;
      const purchase = v.purchase?.amountCents ?? null;
      const rental = rentalByVehicle.get(v._id.toHexString());
      const weekly = rental?.rentalType === 'WEEKLY' ? rental.periodicAmountCents : null;
      return {
        vehicleId: v._id.toHexString(),
        plate: v.plate,
        label: `${v.brand} ${v.model}`,
        purchaseDate: v.purchase?.date ?? null,
        purchaseAmountCents: purchase,
        fipePriceCents: fipe.priceCents,
        referenceMonth: fipe.referenceMonth,
        changeVsPurchasePercent: purchase && purchase > 0 ? round1(((fipe.priceCents - purchase) / purchase) * 100) : null,
        weeklyRentCents: weekly,
        annualYieldPercent: weekly && fipe.priceCents > 0 ? round1(((weekly * 52) / fipe.priceCents) * 100) : null,
      };
    })
    .sort((a, b) => (a.changeVsPurchasePercent ?? 0) - (b.changeVsPurchasePercent ?? 0));
}
