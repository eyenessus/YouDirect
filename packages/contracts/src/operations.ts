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
 * Operação da locadora: cobrança Pix, km excedente, avarias e caução,
 * fidelidade do motorista e contrato com assinatura digital.
 * ------------------------------------------------------------------ */

/* ------------------------------- Pix -------------------------------- */

export const pixChargeStatuses = ['PENDING', 'PAID', 'EXPIRED', 'CANCELED', 'FAILED'] as const;
export const pixChargeStatusSchema = z.enum(pixChargeStatuses);
export type PixChargeStatus = z.infer<typeof pixChargeStatusSchema>;
export const pixChargeStatusLabels: Record<PixChargeStatus, string> = {
  PENDING: 'Aguardando pagamento',
  PAID: 'Pago',
  EXPIRED: 'Expirado',
  CANCELED: 'Cancelado',
  FAILED: 'Falhou',
};

export const pixChargeSchema = z.object({
  id: objectIdSchema,
  receivableId: objectIdSchema,
  description: z.string(),
  amountCents: z.number().int(),
  status: pixChargeStatusSchema,
  qrCode: z.string().nullable(),
  qrCodeBase64: z.string().nullable(),
  ticketUrl: z.string().nullable(),
  expiresAt: isoDateTimeSchema,
  paidAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type PixCharge = z.infer<typeof pixChargeSchema>;

/** Fatura escolhida pelo motorista (chave de `PortalInvoice.key`). */
export const portalPixRequestSchema = z.object({ key: z.string().min(24).max(80) });

export const staffPixRequestSchema = z.object({
  amountCents: amountCentsSchema.refine((v) => v > 0, 'Informe um valor maior que zero').optional(),
});

export const billingSettingsSchema = z.object({
  remindersEnabled: z.boolean(),
  /** Dias antes do vencimento para o lembrete (0 = no dia). */
  reminderDaysBefore: z.number().int().min(0).max(7),
  /** Dias depois do vencimento para a cobrança de atraso. */
  overdueReminderDays: z.array(z.number().int().min(1).max(30)).max(4),
});
export type BillingSettings = z.infer<typeof billingSettingsSchema>;
export const defaultBillingSettings: BillingSettings = { remindersEnabled: true, reminderDaysBefore: 2, overdueReminderDays: [1, 3] };

/* ---------------------------- KM excedente -------------------------- */

export const rentalKmPolicySchema = z.object({
  /** Franquia semanal (km); null = sem limite. */
  weeklyFranchiseKm: z.coerce.number().int().min(1).max(20_000).nullable(),
  extraKmPriceCents: amountCentsSchema,
  /** Hodômetro na entrega; null = usa a primeira vistoria aprovada. */
  startOdometerKm: z.coerce.number().int().min(0).max(10_000_000).nullable(),
});
export type RentalKmPolicy = z.infer<typeof rentalKmPolicySchema>;

export const rentalKmSummarySchema = z.object({
  policy: rentalKmPolicySchema.nullable(),
  baselineOdometerKm: z.number().int().nullable(),
  lastOdometerKm: z.number().int().nullable(),
  drivenKm: z.number().int(),
  allowedKm: z.number().int().nullable(),
  chargedKm: z.number().int(),
  chargedCents: z.number().int(),
  lastReadingAt: isoDateSchema.nullable(),
});
export type RentalKmSummary = z.infer<typeof rentalKmSummarySchema>;

/**
 * Km excedente a cobrar numa leitura de hodômetro (regra pura, testável):
 * franquia proporcional aos dias desde o início (semanal ÷ 7 por dia),
 * menos o que já foi cobrado. Nunca negativo, nunca cobra duas vezes.
 */
export function computeExtraKm(input: {
  baselineKm: number;
  odometerKm: number;
  daysSinceStart: number;
  weeklyFranchiseKm: number | null;
  alreadyChargedKm: number;
}): { drivenKm: number; allowedKm: number | null; excessKm: number; toChargeKm: number } {
  const drivenKm = Math.max(0, input.odometerKm - input.baselineKm);
  if (input.weeklyFranchiseKm === null) return { drivenKm, allowedKm: null, excessKm: 0, toChargeKm: 0 };
  const days = Math.max(1, input.daysSinceStart);
  const allowedKm = Math.round((input.weeklyFranchiseKm * days) / 7);
  const excessKm = Math.max(0, drivenKm - allowedKm);
  return { drivenKm, allowedKm, excessKm, toChargeKm: Math.max(0, excessKm - input.alreadyChargedKm) };
}

/* ------------------------------ Avarias ----------------------------- */

export const damagePriceSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  category: z.string(),
  priceCents: z.number().int(),
  active: z.boolean(),
});
export type DamagePrice = z.infer<typeof damagePriceSchema>;

export const damagePriceInputSchema = z.object({
  name: nonEmptyString(80),
  category: nonEmptyString(40),
  priceCents: amountCentsSchema.refine((v) => v > 0, 'Informe o preço'),
  active: z.boolean().default(true),
});

export const inspectionDamageInputSchema = z.object({
  items: z
    .array(
      z.object({
        damagePriceId: objectIdSchema,
        quantity: z.coerce.number().int().min(1).max(20).default(1),
        note: optionalString(200),
      }),
    )
    .min(1, 'Escolha ao menos uma avaria')
    .max(30),
  dueDate: isoDateSchema.optional(),
});
export type InspectionDamageInput = z.infer<typeof inspectionDamageInputSchema>;

export const inspectionDamageSchema = z.object({
  id: objectIdSchema,
  inspectionId: objectIdSchema,
  items: z.array(
    z.object({ name: z.string(), category: z.string(), quantity: z.number().int(), unitPriceCents: z.number().int(), totalCents: z.number().int(), note: z.string().nullable() }),
  ),
  totalCents: z.number().int(),
  receivable: z.object({ id: objectIdSchema, status: z.string(), paidAmountCents: z.number().int() }).nullable(),
  status: z.enum(['CHARGED', 'CANCELED']),
  createdAt: isoDateTimeSchema,
});
export type InspectionDamage = z.infer<typeof inspectionDamageSchema>;

/* ------------------------- Fechamento da caução ---------------------- */

export const depositSettlementPreviewSchema = z.object({
  rentalId: objectIdSchema,
  depositHeldCents: z.number().int(),
  debts: z.array(
    z.object({
      receivableId: objectIdSchema,
      kind: z.string(),
      description: z.string(),
      dueDate: isoDateSchema,
      remainingCents: z.number().int(),
      appliedCents: z.number().int(),
    }),
  ),
  appliedCents: z.number().int(),
  refundCents: z.number().int(),
  /** Dívida que sobra depois de usar toda a caução. */
  uncoveredCents: z.number().int(),
  settled: z
    .object({ at: isoDateTimeSchema, appliedCents: z.number().int(), refundCents: z.number().int(), notes: z.string().nullable() })
    .nullable(),
  canSettle: z.boolean(),
  blockedReason: z.string().nullable(),
});
export type DepositSettlementPreview = z.infer<typeof depositSettlementPreviewSchema>;

export const depositSettlementInputSchema = z.object({
  refundBankAccountId: objectIdSchema.optional(),
  notes: optionalString(500),
});

/* ----------------------------- Fidelidade ---------------------------- */

export const loyaltyLevelSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(40),
  minScore: z.number().int().min(0).max(10_000),
  weeklyDiscountPercent: z.number().min(0).max(50),
  benefits: z.array(z.string().trim().min(1).max(120)).max(8),
});
export type LoyaltyLevel = z.infer<typeof loyaltyLevelSchema>;

export const loyaltySettingsSchema = z.object({
  enabled: z.boolean(),
  levels: z
    .array(loyaltyLevelSchema)
    .min(2)
    .max(8)
    .refine((ls) => ls[0]?.minScore === 0, 'O primeiro nível começa em 0 pontos')
    .refine((ls) => ls.every((l, i) => i === 0 || l.minScore > ls[i - 1]!.minScore), 'Os níveis devem ter pontuação crescente'),
});
export type LoyaltySettings = z.infer<typeof loyaltySettingsSchema>;

/** Níveis padrão no estilo do Zarp Acelera (Inicial → Especial). */
export const defaultLoyaltySettings: LoyaltySettings = {
  enabled: true,
  levels: [
    { code: 'INICIAL', name: 'Inicial', minScore: 0, weeklyDiscountPercent: 0, benefits: ['Atendimento pelo WhatsApp'] },
    { code: 'BASICO', name: 'Básico', minScore: 60, weeklyDiscountPercent: 0, benefits: ['Prioridade no agendamento de manutenção'] },
    { code: 'INTERMEDIARIO', name: 'Intermediário', minScore: 120, weeklyDiscountPercent: 2, benefits: ['2% de desconto na semana', 'Indicação premiada'] },
    { code: 'AVANCADO', name: 'Avançado', minScore: 180, weeklyDiscountPercent: 4, benefits: ['4% de desconto na semana', 'Troca de carro sem taxa'] },
    { code: 'ESPECIAL', name: 'Especial', minScore: 240, weeklyDiscountPercent: 6, benefits: ['6% de desconto na semana', 'Troca de carro sem taxa', 'Atendimento preferencial'] },
  ],
};

export const loyaltyCriterionSchema = z.object({
  key: z.enum(['TENURE', 'PAYMENTS', 'INSPECTIONS', 'FINES']),
  label: z.string(),
  points: z.number().int(),
  detail: z.string(),
});

export const loyaltyStatusSchema = z.object({
  enabled: z.boolean(),
  score: z.number().int(),
  level: loyaltyLevelSchema,
  nextLevel: loyaltyLevelSchema.nullable(),
  pointsToNext: z.number().int().nullable(),
  criteria: z.array(loyaltyCriterionSchema),
  computedAt: isoDateTimeSchema,
});
export type LoyaltyStatus = z.infer<typeof loyaltyStatusSchema>;

export interface LoyaltyFacts {
  tenureDays: number;
  overdueInvoices: number;
  paidOnTimeInvoices: number;
  inspectionsOnTime: number;
  inspectionsLate: number;
  recentFines: number;
}

/** Pontuação de fidelidade (regra pura). Cada critério tem teto para não depender de um só. */
export function scoreLoyalty(f: LoyaltyFacts): { score: number; criteria: Array<z.infer<typeof loyaltyCriterionSchema>> } {
  const tenure = Math.min(120, Math.floor(f.tenureDays / 30) * 10);
  const payments = Math.max(-60, Math.min(80, f.paidOnTimeInvoices * 5 - f.overdueInvoices * 20));
  const inspections = Math.max(-45, Math.min(40, f.inspectionsOnTime * 5 - f.inspectionsLate * 15));
  const fines = -Math.min(60, f.recentFines * 15);
  const criteria = [
    { key: 'TENURE' as const, label: 'Tempo de contrato', points: tenure, detail: `${Math.floor(f.tenureDays / 30)} mês(es) como cliente` },
    {
      key: 'PAYMENTS' as const,
      label: 'Pagamentos em dia',
      points: payments,
      detail: `${f.paidOnTimeInvoices} fatura(s) quitada(s)${f.overdueInvoices ? `, ${f.overdueInvoices} em atraso` : ''}`,
    },
    {
      key: 'INSPECTIONS' as const,
      label: 'Vistorias no prazo',
      points: inspections,
      detail: `${f.inspectionsOnTime} no prazo${f.inspectionsLate ? `, ${f.inspectionsLate} atrasada(s)` : ''} (90 dias)`,
    },
    { key: 'FINES' as const, label: 'Direção segura', points: fines, detail: f.recentFines ? `${f.recentFines} multa(s) em 180 dias` : 'Sem multas em 180 dias' },
  ];
  return { score: Math.max(0, criteria.reduce((a, c) => a + c.points, 0)), criteria };
}

export function levelForScore(settings: LoyaltySettings, score: number): { level: LoyaltyLevel; next: LoyaltyLevel | null } {
  const sorted = [...settings.levels].sort((a, b) => a.minScore - b.minScore);
  let idx = 0;
  sorted.forEach((l, i) => {
    if (score >= l.minScore) idx = i;
  });
  return { level: sorted[idx]!, next: sorted[idx + 1] ?? null };
}

/* ------------------------ Contrato e assinatura ---------------------- */

export const contractSignatureStatuses = ['SENT', 'SIGNED', 'REFUSED', 'EXPIRED', 'CANCELED'] as const;
export const contractSignatureStatusSchema = z.enum(contractSignatureStatuses);
export type ContractSignatureStatus = z.infer<typeof contractSignatureStatusSchema>;
export const contractSignatureStatusLabels: Record<ContractSignatureStatus, string> = {
  SENT: 'Aguardando assinatura',
  SIGNED: 'Assinado',
  REFUSED: 'Recusado',
  EXPIRED: 'Expirado',
  CANCELED: 'Cancelado',
};

export const contractSignatureSchema = z.object({
  id: objectIdSchema,
  rentalId: objectIdSchema,
  status: contractSignatureStatusSchema,
  provider: z.string(),
  signUrl: z.string().nullable(),
  identity: z.object({ selfie: z.boolean(), document: z.boolean(), validationType: z.string().nullable() }),
  signedAt: isoDateTimeSchema.nullable(),
  signedFile: z.object({ fileId: objectIdSchema, url: z.string() }).nullable(),
  createdAt: isoDateTimeSchema,
});
export type ContractSignature = z.infer<typeof contractSignatureSchema>;
