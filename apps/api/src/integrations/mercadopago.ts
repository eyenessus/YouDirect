import { createHmac, timingSafeEqual } from 'node:crypto';
import { pixStatus, type Env, type IntegrationStatus } from '../config/env.js';

/* ------------------------------------------------------------------ *
 * Pix pelo Mercado Pago (API de pagamentos v1).
 * - Criação: POST /v1/payments com payment_method_id "pix" e
 *   X-Idempotency-Key (repetir a chamada não cria outro Pix).
 * - Confirmação: nunca confiamos no corpo do webhook; consultamos
 *   GET /v1/payments/{id} e só damos baixa com status "approved".
 * - Webhook: assinatura x-signature (ts, v1) = HMAC-SHA256 do manifest
 *   "id:{data.id minúsculo};request-id:{x-request-id};ts:{ts};".
 * ------------------------------------------------------------------ */

export interface PixCreateInput {
  amountCents: number;
  description: string;
  externalReference: string;
  idempotencyKey: string;
  expiresAt: Date;
  notificationUrl: string | null;
  payer: { email: string; firstName: string; lastName: string; cpf: string | null };
}

export interface PixCreated {
  providerPaymentId: string;
  status: string;
  qrCode: string | null;
  qrCodeBase64: string | null;
  ticketUrl: string | null;
}

export interface PixPaymentInfo {
  providerPaymentId: string;
  status: string;
  amountCents: number;
  externalReference: string | null;
  paidAt: Date | null;
}

export interface PixProvider {
  status(): IntegrationStatus;
  create(input: PixCreateInput): Promise<PixCreated>;
  get(providerPaymentId: string): Promise<PixPaymentInfo>;
  cancel(providerPaymentId: string): Promise<void>;
}

const TIMEOUT_MS = 10_000;

/** Data no formato aceito pelo Mercado Pago: yyyy-MM-dd'T'HH:mm:ss.SSSZ (offset -03:00). */
export function mpDate(d: Date): string {
  const local = new Date(d.getTime() - 3 * 3600 * 1000);
  return `${local.toISOString().slice(0, 23)}-03:00`;
}

export function createPixProvider(env: Env): PixProvider {
  const status = pixStatus(env);
  const base = env.MERCADOPAGO_API_URL.replace(/\/$/, '');
  const headers = () => ({
    authorization: `Bearer ${env.MERCADOPAGO_ACCESS_TOKEN}`,
    'content-type': 'application/json',
    accept: 'application/json',
  });

  return {
    status: () => status,

    async create(input) {
      if (!status.connected) throw new Error(status.message);
      const res = await fetch(`${base}/v1/payments`, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { ...headers(), 'X-Idempotency-Key': input.idempotencyKey },
        body: JSON.stringify({
          transaction_amount: Number((input.amountCents / 100).toFixed(2)),
          description: input.description.slice(0, 200),
          payment_method_id: 'pix',
          external_reference: input.externalReference,
          date_of_expiration: mpDate(input.expiresAt),
          ...(input.notificationUrl ? { notification_url: input.notificationUrl } : {}),
          payer: {
            email: input.payer.email,
            first_name: input.payer.firstName,
            last_name: input.payer.lastName,
            ...(input.payer.cpf ? { identification: { type: 'CPF', number: input.payer.cpf } } : {}),
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: number | string;
        status?: string;
        message?: string;
        point_of_interaction?: { transaction_data?: { qr_code?: string; qr_code_base64?: string; ticket_url?: string } };
      };
      if (!res.ok || body.id === undefined) {
        throw new Error(`Mercado Pago recusou a cobrança (HTTP ${res.status}${body.message ? `: ${body.message}` : ''}).`);
      }
      const tx = body.point_of_interaction?.transaction_data;
      return {
        providerPaymentId: String(body.id),
        status: body.status ?? 'pending',
        qrCode: tx?.qr_code ?? null,
        qrCodeBase64: tx?.qr_code_base64 ?? null,
        ticketUrl: tx?.ticket_url ?? null,
      };
    },

    async get(providerPaymentId) {
      if (!status.connected) throw new Error(status.message);
      const res = await fetch(`${base}/v1/payments/${encodeURIComponent(providerPaymentId)}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: headers(),
      });
      if (!res.ok) throw new Error(`Mercado Pago retornou HTTP ${res.status} ao consultar o pagamento.`);
      const body = (await res.json()) as {
        id: number | string;
        status: string;
        transaction_amount: number;
        external_reference?: string | null;
        date_approved?: string | null;
      };
      return {
        providerPaymentId: String(body.id),
        status: body.status,
        amountCents: Math.round(Number(body.transaction_amount) * 100),
        externalReference: body.external_reference ?? null,
        paidAt: body.date_approved ? new Date(body.date_approved) : null,
      };
    },

    async cancel(providerPaymentId) {
      if (!status.connected) return;
      await fetch(`${base}/v1/payments/${encodeURIComponent(providerPaymentId)}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: headers(),
        body: JSON.stringify({ status: 'cancelled' }),
      }).catch(() => undefined);
    },
  };
}

/**
 * Valida a assinatura do webhook do Mercado Pago. Comparação em tempo
 * constante; rejeita notificações com mais de 15 minutos (replay).
 */
export function verifyMercadoPagoSignature(params: {
  secret: string;
  signatureHeader: string | undefined;
  requestId: string | undefined;
  dataId: string | undefined;
  now?: number;
  toleranceMs?: number;
}): boolean {
  if (!params.signatureHeader) return false;
  const parts = Object.fromEntries(
    params.signatureHeader.split(',').map((p) => {
      const [k, ...v] = p.trim().split('=');
      return [k?.trim(), v.join('=').trim()];
    }),
  ) as Record<string, string>;
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return false;
  const tsNum = Number(ts);
  const now = params.now ?? Date.now();
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > (params.toleranceMs ?? 15 * 60 * 1000)) return false;

  const manifestParts: string[] = [];
  if (params.dataId) manifestParts.push(`id:${params.dataId.toLowerCase()}`);
  if (params.requestId) manifestParts.push(`request-id:${params.requestId}`);
  manifestParts.push(`ts:${ts}`);
  const manifest = `${manifestParts.join(';')};`;
  const expected = createHmac('sha256', params.secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
