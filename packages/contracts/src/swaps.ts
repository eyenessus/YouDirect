import { z } from 'zod';
import { isoDateSchema, isoDateTimeSchema, objectIdSchema } from './common.js';
import { vehicleStatusSchema } from './enums.js';

/* ------------------------------------------------------------------ *
 * Carro reserva: troca temporária do veículo de uma locação (manutenção,
 * sinistro etc.) sem perder o contrato. A locação continua no veículo
 * original; o reserva só fica "locado" enquanto a troca estiver ativa.
 * ------------------------------------------------------------------ */

export const swapReasons = ['MAINTENANCE', 'CLAIM', 'OTHER'] as const;
export const swapReasonSchema = z.enum(swapReasons);
export type SwapReason = z.infer<typeof swapReasonSchema>;
export const swapReasonLabels: Record<SwapReason, string> = {
  MAINTENANCE: 'Manutenção',
  CLAIM: 'Sinistro',
  OTHER: 'Outro motivo',
};

export const swapStatuses = ['ACTIVE', 'ENDED'] as const;
export const swapStatusSchema = z.enum(swapStatuses);
export type SwapStatus = z.infer<typeof swapStatusSchema>;

export const swapCreateSchema = z.object({
  replacementVehicleId: objectIdSchema,
  reason: swapReasonSchema,
  /** Sinistro que originou a troca (opcional, só para consulta). */
  claimId: objectIdSchema.optional(),
  startedOn: isoDateSchema.optional(),
  notes: z.string().trim().max(300).optional(),
});
export type SwapCreate = z.infer<typeof swapCreateSchema>;

export const swapEndSchema = z.object({
  endedOn: isoDateSchema.optional(),
  /** O veículo original voltou para a locação? Se não, ele fica como está (ex.: em manutenção). */
  originalReturned: z.boolean().default(true),
  notes: z.string().trim().max(300).optional(),
});
export type SwapEnd = z.infer<typeof swapEndSchema>;

export const vehicleSwapSchema = z.object({
  id: objectIdSchema,
  status: swapStatusSchema,
  reason: swapReasonSchema,
  rental: z.object({ id: objectIdSchema, rentalNumber: z.string() }),
  driver: z.object({ id: objectIdSchema, fullName: z.string() }).nullable(),
  original: z.object({ id: objectIdSchema, plate: z.string(), label: z.string() }),
  replacement: z.object({ id: objectIdSchema, plate: z.string(), label: z.string() }),
  claimId: objectIdSchema.nullable(),
  startedOn: isoDateSchema,
  endedOn: isoDateSchema.nullable(),
  notes: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type VehicleSwap = z.infer<typeof vehicleSwapSchema>;

/** Linha do quadro de disponibilidade da frota. */
export const availabilityRowSchema = z.object({
  vehicleId: objectIdSchema,
  plate: z.string(),
  label: z.string(),
  status: vehicleStatusSchema,
  /** Locação ativa do veículo (ou a que ele atende como reserva). */
  driverName: z.string().nullable(),
  rentalNumber: z.string().nullable(),
  /** Fim previsto da locação; null = sem término. */
  rentalEndsOn: isoDateSchema.nullable(),
  /** O veículo está sendo usado como reserva de outra locação. */
  asReplacementFor: z.string().nullable(),
  /** O veículo da locação está trocado por um reserva. */
  replacedBy: z.string().nullable(),
  /** Existe OS ou sinistro em aberto. */
  openMaintenance: z.number().int(),
  openClaims: z.number().int(),
  /** Pode ser oferecido como reserva agora. */
  usableAsReplacement: z.boolean(),
});
export type AvailabilityRow = z.infer<typeof availabilityRowSchema>;
