import { z } from 'zod';
import {
  amountCentsSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonEmptyString,
  objectIdSchema,
  optionalString,
} from './common.js';

/* ------------------------------------------------------------------ *
 * Multas de trânsito.
 *
 * A notificação chega em nome da locadora (proprietária do veículo).
 * Fluxo: cadastrar → identificar o motorista que estava com o carro →
 * indicar o condutor ao órgão no prazo → cobrar o motorista (conta a
 * receber do tipo FINE) → pago. Recurso e cancelamento em paralelo.
 * ------------------------------------------------------------------ */

export const trafficFineStatuses = [
  'RECEIVED',
  'DRIVER_IDENTIFIED',
  'INDICATED',
  'CHARGED',
  'PAID',
  'COMPANY_LIABLE',
  'CONTESTED',
  'CANCELED',
] as const;
export const trafficFineStatusSchema = z.enum(trafficFineStatuses);
export type TrafficFineStatus = z.infer<typeof trafficFineStatusSchema>;
export const trafficFineStatusLabels: Record<TrafficFineStatus, string> = {
  RECEIVED: 'Recebida',
  DRIVER_IDENTIFIED: 'Motorista identificado',
  INDICATED: 'Condutor indicado',
  CHARGED: 'Cobrada do motorista',
  PAID: 'Paga pelo motorista',
  COMPANY_LIABLE: 'Assumida pela empresa',
  CONTESTED: 'Em recurso',
  CANCELED: 'Cancelada',
};

/** Estados em que nada mais acontece com a multa. */
export const terminalFineStatuses: readonly TrafficFineStatus[] = ['PAID', 'COMPANY_LIABLE', 'CANCELED'];

/**
 * Transições permitidas (fonte única para API e interface).
 * PAID nunca é marcado à mão: deriva do recebível quitado.
 * CONTESTED volta ao estado anterior (recurso negado) ou vai a CANCELED (deferido).
 */
const fineTransitions: Record<TrafficFineStatus, readonly TrafficFineStatus[]> = {
  RECEIVED: ['DRIVER_IDENTIFIED', 'COMPANY_LIABLE', 'CONTESTED', 'CANCELED'],
  DRIVER_IDENTIFIED: ['RECEIVED', 'DRIVER_IDENTIFIED', 'INDICATED', 'CHARGED', 'COMPANY_LIABLE', 'CONTESTED', 'CANCELED'],
  INDICATED: ['CHARGED', 'CONTESTED', 'CANCELED'],
  CHARGED: ['PAID', 'CONTESTED', 'CANCELED'],
  // Paga pelo motorista: o estorno volta a CHARGED; recurso/cancelamento devolvem o valor.
  PAID: ['CHARGED', 'CONTESTED', 'CANCELED'],
  COMPANY_LIABLE: [],
  CONTESTED: ['RECEIVED', 'DRIVER_IDENTIFIED', 'INDICATED', 'CHARGED', 'CANCELED'],
  CANCELED: [],
};

export function canTransitionFine(from: TrafficFineStatus, to: TrafficFineStatus): boolean {
  return fineTransitions[from].includes(to);
}

export const fineGravities = ['LIGHT', 'MEDIUM', 'SERIOUS', 'VERY_SERIOUS'] as const;
export const fineGravitySchema = z.enum(fineGravities);
export type FineGravity = z.infer<typeof fineGravitySchema>;
export const fineGravityLabels: Record<FineGravity, string> = {
  LIGHT: 'Leve',
  MEDIUM: 'Média',
  SERIOUS: 'Grave',
  VERY_SERIOUS: 'Gravíssima',
};
/** Pontos na CNH por gravidade (CTB art. 259). */
export const fineGravityPoints: Record<FineGravity, number> = {
  LIGHT: 3,
  MEDIUM: 4,
  SERIOUS: 5,
  VERY_SERIOUS: 7,
};

export const fineMatchConfidences = ['HIGH', 'MEDIUM', 'AMBIGUOUS', 'NONE', 'MANUAL'] as const;
export const fineMatchConfidenceSchema = z.enum(fineMatchConfidences);
export type FineMatchConfidence = z.infer<typeof fineMatchConfidenceSchema>;
export const fineMatchConfidenceLabels: Record<FineMatchConfidence, string> = {
  HIGH: 'Identificado automaticamente',
  MEDIUM: 'Confirme o motorista',
  AMBIGUOUS: 'Mais de uma locação no dia',
  NONE: 'Sem locação na data',
  MANUAL: 'Definido manualmente',
};

export const fineIndicationStatuses = ['PENDING', 'DONE', 'NOT_REQUIRED', 'MISSED'] as const;
export const fineIndicationStatusSchema = z.enum(fineIndicationStatuses);
export type FineIndicationStatus = z.infer<typeof fineIndicationStatusSchema>;
export const fineIndicationStatusLabels: Record<FineIndicationStatus, string> = {
  PENDING: 'Pendente',
  DONE: 'Indicado',
  NOT_REQUIRED: 'Não necessária',
  MISSED: 'Prazo perdido',
};

export const fineAppealInstances = ['DEFESA_PREVIA', 'JARI', 'CETRAN'] as const;
export const fineAppealInstanceSchema = z.enum(fineAppealInstances);
export type FineAppealInstance = z.infer<typeof fineAppealInstanceSchema>;
export const fineAppealInstanceLabels: Record<FineAppealInstance, string> = {
  DEFESA_PREVIA: 'Defesa prévia',
  JARI: 'JARI (1ª instância)',
  CETRAN: 'CETRAN (2ª instância)',
};

export const fineAppealStatuses = ['NONE', 'FILED', 'GRANTED', 'DENIED'] as const;
export type FineAppealStatus = (typeof fineAppealStatuses)[number];
export const fineAppealStatusLabels: Record<FineAppealStatus, string> = {
  NONE: 'Sem recurso',
  FILED: 'Em análise',
  GRANTED: 'Deferido',
  DENIED: 'Indeferido',
};

/** Normaliza o número do auto de infração (AIT) para detectar duplicidade. */
export function normalizeAitNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Valor a cobrar do motorista: com desconto até a data limite, cheio depois; mais a taxa. */
export function fineChargeAmountCents(
  fine: { amountCents: number; discountedAmountCents: number | null; discountUntil: string | null; adminFeeCents: number },
  today: string,
): number {
  const base =
    fine.discountedAmountCents !== null && fine.discountUntil !== null && today <= fine.discountUntil
      ? fine.discountedAmountCents
      : fine.amountCents;
  return base + fine.adminFeeCents;
}

/* ------------------------------- DTO ------------------------------- */

const fileRefSchema = z.object({
  fileId: objectIdSchema,
  url: z.string(),
  originalName: z.string(),
  contentType: z.string(),
});

export const trafficFineSchema = z.object({
  id: objectIdSchema,
  fineNumber: z.string(),
  aitNumber: z.string(),
  authority: z.object({ name: z.string(), code: z.string().nullable(), state: z.string().nullable() }),
  infractionCode: z.string().nullable(),
  infractionDescription: z.string(),
  gravity: fineGravitySchema.nullable(),
  points: z.number().int().nullable(),
  occurredAt: isoDateTimeSchema,
  occurredOn: isoDateSchema,
  place: z.string().nullable(),
  vehicle: z.object({ id: objectIdSchema, plate: z.string(), brand: z.string(), model: z.string() }),
  amountCents: z.number().int(),
  discountedAmountCents: z.number().int().nullable(),
  discountUntil: isoDateSchema.nullable(),
  adminFeeCents: z.number().int(),
  chargeAmountCents: z.number().int(),
  noticeDate: isoDateSchema.nullable(),
  indicationDeadline: isoDateSchema.nullable(),
  dueDate: isoDateSchema.nullable(),
  status: trafficFineStatusSchema,
  match: z.object({
    confidence: fineMatchConfidenceSchema,
    rental: z.object({ id: objectIdSchema, rentalNumber: z.string(), startDate: isoDateSchema, endDate: isoDateSchema.nullable() }).nullable(),
    driver: z.object({ id: objectIdSchema, fullName: z.string(), phone: z.string().nullable() }).nullable(),
    candidates: z.array(
      z.object({
        rentalId: objectIdSchema,
        rentalNumber: z.string(),
        driverId: objectIdSchema,
        driverName: z.string(),
        startDate: isoDateSchema,
        endDate: isoDateSchema.nullable(),
      }),
    ),
  }),
  indication: z.object({
    status: fineIndicationStatusSchema,
    protocol: z.string().nullable(),
    indicatedAt: isoDateSchema.nullable(),
  }),
  appeal: z.object({
    status: z.enum(fineAppealStatuses),
    instance: fineAppealInstanceSchema.nullable(),
    filedAt: isoDateSchema.nullable(),
  }),
  receivable: z
    .object({
      id: objectIdSchema,
      grossAmountCents: z.number().int(),
      paidAmountCents: z.number().int(),
      dueDate: isoDateSchema,
      status: z.string(),
    })
    .nullable(),
  files: z.object({
    notice: fileRefSchema.nullable(),
    proof: fileRefSchema.nullable(),
  }),
  notes: z.string().nullable(),
  history: z.array(
    z.object({ at: isoDateTimeSchema, action: z.string(), detail: z.string().nullable(), actorName: z.string().nullable() }),
  ),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type TrafficFine = z.infer<typeof trafficFineSchema>;

export const trafficFineSummarySchema = z.object({
  openCount: z.number().int(),
  openAmountCents: z.number().int(),
  indicationDueSoonCount: z.number().int(),
  indicationOverdueCount: z.number().int(),
  toChargeCount: z.number().int(),
});
export type TrafficFineSummary = z.infer<typeof trafficFineSummarySchema>;

/* ----------------------------- Entradas ---------------------------- */

const optionalDate = isoDateSchema.optional().or(z.literal('').transform(() => undefined));
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora deve estar no formato HH:MM');

const fineFieldsBase = z.object({
  vehicleId: objectIdSchema,
  aitNumber: nonEmptyString(40),
  authorityName: nonEmptyString(120),
  authorityCode: optionalString(20),
  authorityState: optionalString(2),
  infractionCode: optionalString(20),
  infractionDescription: nonEmptyString(300),
  gravity: fineGravitySchema.optional(),
  points: z.coerce.number().int().min(0).max(40).optional(),
  /** Data e hora locais (fuso de negócio) da infração. */
  occurredDate: isoDateSchema,
  occurredTime: timeSchema,
  place: optionalString(200),
  amountCents: amountCentsSchema.refine((v) => v > 0, 'Informe o valor da multa'),
  discountedAmountCents: amountCentsSchema.optional(),
  discountUntil: optionalDate,
  adminFeeCents: amountCentsSchema.default(0),
  noticeDate: optionalDate,
  indicationDeadline: optionalDate,
  dueDate: optionalDate,
  noticeFileId: objectIdSchema.optional(),
  notes: optionalString(2000),
});

function refineDiscount<T extends { amountCents?: number; discountedAmountCents?: number }>(v: T): boolean {
  return v.discountedAmountCents === undefined || v.amountCents === undefined || v.discountedAmountCents <= v.amountCents;
}
const discountIssue = { message: 'O valor com desconto não pode ser maior que o valor da multa', path: ['discountedAmountCents'] };

export const trafficFineCreateSchema = fineFieldsBase.refine(refineDiscount, discountIssue);
export type TrafficFineCreate = z.infer<typeof trafficFineCreateSchema>;

export const trafficFineUpdateSchema = fineFieldsBase
  .omit({ vehicleId: true })
  .partial()
  .extend({ version: z.number().int().min(1) })
  .refine(refineDiscount, discountIssue);
export type TrafficFineUpdate = z.infer<typeof trafficFineUpdateSchema>;

export const trafficFineListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: trafficFineStatusSchema.optional(),
  vehicleId: objectIdSchema.optional(),
  driverId: objectIdSchema.optional(),
  rentalId: objectIdSchema.optional(),
  /** overdue = prazo de indicação vencido; soon = vence em até 7 dias. */
  deadline: z.enum(['overdue', 'soon']).optional(),
  /** true = só multas ainda em andamento (exclui pagas, assumidas e canceladas). */
  openOnly: z.enum(['true', 'false']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TrafficFineListQuery = z.infer<typeof trafficFineListQuerySchema>;

export const fineIdentifySchema = z.object({
  driverId: objectIdSchema,
  rentalId: objectIdSchema.optional(),
  version: z.number().int().min(1),
});

export const fineIndicateSchema = z.object({
  protocol: optionalString(80),
  indicatedAt: isoDateSchema,
  proofFileId: objectIdSchema.optional(),
  version: z.number().int().min(1),
});

export const fineChargeSchema = z.object({
  amountCents: amountCentsSchema.refine((v) => v > 0, 'Informe um valor maior que zero').optional(),
  dueDate: isoDateSchema.optional(),
  version: z.number().int().min(1),
});
export type FineCharge = z.infer<typeof fineChargeSchema>;

export const fineContestSchema = z.object({
  instance: fineAppealInstanceSchema,
  filedAt: isoDateSchema,
  notes: optionalString(500),
  version: z.number().int().min(1),
});

export const fineAppealResultSchema = z.object({
  result: z.enum(['GRANTED', 'DENIED']),
  notes: optionalString(500),
  version: z.number().int().min(1),
});

export const fineReasonSchema = z.object({
  reason: nonEmptyString(300),
  version: z.number().int().min(1),
});

export const fineVersionSchema = z.object({ version: z.number().int().min(1) });

export const fineNotifyResultSchema = z.object({
  delivered: z.boolean(),
  error: z.string().nullable(),
  manualLink: z.string().nullable(),
  message: z.string(),
});
export type FineNotifyResult = z.infer<typeof fineNotifyResultSchema>;

export const fineImportResultSchema = z.object({
  available: z.boolean(),
  message: z.string().nullable(),
  created: z.number().int(),
  skipped: z.number().int(),
});
export type FineImportResult = z.infer<typeof fineImportResultSchema>;
