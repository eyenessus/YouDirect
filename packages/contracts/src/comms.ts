import { z } from 'zod';
import {
  isoDateTimeSchema,
  nonEmptyString,
  objectIdSchema,
  optionalString,
} from './common.js';
import {
  dispatchDeliveryStatusSchema,
  notificationSeveritySchema,
  notificationTypeSchema,
} from './enums.js';

/* --------------------------- Notificações -------------------------- */

export const notificationSchema = z.object({
  id: objectIdSchema,
  type: notificationTypeSchema,
  severity: notificationSeveritySchema,
  title: z.string(),
  message: z.string(),
  subjectLabel: z.string().nullable(),
  entityType: z.string().nullable(),
  entityId: objectIdSchema.nullable(),
  targetPath: z.string().nullable(),
  readAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = z.object({
  type: notificationTypeSchema.optional(),
  unread: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === true || v === 'true')),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const unreadCountSchema = z.object({ unread: z.number().int() });

/* ------------------------ Templates / Disparo ---------------------- */

export const MESSAGE_TOKENS = [
  { token: '{{nome_motorista}}', label: 'Nome do motorista' },
  { token: '{{nome_empresa}}', label: 'Nome da empresa' },
] as const;

export const messageTemplateSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  body: z.string(),
  isDefault: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type MessageTemplate = z.infer<typeof messageTemplateSchema>;

export const messageTemplateInputSchema = z.object({
  name: nonEmptyString(80),
  body: nonEmptyString(4000),
});
export type MessageTemplateInput = z.infer<typeof messageTemplateInputSchema>;

export const dispatchRequestSchema = z.object({
  templateId: objectIdSchema.optional(),
  body: nonEmptyString(4000),
  driverIds: z.array(objectIdSchema).min(1, 'Selecione ao menos um motorista').max(500),
  consentConfirmed: z.boolean().refine((v) => v === true, 'Confirme o consentimento dos destinatários'),
});
export type DispatchRequest = z.infer<typeof dispatchRequestSchema>;

export const dispatchDeliverySchema = z.object({
  driverId: objectIdSchema,
  driverName: z.string(),
  phone: z.string(),
  status: dispatchDeliveryStatusSchema,
  providerMessageId: z.string().nullable(),
  error: z.string().nullable(),
  manualLink: z.string().nullable(),
  renderedBody: z.string(),
});
export type DispatchDelivery = z.infer<typeof dispatchDeliverySchema>;

export const dispatchSchema = z.object({
  id: objectIdSchema,
  templateId: objectIdSchema.nullable(),
  bodySnapshot: z.string(),
  providerAvailable: z.boolean(),
  providerName: z.string().nullable(),
  summary: z.object({
    total: z.number().int(),
    sent: z.number().int(),
    failed: z.number().int(),
    pending: z.number().int(),
    unavailable: z.number().int(),
  }),
  deliveries: z.array(dispatchDeliverySchema),
  createdAt: isoDateTimeSchema,
});
export type Dispatch = z.infer<typeof dispatchSchema>;

export const dispatchRetrySchema = z.object({
  driverIds: z.array(objectIdSchema).min(1).max(500).optional(),
});

/** Substituição de tokens — compartilhada entre prévia (web) e envio (api). */
export function renderMessage(
  body: string,
  vars: { driverName: string; companyName: string },
): string {
  return body
    .replace(/\{\{\s*nome_motorista\s*\}\}/g, vars.driverName)
    .replace(/\{\{\s*nome_empresa\s*\}\}/g, vars.companyName);
}

export const messageHistoryQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const dispatchNotesSchema = z.object({ notes: optionalString(500) });
