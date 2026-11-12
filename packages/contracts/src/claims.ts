import { z } from 'zod';
import { amountCentsSchema, isoDateSchema, isoDateTimeSchema, objectIdSchema } from './common.js';

/* ------------------------------------------------------------------ *
 * Sinistros: acidente, roubo, furto, incêndio, vidro etc. envolvendo um
 * veículo da frota. Acompanha o caso (seguradora, oficina, boletim de
 * ocorrência) e, quando a culpa é do motorista, cobra a franquia dele
 * como conta a receber. O sistema não decide a culpa: quem registra decide.
 * ------------------------------------------------------------------ */

export const claimKinds = ['COLLISION', 'THEFT', 'FIRE', 'VANDALISM', 'NATURAL', 'GLASS', 'OTHER'] as const;
export const claimKindSchema = z.enum(claimKinds);
export type ClaimKind = z.infer<typeof claimKindSchema>;
export const claimKindLabels: Record<ClaimKind, string> = {
  COLLISION: 'Colisão',
  THEFT: 'Roubo ou furto',
  FIRE: 'Incêndio',
  VANDALISM: 'Vandalismo',
  NATURAL: 'Enchente ou granizo',
  GLASS: 'Vidros',
  OTHER: 'Outro',
};

export const claimFaults = ['DRIVER', 'THIRD_PARTY', 'UNDETERMINED'] as const;
export const claimFaultSchema = z.enum(claimFaults);
export type ClaimFault = z.infer<typeof claimFaultSchema>;
export const claimFaultLabels: Record<ClaimFault, string> = {
  DRIVER: 'Do motorista',
  THIRD_PARTY: 'De terceiro',
  UNDETERMINED: 'A apurar',
};

export const claimStatuses = ['OPEN', 'IN_ANALYSIS', 'IN_REPAIR', 'CLOSED', 'CANCELED'] as const;
export const claimStatusSchema = z.enum(claimStatuses);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;
export const claimStatusLabels: Record<ClaimStatus, string> = {
  OPEN: 'Aberto',
  IN_ANALYSIS: 'Em análise (seguradora)',
  IN_REPAIR: 'Em reparo',
  CLOSED: 'Encerrado',
  CANCELED: 'Cancelado',
};

/** Só avança (ou cancela); encerrado e cancelado são finais. */
export const claimTransitions: Record<ClaimStatus, readonly ClaimStatus[]> = {
  OPEN: ['IN_ANALYSIS', 'IN_REPAIR', 'CLOSED', 'CANCELED'],
  IN_ANALYSIS: ['IN_REPAIR', 'CLOSED', 'CANCELED'],
  IN_REPAIR: ['CLOSED', 'CANCELED'],
  CLOSED: [],
  CANCELED: [],
};

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  text(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' || v === undefined ? (v === '' ? null : undefined) : v));

export const claimCreateSchema = z.object({
  vehicleId: objectIdSchema,
  /** Sem a locação, o sistema procura a que estava vigente na data do sinistro. */
  rentalId: objectIdSchema.optional(),
  occurredOn: isoDateSchema,
  kind: claimKindSchema,
  fault: claimFaultSchema.default('UNDETERMINED'),
  location: optionalText(200),
  description: text(2000).min(5, 'Descreva o que aconteceu'),
  policeReportNumber: optionalText(60),
  insurerClaimNumber: optionalText(60),
  deductibleCents: amountCentsSchema.optional(),
  estimatedCostCents: amountCentsSchema.optional(),
  fileIds: z.array(objectIdSchema).max(12).optional(),
});
export type ClaimCreate = z.infer<typeof claimCreateSchema>;

export const claimUpdateSchema = z.object({
  version: z.number().int().min(1),
  fault: claimFaultSchema.optional(),
  location: optionalText(200),
  description: text(2000).min(5).optional(),
  policeReportNumber: optionalText(60),
  insurerClaimNumber: optionalText(60),
  deductibleCents: amountCentsSchema.nullable().optional(),
  estimatedCostCents: amountCentsSchema.nullable().optional(),
  finalCostCents: amountCentsSchema.nullable().optional(),
  fileIds: z.array(objectIdSchema).max(12).optional(),
});
export type ClaimUpdate = z.infer<typeof claimUpdateSchema>;

export const claimStatusChangeSchema = z.object({
  version: z.number().int().min(1),
  status: claimStatusSchema,
  note: optionalText(500),
});
export type ClaimStatusChange = z.infer<typeof claimStatusChangeSchema>;

export const claimChargeSchema = z.object({
  version: z.number().int().min(1),
  /** Padrão: a franquia registrada no sinistro. */
  amountCents: amountCentsSchema.refine((v) => v > 0, 'Informe um valor maior que zero').optional(),
  dueDate: isoDateSchema.optional(),
});
export type ClaimCharge = z.infer<typeof claimChargeSchema>;

export const claimListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: claimStatusSchema.optional(),
  vehicleId: objectIdSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const claimSchema = z.object({
  id: objectIdSchema,
  claimNumber: z.string(),
  status: claimStatusSchema,
  kind: claimKindSchema,
  fault: claimFaultSchema,
  occurredOn: isoDateSchema,
  location: z.string().nullable(),
  description: z.string(),
  policeReportNumber: z.string().nullable(),
  insurerClaimNumber: z.string().nullable(),
  deductibleCents: z.number().int().nullable(),
  estimatedCostCents: z.number().int().nullable(),
  finalCostCents: z.number().int().nullable(),
  vehicle: z.object({ id: objectIdSchema, plate: z.string(), label: z.string() }),
  driver: z.object({ id: objectIdSchema, fullName: z.string() }).nullable(),
  rental: z.object({ id: objectIdSchema, rentalNumber: z.string() }).nullable(),
  files: z.array(z.object({ id: objectIdSchema, url: z.string(), originalName: z.string() })),
  receivable: z.object({ id: objectIdSchema, status: z.string(), grossAmountCents: z.number().int(), paidAmountCents: z.number().int() }).nullable(),
  history: z.array(z.object({ at: isoDateTimeSchema, action: z.string(), detail: z.string().nullable() })),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Claim = z.infer<typeof claimSchema>;

/** Dias em aberto sem decisão a partir dos quais a equipe é lembrada (reaviso semanal). */
export const CLAIM_STALE_DAYS = 15;
