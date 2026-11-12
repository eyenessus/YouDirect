import type { ObjectId } from 'mongodb';
import {
  businessDate,
  computeExtraKm,
  diffDaysIso,
  formatCentsBRL,
  type RentalKmPolicy,
  type RentalKmSummary,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import type { InspectionDoc, RentalDoc } from '../database/types.js';
import { audit } from './common.js';
import { createNotification } from './notifications.js';
import { createEntry } from './rental-payments.js';

/* ------------------------------------------------------------------ *
 * KM excedente automático a partir do hodômetro das vistorias aprovadas.
 * - Base: hodômetro da entrega (política) ou a 1ª vistoria aprovada.
 * - Franquia proporcional aos dias (semanal ÷ 7 × dias desde o início).
 * - Cobra só a diferença ainda não cobrada; cada vistoria conta uma vez
 *   (lançamento com chave `km:<vistoria>` + lista de vistorias processadas).
 * ------------------------------------------------------------------ */

export type KmReadingResult =
  | { status: 'CHARGED'; km: number; amountCents: number }
  | { status: 'BASELINE' | 'NO_EXCESS' | 'NO_POLICY' | 'ALREADY_PROCESSED' | 'ODOMETER_LOWER' | 'NOT_APPLICABLE'; km: 0; amountCents: 0 };

const none = (status: Exclude<KmReadingResult['status'], 'CHARGED'>): KmReadingResult => ({ status, km: 0, amountCents: 0 });

export async function processKmReading(ctx: AppContext, inspection: InspectionDoc, actorId: ObjectId | null): Promise<KmReadingResult> {
  if (inspection.status !== 'APPROVED' || inspection.odometerKm === null || !inspection.rentalId) return none('NOT_APPLICABLE');
  const rental = await ctx.mongo.collections.rentals.findOne({ _id: inspection.rentalId, organizationId: inspection.organizationId });
  if (!rental || rental.status === 'CANCELED') return none('NOT_APPLICABLE');
  // Leitura de outro veículo (carro reserva) nunca vira cobrança de km do contrato.
  if (!inspection.vehicleId.equals(rental.vehicleId)) return none('NOT_APPLICABLE');
  const billing = rental.kmBilling ?? null;
  if (billing?.processedInspectionIds.some((i) => i.equals(inspection._id))) return none('ALREADY_PROCESSED');

  const odometer = inspection.odometerKm;
  const readingDate = businessDate(inspection.submittedAt ?? new Date());
  const policy = rental.kmPolicy ?? null;
  const baseline = policy?.startOdometerKm ?? billing?.baselineOdometerKm ?? null;
  const chargedKm = billing?.chargedKm ?? 0;

  const markProcessed = async (set: Record<string, unknown>, inc: Record<string, number> = {}) => {
    await ctx.mongo.collections.rentals.updateOne(
      { _id: rental._id, 'kmBilling.processedInspectionIds': { $ne: inspection._id } },
      {
        $set: {
          'kmBilling.lastOdometerKm': Math.max(odometer, billing?.lastOdometerKm ?? 0),
          'kmBilling.lastReadingAt': readingDate,
          ...set,
          updatedAt: new Date(),
        },
        $inc: { 'kmBilling.chargedKm': 0, 'kmBilling.chargedCents': 0, ...inc },
        $push: { 'kmBilling.processedInspectionIds': inspection._id },
      },
    );
  };

  // Primeira leitura sem hodômetro de entrega: vira a base, nada a cobrar.
  if (baseline === null) {
    await markProcessed({ 'kmBilling.baselineOdometerKm': odometer });
    return none('BASELINE');
  }
  if (billing?.lastOdometerKm !== null && billing?.lastOdometerKm !== undefined && odometer < billing.lastOdometerKm) {
    // Leitura menor que a anterior (erro de digitação/foto): não cobra nem "devolve" km.
    await markProcessed({});
    return none('ODOMETER_LOWER');
  }
  if (!policy || policy.weeklyFranchiseKm === null || policy.extraKmPriceCents <= 0) {
    await markProcessed({ 'kmBilling.baselineOdometerKm': baseline });
    return none('NO_POLICY');
  }

  const calc = computeExtraKm({
    baselineKm: baseline,
    odometerKm: odometer,
    daysSinceStart: diffDaysIso(readingDate, rental.startDate),
    weeklyFranchiseKm: policy.weeklyFranchiseKm,
    alreadyChargedKm: chargedKm,
  });
  if (calc.toChargeKm <= 0 || rental.status !== 'ACTIVE') {
    await markProcessed({ 'kmBilling.baselineOdometerKm': baseline });
    return none('NO_EXCESS');
  }

  const amountCents = calc.toChargeKm * policy.extraKmPriceCents;
  await createEntry(ctx, {
    organizationId: rental.organizationId,
    actorId,
    rentalId: rental._id,
    category: 'EXTRA_KM',
    amountCents,
    expectedDate: businessDate(),
    alreadyPaid: false,
    notes: `${calc.toChargeKm} km além da franquia (hodômetro ${odometer.toLocaleString('pt-BR')} km; rodados ${calc.drivenKm} km, franquia ${calc.allowedKm} km)`,
    idempotencyKey: `km:${inspection._id.toHexString()}`,
  });
  await markProcessed({ 'kmBilling.baselineOdometerKm': baseline }, { 'kmBilling.chargedKm': calc.toChargeKm, 'kmBilling.chargedCents': amountCents });

  const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: rental.vehicleId }, { projection: { plate: 1 } });
  await createNotification(ctx, {
    organizationId: rental.organizationId,
    type: 'RENTAL',
    severity: 'INFO',
    title: 'KM excedente lançado',
    message: `${rental.rentalNumber}${vehicle ? ` (${vehicle.plate})` : ''}: ${calc.toChargeKm} km além da franquia = ${formatCentsBRL(amountCents)}.`,
    subjectLabel: rental.rentalNumber,
    entityType: 'rental',
    entityId: rental._id,
    targetPath: `/dashboard/rentals/${rental._id.toHexString()}?tab=payments`,
    dedupeKey: `extra-km:${inspection._id.toHexString()}`,
  });
  await audit(ctx, {
    organizationId: rental.organizationId,
    actorId,
    action: 'rental.extraKm',
    entityType: 'rental',
    entityId: rental._id,
    after: { inspectionId: inspection._id, km: calc.toChargeKm, amountCents, odometer },
  });
  return { status: 'CHARGED', km: calc.toChargeKm, amountCents };
}

export function kmSummary(rental: RentalDoc, today = businessDate()): RentalKmSummary {
  const policy: RentalKmPolicy | null = rental.kmPolicy ?? null;
  const b = rental.kmBilling ?? null;
  const baseline = policy?.startOdometerKm ?? b?.baselineOdometerKm ?? null;
  const last = b?.lastOdometerKm ?? null;
  const reference = b?.lastReadingAt ?? today;
  const allowed =
    policy?.weeklyFranchiseKm != null
      ? Math.round((policy.weeklyFranchiseKm * Math.max(1, diffDaysIso(reference, rental.startDate))) / 7)
      : null;
  return {
    policy,
    baselineOdometerKm: baseline,
    lastOdometerKm: last,
    drivenKm: baseline !== null && last !== null ? Math.max(0, last - baseline) : 0,
    allowedKm: allowed,
    chargedKm: b?.chargedKm ?? 0,
    chargedCents: b?.chargedCents ?? 0,
    lastReadingAt: b?.lastReadingAt ?? null,
  };
}
