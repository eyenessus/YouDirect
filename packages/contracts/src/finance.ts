import { z } from 'zod';
import {
  amountCentsSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonEmptyString,
  objectIdSchema,
  optionalCnpjSchema,
  optionalString,
} from './common.js';
import {
  bankAccountTypeSchema,
  payableStatusSchema,
  paymentMethodSchema,
  receivableStatusSchema,
  transactionDirectionSchema,
  transactionOriginSchema,
} from './enums.js';

/* --------------------------- Contas bancárias ---------------------- */

export const bankAccountSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  institution: z.string().nullable(),
  type: bankAccountTypeSchema,
  initialBalanceCents: z.number().int(),
  initialBalanceDate: isoDateSchema,
  currentBalanceCents: z.number().int(),
  isDefault: z.boolean(),
  active: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type BankAccount = z.infer<typeof bankAccountSchema>;

export const bankAccountCreateSchema = z.object({
  name: nonEmptyString(80),
  institution: optionalString(80),
  type: bankAccountTypeSchema.default('CHECKING'),
  initialBalanceCents: z.number().int().default(0),
  initialBalanceDate: isoDateSchema,
  isDefault: z.boolean().default(false),
});
export type BankAccountCreate = z.infer<typeof bankAccountCreateSchema>;

export const bankAccountUpdateSchema = bankAccountCreateSchema
  .partial()
  .extend({ active: z.boolean().optional() });
export type BankAccountUpdate = z.infer<typeof bankAccountUpdateSchema>;

export const manualTransactionSchema = z.object({
  direction: transactionDirectionSchema,
  amountCents: amountCentsSchema.refine((v) => v > 0, 'Informe um valor maior que zero'),
  occurredAt: isoDateSchema,
  description: nonEmptyString(200),
});
export type ManualTransaction = z.infer<typeof manualTransactionSchema>;

export const bankTransactionSchema = z.object({
  id: objectIdSchema,
  occurredAt: isoDateSchema,
  description: z.string(),
  origin: transactionOriginSchema,
  direction: transactionDirectionSchema,
  amountCents: z.number().int(),
  runningBalanceCents: z.number().int(),
  reversed: z.boolean(),
});
export type BankTransaction = z.infer<typeof bankTransactionSchema>;

export const statementSchema = z.object({
  account: z.object({ id: objectIdSchema, name: z.string() }),
  from: isoDateSchema,
  to: isoDateSchema,
  openingBalanceCents: z.number().int(),
  inflowCents: z.number().int(),
  outflowCents: z.number().int(),
  closingBalanceCents: z.number().int(),
  transactions: z.array(bankTransactionSchema),
});
export type Statement = z.infer<typeof statementSchema>;

export const statementQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
});

/* --------------------------- Categorias ---------------------------- */

export const expenseCategorySchema = z.object({
  id: objectIdSchema,
  label: z.string(),
  slug: z.string(),
  active: z.boolean(),
  isDefault: z.boolean(),
});
export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;

export const expenseCategoryCreateSchema = z.object({ label: nonEmptyString(60) });

/* --------------------------- Contas a pagar ------------------------ */

/** Periodicidade das parcelas de uma conta a pagar (financiamento, seguro, IPVA...). */
export const installmentFrequencies = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const;
export const installmentFrequencySchema = z.enum(installmentFrequencies);
export type InstallmentFrequency = z.infer<typeof installmentFrequencySchema>;
export const installmentFrequencyLabels: Record<InstallmentFrequency, string> = {
  MONTHLY: 'Mensal',
  QUARTERLY: 'Trimestral',
  SEMIANNUAL: 'Semestral',
  ANNUAL: 'Anual',
};
/** Meses entre uma parcela e a seguinte. */
export const installmentFrequencyMonths: Record<InstallmentFrequency, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  ANNUAL: 12,
};
export const maxInstallments = 120;

export const payableSchema = z.object({
  id: objectIdSchema,
  description: z.string(),
  category: z.object({ id: objectIdSchema, label: z.string() }).nullable(),
  vehicle: z.object({ id: objectIdSchema, plate: z.string() }).nullable(),
  amountCents: z.number().int(),
  paidAmountCents: z.number().int(),
  remainingCents: z.number().int(),
  dueDate: isoDateSchema,
  supplierName: z.string().nullable(),
  supplierTaxId: z.string().nullable(),
  documentUrl: z.string().nullable(),
  recurring: z.boolean(),
  recurringSeriesId: z.string().nullable(),
  /** Parcela de um parcelamento (ex.: 3 de 48); null para conta avulsa. */
  installment: z
    .object({
      seriesId: z.string(),
      number: z.number().int(),
      total: z.number().int(),
      frequency: installmentFrequencySchema,
    })
    .nullable(),
  notes: z.string().nullable(),
  status: payableStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type Payable = z.infer<typeof payableSchema>;

const payableCreateBase = z.object({
  categoryId: objectIdSchema,
  vehicleId: objectIdSchema.optional(),
  amountCents: amountCentsSchema.refine((v) => v > 0, 'Informe um valor maior que zero'),
  dueDate: isoDateSchema,
  description: nonEmptyString(200),
  supplierName: optionalString(120),
  supplierTaxId: optionalCnpjSchema,
  documentUrl: z
    .string()
    .trim()
    .url('Informe uma URL válida')
    .max(600)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  recurring: z.boolean().default(false),
  /** Parcelamento: gera todas as parcelas na criação. O valor informado é o de CADA parcela. */
  installments: z
    .object({
      count: z.number().int().min(2, 'Informe ao menos 2 parcelas').max(maxInstallments),
      frequency: installmentFrequencySchema,
    })
    .optional(),
  alreadyPaid: z.boolean().default(false),
  paidBankAccountId: objectIdSchema.optional(),
  notes: optionalString(2000),
});

export const payableCreateSchema = payableCreateBase.refine((v) => !(v.recurring && v.installments), {
  message: 'Use recorrência ou parcelamento, não os dois',
  path: ['installments'],
});
export type PayableCreate = z.infer<typeof payableCreateSchema>;

export const payableUpdateSchema = payableCreateBase
  .partial()
  .omit({ alreadyPaid: true, paidBankAccountId: true, installments: true })
  // Na edição, null limpa o campo (ausente = não altera).
  .extend({
    vehicleId: objectIdSchema.nullable().optional(),
    supplierName: payableCreateBase.shape.supplierName.nullable(),
    supplierTaxId: payableCreateBase.shape.supplierTaxId.nullable(),
    documentUrl: payableCreateBase.shape.documentUrl.nullable(),
    notes: payableCreateBase.shape.notes.nullable(),
  });

export const payableListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: payableStatusSchema.optional(),
  categoryId: objectIdSchema.optional(),
  sort: z.enum(['createdAt', 'dueDate', 'amount', 'description']).default('createdAt'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/* -------------------------- Contas a receber ----------------------- */

export const receivableSchema = z.object({
  id: objectIdSchema,
  description: z.string(),
  rental: z.object({ id: objectIdSchema, rentalNumber: z.string() }).nullable(),
  driver: z.object({ id: objectIdSchema, fullName: z.string(), cpf: z.string().nullable() }),
  grossAmountCents: z.number().int(),
  paidAmountCents: z.number().int(),
  remainingCents: z.number().int(),
  dueDate: isoDateSchema,
  paymentMethod: paymentMethodSchema.nullable(),
  status: receivableStatusSchema,
  createdAt: isoDateTimeSchema,
});
export type Receivable = z.infer<typeof receivableSchema>;

export const receivableListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: receivableStatusSchema.optional(),
  paymentMethod: paymentMethodSchema.optional(),
  driverId: objectIdSchema.optional(),
  rentalId: objectIdSchema.optional(),
  /** true = só contas com saldo a receber (exclui quitadas e canceladas). */
  openOnly: z.enum(['true', 'false']).optional(),
  sort: z.enum(['createdAt', 'dueDate', 'amount', 'client']).default('createdAt'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const registerPaymentSchema = z.object({
  amountCents: amountCentsSchema.refine((v) => v > 0, 'Informe um valor maior que zero'),
  paidAt: isoDateSchema,
  method: paymentMethodSchema,
  bankAccountId: objectIdSchema,
  notes: optionalString(300),
});
export type RegisterPayment = z.infer<typeof registerPaymentSchema>;

export const paymentSchema = z.object({
  id: objectIdSchema,
  amountCents: z.number().int(),
  paidAt: isoDateSchema,
  method: paymentMethodSchema,
  bankAccountId: objectIdSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

/* ----------------------- Dashboard financeiro ---------------------- */

export const financeDashboardSchema = z.object({
  period: z.object({
    from: isoDateSchema,
    to: isoDateSchema,
    label: z.string(),
    comparisonLabel: z.string().nullable(),
    /** Forma curta usada no rodapé dos cards ("out"). */
    comparisonShortLabel: z.string().nullable(),
  }),
  revenueCents: z.number().int(),
  expensesCents: z.number().int(),
  profitCents: z.number().int(),
  marginPercent: z.number().nullable(),
  previous: z.object({
    revenueCents: z.number().int(),
    expensesCents: z.number().int(),
    profitCents: z.number().int(),
    marginPercent: z.number().nullable(),
  }),
  deltas: z.object({
    revenuePercent: z.number().nullable(),
    expensesPercent: z.number().nullable(),
    profitPercent: z.number().nullable(),
    marginPoints: z.number().nullable(),
  }),
  highlight: z.string().nullable(),
  attention: z.string().nullable(),
  monthlySeries: z.array(
    z.object({
      month: z.string(),
      label: z.string(),
      revenueCents: z.number().int(),
      expensesCents: z.number().int(),
      profitCents: z.number().int(),
    }),
  ),
  expensesByCategory: z.array(
    z.object({ label: z.string(), amountCents: z.number().int(), percent: z.number() }),
  ),
  fleet: z.object({
    occupancyPercent: z.number(),
    occupancyDeltaPoints: z.number().nullable(),
    revenuePerVehicleCents: z.number().int(),
    revenuePerVehicleDeltaPercent: z.number().nullable(),
    activeVehicles: z.number().int(),
    activeVehiclesDelta: z.number().int().nullable(),
  }),
  cash: z.object({
    accounts: z.array(z.object({ id: objectIdSchema, name: z.string(), balanceCents: z.number().int() })),
    totalCents: z.number().int(),
    receivableCents: z.number().int(),
    receivableCount: z.number().int(),
    payableCents: z.number().int(),
    payableCount: z.number().int(),
    overdueCents: z.number().int(),
    overdueClients: z.number().int(),
  }),
  upcoming: z.array(
    z.object({
      kind: z.enum(['RECEIVABLE', 'PAYABLE']),
      id: objectIdSchema,
      description: z.string(),
      dueDate: isoDateSchema,
      amountCents: z.number().int(),
    }),
  ),
});
export type FinanceDashboard = z.infer<typeof financeDashboardSchema>;

export const financePeriodQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
export type FinancePeriodQuery = z.infer<typeof financePeriodQuerySchema>;
