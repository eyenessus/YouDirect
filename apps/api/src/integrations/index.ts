import {
  billingStatus,
  emailStatus,
  postalCodeStatus,
  trafficFinesStatus,
  whatsappStatus,
  type Env,
  type IntegrationStatus,
} from '../config/env.js';
import { createWhaplyClient, type WhaplyClient } from './whaply/client.js';

/* ------------------------------------------------------------------ *
 * Adapters de integrações externas.
 *
 * Regra inegociável (prompt §0.5): nenhuma operação é apresentada como
 * "enviada", "paga" ou "consultada" sem confirmação real do provedor.
 * Sem credenciais, cada adapter devolve `available: false` com uma
 * mensagem honesta — nunca um sucesso simulado.
 * ------------------------------------------------------------------ */

export interface SendResult {
  delivered: boolean;
  providerMessageId: string | null;
  error: string | null;
  /** Ação manual disponível ao operador quando não há provedor. */
  manualLink: string | null;
}

export interface WhatsAppProvider {
  status(): IntegrationStatus;
  send(to: string, body: string, idempotencyKey: string): Promise<SendResult>;
  manualLink(to: string, body: string): string;
}

export interface EmailProvider {
  status(): IntegrationStatus;
  send(to: string, subject: string, body: string): Promise<SendResult>;
}

export interface PostalCodeProvider {
  status(): IntegrationStatus;
  lookup(postalCode: string): Promise<{
    postalCode: string;
    street: string | null;
    district: string | null;
    city: string | null;
    state: string | null;
  } | null>;
}

export interface TrafficFine {
  code: string;
  description: string;
  occurredAt: string | null;
  amountCents: number;
  status: string;
}

export interface TrafficFinesProvider {
  status(): IntegrationStatus;
  query(params: { plate: string; renavam: string | null; state: string | null }): Promise<TrafficFine[]>;
}

export interface BillingProvider {
  status(): IntegrationStatus;
  /** Retorna o link oficial do provedor ou `null` quando não conectado. */
  paymentLink(providerInvoiceId: string): Promise<string | null>;
}

export interface Integrations {
  whatsapp: WhatsAppProvider;
  email: EmailProvider;
  postalCode: PostalCodeProvider;
  trafficFines: TrafficFinesProvider;
  billing: BillingProvider;
  /** Canal oficial de WhatsApp da FF Veículos via Whaply (vistoria guiada). */
  whaply: WhaplyClient;
}

/** Nenhuma chamada a provedor externo pode prender a requisição indefinidamente. */
export const INTEGRATION_TIMEOUT_MS = 10_000;

const UNAVAILABLE = (message: string): SendResult => ({
  delivered: false,
  providerMessageId: null,
  error: message,
  manualLink: null,
});

function waMeLink(phone: string, body: string): string {
  const digits = phone.replace(/\D+/g, '');
  const withCountry = digits.length <= 11 ? `55${digits}` : digits;
  return `https://wa.me/${withCountry}?text=${encodeURIComponent(body)}`;
}

export function createIntegrations(env: Env): Integrations {
  const wa = whatsappStatus(env);
  const mail = emailStatus(env);
  const cep = postalCodeStatus(env);
  const fines = trafficFinesStatus(env);
  const billing = billingStatus(env);

  return {
    whaply: createWhaplyClient(env),

    whatsapp: {
      status: () => wa,
      manualLink: (to, body) => waMeLink(to, body),
      async send(to, body, idempotencyKey) {
        if (!wa.connected) {
          return {
            delivered: false,
            providerMessageId: null,
            error: wa.message,
            manualLink: waMeLink(to, body),
          };
        }
        try {
          const res = await fetch(env.WHATSAPP_API_URL!, {
            signal: AbortSignal.timeout(INTEGRATION_TIMEOUT_MS),
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${env.WHATSAPP_API_TOKEN}`,
              'idempotency-key': idempotencyKey,
            },
            body: JSON.stringify({ to, body, from: env.WHATSAPP_SENDER_ID ?? undefined }),
          });
          if (!res.ok) {
            return {
              delivered: false,
              providerMessageId: null,
              error: `Provedor retornou HTTP ${res.status}.`,
              manualLink: waMeLink(to, body),
            };
          }
          const payload = (await res.json().catch(() => ({}))) as { id?: string; messageId?: string };
          return {
            delivered: true,
            providerMessageId: payload.id ?? payload.messageId ?? null,
            error: null,
            manualLink: null,
          };
        } catch (err) {
          return {
            delivered: false,
            providerMessageId: null,
            error: `Falha ao contatar o provedor: ${(err as Error).message}`,
            manualLink: waMeLink(to, body),
          };
        }
      },
    },

    email: {
      status: () => mail,
      async send(to, subject, body) {
        if (!mail.connected) return UNAVAILABLE(mail.message);
        try {
          const res = await fetch(env.EMAIL_API_URL!, {
            signal: AbortSignal.timeout(INTEGRATION_TIMEOUT_MS),
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${env.EMAIL_API_TOKEN}` },
            body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text: body }),
          });
          if (!res.ok) return UNAVAILABLE(`Provedor de e-mail retornou HTTP ${res.status}.`);
          const payload = (await res.json().catch(() => ({}))) as { id?: string };
          return { delivered: true, providerMessageId: payload.id ?? null, error: null, manualLink: null };
        } catch (err) {
          return UNAVAILABLE(`Falha ao contatar o provedor de e-mail: ${(err as Error).message}`);
        }
      },
    },

    postalCode: {
      status: () => cep,
      async lookup(postalCode) {
        if (!cep.connected) return null;
        const url = env.POSTAL_CODE_PROVIDER_URL!.replace('{cep}', postalCode);
        const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(INTEGRATION_TIMEOUT_MS) });
        if (!res.ok) return null;
        const data = (await res.json()) as Record<string, string>;
        if ((data as { erro?: unknown }).erro) return null;
        return {
          postalCode,
          street: data.logradouro ?? data.street ?? null,
          district: data.bairro ?? data.district ?? null,
          city: data.localidade ?? data.city ?? null,
          state: data.uf ?? data.state ?? null,
        };
      },
    },

    trafficFines: {
      status: () => fines,
      async query(params) {
        if (!fines.connected) return [];
        const url = new URL(env.TRAFFIC_FINES_API_URL!);
        url.searchParams.set('plate', params.plate);
        if (params.renavam) url.searchParams.set('renavam', params.renavam);
        if (params.state) url.searchParams.set('state', params.state);
        const res = await fetch(url, {
            signal: AbortSignal.timeout(INTEGRATION_TIMEOUT_MS),
          headers: { authorization: `Bearer ${env.TRAFFIC_FINES_API_TOKEN}`, accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`Serviço de multas retornou HTTP ${res.status}.`);
        const payload = (await res.json()) as { fines?: TrafficFine[] };
        return payload.fines ?? [];
      },
    },

    billing: {
      status: () => billing,
      async paymentLink(providerInvoiceId) {
        if (!billing.connected) return null;
        const res = await fetch(`${env.BILLING_API_URL}/invoices/${providerInvoiceId}`, {
            signal: AbortSignal.timeout(INTEGRATION_TIMEOUT_MS),
          headers: { authorization: `Bearer ${env.BILLING_API_TOKEN}`, accept: 'application/json' },
        });
        if (!res.ok) return null;
        const payload = (await res.json()) as { invoiceUrl?: string; bankSlipUrl?: string };
        return payload.invoiceUrl ?? payload.bankSlipUrl ?? null;
      },
    },
  };
}
