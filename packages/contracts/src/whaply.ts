import { z } from 'zod';
import { isoDateTimeSchema, objectIdSchema } from './common.js';

/* ------------------------------------------------------------------ *
 * Contrato v1 entre YuDirect e Whaply (vistoria por WhatsApp).
 * Referência: docs/architecture/yudirect-whaply-vistoria-plan.md §5.
 *
 * Regras de compatibilidade:
 *  - mudanças apenas aditivas dentro da v1;
 *  - campos desconhecidos são ignorados (schemas não usam .strict());
 *  - tipos de evento desconhecidos são aceitos e registrados.
 * ------------------------------------------------------------------ */

export const WHAPLY_CONTRACT_VERSION = 1 as const;

/* --------------------------- telefone ------------------------------ */

/**
 * Converte dígitos locais brasileiros (10/11 dígitos, como o YuDirect
 * armazena) para E.164. Retorna `null` quando o número não é válido.
 */
export function toE164BR(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D+/g, '');
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) digits = digits.slice(2);
  if (digits.length !== 10 && digits.length !== 11) return null;
  const ddd = Number(digits.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  return `+55${digits}`;
}

export const phoneE164Schema = z.string().regex(/^\+[1-9]\d{9,14}$/, 'Telefone deve estar no formato E.164');

/* ---------------------------- enums -------------------------------- */

export const messageKinds = ['INSPECTION_REQUEST', 'REMINDER', 'CORRECTION', 'SESSION_PROMPT'] as const;
export const messageKindSchema = z.enum(messageKinds);
export type MessageKind = z.infer<typeof messageKindSchema>;

export const messageKindLabels: Record<MessageKind, string> = {
  INSPECTION_REQUEST: 'Solicitação de vistoria',
  REMINDER: 'Lembrete',
  CORRECTION: 'Correção de fotos',
  SESSION_PROMPT: 'Instrução da coleta',
};

/**
 * Estados de uma mensagem do ponto de vista do YuDirect. A ordem importa:
 * eventos só promovem para frente (ver `messageStatusRank`).
 */
export const messageStatuses = [
  'INTENT_CREATED',
  'RETRY_SCHEDULED',
  'SUBMITTED_TO_WHAPLY',
  'ACCEPTED_BY_WHAPLY',
  'DEFERRED',
  'ACCEPTED_BY_META',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'CANCELED',
] as const;
export const messageStatusSchema = z.enum(messageStatuses);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const messageStatusLabels: Record<MessageStatus, string> = {
  INTENT_CREATED: 'Envio pendente',
  RETRY_SCHEDULED: 'Aguardando nova tentativa',
  SUBMITTED_TO_WHAPLY: 'Em processamento',
  ACCEPTED_BY_WHAPLY: 'Aceita pelo Whaply',
  DEFERRED: 'Adiada pelo canal',
  ACCEPTED_BY_META: 'Aceita pela Meta',
  SENT: 'Enviada',
  DELIVERED: 'Entregue',
  READ: 'Lida',
  FAILED: 'Falhou',
  CANCELED: 'Cancelada',
};

const RANK: Record<MessageStatus, number> = {
  INTENT_CREATED: 0,
  RETRY_SCHEDULED: 1,
  SUBMITTED_TO_WHAPLY: 2,
  ACCEPTED_BY_WHAPLY: 3,
  DEFERRED: 4,
  ACCEPTED_BY_META: 5,
  SENT: 6,
  DELIVERED: 7,
  READ: 8,
  // Estados terminais laterais: tratados à parte em `canPromoteMessage`.
  FAILED: 100,
  CANCELED: 101,
};

export function messageStatusRank(status: MessageStatus): number {
  return RANK[status];
}

/**
 * Regra de promoção monotônica:
 *  - nunca regride (webhook fora de ordem);
 *  - CANCELED é terminal;
 *  - FAILED pode chegar depois de SENT (falha de entrega), mas não
 *    depois de DELIVERED/READ;
 *  - um sucesso posterior (ex.: retry aceito) pode sair de FAILED apenas
 *    se vier do transporte — tratado no serviço, não aqui.
 */
export function canPromoteMessage(from: MessageStatus, to: MessageStatus): boolean {
  if (from === to) return false;
  if (from === 'CANCELED') return false;
  if (to === 'CANCELED') return RANK[from] < RANK.ACCEPTED_BY_META;
  if (to === 'FAILED') return from !== 'READ' && from !== 'DELIVERED';
  if (from === 'FAILED') return false;
  if (to === 'RETRY_SCHEDULED') return from === 'INTENT_CREATED' || from === 'SUBMITTED_TO_WHAPLY' || from === 'RETRY_SCHEDULED';
  if (to === 'SUBMITTED_TO_WHAPLY') return from === 'INTENT_CREATED' || from === 'RETRY_SCHEDULED';
  return RANK[to] > RANK[from];
}

export const collectionStatuses = [
  'NOT_SCHEDULED',
  'SCHEDULED',
  'BLOCKED_NO_CONSENT',
  'REQUESTED',
  'IN_PROGRESS',
  'PARTIAL',
  'COMPLETE',
  'EXPIRED',
  'FAILED',
  'CANCELED',
] as const;
export const collectionStatusSchema = z.enum(collectionStatuses);
export type CollectionStatus = z.infer<typeof collectionStatusSchema>;

export const collectionStatusLabels: Record<CollectionStatus, string> = {
  NOT_SCHEDULED: 'Sem coleta automática',
  SCHEDULED: 'Agendada',
  BLOCKED_NO_CONSENT: 'Bloqueada (sem consentimento)',
  REQUESTED: 'Solicitação enviada',
  IN_PROGRESS: 'Aguardando fotografias',
  PARTIAL: 'Fotos parciais',
  COMPLETE: 'Fotos completas',
  EXPIRED: 'Expirada',
  FAILED: 'Falha operacional',
  CANCELED: 'Cancelada',
};

export const collectionModes = ['WHATSAPP', 'WEB_LINK', 'MANUAL'] as const;
export type CollectionMode = (typeof collectionModes)[number];

export const errorSources = ['YUDIRECT', 'TRANSPORT', 'WHAPLY', 'META'] as const;
export type ErrorSource = (typeof errorSources)[number];

export const consentSources = ['CONTRACT', 'IN_PERSON', 'WHATSAPP', 'OTHER'] as const;
export const consentSourceSchema = z.enum(consentSources);
export type ConsentSource = z.infer<typeof consentSourceSchema>;

export const consentSourceLabels: Record<ConsentSource, string> = {
  CONTRACT: 'Contrato de locação',
  IN_PERSON: 'Presencial',
  WHATSAPP: 'Pelo WhatsApp',
  OTHER: 'Outro',
};

/* ------------------- YuDirect → Whaply: comandos ------------------- */

export const sessionStepSchema = z.object({
  code: z.string().min(1).max(32),
  label: z.string().min(1).max(60),
  instruction: z.string().max(300).nullable().optional(),
  type: z.enum(['IMAGE', 'NUMBER']),
});
export type SessionStep = z.infer<typeof sessionStepSchema>;

export const whaplyMessageRequestSchema = z.object({
  contractVersion: z.literal(WHAPLY_CONTRACT_VERSION),
  idempotencyKey: z.string().min(8).max(200),
  correlationId: z.string().uuid(),
  externalRef: z.object({ type: z.literal('inspection'), id: objectIdSchema }),
  kind: z.enum(['INSPECTION_REQUEST', 'REMINDER', 'CORRECTION']),
  recipient: z.object({ phoneE164: phoneE164Schema, name: z.string().min(1).max(120) }),
  consent: z.object({ grantedAt: isoDateTimeSchema, source: consentSourceSchema }),
  template: z.object({
    name: z.string().min(1).max(512),
    language: z.string().min(2).max(10),
    bodyParams: z.array(z.string().max(1024)).max(10),
    urlButtonParam: z.string().max(200).nullable().optional(),
  }),
  session: z
    .object({
      steps: z.array(sessionStepSchema).min(1).max(13),
      expiresAt: isoDateTimeSchema,
      round: z.number().int().min(0).max(50),
    })
    .nullable(),
});
export type WhaplyMessageRequest = z.infer<typeof whaplyMessageRequestSchema>;

export const whaplyRequestStates = [
  'ACCEPTED_BY_WHAPLY',
  'DEFERRED',
  'ACCEPTED_BY_META',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'CANCELED',
] as const;

export const whaplyMessageAcceptedSchema = z.object({
  requestId: z.string().min(1).max(64),
  state: z.enum(whaplyRequestStates),
  wamid: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
});
export type WhaplyMessageAccepted = z.infer<typeof whaplyMessageAcceptedSchema>;

export const whaplySessionCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('CANCEL'), reason: z.string().max(200) }),
  z.object({ type: z.literal('EXTEND'), expiresAt: isoDateTimeSchema }),
]);
export type WhaplySessionCommand = z.infer<typeof whaplySessionCommandSchema>;

export const whaplyErrorCodes = [
  'VALIDATION',
  'SIGNATURE_INVALID',
  'TIMESTAMP_SKEW',
  'NONCE_REPLAY',
  'SCOPE_DENIED',
  'IDEMPOTENCY_CONFLICT',
  'SESSION_BUSY',
  'CONSENT_REQUIRED',
  'TEMPLATE_NOT_APPROVED',
  'TEMPLATE_CATEGORY_CHANGED',
  'RECIPIENT_INVALID',
  'OPTED_OUT',
  'RATE_LIMITED',
  'CHANNEL_UNAVAILABLE',
  'NOT_FOUND',
  'INTERNAL',
] as const;
export type WhaplyErrorCode = (typeof whaplyErrorCodes)[number];

export const whaplyErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean().optional(),
    requestId: z.string().optional(),
  }),
});

/* -------------------- Whaply → YuDirect: eventos ------------------- */

export const pricingSchema = z
  .object({
    billable: z.boolean().nullable().optional(),
    category: z.string().nullable().optional(),
    pricingModel: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
  })
  .nullable()
  .optional();

const messageEventData = z.object({
  /** Chave de idempotência do pedido (ausente em instruções da sessão). */
  idempotencyKey: z.string().max(200).nullable().optional(),
  wamid: z.string().nullable().optional(),
  kind: messageKindSchema.optional(),
  pricing: pricingSchema,
  code: z.union([z.string(), z.number()]).nullable().optional(),
  title: z.string().max(500).nullable().optional(),
  permanent: z.boolean().optional(),
  source: z.enum(['WHAPLY', 'META']).optional(),
  retryAt: isoDateTimeSchema.nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
});

const mediaEventData = z.object({
  slotCode: z.string().max(32).nullable(),
  mediaRef: z.string().min(16).max(200),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string().max(100),
  size: z.number().int().min(1).max(20 * 1024 * 1024),
  wamid: z.string().max(200),
  contextWamid: z.string().max(200).nullable().optional(),
  round: z.number().int().min(0).max(50).optional(),
  receivedAt: isoDateTimeSchema.optional(),
});

export const whaplyEventTypes = [
  'message.accepted',
  'message.deferred',
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'session.started',
  'session.media_received',
  'session.text_received',
  'session.completed',
  'session.expired',
  'session.opted_out',
  'media.unmatched',
  'template.status_changed',
] as const;
export type WhaplyEventType = (typeof whaplyEventTypes)[number];

export const whaplyEventEnvelopeSchema = z.object({
  contractVersion: z.number().int().min(1),
  eventId: z.string().uuid(),
  seq: z.number().int().min(1),
  type: z.string().min(1).max(64),
  occurredAt: isoDateTimeSchema,
  correlationId: z.string().max(100).nullable().optional(),
  externalRef: z.object({ type: z.string(), id: z.string() }).nullable().optional(),
  requestId: z.string().max(64).nullable().optional(),
  sessionId: z.string().max(64).nullable().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type WhaplyEventEnvelope = z.infer<typeof whaplyEventEnvelopeSchema>;

export const whaplyEventDataSchemas = {
  'message.accepted': messageEventData,
  'message.deferred': messageEventData,
  'message.sent': messageEventData,
  'message.delivered': messageEventData,
  'message.read': messageEventData,
  'message.failed': messageEventData,
  'session.started': z.object({ round: z.number().int().min(0).optional() }),
  'session.media_received': mediaEventData,
  'session.text_received': z.object({
    slotCode: z.string().max(32),
    value: z.string().max(40),
    wamid: z.string().max(200).optional(),
  }),
  'session.completed': z.object({ round: z.number().int().min(0).optional() }),
  'session.expired': z.object({ round: z.number().int().min(0).optional() }),
  'session.opted_out': z.object({ keyword: z.string().max(40).optional() }),
  'media.unmatched': mediaEventData.extend({ reason: z.string().max(200) }),
  'template.status_changed': z.object({
    name: z.string().max(512),
    language: z.string().max(10).optional(),
    status: z.string().max(40),
    category: z.string().max(40).nullable().optional(),
    reason: z.string().max(500).nullable().optional(),
  }),
} as const;

/* -------------------- configuração e consentimento ----------------- */

export const inspectionWhatsappSettingsSchema = z.object({
  enabled: z.boolean(),
  sendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário no formato HH:mm'),
  reminderAfterHours: z.coerce.number().int().min(1).max(168),
  maxReminders: z.coerce.number().int().min(0).max(3),
  collectionTtlHours: z.coerce.number().int().min(6).max(336),
  instructions: z.record(z.string().max(32), z.string().max(300)).default({}),
});
export type InspectionWhatsappSettings = z.infer<typeof inspectionWhatsappSettingsSchema>;

export const DEFAULT_INSPECTION_WHATSAPP_SETTINGS: InspectionWhatsappSettings = {
  enabled: false,
  sendTime: '09:00',
  reminderAfterHours: 24,
  maxReminders: 1,
  collectionTtlHours: 72,
  instructions: {},
};

export const driverConsentUpdateSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('GRANT'), source: consentSourceSchema, grantedAt: isoDateTimeSchema.optional() }),
  z.object({ action: z.literal('REVOKE'), reason: z.string().max(200).optional() }),
]);
export type DriverConsentUpdate = z.infer<typeof driverConsentUpdateSchema>;

export const driverConsentSchema = z
  .object({
    status: z.enum(['GRANTED', 'REVOKED']),
    grantedAt: isoDateTimeSchema.nullable(),
    source: consentSourceSchema.nullable(),
    revokedAt: isoDateTimeSchema.nullable(),
    revokedSource: z.enum(['OPERATOR', 'WHATSAPP_STOP']).nullable(),
  })
  .nullable();
export type DriverConsent = z.infer<typeof driverConsentSchema>;

export const correctionRequestSchema = z.object({
  slots: z.array(z.string().min(1).max(32)).min(1).max(13),
  reason: z.string().trim().min(3).max(300),
});
export type CorrectionRequest = z.infer<typeof correctionRequestSchema>;

/** Código reservado do passo de quilometragem na coleta guiada. */
export const ODOMETER_STEP_CODE = 'ODOMETER';

/* --------------------- painel de mensagens (DTOs) ------------------ */

export const messagingListQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: messageStatusSchema.optional(),
  kind: messageKindSchema.optional(),
  q: z.string().trim().max(120).optional(),
  inspectionId: objectIdSchema.optional(),
  needsAction: z
    .union([z.boolean(), z.string()])
    .transform((v) => v === true || v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MessagingListQuery = z.infer<typeof messagingListQuerySchema>;

export const messagingRateSchema = z.object({
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION', 'SERVICE']),
  currency: z.enum(['BRL', 'USD']),
  amount: z.coerce.number().min(0).max(100),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().trim().min(3).max(300),
});
export type MessagingRateInput = z.infer<typeof messagingRateSchema>;
