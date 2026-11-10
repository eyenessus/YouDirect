import type { ObjectId } from 'mongodb';
import { businessDate, type FineMatchConfidence } from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import type { IsoDate, RentalDoc } from '../database/types.js';

/* ------------------------------------------------------------------ *
 * Quem estava com o carro na hora da infração?
 *
 * As locações guardam só datas (sem hora). Por isso o dia da infração é
 * calculado no fuso de negócio (nunca `toISOString().slice(0,10)`, o bug
 * B-07) e os dias de entrega/devolução pedem confirmação: no mesmo dia o
 * carro pode ter passado por dois motoristas.
 * ------------------------------------------------------------------ */

export type MatchableRental = Pick<RentalDoc, '_id' | 'driverId' | 'startDate' | 'endDate' | 'status'>;

export interface FineMatchResult {
  confidence: Exclude<FineMatchConfidence, 'MANUAL'>;
  rental: MatchableRental | null;
  candidates: MatchableRental[];
}

/** A locação cobre o dia? ACTIVE vale mesmo depois do fim previsto (o carro ainda está com o motorista). */
function covers(rental: MatchableRental, day: IsoDate): boolean {
  if (rental.status === 'CANCELED') return false;
  if (rental.startDate > day) return false;
  if (rental.status === 'ACTIVE') return true;
  return rental.endDate !== null && rental.endDate >= day;
}

export function matchRental(rentals: MatchableRental[], occurredAt: Date): FineMatchResult {
  const day = businessDate(occurredAt);
  const candidates = rentals.filter((r) => covers(r, day)).sort((a, b) => (a.startDate < b.startDate ? -1 : 1));

  if (candidates.length === 0) return { confidence: 'NONE', rental: null, candidates: [] };
  if (candidates.length > 1) return { confidence: 'AMBIGUOUS', rental: null, candidates };

  const rental = candidates[0]!;
  const handoverDay = rental.startDate === day || rental.endDate === day;
  const pastPlannedEnd = rental.status === 'ACTIVE' && rental.endDate !== null && rental.endDate < day;
  return {
    confidence: handoverDay || pastPlannedEnd ? 'MEDIUM' : 'HIGH',
    rental,
    candidates,
  };
}

/** Carrega as locações do veículo que podem cobrir o dia e aplica `matchRental`. */
export async function matchFineToRental(
  ctx: AppContext,
  organizationId: ObjectId,
  vehicleId: ObjectId,
  occurredAt: Date,
): Promise<FineMatchResult> {
  const day = businessDate(occurredAt);
  const rentals = await ctx.mongo.collections.rentals
    .find(
      { organizationId, vehicleId, status: { $ne: 'CANCELED' }, startDate: { $lte: day } },
      { projection: { _id: 1, driverId: 1, startDate: 1, endDate: 1, status: 1 } },
    )
    .toArray();
  return matchRental(rentals, occurredAt);
}
