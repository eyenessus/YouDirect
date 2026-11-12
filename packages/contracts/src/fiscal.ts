import { z } from 'zod';
import { isoDateSchema, isoDateTimeSchema, objectIdSchema } from './common.js';

/* ------------------------------------------------------------------ *
 * Controle fiscal e recibos.
 *
 * O YuDirect NÃO emite nota fiscal: a NFS-e depende da prefeitura (ou
 * de um emissor contratado) e de dados do contador. O que ele faz:
 *  - gera o recibo de pagamento (PDF), que não substitui a nota;
 *  - lista os recebimentos de serviço ainda SEM nota registrada;
 *  - registra o número/link da nota emitida fora e controla cancelamentos.
 * ------------------------------------------------------------------ */

/** Só recebimentos de serviço entram no controle: aluguel e km excedente. Multa, avaria e caução não. */
export const FISCAL_RECEIVABLE_KINDS = ['RENT', 'OTHER'] as const;

export const fiscalNoteStatuses = ['ISSUED', 'CANCELED'] as const;
export const fiscalNoteStatusSchema = z.enum(fiscalNoteStatuses);
export type FiscalNoteStatus = z.infer<typeof fiscalNoteStatusSchema>;
export const fiscalNoteStatusLabels: Record<FiscalNoteStatus, string> = { ISSUED: 'Emitida', CANCELED: 'Cancelada' };

export const fiscalPeriodQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const fiscalNoteCreateSchema = z.object({
  paymentId: objectIdSchema,
  /** Número da nota como a prefeitura/emissor informou. */
  number: z.string().trim().min(1, 'Informe o número da nota').max(40),
  issuedOn: isoDateSchema,
  /** Link para a nota (opcional): só http(s). */
  url: z
    .string()
    .trim()
    .max(500)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'Use um link http ou https')
    .optional(),
  notes: z.string().trim().max(300).optional(),
});
export type FiscalNoteCreate = z.infer<typeof fiscalNoteCreateSchema>;

export const fiscalNoteCancelSchema = z.object({ reason: z.string().trim().min(3, 'Informe o motivo').max(300) });

export const pendingFiscalPaymentSchema = z.object({
  paymentId: objectIdSchema,
  paidAt: isoDateSchema,
  amountCents: z.number().int(),
  description: z.string(),
  driverName: z.string().nullable(),
  method: z.string(),
});
export type PendingFiscalPayment = z.infer<typeof pendingFiscalPaymentSchema>;

export const fiscalNoteSchema = z.object({
  id: objectIdSchema,
  paymentId: objectIdSchema,
  number: z.string(),
  issuedOn: isoDateSchema,
  amountCents: z.number().int(),
  url: z.string().nullable(),
  notes: z.string().nullable(),
  status: fiscalNoteStatusSchema,
  canceledReason: z.string().nullable(),
  description: z.string(),
  driverName: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type FiscalNote = z.infer<typeof fiscalNoteSchema>;
