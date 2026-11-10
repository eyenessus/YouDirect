import {
  whaplyMessageAcceptedSchema,
  type WhaplyEventEnvelope,
  type WhaplyMessageAccepted,
  type WhaplySessionCommand,
} from '@yudirect/contracts';
import { whaplyStatus, type Env, type IntegrationStatus } from '../../config/env.js';
import { signRequest } from './signing.js';

/* ------------------------------------------------------------------ *
 * Cliente HTTP do Whaply (YuDirect → Whaply), contrato v1.
 *
 * Nunca lança para erros esperados: devolve um resultado tipado com a
 * classificação `retryable`, que o outbox usa para decidir entre nova
 * tentativa (mesma chave de idempotência) e falha definitiva.
 * ------------------------------------------------------------------ */

export const WHAPLY_BASE_PATH = '/integrations/yudirect/v1';

export interface WhaplyError {
  ok: false;
  status: number | null;
  code: string;
  message: string;
  retryable: boolean;
  retryAfterSeconds: number | null;
  source: 'TRANSPORT' | 'WHAPLY';
}

export type WhaplyResult<T> = { ok: true; status: number; data: T } | WhaplyError;

export interface WhaplyClient {
  status(): IntegrationStatus;
  sendMessage(body: string, idempotencyKey: string): Promise<WhaplyResult<WhaplyMessageAccepted>>;
  getMessage(requestId: string): Promise<WhaplyResult<WhaplyMessageAccepted & { lastError?: unknown }>>;
  getEvents(afterSeq: number, limit?: number): Promise<WhaplyResult<{ data: WhaplyEventEnvelope[] }>>;
  fetchMedia(mediaRef: string): Promise<WhaplyResult<{ buffer: Buffer; contentType: string }>>;
  sessionCommand(sessionId: string, command: WhaplySessionCommand): Promise<WhaplyResult<unknown>>;
}

/** Status HTTP que admitem nova tentativa com a mesma chave. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function createWhaplyClient(env: Env, fetchImpl: typeof fetch = fetch): WhaplyClient {
  const status = () => whaplyStatus(env);

  async function call(
    method: 'GET' | 'POST',
    pathAndQuery: string,
    body: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<WhaplyResult<Response>> {
    const st = status();
    if (!st.connected) {
      return {
        ok: false,
        status: null,
        code: 'CHANNEL_UNAVAILABLE',
        message: st.message,
        retryable: false,
        retryAfterSeconds: null,
        source: 'TRANSPORT',
      };
    }
    const base = env.WHAPLY_API_URL!.replace(/\/$/, '');
    const fullPath = `${WHAPLY_BASE_PATH}${pathAndQuery}`;
    const headers = {
      ...signRequest(
        { keyId: env.WHAPLY_OUTBOUND_KEY_ID!, secret: env.WHAPLY_OUTBOUND_SECRET! },
        { method, path: fullPath, body },
      ),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      accept: 'application/json',
      ...extraHeaders,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.WHAPLY_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${base}${fullPath}`, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        signal: controller.signal,
      });
      return { ok: true, status: res.status, data: res };
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      return {
        ok: false,
        status: null,
        code: aborted ? 'TIMEOUT' : 'NETWORK',
        message: aborted
          ? `Whaply não respondeu em ${env.WHAPLY_REQUEST_TIMEOUT_MS} ms.`
          : `Falha de rede ao contatar o Whaply: ${(err as Error).message}`,
        retryable: true,
        retryAfterSeconds: null,
        source: 'TRANSPORT',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function asError(res: Response): Promise<WhaplyError> {
    const payload = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string; retryable?: boolean };
    } | null;
    const retryAfter = Number(res.headers.get('retry-after'));
    return {
      ok: false,
      status: res.status,
      code: payload?.error?.code ?? `HTTP_${res.status}`,
      message: payload?.error?.message ?? `Whaply retornou HTTP ${res.status}.`,
      retryable: payload?.error?.retryable ?? isRetryableStatus(res.status),
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      source: res.status >= 500 || res.status === 408 ? 'TRANSPORT' : 'WHAPLY',
    };
  }

  async function json<T>(
    result: WhaplyResult<Response>,
    parse: (v: unknown) => T,
  ): Promise<WhaplyResult<T>> {
    if (!result.ok) return result;
    const res = result.data;
    if (res.status >= 400) return asError(res);
    try {
      return { ok: true, status: res.status, data: parse(await res.json()) };
    } catch (err) {
      return {
        ok: false,
        status: res.status,
        code: 'INVALID_RESPONSE',
        message: `Resposta inválida do Whaply: ${(err as Error).message}`,
        retryable: true,
        retryAfterSeconds: null,
        source: 'WHAPLY',
      };
    }
  }

  return {
    status,

    async sendMessage(body, idempotencyKey) {
      const res = await call('POST', '/messages', body, { 'idempotency-key': idempotencyKey });
      return json(res, (v) => whaplyMessageAcceptedSchema.parse(v));
    },

    async getMessage(requestId) {
      const res = await call('GET', `/messages/${encodeURIComponent(requestId)}`, '');
      return json(res, (v) => whaplyMessageAcceptedSchema.passthrough().parse(v));
    },

    async getEvents(afterSeq, limit = 100) {
      const res = await call('GET', `/events?afterSeq=${afterSeq}&limit=${limit}`, '');
      return json(res, (v) => v as { data: WhaplyEventEnvelope[] });
    },

    async fetchMedia(mediaRef) {
      const res = await call('GET', `/media/${encodeURIComponent(mediaRef)}`, '');
      if (!res.ok) return res;
      if (res.data.status >= 400) return asError(res.data);
      const buffer = Buffer.from(await res.data.arrayBuffer());
      return {
        ok: true,
        status: res.data.status,
        data: { buffer, contentType: res.data.headers.get('content-type') ?? 'application/octet-stream' },
      };
    },

    async sessionCommand(sessionId, command) {
      const res = await call('POST', `/sessions/${encodeURIComponent(sessionId)}/commands`, JSON.stringify(command));
      return json(res, (v) => v);
    },
  };
}
