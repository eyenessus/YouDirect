import { z } from 'zod';
import { isoDateTimeSchema, objectIdSchema } from './common.js';

/* ------------------------------------------------------------------ *
 * Análise de crédito do motorista pela Serasa Experian
 * (Relatório Básico PF — API "person-information-report").
 *
 * A consulta é paga, por isso: finalidade obrigatória, confirmação de
 * custo, reaproveitamento dentro da validade, bloqueio de duplicidade e
 * limite mensal. O resultado nunca decide sozinho: a decisão da locação
 * é sempre registrada por uma pessoa, com justificativa.
 * ------------------------------------------------------------------ */

export const creditPurposes = ['PRE_LOCACAO', 'RENOVACAO_CONTRATO', 'REVISAO_INADIMPLENCIA'] as const;
export const creditPurposeSchema = z.enum(creditPurposes);
export type CreditPurpose = z.infer<typeof creditPurposeSchema>;
export const creditPurposeLabels: Record<CreditPurpose, string> = {
  PRE_LOCACAO: 'Análise para nova locação',
  RENOVACAO_CONTRATO: 'Renovação do contrato',
  REVISAO_INADIMPLENCIA: 'Revisão por atraso de pagamento',
};

/**
 * PENDING: enviada à Serasa, aguardando resposta.
 * COMPLETED: relatório recebido.
 * NOT_AVAILABLE: a Serasa respondeu que não há informação disponível para o CPF
 *   (código 30) — isso NÃO significa ausência de risco.
 * FAILED: a Serasa recusou antes de processar (credencial, produto não
 *   contratado, CPF inválido, limite) — não houve consulta cobrada.
 * UNCERTAIN: tempo esgotado, erro do servidor ou resposta fora do formato —
 *   pode ter sido cobrada; o sistema NÃO repete automaticamente.
 */
export const creditCheckStatuses = ['PENDING', 'COMPLETED', 'NOT_AVAILABLE', 'FAILED', 'UNCERTAIN'] as const;
export const creditCheckStatusSchema = z.enum(creditCheckStatuses);
export type CreditCheckStatus = z.infer<typeof creditCheckStatusSchema>;
export const creditCheckStatusLabels: Record<CreditCheckStatus, string> = {
  PENDING: 'Em andamento',
  COMPLETED: 'Concluída',
  NOT_AVAILABLE: 'Sem informação disponível',
  FAILED: 'Não realizada',
  UNCERTAIN: 'Resultado incerto',
};

export const creditDecisions = ['APROVADO', 'APROVADO_COM_CAUCAO', 'PENDENTE_DOCUMENTOS', 'RECUSADO'] as const;
export const creditDecisionSchema = z.enum(creditDecisions);
export type CreditDecision = z.infer<typeof creditDecisionSchema>;
export const creditDecisionLabels: Record<CreditDecision, string> = {
  APROVADO: 'Aprovado',
  APROVADO_COM_CAUCAO: 'Aprovado com caução maior',
  PENDENTE_DOCUMENTOS: 'Pendente de documentos',
  RECUSADO: 'Recusado',
};

/** Categorias de anotação negativa normalizadas a partir do bloco negativeData. */
export const creditNegativeTypes = ['PEFIN', 'REFIN', 'PROTESTO', 'CHEQUE', 'COBRANCA'] as const;
export type CreditNegativeType = (typeof creditNegativeTypes)[number];
export const creditNegativeTypeLabels: Record<CreditNegativeType, string> = {
  PEFIN: 'Pendências financeiras (PEFIN)',
  REFIN: 'Restrições financeiras (REFIN)',
  PROTESTO: 'Protestos',
  CHEQUE: 'Cheques sem fundo',
  COBRANCA: 'Dívidas vencidas em cobrança',
};

/* ---------------------------- Configuração ---------------------------- */

export const creditSettingsSchema = z.object({
  /** Liga a consulta para a organização (além das credenciais no servidor). */
  enabled: z.boolean(),
  /** Valor contratado por consulta, só para estimativa. null = não informado. */
  costPerQueryCents: z.number().int().min(0).max(100_000).nullable(),
  /** Máximo de consultas cobráveis por mês. null = sem limite. */
  monthlyLimit: z.number().int().min(1).max(100_000).nullable(),
  /** Dias em que uma consulta concluída é reaproveitada para o mesmo motorista. 0 = nunca. */
  reuseDays: z.number().int().min(0).max(90),
  /** Dias em que o conteúdo do relatório fica guardado (depois é apagado; fica só o registro). */
  retentionDays: z.number().int().min(7).max(1825),
});
export type CreditSettings = z.infer<typeof creditSettingsSchema>;
export const defaultCreditSettings: CreditSettings = {
  enabled: false,
  costPerQueryCents: null,
  monthlyLimit: 50,
  reuseDays: 30,
  retentionDays: 90,
};

export const creditCheckRequestSchema = z.object({
  purpose: creditPurposeSchema,
  /** Por que a consulta é necessária (fica na trilha de auditoria). */
  justification: z.string().trim().min(10, 'Descreva a finalidade (mínimo 10 caracteres).').max(500),
  /** O operador confirma que o motorista foi informado da consulta (aviso de privacidade). */
  holderInformed: z.literal(true, { errorMap: () => ({ message: 'Confirme que o motorista foi informado da consulta.' }) }),
  /** O operador confirma ciência do custo da consulta. */
  confirmCost: z.literal(true, { errorMap: () => ({ message: 'Confirme o custo da consulta.' }) }),
  /** Ignora uma consulta recente reaproveitável e faz uma nova (nova cobrança). */
  forceNew: z.boolean().default(false),
  rentalId: objectIdSchema.nullable().optional(),
  /** Chave gerada pela tela: cliques repetidos devolvem a mesma consulta. */
  idempotencyKey: z.string().trim().min(8).max(80),
});
export type CreditCheckRequest = z.infer<typeof creditCheckRequestSchema>;

export const creditReviewSchema = z.object({
  decision: creditDecisionSchema,
  notes: z.string().trim().min(5, 'Justifique a decisão (mínimo 5 caracteres).').max(1000),
});
export type CreditReviewInput = z.infer<typeof creditReviewSchema>;

/* ------------------------------ Relatório ------------------------------ */

export const creditNegativeItemSchema = z.object({
  date: z.string().nullable(),
  creditor: z.string().nullable(),
  amountCents: z.number().int().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  subJudice: z.boolean(),
});

export const creditNegativeGroupSchema = z.object({
  type: z.enum(creditNegativeTypes),
  /** RETURNED: bloco veio; NOT_RETURNED: o relatório contratado não trouxe este bloco. */
  availability: z.enum(['RETURNED', 'NOT_RETURNED', 'ERROR']),
  count: z.number().int(),
  balanceCents: z.number().int(),
  firstDate: z.string().nullable(),
  lastDate: z.string().nullable(),
  items: z.array(creditNegativeItemSchema),
  message: z.string().nullable(),
});
export type CreditNegativeGroup = z.infer<typeof creditNegativeGroupSchema>;

export const creditScoreSchema = z.object({
  score: z.number().int(),
  model: z.string().nullable(),
  range: z.string().nullable(),
  defaultRate: z.string().nullable(),
  message: z.string().nullable(),
});
export type CreditScore = z.infer<typeof creditScoreSchema>;

export const creditReportSchema = z.object({
  reportName: z.string().nullable(),
  consumerName: z.string().nullable(),
  registrationStatus: z.string().nullable(),
  score: creditScoreSchema.nullable(),
  /** Mensagem/erro do bloco de score quando ele não veio. */
  scoreMessage: z.string().nullable(),
  /** null = o relatório não informou (não é o mesmo que "sem pendências"). */
  hasNegative: z.boolean().nullable(),
  negatives: z.array(creditNegativeGroupSchema),
  stolenDocumentAlerts: z.number().int().nullable(),
  inquiriesThisMonth: z.number().int().nullable(),
});
export type CreditReport = z.infer<typeof creditReportSchema>;

/* -------------------------------- DTOs -------------------------------- */

export const creditCheckSchema = z.object({
  id: objectIdSchema,
  driverId: objectIdSchema,
  driverName: z.string().nullable(),
  rentalId: objectIdSchema.nullable(),
  purpose: creditPurposeSchema,
  justification: z.string(),
  status: creditCheckStatusSchema,
  /** Código interno do desfecho (PRODUCT_NOT_ENABLED, INVALID_DOCUMENT…). */
  outcome: z.string().nullable(),
  message: z.string().nullable(),
  environment: z.enum(['homologacao', 'producao']),
  reportName: z.string(),
  billable: z.enum(['YES', 'NO', 'UNKNOWN']),
  estimatedCostCents: z.number().int().nullable(),
  requestedBy: z.object({ id: objectIdSchema, name: z.string() }).nullable(),
  requestedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
  /** Presente só no detalhe e enquanto não expirou. */
  report: creditReportSchema.nullable(),
  reportExpiresAt: isoDateTimeSchema.nullable(),
  reportPurged: z.boolean(),
  review: z
    .object({
      decision: creditDecisionSchema,
      notes: z.string(),
      reviewedBy: z.string(),
      reviewedAt: isoDateTimeSchema,
    })
    .nullable(),
});
export type CreditCheck = z.infer<typeof creditCheckSchema>;

export interface CreditCheckResult {
  check: CreditCheck;
  /** true quando uma consulta recente foi reaproveitada (sem nova cobrança). */
  reused: boolean;
}

export interface CreditIntegrationStatus {
  connected: boolean;
  environment: 'homologacao' | 'producao';
  message: string;
  reportName: string;
  optionalFeatures: string[];
  scoreModel: string | null;
  settings: CreditSettings;
  usage: { month: string; billable: number; uncertain: number; estimatedCostCents: number | null; limit: number | null };
}

export interface CreditUsageRow {
  month: string;
  total: number;
  billable: number;
  notBilled: number;
  uncertain: number;
  reused: number;
  estimatedCostCents: number | null;
}

export interface CreditUsageReport {
  months: CreditUsageRow[];
  byUser: Array<{ userId: string; name: string; total: number }>;
}

/* ------------------------- Regras puras (testáveis) ------------------------- */

/** Mês (AAAA-MM) no fuso de São Paulo. */
export function creditMonth(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  return `${y}-${m}`;
}

/** Consultas que contam no limite e no custo (cobradas ou possivelmente cobradas). */
export function countsAsBillable(status: CreditCheckStatus): boolean {
  return status === 'COMPLETED' || status === 'NOT_AVAILABLE' || status === 'UNCERTAIN' || status === 'PENDING';
}
