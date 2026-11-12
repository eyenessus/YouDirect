import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { fullMatrix, toE164BR } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { tinyPng } from '../testing/fake-whaply.js';
import { hashPassword } from '../common/helpers.js';
import { dispatchDueInspections, reconcileMessages, sendPendingMessages } from '../services/whatsapp-inspection.js';

/* ------------------------------------------------------------------ *
 * E2E ENTRE SISTEMAS — YuDirect real ⇄ Whaply real (harness), Meta
 * simulada. Plano: docs/architecture/yudirect-whaply-vistoria-plan.md §11.
 *
 * Diferente de `whatsapp-integration.test.ts` (que usa o simulador do
 * contrato), aqui o outro lado é o CÓDIGO DO WHAPLY: router HMAC, serviço
 * de parceiro, coleta guiada, download de mídia e outbox de eventos, que
 * chama a rota pública do YuDirect por HTTP de verdade.
 *
 * Opt-in: defina WHAPLY_E2E_DIR com o caminho do repositório do Whaply
 * (branch com tests/e2e-harness/YuDirectPartnerHarness.ts) e rode
 *   npm run test:e2e:whaply -w @yudirect/api
 * Sem a variável a suíte é ignorada (não falha o CI do YuDirect).
 * ------------------------------------------------------------------ */

const WHAPLY_DIR = process.env.WHAPLY_E2E_DIR;
const DAY = 24 * 3600 * 1000;
const KEYS = {
  ydToWh: { keyId: 'yd-e2e', secret: 'segredo-yd-para-wh-e2e-0123456789abcdef' },
  whToYd: { keyId: 'wh-e2e', secret: 'segredo-wh-para-yd-e2e-0123456789abcdef' },
};
const SLOTS = ['FRONT', 'REAR', 'LEFT_SIDE', 'RIGHT_SIDE', 'DASHBOARD'];

describe.skipIf(!WHAPLY_DIR)('E2E YuDirect ⇄ Whaply (código real dos dois lados)', () => {
  let child: ChildProcess;
  let whaplyUrl: string;
  let harness: TestHarness;
  let cookie: string;
  let n = 0;
  const later = (ms = 0) => new Date(Date.now() + 30 * DAY + ms);

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
  });

  /** Um ciclo completo: YuDirect envia, Whaply processa e entrega eventos. */
  async function cycle(times = 1) {
    for (let i = 0; i < times; i += 1) {
      await dispatchDueInspections(harness.ctx, later());
      await sendPendingMessages(harness.ctx, later());
      await wh('/__test/tick', {});
    }
  }

  async function newRental() {
    n += 1;
    const plate = `XE${String.fromCharCode(65 + n)}${n % 10}${String.fromCharCode(66 + n)}${String(n).padStart(2, '0')}`;
    const phone = `1197777${String(1000 + n).slice(-4)}`;
    const vehicle = await api(cookie).post('/api/v1/vehicles', { plate, brand: 'VW', model: 'Polo' });
    const driver = await api(cookie).post('/api/v1/drivers', { fullName: `Cliente E2E ${n}`, phone });
    await api(cookie).put(`/api/v1/drivers/${driver.json().id}/whatsapp-consent`, { action: 'GRANT', source: 'CONTRACT' });
    const rental = await api(cookie).post('/api/v1/rentals', {
      vehicleId: vehicle.json().id,
      driverId: driver.json().id,
      startDate: '2026-11-01',
      rentalType: 'MONTHLY',
      periodicAmountCents: 100000,
      depositCents: 0,
    });
    expect(rental.statusCode, rental.body).toBe(201);
    const req = await api(cookie).post(`/api/v1/vehicles/${vehicle.json().id}/inspections/request`, {
      responsibleName: `Cliente E2E ${n}`,
      phone,
      scheduledAt: '2026-11-20',
    });
    expect(req.statusCode, req.body).toBe(201);
    return {
      inspectionId: req.json().inspection.id as string,
      vehicleId: vehicle.json().id as string,
      driverId: driver.json().id as string,
      waPhone: toE164BR(phone)!.slice(1),
    };
  }

  async function metaSent() {
    return (await wh<{ data: Array<{ phoneNumberId: string; body: Record<string, any>; wamid: string | null }> }>('/__test/meta/sent')).data;
  }

  async function lastTemplateTo(waPhone: string, name?: string) {
    const sent = (await metaSent()).filter((s) => s.body.to === waPhone && s.body.type === 'template' && (!name || s.body.template.name === name));
    return sent.at(-1)!;
  }

  function buttonPayload(sent: { body: Record<string, any> }): string {
    const quick = (sent.body.template.components as Array<Record<string, any>>).find((c) => c.sub_type === 'quick_reply')!;
    return quick.parameters[0].payload as string;
  }

  async function inbound(body: Record<string, unknown>) {
    return wh<{ handled: boolean; wamid: string }>('/__test/inbound', body);
  }

  /** Em caso de falha, mostra o que cada lado registrou (inbox, alertas e estado do Whaply). */
  async function diagnose(id: string) {
    const inbox = await harness.ctx.mongo.collections.integrationInbox.find({ lastError: { $ne: null } }).toArray();
    const alerts = await harness.ctx.mongo.collections.notifications.find({ entityId: new ObjectId(id) }).toArray();
    const doc = await inspection(id);
    console.error('[diagnose] inbox com erro', inbox.map((i) => ({ type: i.type, seq: i.seq, err: i.lastError })));
    console.error('[diagnose] alertas', alerts.map((a) => a.message));
    console.error('[diagnose] coleta', doc?.collection, doc?.photoEvidence?.length);
    console.error('[diagnose] whaply', JSON.stringify((await wh('/__test/state')).events));
    console.error('[diagnose] textos ao cliente', (await metaSent()).filter((m) => m.body.type === 'text').map((m) => m.body.text.body));
  }

  const inspection = (id: string) => harness.ctx.mongo.collections.inspections.findOne({ _id: new ObjectId(id) });
  const messages = (id: string) => harness.ctx.mongo.collections.whatsappMessages.find({ inspectionId: new ObjectId(id) }).toArray();

  beforeAll(async () => {
    // Porta fixa opcional (WHAPLY_E2E_PORT / YUDIRECT_E2E_PORT) para maquinas com faixas de porta reservadas.
    const port = Number(process.env.WHAPLY_E2E_PORT) || 5100 + Math.floor(Math.random() * 800);
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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const collect = (s: unknown) => (s as { on(event: 'data', cb: (d: Buffer) => void): void } | null)?.on('data', (d) => (log += String(d)));
    collect(child.stdout);
    collect(child.stderr);
    for (let i = 0; i < 120; i += 1) {
      try {
        await wh('/__test/health');
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
    // O Whaply chama a rota pública do YuDirect por HTTP real.
    await harness.app.listen({ port: Number(process.env.YUDIRECT_E2E_PORT) || 0, host: '127.0.0.1' });
    const ydPort = (harness.app.server.address() as AddressInfo).port;
    await wh('/__test/configure', { callbackUrl: `http://127.0.0.1:${ydPort}/api/v1/integrations/whaply/events` });

    const now = new Date();
    const organizationId = new ObjectId();
    await harness.ctx.mongo.collections.organizations.insertOne({
      _id: organizationId,
      name: 'FF Veículos',
      legalId: null,
      timezone: 'America/Sao_Paulo',
      currency: 'BRL',
      settings: { freeSeats: 3, extraSeatPriceCents: 990 },
      createdAt: now,
      updatedAt: now,
    });
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: 'Dono',
      emailLower: 'dono@ff.test',
      passwordHash: await hashPassword('Dono@123456'),
      phone: null,
      status: 'ACTIVE',
      browserNotificationsEnabled: false,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await harness.ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(),
      organizationId,
      userId,
      role: 'OWNER',
      permissions: fullMatrix(),
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    const login = await harness.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'dono@ff.test', password: 'Dono@123456' } });
    cookie = sessionCookie(login.headers as Record<string, unknown>);
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
    await new Promise((r) => setTimeout(r, 1500));
    if (child && child.exitCode === null) child.kill();
    await harness?.close();
  });

  it('caminho completo: agendamento → template → status → coleta guiada → fotos íntegras → aprovação humana', async () => {
    const r = await newRental();
    await cycle();

    // Envio pela conta da FF Veículos, com o template aprovado.
    const tpl = await lastTemplateTo(r.waPhone, 'yudirect_vistoria_solicitacao');
    expect(tpl).toBeTruthy();
    expect(tpl.body.template.components.find((c: Record<string, any>) => c.type === 'body').parameters[1].text).toMatch(/^XE/);
    let [msg] = await messages(r.inspectionId);
    expect(msg?.status).toBe('ACCEPTED_BY_META');
    expect(msg?.wamid).toBe(tpl.wamid);

    // Status reais da Meta chegam ao YuDirect pelo outbox do Whaply.
    await wh('/__test/meta/status', { id: tpl.wamid, status: 'sent' });
    await wh('/__test/meta/status', { id: tpl.wamid, status: 'delivered', pricing: { billable: true, category: 'utility', pricing_model: 'PMP', type: 'regular' } });
    await wh('/__test/tick', {});
    [msg] = await messages(r.inspectionId);
    expect(msg?.status).toBe('DELIVERED');
    expect(msg?.pricing).toMatchObject({ billable: true, category: 'UTILITY' });

    // Cliente toca "Iniciar vistoria" (payload assinado pelo Whaply).
    expect((await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonPayload(tpl) })).handled).toBe(true);
    await wh('/__test/tick', {});
    expect((await inspection(r.inspectionId))?.collection?.status).toBe('IN_PROGRESS');

    const sentHashes: string[] = [];
    for (const [i] of SLOTS.entries()) {
      const img = tinyPng(1000 + i);
      sentHashes.push(createHash('sha256').update(img).digest('hex'));
      expect((await inbound({ from: r.waPhone, type: 'image', imageBase64: img.toString('base64') })).handled).toBe(true);
      await wh('/__test/tick', {});
    }
    expect((await inbound({ from: r.waPhone, type: 'text', text: '52.340' })).handled).toBe(true);
    await wh('/__test/tick', {});

    const done = await inspection(r.inspectionId);
    if (done?.status !== 'SUBMITTED') await diagnose(r.inspectionId);
    expect(done?.status).toBe('SUBMITTED'); // aguardando revisão — evento externo não aprova
    expect(done?.collection?.status).toBe('COMPLETE');
    expect(done?.odometerKm).toBe(52340);
    expect(done?.photos.map((p) => p.slotCode)).toEqual(SLOTS);

    // A foto armazenada no YuDirect é byte a byte a enviada pelo cliente.
    for (const [i, photo] of done!.photos.entries()) {
      const file = await harness.ctx.mongo.collections.files.findOne({ _id: photo.fileId });
      expect(file?.checksum).toBe(sentHashes[i]);
    }

    // Instruções da coleta viram mensagens de serviço rastreadas (custos).
    const prompts = (await messages(r.inspectionId)).filter((m) => m.kind === 'SESSION_PROMPT');
    expect(prompts.length).toBeGreaterThanOrEqual(SLOTS.length + 1);

    // Só a FF Veículos enviou — nunca o outro tenant do mesmo banco.
    const sent = await metaSent();
    expect(new Set(sent.map((s) => s.phoneNumberId))).toEqual(new Set(['551100009999']));

    const approve = await api(cookie).post(`/api/v1/inspections/${r.inspectionId}/review`, { decision: 'APPROVE' });
    expect(approve.statusCode).toBe(200);
    expect((await inspection(r.inspectionId))?.status).toBe('APPROVED');
  });

  it('retry com a mesma chave não gera segundo envio na Meta (idempotência ponta a ponta)', async () => {
    const r = await newRental();
    await dispatchDueInspections(harness.ctx, later());
    await sendPendingMessages(harness.ctx, later());
    const [first] = await messages(r.inspectionId);
    // Simula a resposta perdida: o YuDirect volta a enviar o mesmo pedido.
    await harness.ctx.mongo.collections.whatsappMessages.updateOne(
      { _id: first!._id },
      { $set: { status: 'RETRY_SCHEDULED', nextAttemptAt: new Date(), whaplyRequestId: null } },
    );
    await sendPendingMessages(harness.ctx, later());
    const [again] = await messages(r.inspectionId);
    expect(again?.whaplyRequestId).toBe(first?.whaplyRequestId);
    await wh('/__test/tick', {});
    const sentToClient = (await metaSent()).filter((s) => s.body.to === r.waPhone && s.body.type === 'template');
    expect(sentToClient).toHaveLength(1);
  });

  it('template pausado no Whaply: falha definitiva, link manual, nenhuma mensagem enviada', async () => {
    await wh('/__test/templates', { name: 'yudirect_vistoria_solicitacao', status: 'PAUSED' });
    try {
      const r = await newRental();
      const before = (await metaSent()).length;
      await cycle();
      const [msg] = await messages(r.inspectionId);
      expect(msg?.status).toBe('FAILED');
      expect(msg?.lastError).toMatchObject({ code: 'TEMPLATE_NOT_APPROVED', source: 'WHAPLY' });
      const doc = await inspection(r.inspectionId);
      expect(doc?.collection?.status).toBe('FAILED');
      expect(doc?.delivery?.manualLink).toContain('/vistoria/');
      expect((await metaSent()).length).toBe(before);
    } finally {
      await wh('/__test/templates', { name: 'yudirect_vistoria_solicitacao', status: 'APPROVED' });
    }
  });

  it('falha permanente da Meta (número sem WhatsApp) chega ao YuDirect com origem META', async () => {
    const r = await newRental();
    await wh('/__test/meta/fail-next', { status: 400, body: { error: { code: 131026, message: 'Message undeliverable' } } });
    await cycle();
    const [msg] = await messages(r.inspectionId);
    expect(msg?.status).toBe('FAILED');
    expect(msg?.lastError).toMatchObject({ code: '131026', source: 'META' });
    expect((await inspection(r.inspectionId))?.collection?.status).toBe('FAILED');
  });

  it('YuDirect fora do ar: eventos acumulam no Whaply e a reconciliação recupera por sequência', async () => {
    const r = await newRental();
    await wh('/__test/configure', { callbackDown: true });
    try {
      await cycle();
      const tpl = await lastTemplateTo(r.waPhone);
      await wh('/__test/meta/status', { id: tpl.wamid, status: 'read', pricing: { billable: true, category: 'utility' } });
      await wh('/__test/tick', {});
      let [msg] = await messages(r.inspectionId);
      expect(msg?.status).toBe('ACCEPTED_BY_WHAPLY'); // nada chegou ainda
      const result = await reconcileMessages(harness.ctx, new Date());
      expect(result.replayed).toBeGreaterThanOrEqual(2);
      [msg] = await messages(r.inspectionId);
      expect(msg?.status).toBe('READ');
    } finally {
      await wh('/__test/configure', { callbackDown: false });
      await wh('/__test/tick', {}); // entrega os pendentes (o YuDirect deduplica)
    }
  });

  it('cliente responde SAIR: coleta encerrada e consentimento revogado no YuDirect', async () => {
    const r = await newRental();
    await cycle();
    const tpl = await lastTemplateTo(r.waPhone);
    await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonPayload(tpl) });
    expect((await inbound({ from: r.waPhone, type: 'text', text: 'SAIR' })).handled).toBe(true);
    await wh('/__test/tick', {});
    const driver = await harness.ctx.mongo.collections.drivers.findOne({ _id: new ObjectId(r.driverId) });
    expect(driver?.whatsappConsent).toMatchObject({ status: 'REVOKED', revokedSource: 'WHATSAPP_STOP' });
    expect((await inspection(r.inspectionId))?.collection?.status).toBe('FAILED');
  });

  it('foto fora da coleta não entra na vistoria: vai para "sem vínculo" e só é atribuída pela equipe', async () => {
    const r = await newRental();
    await cycle();
    const tpl = await lastTemplateTo(r.waPhone);
    // Foto ANTES de iniciar a coleta.
    expect((await inbound({ from: r.waPhone, type: 'image', imageBase64: tinyPng(2000).toString('base64') })).handled).toBe(true);
    await wh('/__test/tick', {});
    expect((await inspection(r.inspectionId))?.photos ?? []).toHaveLength(0);
    const list = await api(cookie).get('/api/v1/messaging/unmatched-media');
    const item = (list.json().data as Array<{ id: string }>)[0];
    expect(item).toBeTruthy();
    const assign = await api(cookie).post(`/api/v1/messaging/unmatched-media/${item!.id}/assign`, { inspectionId: r.inspectionId, slotCode: 'FRONT' });
    expect(assign.statusCode).toBe(200);
    expect((await inspection(r.inspectionId))?.photos.map((p) => p.slotCode)).toEqual(['FRONT']);
    void tpl;
  });

  it('correção: só o ângulo pedido é coletado de novo, em nova rodada, e a foto antiga vira histórico', async () => {
    const r = await newRental();
    await cycle();
    let tpl = await lastTemplateTo(r.waPhone, 'yudirect_vistoria_solicitacao');
    await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonPayload(tpl) });
    for (const [i] of SLOTS.entries()) await inbound({ from: r.waPhone, type: 'image', imageBase64: tinyPng(3000 + i).toString('base64') });
    await inbound({ from: r.waPhone, type: 'text', text: '1000' });
    await wh('/__test/tick', {});
    expect((await inspection(r.inspectionId))?.status).toBe('SUBMITTED');
    const oldFront = (await inspection(r.inspectionId))!.photos.find((p) => p.slotCode === 'FRONT')!;

    const corr = await api(cookie).post(`/api/v1/inspections/${r.inspectionId}/request-correction`, { slots: ['FRONT'], reason: 'Placa ilegível' });
    expect(corr.statusCode, corr.body).toBe(200);
    await sendPendingMessages(harness.ctx, later());
    await wh('/__test/tick', {});
    tpl = await lastTemplateTo(r.waPhone, 'yudirect_vistoria_correcao');
    expect(tpl.body.template.components.find((c: Record<string, any>) => c.type === 'body').parameters[3].text).toBe('Placa ilegível');

    await inbound({ from: r.waPhone, type: 'button', buttonPayload: buttonPayload(tpl) });
    await inbound({ from: r.waPhone, type: 'image', imageBase64: tinyPng(3999).toString('base64') });
    await wh('/__test/tick', {});
    const after = await inspection(r.inspectionId);
    expect(after?.status).toBe('SUBMITTED');
    expect(after?.correctionRound).toBe(1);
    const newFront = after!.photos.find((p) => p.slotCode === 'FRONT')!;
    expect(newFront.fileId.equals(oldFront.fileId)).toBe(false);
    expect(after!.photoEvidence!.find((e) => e.fileId.equals(oldFront.fileId))?.supersededAt).toBeTruthy();
    expect(after!.photos).toHaveLength(5);
  });

  it('chave errada no YuDirect: o Whaply recusa (401) e nada é enviado', async () => {
    const wrong = await createHarness({
      WHAPLY_INTEGRATION_ENABLED: 'true',
      WHAPLY_API_URL: whaplyUrl,
      WHAPLY_OUTBOUND_KEY_ID: KEYS.ydToWh.keyId,
      WHAPLY_OUTBOUND_SECRET: 'segredo-errado-com-mais-de-32-caracteres!!',
      WHAPLY_INBOUND_KEY_ID: KEYS.whToYd.keyId,
      WHAPLY_INBOUND_SECRET: KEYS.whToYd.secret,
    });
    try {
      const res = await wrong.ctx.integrations.whaply.sendMessage('{}', 'chave-qualquer-123');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.status).toBe(401);
        expect(res.code).toBe('SIGNATURE_INVALID');
        expect(res.retryable).toBe(false);
      }
    } finally {
      await wrong.close();
    }
  });
});
