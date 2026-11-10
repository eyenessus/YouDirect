import { z } from 'zod';
import {
  amountCentsSchema,
  isoDateSchema,
  isoDateTimeSchema,
  objectIdSchema,
  optionalString,
} from './common.js';
import {
  inspectionPeriodSchema,
  inspectionWeekdaySchema,
  paymentMethodSchema,
  rentalStatusSchema,
  rentalTypeSchema,
} from './enums.js';

export const rentalSchema = z.object({
  id: objectIdSchema,
  rentalNumber: z.string(),
  vehicle: z.object({
    id: objectIdSchema,
    plate: z.string(),
    brand: z.string(),
    model: z.string(),
    year: z.number().int().nullable(),
  }),
  driver: z.object({
    id: objectIdSchema,
    fullName: z.string(),
    cpf: z.string().nullable(),
    phone: z.string(),
  }),
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullable(),
  rentalType: rentalTypeSchema,
  inspectionPeriod: inspectionPeriodSchema.nullable(),
  inspectionWeekday: inspectionWeekdaySchema,
  periodicAmountCents: z.number().int(),
  depositCents: z.number().int(),
  firstPeriodPrepaid: z.boolean(),
  depositPrepaid: z.boolean(),
  allowedKm: z.number().int().nullable(),
  monthlyFranchiseKm: z.number().int().nullable(),
  contractFile: z
    .object({ fileId: objectIdSchema, url: z.string(), originalName: z.string() })
    .nullable(),
  notes: z.string().nullable(),
  status: rentalStatusSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Rental = z.infer<typeof rentalSchema>;

const baseRentalFields = {
  startDate: isoDateSchema,
  endDate: isoDateSchema.optional().or(z.literal('').transform(() => undefined)),
  rentalType: rentalTypeSchema,
  inspectionPeriod: inspectionPeriodSchema.optional(),
  inspectionWeekday: inspectionWeekdaySchema.default('ANY'),
  periodicAmountCents: amountCentsSchema.refine((v) => v > 0, 'Informe o valor da locação'),
  depositCents: amountCentsSchema.default(0),
  firstPeriodPrepaid: z.boolean().default(false),
  depositPrepaid: z.boolean().default(false),
  allowedKm: z.coerce.number().int().min(0).max(10_000_000).optional(),
  monthlyFranchiseKm: z.coerce.number().int().min(0).max(10_000_000).optional(),
  contractFileId: objectIdSchema.optional(),
  notes: optionalString(2000),
};

export const rentalCreateSchema = z
  .object({
    vehicleId: objectIdSchema,
    driverId: objectIdSchema,
    ...baseRentalFields,
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, {
    message: 'A data de término deve ser igual ou posterior à data de início',
    path: ['endDate'],
  })
  .refine((v) => !v.depositPrepaid || v.depositCents > 0, {
    message: 'Informe o valor do caução para marcá-lo como recebido',
    path: ['depositPrepaid'],
  });
export type RentalCreate = z.infer<typeof rentalCreateSchema>;

export const rentalUpdateSchema = z
  .object(baseRentalFields)
  .partial()
  .refine((v) => !v.endDate || !v.startDate || v.endDate >= v.startDate, {
    message: 'A data de término deve ser igual ou posterior à data de início',
    path: ['endDate'],
  });
export type RentalUpdate = z.infer<typeof rentalUpdateSchema>;

export const rentalListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: rentalStatusSchema.optional(),
  vehicleId: objectIdSchema.optional(),
  driverId: objectIdSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const rentalCloseSchema = z.object({
  endDate: isoDateSchema,
  notes: optionalString(1000),
});

/* ------------------- Cronograma de pagamento da locação ------------------ */

export const paymentWeekStatuses = ['PAID', 'PARTIAL', 'OPEN', 'OVERDUE'] as const;
export const paymentWeekStatusSchema = z.enum(paymentWeekStatuses);
export type PaymentWeekStatus = z.infer<typeof paymentWeekStatusSchema>;
export const paymentWeekStatusLabels: Record<PaymentWeekStatus, string> = {
  PAID: 'Paga',
  PARTIAL: 'Parcial',
  OPEN: 'Em aberto',
  OVERDUE: 'Atrasada',
};

/** Uma semana (ou mês, em locação mensal) do contrato, calculada sobre a conta a receber. */
export const rentalPaymentWeekSchema = z.object({
  number: z.number().int(),
  dueDate: isoDateSchema,
  amountCents: z.number().int(),
  paidCents: z.number().int(),
  remainingCents: z.number().int(),
  status: paymentWeekStatusSchema,
});
export type RentalPaymentWeek = z.infer<typeof rentalPaymentWeekSchema>;

export const rentalPaymentScheduleSchema = z.object({
  rentalId: objectIdSchema,
  rentalNumber: z.string(),
  /** Conta a receber do contrato; null em locação legada sem conta. */
  receivableId: objectIdSchema.nullable(),
  rentalType: rentalTypeSchema,
  weeks: z.array(rentalPaymentWeekSchema),
  totals: z.object({
    amountCents: z.number().int(),
    paidCents: z.number().int(),
    remainingCents: z.number().int(),
  }),
});
export type RentalPaymentSchedule = z.infer<typeof rentalPaymentScheduleSchema>;

/* ------------- Pagamentos da locação (aba "Pagamentos" da página da locação) ------------- */

/** Pagamento da locação (abate o contrato) ou KM excedente (cobrança extra que soma ao total). */
export const rentalPaymentCategories = ['RENT', 'EXTRA_KM'] as const;
export const rentalPaymentCategorySchema = z.enum(rentalPaymentCategories);
export type RentalPaymentCategory = z.infer<typeof rentalPaymentCategorySchema>;
export const rentalPaymentCategoryLabels: Record<RentalPaymentCategory, string> = {
  RENT: 'Pagamento da Locação',
  EXTRA_KM: 'KM Excedente',
};

/** Situação exibida: `OVERDUE` = pendente com data prevista já vencida. */
export const rentalPaymentStatuses = ['PAID', 'PENDING', 'OVERDUE'] as const;
export const rentalPaymentStatusSchema = z.enum(rentalPaymentStatuses);
export type RentalPaymentStatus = z.infer<typeof rentalPaymentStatusSchema>;
export const rentalPaymentStatusLabels: Record<RentalPaymentStatus, string> = {
  PAID: 'Pago',
  PENDING: 'Pendente',
  OVERDUE: 'Atrasado',
};

export const rentalPaymentEntrySchema = z.object({
  id: objectIdSchema,
  receiptNumber: z.string(),
  category: rentalPaymentCategorySchema,
  description: z.string(),
  amountCents: z.number().int(),
  expectedDate: isoDateSchema,
  method: paymentMethodSchema.nullable(),
  status: rentalPaymentStatusSchema,
  paidAt: isoDateSchema.nullable(),
  notes: z.string().nullable(),
});
export type RentalPaymentEntry = z.infer<typeof rentalPaymentEntrySchema>;

export const rentalPaymentsViewSchema = z.object({
  rentalId: objectIdSchema,
  rentalNumber: z.string(),
  rentalStatus: rentalStatusSchema,
  summary: z.object({
    /** Valor total da locação, sem caução (contrato + KM excedente). */
    totalCents: z.number().int(),
    paidCents: z.number().int(),
    pendingCents: z.number().int(),
    /** Caução: valor separado, fora do total. */
    depositCents: z.number().int(),
  }),
  entries: z.array(rentalPaymentEntrySchema),
});
export type RentalPaymentsView = z.infer<typeof rentalPaymentsViewSchema>;

/** Data prevista e data do pagamento são sempre informadas pelo dono (sem valor automático). */
export const rentalPaymentCreateSchema = z
  .object({
    category: rentalPaymentCategorySchema,
    amountCents: amountCentsSchema.refine((v) => v > 0, 'Informe um valor maior que zero'),
    expectedDate: isoDateSchema,
    alreadyPaid: z.boolean().default(false),
    paidAt: isoDateSchema.optional(),
    method: paymentMethodSchema.optional(),
    notes: optionalString(300),
  })
  .refine((v) => !v.alreadyPaid || Boolean(v.paidAt), {
    message: 'Informe a data do pagamento',
    path: ['paidAt'],
  });
export type RentalPaymentCreate = z.infer<typeof rentalPaymentCreateSchema>;

/** Só lançamentos pendentes podem ser editados. */
export const rentalPaymentUpdateSchema = z.object({
  amountCents: amountCentsSchema.refine((v) => v > 0, 'Informe um valor maior que zero').optional(),
  expectedDate: isoDateSchema.optional(),
  notes: optionalString(300),
});
export type RentalPaymentUpdate = z.infer<typeof rentalPaymentUpdateSchema>;

/** "Marcar como pago" num lançamento pendente. */
export const rentalPaymentPaySchema = z.object({
  paidAt: isoDateSchema,
  method: paymentMethodSchema,
});
export type RentalPaymentPay = z.infer<typeof rentalPaymentPaySchema>;

export const rentalPaymentListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
});
