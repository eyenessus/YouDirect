import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { fullMatrix, toE164BR } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { tinyPng } from '../testing/fake-whaply.js';
import { hashPassword } from '../common/helpers.js';
import { signRequest, type SigningKey } from '../integrations/whaply/signing.js';
import {
  dispatchDueInspections,
  reconcileMessages,
  runCollectionLifecycle,
  sendPendingMessages,
} from '../services/whatsapp-inspection.js';

/* ------------------------------------------------------------------ *
 * E2E ENTRE SISTEMAS — bateria de estabilização (contrato, mídia,
 * agendamento, aprovação, resiliência e isolamento).
 *
 * Complementa `e2e-whaply-cross.test.ts`: os dois lados são o CÓDIGO
 * REAL (API do YuDirect com Mongo em memória ⇄ harness do Whaply com
 * Mongo em memória), conversando por HTTP em localhost. A Meta é a
 * única simulação (nock no processo do Whaply, que grava o que SERIA
 * enviado). Nenhum relógio é esperado: o tempo é passado como `now`.
 *
 * Opt-in (mesma convenção): WHAPLY_E2E_DIR=<repo do Whaply>. Portas
 * fixas opcionais: WHAPLY_E2E_PORT e YUDIRECT_E2E_PORT.
 * ------------------------------------------------------------------ */

const WHAPLY_DIR = process.env.WHAPLY_E2E_DIR;
const HOUR = 3600 * 1000;
const KEYS = {
  ydToWh: { keyId: 'yd-e2e', secret: 'segredo-yd-para-wh-e2e-0123456789abcdef' },
  whToYd: { keyId: 'wh-e2e', secret: 'segredo-wh-para-yd-e2e-0123456789abcdef' },
};
const APP_SECRET = 'segredo-do-webhook-meta-e2e-0123456789';
const SLOTS = ['FRONT', 'REAR', 'LEFT_SIDE', 'RIGHT_SIDE', 'DASHBOARD'];
const PARTNER = '/integrations/yudirect/v1';
const DEAD_URL = 'http://127.0.0.1:5199/api/v1/integrations/whaply/events';

interface TemplateComponent {
  type: string;
  sub_type?: string;
  parameters: Array<{ type: string; text?: string; payload?: string }>;
}
interface MetaSent {
  phoneNumberId: string;
  wamid: string | null;
  body: {
    to: string;
    type: string;
    text?: { body: string };
    template?: { name: string; components: TemplateComponent[] };
  };
}
interface WhaplyEventRow {
  seq: number;
  type: string;
  state: string;
  envelope: { eventId: string; externalRef: { id: string } | null; data: Record<string, unknown> };
}
interface WhaplyState {
  requests: Array<{ _id: string; state: string; external_ref: string; kind: string; phone_number_id: string; recipient_phone: string }>;
  sessions: Array<{ _id: string; state: string; external_ref: string; contact_phone: string; current_index: number; received: Array<{ code: string; wamid: string }> }>;
  events: Array<{ seq: number; type: string; state: string }>;
}
interface Tick {
  processed: number;
  expired: number;
  events: { delivered: number; failed: number; dead: number };
}
interface Rental {
  inspectionId: string;
  vehicleId: string;
  driverId: string;
  plate: string;
  waPhone: string;
  phone: string;
}

describe.skipIf(!WHAPLY_DIR)('E2E YuDirect ⇄ Whaply — estabilização (código real dos dois lados)', () => {
  let child: ChildProcess;
  let whaplyUrl: string;
  let callbackUrl: string;
  let harness: TestHarness;
  let cookie: string;
  let otherCookie: string;
  let organizationId: ObjectId;
  let otherOrganizationId: ObjectId;
  let health: { companyId: string; phoneNumberId: string; intruderPhoneNumberId: string; infra: Record<string, string> };
  let n = 0;
  let imageSeq = 5000;

  async function wh<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${whaplyUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  const api = (c: string) => ({
    get: (url: string) => harness.app.inject({ method: 'GET', url, headers: { cookie: c } }),
    post: (url: string, payload?: unknown) => harness.app.inject({ method: 'POST', url, headers: { cookie: c }, payload: payload as never }),
    put: (url: string, payload?: unknown) => harness.app.inject({ method: 'PUT', url, headers: { cookie: c }, payload: payload as never }),
    patch: (url: string, payload?: unknown) => harness.app.inject({ method: 'PATCH', url, headers: { cookie: c }, payload: payload as never }),
    del: (url: string) => harness.app.inject({ method: 'DELETE', url, headers: { cookie: c } }),
  });

  const tick = (now?: Date) => wh<Tick>('/__test/tick', now ? { now: now.toISOString() } : {});
  const inspection = (id: string) => harness.ctx.mongo.collections.inspections.findOne({ _id: new ObjectId(id) });
  const messages = (id: string) => harness.ctx.mongo.collections.whatsappMessages.find({ inspectionId: new ObjectId(id) }).sort({ createdAt: 1 }).toArray();
  const whaplyState = () => wh<WhaplyState>('/__test/state');
  const whaplyEvents = async () => (await wh<{ data: WhaplyEventRow[] }>('/__test/events')).data;
  const metaSent = async () => (await wh<{ data: MetaSent[] }>('/__test/meta/sent')).data;
  const templatesTo = async (waPhone: string, name?: string) =>
    (await metaSent()).filter((s) => s.body.to === waPhone && s.body.type === 'template' && (!name || s.body.template?.name === name));
  const textsTo = async (waPhone: string) =>
    (await metaSent()).filter((s) => s.body.to === waPhone && s.body.type === 'text').map((s) => s.body.text?.body ?? '');
  const buttonOf = (sent: MetaSent) =>
    sent.body.template!.components.find((c) => c.sub_type === 'quick_reply')!.parameters[0]!.payload!;
  const bodyParams = (sent: MetaSent) => sent.body.template!.components.find((c) => c.type === 'body')!.parameters.map((p) => p.text);
  const inbound = (body: Record<string, unknown>) => wh<{ handled: boolean; wamid: string }>('/__test/inbound', body);
  const nextImage = () => tinyPng((imageSeq += 1));
  const sessionOf = async (inspectionId: string) => (await whaplyState()).sessions.filter((s) => s.external_ref === inspectionId).at(-1);

  /** Horário (UTC) em que o YuDirect agenda o envio: data da vistoria às 09:00 de São Paulo. */
  const sendAtOf = (date: string) => new Date(`${date}T12:00:00.000Z`);

  async function newRental(scheduledAt = '2026-11-20', c = cookie): Promise<Rental> {
    n += 1;
    const plate = `ZE${String.fromCharCode(65 + (n % 26))}${n % 10}${String.fromCharCode(66 + (n % 24))}${String(n).padStart(2, '0')}`;
    const phone = `1196666${String(1000 + n).slice(-4)}`;
    const vehicle = await api(c).post('/api/v1/vehicles', { plate, brand: 'VW', model: 'Polo' });
    expect(vehicle.statusCode, vehicle.body).toBe(201);
    const driver = await api(c).post('/api/v1/drivers', { fullName: `Cliente Estab ${n}`, phone });
    await api(c).put(`/api/v1/drivers/${driver.json().id}/whatsapp-consent`, { action: 'GRANT', source: 'CONTRACT' });
    const rental = await api(c).post('/api/v1/rentals', {
      vehicleId: vehicle.json().id,
      driverId: driver.json().id,
      startDate: '2026-11-01',
      rentalType: 'MONTHLY',
      periodicAmountCents: 100000,
      depositCents: 0,
    });
    expect(rental.statusCode, rental.body).toBe(201);
    const req = await api(c).post(`/api/v1/vehicles/${vehicle.json().id}/inspections/request`, {
      responsibleName: `Cliente Estab ${n}`,
      phone,
      scheduledAt,
    });
    expect(req.statusCode, req.body).toBe(201);
    return {
      inspectionId: req.json().inspection.id as string,
      vehicleId: vehicle.json().id as string,
      driverId: driver.json().id as string,
      plate,
      phone,
      waPhone: toE164BR(phone)!.slice(1),
    };
  }

  /** O job do YuDirect no instante `now` (disparo + outbox) seguido do worker do Whaply. */
  async function runAt(now: Date): Promise<void> {
    await dispatchDueInspections(harness.ctx, now);
    await sendPendingMessages(harness.ctx, now);
    await tick();
  }

  /** Agenda, dispara no horário e devolve o template enviado ao cliente. */
  async function requested(scheduledAt = '2026-11-20'): Promise<{ r: Rental; tpl: MetaSent }> {
    const r = await newRental(scheduledAt);
    await runAt(sendAtOf(scheduledAt));
    const [tpl] = await templatesTo(r.waPhone, 'yudirect_vistoria_solicitacao');
    expect(tpl, 'template de solicitação enviado').toBeTruthy();
    return { r, tpl: tpl! };
  }

  /** Coleta completa pelo WhatsApp: botão, cinco fotos e quilometragem. */
  async function collectAll(r: Rental, tpl: MetaSent): Promise<void> {
    await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonOf(tpl) });
    for (let i = 0; i < SLOTS.length; i += 1) await inbound({ from: r.waPhone, type: 'image', imageBase64: nextImage().toString('base64') });
    await inbound({ from: r.waPhone, type: 'text', text: '45000' });
    await tick();
  }

  /** Requisição assinada à API de parceiro do Whaply (como o cliente do YuDirect faria). */
  async function partner(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: string; key?: SigningKey; headers?: Record<string, string>; now?: Date; nonce?: string; unsigned?: boolean } = {},
  ): Promise<{ status: number; json: { error?: { code?: string }; state?: string; requestId?: string } }> {
    const body = opts.body ?? '';
    const signature = opts.unsigned
      ? {}
      : signRequest(opts.key ?? KEYS.ydToWh, { method, path: `${PARTNER}${path}`, body, now: opts.now, nonce: opts.nonce });
    const res = await fetch(`${whaplyUrl}${PARTNER}${path}`, {
      method,
      headers: { ...signature, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...opts.headers },
      body: method === 'POST' ? body : undefined,
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as { error?: { code?: string } } };
  }

  /** Evento entregue à rota pública do YuDirect (como o outbox do Whaply faria). */
  async function postEvent(raw: string, headers: Record<string, string>): Promise<number> {
    const res = await fetch(callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
    return res.status;
  }
  const eventPath = () => new URL(callbackUrl).pathname;

  /** Webhook no formato da Meta, assinado com o segredo do app. */
  async function metaWebhook(value: Record<string, unknown>, opts: { secret?: string; phoneNumberId?: string } = {}) {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: opts.phoneNumberId ?? health.phoneNumberId }, ...value } }] }],
    });
    const signature = `sha256=${createHmac('sha256', opts.secret ?? APP_SECRET).update(raw).digest('hex')}`;
    const res = await fetch(`${whaplyUrl}/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: raw });
    return { status: res.status, json: res.ok ? ((await res.json()) as { results: Array<{ wamid: string; handled: boolean }> }) : null };
  }
  const registerMedia = async (data: Buffer) => (await wh<{ mediaId: string }>('/__test/meta/media', { base64: data.toString('base64') })).mediaId;

  async function seedOrganization(name: string, email: string, createdAt: Date): Promise<{ id: ObjectId; cookie: string }> {
    const id = new ObjectId();
    await harness.ctx.mongo.collections.organizations.insertOne({
      _id: id,
      name,
      legalId: null,
      timezone: 'America/Sao_Paulo',
      currency: 'BRL',
      settings: { freeSeats: 3, extraSeatPriceCents: 990 },
      createdAt,
      updatedAt: createdAt,
    });
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: `Dono ${name}`,
      emailLower: email,
      passwordHash: await hashPassword('Dono@123456'),
      phone: null,
      status: 'ACTIVE',
      browserNotificationsEnabled: false,
      lastLoginAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    await harness.ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(),
      organizationId: id,
      userId,
      role: 'OWNER',
      permissions: fullMatrix(),
      status: 'ACTIVE',
      createdAt,
      updatedAt: createdAt,
    });
    const login = await harness.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'Dono@123456' } });
    return { id, cookie: sessionCookie(login.headers as Record<string, unknown>) };
  }

  beforeAll(async () => {
    const port = Number(process.env.WHAPLY_E2E_PORT) || 5181;
    whaplyUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', 'tests/e2e-harness/YuDirectPartnerHarness.ts'], {
      cwd: WHAPLY_DIR,
      env: {
        ...process.env,
        HARNESS_PORT: String(port),
        VERSION_GRAPH_API: '23.0',
        NODE_ENV: 'test',
        HARNESS_INBOUND_KEY_ID: KEYS.ydToWh.keyId,
        HARNESS_INBOUND_SECRET: KEYS.ydToWh.secret,
        HARNESS_OUTBOUND_KEY_ID: KEYS.whToYd.keyId,
        HARNESS_OUTBOUND_SECRET: KEYS.whToYd.secret,
        HARNESS_APP_SECRET: APP_SECRET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const collect = (stream: NodeJS.ReadableStream | null) => stream?.on('data', (d: Buffer) => (log += String(d)));
    collect(child.stdout);
    collect(child.stderr);
    for (let i = 0; i < 120; i += 1) {
      try {
        health = await wh('/__test/health');
        break;
      } catch {
        if (child.exitCode !== null) throw new Error(`harness do Whaply terminou:\n${log}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (i === 119) throw new Error(`harness do Whaply não respondeu:\n${log}`);
    }

    harness = await createHarness({
      WHAPLY_INTEGRATION_ENABLED: 'true',
      WHAPLY_API_URL: whaplyUrl,
      WHAPLY_OUTBOUND_KEY_ID: KEYS.ydToWh.keyId,
      WHAPLY_OUTBOUND_SECRET: KEYS.ydToWh.secret,
      WHAPLY_INBOUND_KEY_ID: KEYS.whToYd.keyId,
      WHAPLY_INBOUND_SECRET: KEYS.whToYd.secret,
      WHAPLY_REQUEST_TIMEOUT_MS: '8000',
    });
    await harness.app.listen({ port: Number(process.env.YUDIRECT_E2E_PORT) || 0, host: '127.0.0.1' });
    callbackUrl = `http://127.0.0.1:${(harness.app.server.address() as AddressInfo).port}/api/v1/integrations/whaply/events`;
    await wh('/__test/configure', { callbackUrl });

    // Uma locadora MAIS ANTIGA no mesmo YuDirect (SaaS multiempresa) e a FF Veículos, dona do canal.
    const other = await seedOrganization('Outra Locadora', 'dono@outra.test', new Date('2025-01-01T00:00:00.000Z'));
    const ff = await seedOrganization('FF Veículos', 'dono@ff.test', new Date('2026-01-01T00:00:00.000Z'));
    organizationId = ff.id;
    cookie = ff.cookie;
    otherOrganizationId = other.id;
    otherCookie = other.cookie;
    await api(cookie).put('/api/v1/inspection/whatsapp-settings', {
      enabled: true,
      sendTime: '09:00',
      reminderAfterHours: 24,
      maxReminders: 1,
      collectionTtlHours: 72,
      instructions: {},
    });
  }, 300_000);

  afterAll(async () => {
    await fetch(`${whaplyUrl}/__test/shutdown`, { method: 'POST' }).catch(() => undefined);
    for (let i = 0; i < 100 && child && child.exitCode === null; i += 1) await new Promise((r) => setTimeout(r, 100));
    if (child && child.exitCode === null) child.kill();
    await harness?.close();
  });

  it('SEG-00 — o harness do Whaply sobe só com infraestrutura local', () => {
    expect(health.infra.mongoHost).toBe('127.0.0.1');
    expect(health.infra.redisHost).toBe('127.0.0.1');
    expect(health.infra.kafkaUrl).toContain('127.0.0.1');
  });

  /* ----------------------------- E2E-018 --------------------------- */

  it('E2E-018 — agendamento: nada antes da hora; na hora, UM template ao cliente certo; lembrete único', async () => {
    const r = await newRental('2026-11-20');
    const sendAt = sendAtOf('2026-11-20');
    const doc = await inspection(r.inspectionId);
    expect(doc?.collection?.status).toBe('SCHEDULED');
    expect(doc?.scheduledSendAt?.toISOString()).toBe(sendAt.toISOString());

    await runAt(new Date(sendAt.getTime() - 60_000));
    expect(await messages(r.inspectionId)).toHaveLength(0);
    expect(await templatesTo(r.waPhone)).toHaveLength(0);

    await runAt(sendAt);
    await runAt(new Date(sendAt.getTime() + 60_000)); // o job roda de novo: não duplica
    const sent = await templatesTo(r.waPhone);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body.template?.name).toBe('yudirect_vistoria_solicitacao');
    expect(sent[0]!.phoneNumberId).toBe(health.phoneNumberId);
    expect(bodyParams(sent[0]!).slice(0, 4)).toEqual(['Cliente', r.plate, '20/11/2026', '5']);
    const [msg] = await messages(r.inspectionId);
    expect(msg).toMatchObject({ kind: 'INSPECTION_REQUEST', status: 'ACCEPTED_BY_META', wamid: sent[0]!.wamid });
    expect(msg?.idempotencyKey).toBe(`inspection:${r.inspectionId}:INSPECTION_REQUEST:r0:n0`);
    expect((await inspection(r.inspectionId))?.collection?.status).toBe('REQUESTED');

    // Lembrete: só depois do prazo configurado (24 h), uma única vez.
    expect((await runCollectionLifecycle(harness.ctx, new Date(sendAt.getTime() + 23 * HOUR))).reminders).toBe(0);
    expect((await runCollectionLifecycle(harness.ctx, new Date(sendAt.getTime() + 25 * HOUR))).reminders).toBe(1);
    expect((await runCollectionLifecycle(harness.ctx, new Date(sendAt.getTime() + 50 * HOUR))).reminders).toBe(0);
    await sendPendingMessages(harness.ctx, new Date(sendAt.getTime() + 50 * HOUR));
    await tick();
    expect(await templatesTo(r.waPhone, 'yudirect_vistoria_lembrete')).toHaveLength(1);
    expect(await templatesTo(r.waPhone)).toHaveLength(2);
  });

  it('E2E-018b — reagendamento antes do envio move o disparo; cancelamento antes do envio não envia nada', async () => {
    const moved = await newRental('2026-11-20');
    const patch = await api(cookie).patch(`/api/v1/inspections/${moved.inspectionId}/schedule`, { scheduledAt: '2026-11-25' });
    expect(patch.statusCode, patch.body).toBe(200);
    const canceled = await newRental('2026-11-20');
    expect((await api(cookie).del(`/api/v1/inspections/${canceled.inspectionId}`)).statusCode).toBe(200);

    await runAt(sendAtOf('2026-11-20'));
    expect(await templatesTo(moved.waPhone)).toHaveLength(0);
    expect(await templatesTo(canceled.waPhone)).toHaveLength(0);

    await runAt(sendAtOf('2026-11-25'));
    expect(await templatesTo(moved.waPhone)).toHaveLength(1);
    expect(bodyParams((await templatesTo(moved.waPhone))[0]!)[2]).toBe('25/11/2026');
    expect(await templatesTo(canceled.waPhone)).toHaveLength(0);
    expect(await messages(canceled.inspectionId)).toHaveLength(0);

    // Depois de enviado, o reagendamento é recusado (a mensagem já saiu com a data antiga).
    const late = await api(cookie).patch(`/api/v1/inspections/${moved.inspectionId}/schedule`, { scheduledAt: '2026-11-28' });
    expect(late.statusCode).toBe(409);
  });

  it('E2E-020c — cancelamento depois do envio encerra a coleta no Whaply; foto posterior não entra na vistoria', async () => {
    const { r, tpl } = await requested();
    expect((await sessionOf(r.inspectionId))?.state).toBe('AWAITING_START');
    expect((await api(cookie).del(`/api/v1/inspections/${r.inspectionId}`)).statusCode).toBe(200);
    expect((await sessionOf(r.inspectionId))?.state).toBe('CANCELED');

    expect((await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonOf(tpl) })).handled).toBe(true);
    expect((await textsTo(r.waPhone)).at(-1)).toMatch(/não está mais ativa/);
    expect((await inbound({ from: r.waPhone, type: 'image', imageBase64: nextImage().toString('base64') })).handled).toBe(true);
    await tick();
    const doc = await inspection(r.inspectionId);
    expect(doc?.status).toBe('CANCELED');
    expect(doc?.photos ?? []).toHaveLength(0);
  });

  /* ----------------------------- E2E-019 --------------------------- */

  it('E2E-019 — webhook assinado: fotos intercaladas de dois clientes vão cada uma à vistoria, veículo e motorista certos', async () => {
    const a = await requested();
    const b = await requested();

    const forged = await metaWebhook({ messages: [{ id: 'wamid.FORGED', from: a.r.waPhone, type: 'button', button: { payload: buttonOf(a.tpl) } }] }, { secret: 'segredo-errado' });
    expect(forged.status).toBe(401);
    expect((await sessionOf(a.r.inspectionId))?.state).toBe('AWAITING_START');

    for (const x of [a, b]) {
      const start = await metaWebhook({ messages: [{ id: `wamid.START${x.r.waPhone}`, from: x.r.waPhone, type: 'button', button: { payload: buttonOf(x.tpl), text: 'Iniciar vistoria' } }] });
      expect(start.json?.results[0]?.handled).toBe(true);
    }
    const hashes: Record<string, string[]> = { [a.r.inspectionId]: [], [b.r.inspectionId]: [] };
    for (let i = 0; i < SLOTS.length; i += 1) {
      for (const x of [a, b]) {
        const img = nextImage();
        hashes[x.r.inspectionId]!.push(createHash('sha256').update(img).digest('hex'));
        const res = await metaWebhook({ messages: [{ id: `wamid.IMG${x.r.waPhone}-${i}`, from: x.r.waPhone, type: 'image', image: { id: await registerMedia(img), mime_type: 'image/png' } }] });
        expect(res.json?.results[0]?.handled).toBe(true);
      }
    }
    for (const [x, km] of [[a, '10.500'], [b, '20700']] as const) {
      await metaWebhook({ messages: [{ id: `wamid.KM${x.r.waPhone}`, from: x.r.waPhone, type: 'text', text: { body: km } }] });
    }
    await tick();

    for (const [x, km] of [[a, 10500], [b, 20700]] as const) {
      const doc = await inspection(x.r.inspectionId);
      expect(doc?.status).toBe('SUBMITTED');
      expect(doc?.vehicleId.toHexString()).toBe(x.r.vehicleId);
      expect(doc?.driverId?.toHexString()).toBe(x.r.driverId);
      expect(doc?.organizationId.equals(organizationId)).toBe(true);
      expect(doc?.odometerKm).toBe(km);
      expect(doc?.photos.map((p) => p.slotCode)).toEqual(SLOTS);
      for (const [i, photo] of doc!.photos.entries()) {
        const file = await harness.ctx.mongo.collections.files.findOne({ _id: photo.fileId });
        expect(file?.checksum).toBe(hashes[x.r.inspectionId]![i]);
        expect(file?.organizationId.equals(organizationId)).toBe(true);
      }
    }
  });

  it('E2E-019b — duplicidade: mesma mensagem (wamid), mesmo evento e mesma imagem não geram mídia duplicada', async () => {
    const { r, tpl } = await requested();
    await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonOf(tpl) });
    const img = nextImage().toString('base64');
    const first = await inbound({ id: 'wamid.DUPLICADA-1', from: r.waPhone, type: 'image', imageBase64: img });
    const again = await inbound({ id: 'wamid.DUPLICADA-1', from: r.waPhone, type: 'image', imageBase64: img });
    expect([first.handled, again.handled]).toEqual([true, true]);
    // Mesma imagem com OUTRO wamid (cliente reenviou a foto anterior): recusada, passo não avança.
    await inbound({ from: r.waPhone, type: 'image', imageBase64: img });
    expect((await textsTo(r.waPhone)).at(-1)).toMatch(/já foi enviada/);
    await tick();

    const session = await sessionOf(r.inspectionId);
    expect(session?.current_index).toBe(1);
    expect(session?.received).toHaveLength(1);
    const mediaEvents = (await whaplyEvents()).filter((e) => e.type === 'session.media_received' && e.envelope.externalRef?.id === r.inspectionId);
    expect(mediaEvents).toHaveLength(1);

    // O mesmo evento entregue de novo (nova assinatura, mesmo eventId): reconhecido sem duplicar.
    const raw = JSON.stringify(mediaEvents[0]!.envelope);
    const replay = await postEvent(raw, signRequest(KEYS.whToYd, { method: 'POST', path: eventPath(), body: raw }));
    expect(replay).toBe(204);
    const doc = await inspection(r.inspectionId);
    expect(doc?.photoEvidence).toHaveLength(1);
    expect(doc?.photos.map((p) => p.slotCode)).toEqual(['FRONT']);
    expect(await harness.ctx.mongo.collections.files.countDocuments({ checksum: createHash('sha256').update(Buffer.from(img, 'base64')).digest('hex') })).toBe(1);
  });

  it('E2E-019c — formato inválido e falha de download da Meta: nada é associado e o cliente é orientado', async () => {
    const { r, tpl } = await requested();
    await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonOf(tpl) });
    const mediaEvents = async () => (await whaplyEvents()).filter((e) => e.type.includes('media')).length;
    const eventsBefore = await mediaEvents();

    expect((await inbound({ from: r.waPhone, type: 'image', imageBase64: Buffer.from('%PDF-1.7 isto não é uma foto').toString('base64') })).handled).toBe(true);
    expect((await textsTo(r.waPhone)).at(-1)).toMatch(/Envie uma \*foto\*/);
    expect((await inbound({ from: r.waPhone, type: 'image', mediaMissing: true })).handled).toBe(true);
    expect((await textsTo(r.waPhone)).at(-1)).toMatch(/Não consegui receber a foto agora/);

    expect((await sessionOf(r.inspectionId))?.current_index).toBe(0);
    expect(await mediaEvents()).toBe(eventsBefore);
    await tick();
    expect((await inspection(r.inspectionId))?.photos ?? []).toHaveLength(0);

    // A coleta continua do mesmo ponto com uma foto válida.
    await inbound({ from: r.waPhone, type: 'image', imageBase64: nextImage().toString('base64') });
    await tick();
    expect((await inspection(r.inspectionId))?.photos.map((p) => p.slotCode)).toEqual(['FRONT']);
  });

  it('E2E-019d — coleta incompleta expira no prazo; foto após o prazo não entra na vistoria', async () => {
    const { r, tpl } = await requested();
    await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonOf(tpl) });
    for (let i = 0; i < 2; i += 1) await inbound({ from: r.waPhone, type: 'image', imageBase64: nextImage().toString('base64') });
    await tick();
    expect((await inspection(r.inspectionId))?.collection?.status).toBe('PARTIAL');

    const afterDeadline = new Date(Date.now() + 73 * HOUR);
    const expiry = await tick(afterDeadline);
    expect(expiry.expired).toBeGreaterThanOrEqual(1);
    const doc = await inspection(r.inspectionId);
    expect(doc?.status).toBe('PENDING');
    expect(doc?.collection?.status).toBe('EXPIRED');
    expect(doc?.photos.map((p) => p.slotCode)).toEqual(['FRONT', 'REAR']);

    expect((await inbound({ from: r.waPhone, type: 'image', imageBase64: nextImage().toString('base64') })).handled).toBe(true);
    await tick();
    const after = await inspection(r.inspectionId);
    expect(after?.photos.map((p) => p.slotCode)).toEqual(['FRONT', 'REAR']);
    expect(after?.photoEvidence).toHaveLength(2);
  });

  it('E2E-019e — telefone sem vistoria aberta: a foto segue o atendimento normal e não vaza para outra vistoria', async () => {
    const { r, tpl } = await requested();
    await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonOf(tpl) });
    const eventsBefore = (await whaplyEvents()).length;
    const stranger = '5511955550000';

    expect((await inbound({ from: stranger, type: 'image', imageBase64: nextImage().toString('base64') })).handled).toBe(false);
    expect((await inbound({ from: stranger, type: 'text', text: 'oi' })).handled).toBe(false);
    // Botão de OUTRO cliente apertado por este telefone: recusado.
    expect((await inbound({ from: stranger, type: 'button', buttonPayload: buttonOf(tpl) })).handled).toBe(false);
    await tick();

    expect((await whaplyEvents()).length).toBe(eventsBefore);
    expect((await sessionOf(r.inspectionId))?.current_index).toBe(0);
    expect((await inspection(r.inspectionId))?.photos ?? []).toHaveLength(0);
    expect((await textsTo(stranger))).toHaveLength(0);
  });

  it('E2E-019f — eventos fora de ordem (mídia atrasada, conclusão antes): a vistoria completa chega à revisão', async () => {
    const { r, tpl } = await requested();
    await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonOf(tpl) });
    for (let i = 0; i < 4; i += 1) await inbound({ from: r.waPhone, type: 'image', imageBase64: nextImage().toString('base64') });
    await tick();
    expect((await inspection(r.inspectionId))?.photos).toHaveLength(4);

    // A última foto e a quilometragem chegam enquanto o Whaply não consegue servir a mídia ao YuDirect:
    // o evento da foto falha (será reenviado) e os seguintes — inclusive a conclusão — passam na frente.
    await inbound({ from: r.waPhone, type: 'image', imageBase64: nextImage().toString('base64') });
    await inbound({ from: r.waPhone, type: 'text', text: '77000' });
    await wh('/__test/configure', { partnerFault: 'down' });
    try {
      const first = await tick();
      expect(first.events.failed).toBeGreaterThanOrEqual(1);
    } finally {
      await wh('/__test/configure', { partnerFault: null });
    }
    await tick(new Date(Date.now() + 2 * HOUR)); // nova tentativa do evento da foto
    await reconcileMessages(harness.ctx, new Date(Date.now() + 2 * HOUR));

    const doc = await inspection(r.inspectionId);
    expect(doc?.photos.map((p) => p.slotCode)).toEqual(SLOTS);
    expect(doc?.odometerKm).toBe(77000);
    expect((await sessionOf(r.inspectionId))?.state).toBe('COMPLETED');
    // O cliente recebeu "Pronto! Recebemos todas as fotos" — a vistoria tem de estar aguardando revisão.
    expect(doc?.status).toBe('SUBMITTED');
  });

  it('E2E-019g — mídia perdida no armazenamento do Whaply: a foto faltante fica visível para a equipe', async () => {
    const { r, tpl } = await requested();
    await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonOf(tpl) });
    const lost = await inbound({ from: r.waPhone, type: 'image', imageBase64: nextImage().toString('base64') });
    expect((await wh<{ deleted: number }>('/__test/media/drop', { wamid: lost.wamid })).deleted).toBe(1);
    await tick();

    const doc = await inspection(r.inspectionId);
    expect(doc?.photos ?? []).toHaveLength(0);
    const alerts = await harness.ctx.mongo.collections.notifications.find({ entityId: new ObjectId(r.inspectionId) }).toArray();
    expect(alerts.some((a) => /Não foi possível obter a foto/.test(a.message))).toBe(true);
    // O evento foi reconhecido (não fica em reenvio infinito).
    const event = (await whaplyEvents()).find((e) => e.type === 'session.media_received' && e.envelope.data.wamid === lost.wamid);
    expect(event?.state).toBe('DELIVERED');
  });

  /* ----------------------------- E2E-020 --------------------------- */

  it('E2E-020 — aprovação e reprovação no YuDirect: decisão única, histórico auditado, nenhuma mensagem automática ao cliente', async () => {
    const ok = await requested();
    const bad = await requested();
    await collectAll(ok.r, ok.tpl);
    await collectAll(bad.r, bad.tpl);
    expect((await inspection(ok.r.inspectionId))?.status).toBe('SUBMITTED');
    expect((await inspection(bad.r.inspectionId))?.status).toBe('SUBMITTED');
    const sentBefore = (await metaSent()).length;

    const approve = await api(cookie).post(`/api/v1/inspections/${ok.r.inspectionId}/review`, { decision: 'APPROVE' });
    expect(approve.statusCode, approve.body).toBe(200);
    const reject = await api(cookie).post(`/api/v1/inspections/${bad.r.inspectionId}/review`, { decision: 'REJECT', notes: 'Fotos escuras' });
    expect(reject.statusCode, reject.body).toBe(200);
    expect((await api(cookie).post(`/api/v1/inspections/${ok.r.inspectionId}/review`, { decision: 'REJECT' })).statusCode).toBe(409);
    await runAt(new Date(Date.now() + HOUR));

    expect((await inspection(ok.r.inspectionId))?.status).toBe('APPROVED');
    expect((await inspection(bad.r.inspectionId))?.status).toBe('REJECTED');
    // Como implementado: a decisão NÃO dispara mensagem ao cliente pelo WhatsApp.
    expect((await metaSent()).length).toBe(sentBefore);

    const audit = async (id: string) =>
      (await harness.ctx.mongo.collections.auditLogs.find({ entityId: new ObjectId(id) }).sort({ occurredAt: 1 }).toArray()).map((a) => a.action);
    expect(await audit(ok.r.inspectionId)).toEqual(expect.arrayContaining(['inspection.submitted', 'inspection.approved']));
    expect(await audit(bad.r.inspectionId)).toEqual(expect.arrayContaining(['inspection.submitted', 'inspection.rejected']));
    const [msg] = await messages(ok.r.inspectionId);
    expect(msg?.events.map((e) => e.type)).toEqual(expect.arrayContaining(['intent.created', 'submit.attempt', 'submit.accepted', 'message.accepted']));

    // Foto que chega depois da decisão não altera a vistoria aprovada.
    await inbound({ from: ok.r.waPhone, type: 'image', imageBase64: nextImage().toString('base64') });
    await tick();
    const after = await inspection(ok.r.inspectionId);
    expect(after?.status).toBe('APPROVED');
    expect(after?.photos).toHaveLength(5);
  });

  /* --------------------------- resiliência ------------------------- */

  it('RES-01 — YuDirect fora do ar (conexão recusada) ao receber a foto: nada se perde e nada duplica na volta', async () => {
    const { r, tpl } = await requested();
    await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonOf(tpl) });
    await tick();
    await wh('/__test/configure', { callbackUrl: DEAD_URL });
    try {
      await inbound({ from: r.waPhone, type: 'image', imageBase64: nextImage().toString('base64') });
      const down = await tick();
      expect(down.events.delivered).toBe(0);
      expect(down.events.failed).toBeGreaterThanOrEqual(1);
      expect((await inspection(r.inspectionId))?.photos ?? []).toHaveLength(0);
      // Sem avançar o relógio a nova tentativa ainda não é devida (backoff).
      expect((await tick()).events.failed).toBe(0);
    } finally {
      await wh('/__test/configure', { callbackUrl });
    }
    const back = await tick(new Date(Date.now() + 2 * HOUR));
    expect(back.events.delivered).toBeGreaterThanOrEqual(1);
    await tick(new Date(Date.now() + 4 * HOUR));
    const doc = await inspection(r.inspectionId);
    expect(doc?.photos.map((p) => p.slotCode)).toEqual(['FRONT']);
    expect(doc?.photoEvidence).toHaveLength(1);
    expect((await whaplyEvents()).filter((e) => e.envelope.externalRef?.id === r.inspectionId && e.state !== 'DELIVERED')).toHaveLength(0);
  });

  it('RES-02 — Whaply fora do ar no disparo e resposta perdida: nova tentativa com a mesma chave, UM envio na Meta', async () => {
    const down = await newRental('2026-11-20');
    const sendAt = sendAtOf('2026-11-20');
    await wh('/__test/configure', { partnerFault: 'down' });
    try {
      await runAt(sendAt);
    } finally {
      await wh('/__test/configure', { partnerFault: null });
    }
    let [msg] = await messages(down.inspectionId);
    expect(msg).toMatchObject({ status: 'RETRY_SCHEDULED', attempts: 1 });
    expect(msg?.lastError).toMatchObject({ code: 'NETWORK', source: 'TRANSPORT' });
    expect(await templatesTo(down.waPhone)).toHaveLength(0);
    await runAt(new Date(sendAt.getTime() + HOUR));
    [msg] = await messages(down.inspectionId);
    expect(msg?.status).toBe('ACCEPTED_BY_META');
    expect(await templatesTo(down.waPhone)).toHaveLength(1);

    // Resposta perdida: o Whaply aceitou o pedido, mas o YuDirect não soube.
    const lostAck = await newRental('2026-11-20');
    await wh('/__test/configure', { partnerFault: 'drop-response' });
    try {
      await dispatchDueInspections(harness.ctx, sendAt);
      await sendPendingMessages(harness.ctx, sendAt);
    } finally {
      await wh('/__test/configure', { partnerFault: null });
    }
    [msg] = await messages(lostAck.inspectionId);
    expect(msg?.status).toBe('RETRY_SCHEDULED');
    expect((await whaplyState()).requests.filter((q) => q.external_ref === lostAck.inspectionId)).toHaveLength(1);
    await runAt(new Date(sendAt.getTime() + HOUR));
    await runAt(new Date(sendAt.getTime() + 2 * HOUR));
    [msg] = await messages(lostAck.inspectionId);
    expect(msg?.status).toBe('ACCEPTED_BY_META');
    expect((await whaplyState()).requests.filter((q) => q.external_ref === lostAck.inspectionId)).toHaveLength(1);
    expect(await templatesTo(lostAck.waPhone)).toHaveLength(1);
  });

  /* ---------------------------- segurança -------------------------- */

  it('SEG-01 — API de parceiro do Whaply: sem credencial, chave errada, relógio vencido, corpo alterado e replay são recusados', async () => {
    const path = '/events?afterSeq=0&limit=1';
    expect((await partner('GET', path, { unsigned: true })).status).toBe(401);
    expect((await partner('GET', path, { key: { keyId: KEYS.ydToWh.keyId, secret: 'segredo-errado-com-mais-de-32-caracteres!!' } })).json.error?.code).toBe('SIGNATURE_INVALID');
    // Chave da direção oposta (Whaply → YuDirect) não autentica comandos.
    expect((await partner('GET', path, { key: KEYS.whToYd })).status).toBe(401);
    const stale = await partner('GET', path, { now: new Date(Date.now() - 10 * 60_000) });
    expect([stale.status, stale.json.error?.code]).toEqual([401, 'TIMESTAMP_SKEW']);

    const nonce = 'nonce-de-replay-0123456789';
    expect((await partner('GET', path, { nonce })).status).toBe(200);
    const replay = await partner('GET', path, { nonce });
    expect([replay.status, replay.json.error?.code]).toEqual([401, 'NONCE_REPLAY']);

    // Assinatura válida para outro corpo: recusada, nada é criado.
    const before = (await whaplyState()).requests.length;
    const signedFor = JSON.stringify({ contractVersion: 1 });
    const headers = signRequest(KEYS.ydToWh, { method: 'POST', path: `${PARTNER}/messages`, body: signedFor });
    const tampered = await partner('POST', '/messages', { unsigned: true, headers, body: JSON.stringify({ contractVersion: 1, extra: true }) });
    expect(tampered.status).toBe(401);
    expect((await whaplyState()).requests.length).toBe(before);
  });

  it('SEG-02 — eventos no YuDirect: sem assinatura, chave da direção errada, relógio vencido e replay são recusados', async () => {
    const raw = JSON.stringify({
      contractVersion: 1,
      eventId: '11111111-1111-4111-8111-111111111111',
      seq: 999_001,
      type: 'session.started',
      occurredAt: new Date().toISOString(),
      correlationId: null,
      externalRef: null,
      requestId: null,
      sessionId: null,
      data: {},
    });
    const sign = (key: SigningKey, now?: Date) => signRequest(key, { method: 'POST', path: eventPath(), body: raw, now });
    expect(await postEvent(raw, {})).toBe(401);
    expect(await postEvent(raw, sign(KEYS.ydToWh))).toBe(401);
    expect(await postEvent(raw, sign(KEYS.whToYd, new Date(Date.now() - 10 * 60_000)))).toBe(401);
    expect(await harness.ctx.mongo.collections.integrationInbox.countDocuments({ _id: '11111111-1111-4111-8111-111111111111' })).toBe(0);

    const headers = sign(KEYS.whToYd);
    expect(await postEvent(raw, headers)).toBe(204);
    expect(await postEvent(raw, headers)).toBe(401); // mesma requisição capturada e reenviada
  });

  it('E2E-026 — credencial válida não escolhe a conta: campos de outro tenant são ignorados e o envio sai só pela FF Veículos', async () => {
    const r = await newRental('2026-11-20');
    const key = `inspection:${r.inspectionId}:INSPECTION_REQUEST:r0:n9`;
    const body = JSON.stringify({
      contractVersion: 1,
      idempotencyKey: key,
      correlationId: '22222222-2222-4222-8222-222222222222',
      externalRef: { type: 'inspection', id: r.inspectionId },
      kind: 'INSPECTION_REQUEST',
      recipient: { phoneE164: `+${r.waPhone}`, name: 'Cliente' },
      consent: { grantedAt: '2026-11-01T12:00:00.000Z', source: 'CONTRACT' },
      template: { name: 'yudirect_vistoria_solicitacao', language: 'pt_BR', bodyParams: ['Cliente', r.plate, '20/11/2026', '5', '23/11/2026 09:00'], urlButtonParam: 'tok' },
      session: { round: 0, expiresAt: new Date(Date.now() + 72 * HOUR).toISOString(), steps: [{ code: 'FRONT', label: 'Frente', instruction: null, type: 'IMAGE' }] },
      // Tentativa de agir por outra empresa/número do mesmo Whaply:
      companyId: 'ffffffffffffffffffffffff',
      company: 'ffffffffffffffffffffffff',
      phoneNumberId: health.intruderPhoneNumberId,
      phone_number_id: health.intruderPhoneNumberId,
      wabaId: '7701000',
    });
    const accepted = await partner('POST', '/messages', { body, headers: { 'idempotency-key': key } });
    expect(accepted.status).toBe(202);
    await tick();

    const request = (await whaplyState()).requests.find((q) => q.external_ref === r.inspectionId);
    expect(request?.phone_number_id).toBe(health.phoneNumberId);
    const sent = await templatesTo(r.waPhone);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.phoneNumberId).toBe(health.phoneNumberId);
    expect(new Set((await metaSent()).map((s) => s.phoneNumberId))).toEqual(new Set([health.phoneNumberId]));

    // O botão assinado desta coleta, entregue pelo NÚMERO de outro tenant, não é tratado pela integração.
    const viaIntruder = await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonOf(sent[0]!), phoneNumberId: health.intruderPhoneNumberId });
    expect(viaIntruder.handled).toBe(false);
    expect((await sessionOf(r.inspectionId))?.state).toBe('AWAITING_START');
  });

  it('E2E-026b — no YuDirect, outra locadora não enxerga nem decide vistorias e fotos da FF Veículos', async () => {
    const { r, tpl } = await requested();
    await collectAll(r, tpl);
    expect((await inspection(r.inspectionId))?.status).toBe('SUBMITTED');

    expect((await api(otherCookie).post(`/api/v1/inspections/${r.inspectionId}/review`, { decision: 'APPROVE' })).statusCode).toBe(404);
    expect((await api(otherCookie).del(`/api/v1/inspections/${r.inspectionId}`)).statusCode).toBe(404);
    expect((await api(otherCookie).post(`/api/v1/inspections/${r.inspectionId}/request-correction`, { slots: ['FRONT'], reason: 'Placa ilegível na foto' })).statusCode).toBe(404);
    const list = await api(otherCookie).get(`/api/v1/messaging/messages?inspectionId=${r.inspectionId}`);
    expect(list.json().data).toHaveLength(0);
    expect((await inspection(r.inspectionId))?.status).toBe('SUBMITTED');
  });

  it('E2E-026c — foto "sem vínculo" de um cliente da FF Veículos fica na FF Veículos, nunca em outra locadora', async () => {
    const { r } = await requested();
    // Foto enviada antes de tocar em "Iniciar vistoria".
    expect((await inbound({ from: r.waPhone, type: 'image', imageBase64: nextImage().toString('base64') })).handled).toBe(true);
    await tick();

    const mine = await harness.ctx.mongo.collections.unmatchedMedia.countDocuments({ organizationId });
    const theirs = await harness.ctx.mongo.collections.unmatchedMedia.countDocuments({ organizationId: otherOrganizationId });
    const leakedFiles = await harness.ctx.mongo.collections.files.countDocuments({ organizationId: otherOrganizationId });
    expect({ theirs, leakedFiles }).toEqual({ theirs: 0, leakedFiles: 0 });
    expect(mine).toBeGreaterThanOrEqual(1);
    expect((await api(otherCookie).get('/api/v1/messaging/unmatched-media')).json().data).toHaveLength(0);
  });
});
