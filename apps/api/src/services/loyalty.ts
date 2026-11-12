import { ObjectId } from 'mongodb';
import {
  addDaysIso,
  businessDate,
  defaultLoyaltySettings,
  diffDaysIso,
  levelForScore,
  scoreLoyalty,
  type DriverRankingRow,
  type LoyaltyFacts,
  type LoyaltySettings,
  type LoyaltyStatus,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { portalInvoices } from './driver-portal.js';
import { createNotification } from './notifications.js';

/* ------------------------------------------------------------------ *
 * Fidelidade do motorista (estilo Zarp Acelera): pontos por tempo de
 * contrato, pagamentos em dia, vistorias no prazo e direção sem multas.
 * Recalculada todo dia pelo job; o nível aparece na Área do Motorista.
 * ------------------------------------------------------------------ */

export function loyaltySettingsOf(settings: { loyalty?: LoyaltySettings } | undefined): LoyaltySettings {
  return settings?.loyalty ?? defaultLoyaltySettings;
}

export async function loyaltyFacts(ctx: AppContext, organizationId: ObjectId, driverId: ObjectId, today = businessDate()): Promise<LoyaltyFacts> {
  const c = ctx.mongo.collections;
  const first = await c.rentals.findOne({ organizationId, driverId, status: { $ne: 'CANCELED' } }, { sort: { startDate: 1 } });
  const tenureDays = first ? Math.max(0, diffDaysIso(today, first.startDate)) : 0;

  const { invoices } = await portalInvoices(ctx, { organizationId, driverId, sessionId: new ObjectId() }, today);
  const overdueInvoices = invoices.filter((i) => i.status === 'OVERDUE').length;
  const paidOnTimeInvoices = invoices.filter((i) => i.status === 'PAID' && i.kind === 'RENT').length;

  const since90 = addDaysIso(today, -90);
  const inspections = await c.inspections.find({ organizationId, driverId, dueDate: { $gte: since90 } }).toArray();
  let inspectionsOnTime = 0;
  let inspectionsLate = 0;
  for (const i of inspections) {
    if (i.status === 'CANCELED') continue;
    if (i.submittedAt) {
      if (businessDate(i.submittedAt) <= i.dueDate) inspectionsOnTime += 1;
      else inspectionsLate += 1;
    } else if (i.dueDate < today) inspectionsLate += 1;
  }

  const recentFines = await c.trafficFines.countDocuments({
    organizationId,
    'match.driverId': driverId,
    occurredOn: { $gte: addDaysIso(today, -180) },
    status: { $nin: ['CANCELED', 'COMPANY_LIABLE', 'RECEIVED'] },
  });
  const recentClaims = await c.claims.countDocuments({
    organizationId,
    driverId,
    fault: 'DRIVER',
    status: { $ne: 'CANCELED' },
    occurredOn: { $gte: addDaysIso(today, -365) },
  });
  return { tenureDays, overdueInvoices, paidOnTimeInvoices, inspectionsOnTime, inspectionsLate, recentFines, recentClaims };
}

export async function loyaltyStatus(ctx: AppContext, organizationId: ObjectId, driverId: ObjectId, today = businessDate()): Promise<LoyaltyStatus> {
  const org = await ctx.mongo.collections.organizations.findOne({ _id: organizationId });
  const settings = loyaltySettingsOf(org?.settings);
  const facts = await loyaltyFacts(ctx, organizationId, driverId, today);
  const { score, criteria } = scoreLoyalty(facts);
  const { level, next } = levelForScore(settings, score);
  return {
    enabled: settings.enabled,
    score,
    level,
    nextLevel: next,
    pointsToNext: next ? next.minScore - score : null,
    criteria,
    computedAt: new Date().toISOString(),
  };
}

/** Ranking dos motoristas com locação ativa, do menor para o maior ponto (quem precisa de atenção primeiro). */
export async function driverRanking(ctx: AppContext, organizationId: ObjectId): Promise<DriverRankingRow[]> {
  const org = await ctx.mongo.collections.organizations.findOne({ _id: organizationId });
  const settings = loyaltySettingsOf(org?.settings);
  const rentals = await ctx.mongo.collections.rentals.find({ organizationId, status: 'ACTIVE' }).toArray();
  const drivers = await ctx.mongo.collections.drivers.find({ organizationId, _id: { $in: rentals.map((r) => r.driverId) }, anonymizedAt: { $in: [null, undefined] } }).toArray();
  const vehicles = await ctx.mongo.collections.vehicles.find({ organizationId, _id: { $in: rentals.map((r) => r.vehicleId) } }).toArray();
  const plateByVehicle = new Map(vehicles.map((v) => [v._id.toHexString(), v.plate]));
  const sorted = [...settings.levels].sort((a, b) => a.minScore - b.minScore);
  const attentionBelow = sorted[1]?.minScore ?? 0;
  return drivers
    .map((d) => {
      const rental = rentals.find((r) => r.driverId.equals(d._id));
      const score = d.loyalty?.score ?? 0;
      const level = levelForScore(settings, score).level;
      return {
        driverId: d._id.toHexString(),
        fullName: d.fullName,
        plate: rental ? (plateByVehicle.get(rental.vehicleId.toHexString()) ?? null) : null,
        score,
        levelCode: level.code,
        levelName: level.name,
        attention: score < attentionBelow,
        computedAt: d.loyalty?.computedAt ? d.loyalty.computedAt.toISOString() : null,
      };
    })
    .sort((a, b) => a.score - b.score || a.fullName.localeCompare(b.fullName));
}

/** Job diário: recalcula e grava o nível de quem tem locação ativa; avisa a equipe quando alguém sobe de nível. */
export async function recomputeLoyalty(ctx: AppContext, organizationId: ObjectId, today = businessDate()): Promise<number> {
  const org = await ctx.mongo.collections.organizations.findOne({ _id: organizationId });
  const settings = loyaltySettingsOf(org?.settings);
  if (!settings.enabled) return 0;
  const driverIds = (await ctx.mongo.collections.rentals.distinct('driverId', { organizationId, status: 'ACTIVE' })) as ObjectId[];
  let updated = 0;
  for (const driverId of driverIds) {
    const driver = await ctx.mongo.collections.drivers.findOne({ _id: driverId, organizationId });
    if (!driver || driver.anonymizedAt) continue;
    const status = await loyaltyStatus(ctx, organizationId, driverId, today);
    const previous = driver.loyalty?.levelCode ?? null;
    await ctx.mongo.collections.drivers.updateOne(
      { _id: driverId },
      { $set: { loyalty: { score: status.score, levelCode: status.level.code, computedAt: new Date() } } },
    );
    updated += 1;
    const prevIdx = settings.levels.findIndex((l) => l.code === previous);
    const newIdx = settings.levels.findIndex((l) => l.code === status.level.code);
    if (previous && newIdx > prevIdx) {
      await createNotification(ctx, {
        organizationId,
        type: 'RENTAL',
        severity: 'INFO',
        title: 'Motorista subiu de nível',
        message: `${driver.fullName} chegou ao nível ${status.level.name} (${status.score} pontos).`,
        subjectLabel: driver.fullName,
        entityType: 'driver',
        entityId: driverId,
        targetPath: `/dashboard/drivers/${driverId.toHexString()}`,
        dedupeKey: `loyalty-up:${driverId.toHexString()}:${status.level.code}`,
      });
    }
  }
  return updated;
}
