import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { whaplyMessageRequestSchema, type WhaplyMessageRequest } from '@yudirect/contracts';
import { sha256Hex, signRequest, verifySignature, type SigningKey } from '../integrations/whaply/signing.js';

/* ------------------------------------------------------------------ *
 * Simulador do Whaply para testes de integração do YuDirect.
 *
 * Implementa o contrato v1 de verdade (HTTP real, assinatura HMAC
 * verificada, idempotência por chave + hash do corpo, sequência de
 * eventos com replay e mídia por referência). Não é um mock de função:
 * o YuDirect fala com ele pela rede exatamente como falaria com o
 * Whaply, e os eventos chegam assinados pela rota pública da API.
 * ------------------------------------------------------------------ */

export const FAKE_KEYS = {
  outbound: { keyId: 'yd-test-1', secret: 'outbound-secret-for-tests-0123456789abcdef' } satisfies SigningKey,
  inbound: { keyId: 'wh-test-1', secret: 'inbound-secret-for-tests-0123456789abcdefgh' } satisfies SigningKey,
};

export interface FakeRequestRecord {
  requestId: string;
  idempotencyKey: string;
  bodyHash: string;
  body: WhaplyMessageRequest;
  state: string;
  wamid: string | null;
  sessionId: string | null;
  posts: number;
}

type Scripted =
  | { kind: 'status'; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: 'hang' }
  | { kind: 'accept-then-drop' }
  | { kind: 'accept-then-hang' };

export interface StoredEvent {
  contractVersion: number;
  eventId: string;
  seq: number;
  type: string;
  occurredAt: string;
  correlationId: string | null;
  externalRef: { type: string; id: string } | null;
  requestId: string | null;
  sessionId: string | null;
  data: Record<string, unknown>;
}

export class FakeWhaply {
  server!: Server;
  url!: string;
  readonly requests = new Map<string, FakeRequestRecord>();
  readonly byId = new Map<string, FakeRequestRecord>();
  readonly commands: Array<{ sessionId: string; body: unknown }> = [];
  readonly media = new Map<string, { buffer: Buffer; contentType: string; available: boolean }>();
  readonly events: StoredEvent[] = [];
  readonly authFailures: string[] = [];
  private readonly script: Scripted[] = [];
  private readonly nonces = new Set<string>();
  private seq = 0;
  app: FastifyInstance | null = null;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  env(): Record<string, string> {
    return {
      WHAPLY_INTEGRATION_ENABLED: 'true',
      WHAPLY_API_URL: this.url,
      WHAPLY_OUTBOUND_KEY_ID: FAKE_KEYS.outbound.keyId,
      WHAPLY_OUTBOUND_SECRET: FAKE_KEYS.outbound.secret,
      WHAPLY_INBOUND_KEY_ID: FAKE_KEYS.inbound.keyId,
      WHAPLY_INBOUND_SECRET: FAKE_KEYS.inbound.secret,
      WHAPLY_REQUEST_TIMEOUT_MS: '1500',
    };
  }

  /** Próximas respostas de POST /messages (FIFO); vazio = comportamento normal. */
  enqueue(...items: Scripted[]): void {
    this.script.push(...items);
  }

  reset(): void {
    this.requests.clear();
    this.byId.clear();
    this.commands.length = 0;
    this.script.length = 0;
    this.authFailures.length = 0;
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const url = req.url ?? '/';
    const verdict = verifySignature({
      keys: [FAKE_KEYS.outbound],
      headers: req.headers,
      method: req.method ?? 'GET',
      path: url,
      body,
    });
    if (!verdict.ok) {
      this.authFailures.push(verdict.reason ?? 'unknown');
      return this.send(res, 401, { error: { code: verdict.reason ?? 'SIGNATURE_INVALID', message: 'assinatura', retryable: false } });
    }
    const nonceKey = `${verdict.keyId}:${verdict.nonce}`;
    if (this.nonces.has(nonceKey)) {
      return this.send(res, 401, { error: { code: 'NONCE_REPLAY', message: 'replay', retryable: false } });
    }
    this.nonces.add(nonceKey);

    const base = '/integrations/yudirect/v1';
    const path = url.split('?')[0]!;
    if (req.method === 'POST' && path === `${base}/messages`) return this.postMessage(req, res, body);
    if (req.method === 'GET' && path.startsWith(`${base}/messages/`)) {
      const rec = this.byId.get(decodeURIComponent(path.slice(`${base}/messages/`.length)));
      if (!rec) return this.send(res, 404, { error: { code: 'NOT_FOUND', message: 'não encontrado' } });
      return this.send(res, 200, { requestId: rec.requestId, state: rec.state, wamid: rec.wamid, sessionId: rec.sessionId });
    }
    if (req.method === 'GET' && path === `${base}/events`) {
      const after = Number(new URL(url, 'http://x').searchParams.get('afterSeq') ?? 0);
      return this.send(res, 200, { data: this.events.filter((e) => e.seq > after).slice(0, 100) });
    }
    if (req.method === 'GET' && path.startsWith(`${base}/media/`)) {
      const ref = decodeURIComponent(path.slice(`${base}/media/`.length));
      const item = this.media.get(ref);
      if (!item) return this.send(res, 404, { error: { code: 'NOT_FOUND', message: 'mídia expirada', retryable: false } });
      if (!item.available) return this.send(res, 503, { error: { code: 'CHANNEL_UNAVAILABLE', message: 'tente depois', retryable: true } });
      res.writeHead(200, { 'content-type': item.contentType });
      return void res.end(item.buffer);
    }
    if (req.method === 'POST' && path.startsWith(`${base}/sessions/`)) {
      const sessionId = path.slice(`${base}/sessions/`.length).split('/')[0]!;
      this.commands.push({ sessionId, body: JSON.parse(body || '{}') });
      return this.send(res, 200, { ok: true });
    }
    return this.send(res, 404, { error: { code: 'NOT_FOUND', message: 'rota' } });
  }

  private postMessage(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const parsed = whaplyMessageRequestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return this.send(res, 400, { error: { code: 'VALIDATION', message: parsed.error.message, retryable: false } });
    const header = req.headers['idempotency-key'];
    if (header !== parsed.data.idempotencyKey) {
      return this.send(res, 400, { error: { code: 'VALIDATION', message: 'Idempotency-Key divergente', retryable: false } });
    }
    const hash = sha256Hex(raw);
    const existing = this.requests.get(parsed.data.idempotencyKey);
    if (existing) {
      existing.posts += 1;
      if (existing.bodyHash !== hash) {
        return this.send(res, 409, { error: { code: 'IDEMPOTENCY_CONFLICT', message: 'corpo diferente', retryable: false } });
      }
      return this.send(res, 200, { requestId: existing.requestId, state: existing.state, wamid: existing.wamid, sessionId: existing.sessionId });
    }

    const step = this.script.shift();
    if (step?.kind === 'status') return this.send(res, step.status, step.body, step.headers);
    if (step?.kind === 'hang') return; // sem resposta: o cliente estoura o timeout

    const rec: FakeRequestRecord = {
      requestId: `req_${randomUUID().slice(0, 12)}`,
      idempotencyKey: parsed.data.idempotencyKey,
      bodyHash: hash,
      body: parsed.data,
      state: 'ACCEPTED_BY_WHAPLY',
      wamid: null,
      sessionId: parsed.data.session ? `ses_${randomUUID().slice(0, 12)}` : null,
      posts: 1,
    };
    this.requests.set(rec.idempotencyKey, rec);
    this.byId.set(rec.requestId, rec);
    if (step?.kind === 'accept-then-hang') return; // aceito, mas a resposta nunca chega (timeout)
    if (step?.kind === 'accept-then-drop') {
      // Aceita e registra, mas a conexão cai antes da resposta.
      req.socket.destroy();
      return;
    }
    this.send(res, 202, { requestId: rec.requestId, state: rec.state, sessionId: rec.sessionId });
  }

  /* ----------------------- eventos para o YuDirect ------------------ */

  addMedia(buffer: Buffer, contentType = 'image/png', available = true): { mediaRef: string; sha256: string } {
    const mediaRef = randomBytes(18).toString('base64url');
    this.media.set(mediaRef, { buffer, contentType, available });
    return { mediaRef, sha256: sha256Hex(buffer) };
  }

  /** Cria o evento (com seq) sem entregar — útil para simular callback perdido. */
  record(
    type: string,
    data: Record<string, unknown>,
    ref: { inspectionId?: string | null; requestId?: string | null; sessionId?: string | null; correlationId?: string | null } = {},
  ): StoredEvent {
    this.seq += 1;
    const event: StoredEvent = {
      contractVersion: 1,
      eventId: randomUUID(),
      seq: this.seq,
      type,
      occurredAt: new Date().toISOString(),
      correlationId: ref.correlationId ?? null,
      externalRef: ref.inspectionId ? { type: 'inspection', id: ref.inspectionId } : null,
      requestId: ref.requestId ?? null,
      sessionId: ref.sessionId ?? null,
      data,
    };
    this.events.push(event);
    return event;
  }

  /** Entrega um evento assinado na rota pública do YuDirect. */
  async deliver(event: StoredEvent, opts: { key?: SigningKey; tamper?: boolean; nonce?: string; now?: Date } = {}) {
    if (!this.app) throw new Error('app não vinculado ao FakeWhaply');
    const url = '/api/v1/integrations/whaply/events';
    const body = JSON.stringify(event);
    const headers = signRequest(opts.key ?? FAKE_KEYS.inbound, { method: 'POST', path: url, body, nonce: opts.nonce, now: opts.now });
    return this.app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: opts.tamper ? body.replace('"seq":', '"seq": ') : body,
    });
  }

  async emit(
    type: string,
    data: Record<string, unknown>,
    ref: Parameters<FakeWhaply['record']>[2] = {},
  ) {
    return this.deliver(this.record(type, data, ref));
  }

  /** Simula o Whaply processando o pedido: aceite pela Meta (wamid). */
  async metaAccept(rec: FakeRequestRecord) {
    rec.wamid = `wamid.${randomBytes(10).toString('hex')}`;
    rec.state = 'ACCEPTED_BY_META';
    return this.emit(
      'message.accepted',
      { idempotencyKey: rec.idempotencyKey, wamid: rec.wamid, kind: rec.body.kind },
      { inspectionId: rec.body.externalRef.id, requestId: rec.requestId, correlationId: rec.body.correlationId, sessionId: rec.sessionId },
    );
  }

  async status(rec: FakeRequestRecord, status: 'sent' | 'delivered' | 'read' | 'failed', extra: Record<string, unknown> = {}) {
    rec.state = status.toUpperCase();
    return this.emit(
      `message.${status}`,
      {
        idempotencyKey: rec.idempotencyKey,
        wamid: rec.wamid,
        kind: rec.body.kind,
        pricing: status === 'delivered' || status === 'read' ? { billable: true, category: 'utility', pricingModel: 'PMP', type: 'regular' } : undefined,
        ...extra,
      },
      { inspectionId: rec.body.externalRef.id, requestId: rec.requestId, correlationId: rec.body.correlationId, sessionId: rec.sessionId },
    );
  }

  latest(): FakeRequestRecord | undefined {
    return [...this.requests.values()].at(-1);
  }
}

/** PNG mínimo válido (1×1) para testes de mídia, com variação de bytes. */
export function tinyPng(variant = 0): Buffer {
  const base = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  // Bytes extras após o IEND não invalidam a assinatura PNG, mas mudam o hash.
  return Buffer.concat([base, Buffer.from(`variant-${variant}`)]);
}
