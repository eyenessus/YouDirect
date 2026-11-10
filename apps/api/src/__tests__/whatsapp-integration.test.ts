import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { canPromoteMessage, emptyMatrix, fullMatrix, toE164BR } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { FAKE_KEYS, FakeWhaply, tinyPng } from '../testing/fake-whaply.js';
import { hashPassword } from '../common/helpers.js';
import { signRequest, verifySignature } from '../integrations/whaply/signing.js';
import {
  dispatchDueInspections,
  localDateTimeToUtc,
  reconcileMessages,
  retryDelayMs,
  runCollectionLifecycle,
  sendPendingMessages,
} from '../services/whatsapp-inspection.js';
import { tryAcquireLease } from '../jobs/lease.js';

/* ------------------------------------------------------------------ *
 * WA22–WA50 — coleta de vistoria pelo WhatsApp (YuDirect ⇄ Whaply).
 * O Whaply é simulado por um servidor HTTP real (`FakeWhaply`) que
 * implementa o contrato v1 com assinatura, idempotência e eventos.
 * Plano: docs/architecture/yudirect-whaply-vistoria-plan.md §11.
 * ------------------------------------------------------------------ */

const DAY = 24 * 3600 * 1000;
const SLOT_CODES = ['FRONT', 'REAR', 'LEFT_SIDE', 'RIGHT_SIDE', 'DASHBOARD'];

describe('assinatura HMAC v1 (unitário)', () => {
  const key = { keyId: 'k1', secret: 'segredo-com-pelo-menos-32-caracteres!!' };
  const sign = (body: string, now = new Date()) => signRequest(key, { method: 'POST', path: '/x?y=1', body, now });

  it('aceita assinatura válida e rejeita corpo alterado', () => {
    const headers = sign('{"a":1}');
    expect(verifySignature({ keys: [key], headers, method: 'POST', path: '/x?y=1', body: '{"a":1}' }).ok).toBe(true);
    const tampered = verifySignature({ keys: [key], headers, method: 'POST', path: '/x?y=1', body: '{"a":2}' });
    expect(tampered).toMatchObject({ ok: false, reason: 'SIGNATURE_INVALID' });
  });

  it('rejeita relógio fora da janela, chave desconhecida, caminho trocado e cabeçalhos ausentes', () => {
    const old = sign('{}', new Date(Date.now() - 10 * 60 * 1000));
    expect(verifySignature({ keys: [key], headers: old, method: 'POST', path: '/x?y=1', body: '{}' }).reason).toBe('TIMESTAMP_SKEW');
    const headers = sign('{}');
    expect(
      verifySignature({ keys: [{ keyId: 'outra', secret: key.secret }], headers, method: 'POST', path: '/x?y=1', body: '{}' }).reason,
    ).toBe('UNKNOWN_KEY');
    expect(verifySignature({ keys: [key], headers, method: 'POST', path: '/x?y=2', body: '{}' }).ok).toBe(false);
    expect(verifySignature({ keys: [key], headers: {}, method: 'POST', path: '/x', body: '' }).reason).toBe('MISSING_HEADERS');
  });

  it('aceita a chave de rotação (NEXT) com o mesmo keyId', () => {
    const next = { keyId: 'k1', secret: 'nova-chave-de-rotacao-com-32-caracteres!!' };
    const headers = signRequest(next, { method: 'POST', path: '/x', body: 'b' });
    expect(verifySignature({ keys: [key, next], headers, method: 'POST', path: '/x', body: 'b' }).ok).toBe(true);
  });
});

describe('regras de domínio (unitário)', () => {
  it('normaliza telefones brasileiros para E.164', () => {
    expect(toE164BR('11987654321')).toBe('+5511987654321');
    expect(toE164BR('(21) 3333-4444')).toBe('+552133334444');
    expect(toE164BR('5511987654321')).toBe('+5511987654321');
    expect(toE164BR('123')).toBeNull();
    expect(toE164BR('00987654321')).toBeNull();
  });

  it('promove estados de mensagem apenas para frente', () => {
    expect(canPromoteMessage('SENT', 'DELIVERED')).toBe(true);
    expect(canPromoteMessage('READ', 'DELIVERED')).toBe(false);
    expect(canPromoteMessage('DELIVERED', 'FAILED')).toBe(false);
    expect(canPromoteMessage('SENT', 'FAILED')).toBe(true);
    expect(canPromoteMessage('FAILED', 'SENT')).toBe(false);
    expect(canPromoteMessage('CANCELED', 'SENT')).toBe(false);
    expect(canPromoteMessage('INTENT_CREATED', 'CANCELED')).toBe(true);
    expect(canPromoteMessage('SENT', 'CANCELED')).toBe(false);
  });

  it('calcula o horário de disparo em America/Sao_Paulo', () => {
    expect(localDateTimeToUtc('2026-11-12', '09:00').toISOString()).toBe('2026-11-12T12:00:00.000Z');
    expect(localDateTimeToUtc('2026-01-31', '23:30').toISOString()).toBe('2026-02-01T02:30:00.000Z');
  });

  it('aplica backoff exponencial com jitter limitado', () => {
    expect(retryDelayMs(1, () => 0.5)).toBe(30_000);
    expect(retryDelayMs(3, () => 0.5)).toBe(120_000);
    expect(retryDelayMs(20, () => 0.5)).toBe(30 * 60_000);
    expect(retryDelayMs(1, () => 0)).toBe(24_000);
    expect(retryDelayMs(1, () => 1)).toBe(36_000);
  });
});

describe('coleta de vistoria pelo WhatsApp (YuDirect ⇄ Whaply simulado)', () => {
  let harness: TestHarness;
  const fake = new FakeWhaply();
  let cookie: string;
  let memberCookie: string;
  let organizationId: ObjectId;
  let vehicleId: string;
  let driverId: string;
  let vehicleCounter = 0;

  const req = (c: string) => ({
    get: (url: string) => harness.app.inject({ method: 'GET', url, headers: { cookie: c } }),
    post: (url: string, payload?: unknown) => harness.app.inject({ method: 'POST', url, headers: { cookie: c }, payload: payload as never }),
    put: (url: string, payload?: unknown) => harness.app.inject({ method: 'PUT', url, headers: { cookie: c }, payload: payload as never }),
    patch: (url: string, payload?: unknown) => harness.app.inject({ method: 'PATCH', url, headers: { cookie: c }, payload: payload as never }),
    del: (url: string) => harness.app.inject({ method: 'DELETE', url, headers: { cookie: c } }),
  });
  const later = (ms = 0) => new Date(Date.now() + 30 * DAY + ms);
  const inspections = () => harness.ctx.mongo.collections.inspections;
  const messages = () => harness.ctx.mongo.collections.whatsappMessages;

  async function login(email: string, password: string): Promise<string> {
    const res = await harness.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
    expect(res.statusCode).toBe(200);
    return sessionCookie(res.headers as Record<string, unknown>);
  }

  async function addUser(email: string, role: 'OWNER' | 'MEMBER', permissions = fullMatrix()) {
    const now = new Date();
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: email,
      emailLower: email,
      passwordHash: await hashPassword('Senha@123456'),
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
      role,
      permissions,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    return login(email, 'Senha@123456');
  }

  /** Veículo + motorista com consentimento + locação ativa. */
  async function rentedVehicle(opts: { consent?: boolean; phone?: string } = {}) {
    vehicleCounter += 1;
    const L = (n: number) => String.fromCharCode(65 + (Math.floor(n) % 26));
    const plate = `W${L(vehicleCounter / 26)}${L(vehicleCounter)}${vehicleCounter % 10}${L(vehicleCounter / 10)}${String(vehicleCounter % 100).padStart(2, '0')}`;
    const vehicle = await req(cookie).post('/api/v1/vehicles', { plate, brand: 'Fiat', model: 'Cronos' });
    expect(vehicle.statusCode, vehicle.body).toBe(201);
    const phone = opts.phone ?? `1198888${String(1000 + vehicleCounter).slice(-4)}`;
    const driver = await req(cookie).post('/api/v1/drivers', { fullName: `Carlos Teste ${vehicleCounter}`, phone });
    expect(driver.statusCode, driver.body).toBe(201);
    if (opts.consent !== false) {
      const consent = await req(cookie).put(`/api/v1/drivers/${driver.json().id}/whatsapp-consent`, {
        action: 'GRANT',
        source: 'CONTRACT',
      });
      expect(consent.statusCode).toBe(200);
    }
    const rental = await req(cookie).post('/api/v1/rentals', {
      vehicleId: vehicle.json().id,
      driverId: driver.json().id,
      startDate: '2026-11-01',
      endDate: '2027-01-01',
      rentalType: 'MONTHLY',
      periodicAmountCents: 150000,
      depositCents: 50000,
    });
    expect(rental.statusCode, rental.body).toBe(201);
    return { vehicleId: vehicle.json().id as string, driverId: driver.json().id as string, phone, name: `Carlos Teste ${vehicleCounter}` };
  }

  async function requestInspection(v: { vehicleId: string; phone: string; name: string }, scheduledAt = '2026-11-20') {
    const res = await req(cookie).post(`/api/v1/vehicles/${v.vehicleId}/inspections/request`, {
      responsibleName: v.name,
      phone: v.phone,
      scheduledAt,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { inspection: { id: string; collection: { status: string } | null; delivery: { channel: string; status: string } }; link: string };
  }

  /** Agenda, dispara e envia: devolve o registro do pedido no Whaply. */
  async function dispatchAndSend(v: Awaited<ReturnType<typeof rentedVehicle>>) {
    const { inspection } = await requestInspection(v);
    await dispatchDueInspections(harness.ctx, later());
    await sendPendingMessages(harness.ctx, later());
    const rec = [...fake.requests.values()].find((r) => r.body.externalRef.id === inspection.id)!;
    expect(rec).toBeTruthy();
    return { inspectionId: inspection.id, rec };
  }

  async function sendAllPhotos(inspectionId: string, rec: { requestId: string; sessionId: string | null; body: { correlationId: string } }, opts: { round?: number; codes?: string[]; variant?: number } = {}) {
    const ref = { inspectionId, requestId: rec.requestId, sessionId: rec.sessionId, correlationId: rec.body.correlationId };
    for (const [i, code] of (opts.codes ?? SLOT_CODES).entries()) {
      const media = fake.addMedia(tinyPng((opts.variant ?? 0) * 100 + i));
      const res = await fake.emit(
        'session.media_received',
        { slotCode: code, mediaRef: media.mediaRef, sha256: media.sha256, mimeType: 'image/png', size: 80, wamid: `wamid.in.${new ObjectId().toHexString()}`, round: opts.round ?? 0 },
        ref,
      );
      expect(res.statusCode).toBe(204);
    }
  }

  beforeAll(async () => {
    await fake.start();
    harness = await createHarness(fake.env());
    fake.app = harness.app;

    const now = new Date();
    organizationId = new ObjectId();
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
    cookie = await addUser('owner@ff.test', 'OWNER');
    const restricted = emptyMatrix();
    restricted.inspections = ['read'];
    memberCookie = await addUser('membro@ff.test', 'MEMBER', restricted);

    const settings = await req(cookie).put('/api/v1/inspection/whatsapp-settings', {
      enabled: true,
      sendTime: '09:00',
      reminderAfterHours: 24,
      maxReminders: 1,
      collectionTtlHours: 72,
      instructions: { FRONT: 'Fotografe a frente inteira, com a placa legível.' },
    });
    expect(settings.statusCode).toBe(200);
  });

  afterAll(async () => {
    await harness?.close();
    await fake.stop();
  });

  beforeEach(() => fake.reset());

  /* ------------------------- T22 caminho feliz -------------------- */
  it('WA22 — agenda, dispara uma única vez, envia, recebe as fotos e aguarda aprovação humana', async () => {
    const v = await rentedVehicle();
    vehicleId = v.vehicleId;
    driverId = v.driverId;
    const { inspection } = await requestInspection(v);
    expect(inspection.collection?.status).toBe('SCHEDULED');
    expect(inspection.delivery).toMatchObject({ channel: 'WHATSAPP', status: 'PENDING' });
    expect(fake.requests.size).toBe(0); // nada enviado na criação

    // Antes da hora: nada acontece.
    expect(await dispatchDueInspections(harness.ctx, new Date('2026-01-01T00:00:00Z'))).toBe(0);

    // Dois workers simultâneos → UMA intenção.
    const [a, b] = await Promise.all([
      dispatchDueInspections(harness.ctx, later()),
      dispatchDueInspections(harness.ctx, later()),
    ]);
    expect(a + b).toBe(1);
    expect(await messages().countDocuments({ inspectionId: new ObjectId(inspection.id) })).toBe(1);

    await Promise.all([sendPendingMessages(harness.ctx, later()), sendPendingMessages(harness.ctx, later())]);
    expect(fake.requests.size).toBe(1);
    const rec = fake.latest()!;
    expect(rec.posts).toBe(1);
    expect(rec.body.recipient.phoneE164).toBe(toE164BR(v.phone));
    expect(rec.body.template.name).toBe('yudirect_vistoria_solicitacao');
    expect(rec.body.template.bodyParams[1]).toMatch(/^W[A-Z]{2}\d[A-Z]\d{2}$/);
    expect(rec.body.session?.steps.map((s) => s.code)).toEqual([...SLOT_CODES, 'ODOMETER']);
    expect(rec.body.session?.steps[0]?.instruction).toContain('placa');
    expect(rec.body.consent.source).toBe('CONTRACT');
    expect(fake.authFailures).toHaveLength(0);

    let msg = await messages().findOne({ inspectionId: new ObjectId(inspection.id) });
    expect(msg?.status).toBe('ACCEPTED_BY_WHAPLY');
    expect(msg?.whaplyRequestId).toBe(rec.requestId);

    // Ciclo de status real (aceita pela Meta → enviada → entregue → lida).
    expect((await fake.metaAccept(rec)).statusCode).toBe(204);
    expect((await fake.status(rec, 'sent')).statusCode).toBe(204);
    expect((await fake.status(rec, 'delivered')).statusCode).toBe(204);
    expect((await fake.status(rec, 'read')).statusCode).toBe(204);
    msg = await messages().findOne({ _id: msg!._id });
    expect(msg?.status).toBe('READ');
    expect(msg?.wamid).toBe(rec.wamid);
    expect(msg?.pricing).toMatchObject({ billable: true, category: 'UTILITY' });
    expect(msg?.timestamps.deliveredAt).toBeTruthy();

    const ref = { inspectionId: inspection.id, requestId: rec.requestId, sessionId: rec.sessionId, correlationId: rec.body.correlationId };
    expect((await fake.emit('session.started', { round: 0 }, ref)).statusCode).toBe(204);
    expect((await inspections().findOne({ _id: new ObjectId(inspection.id) }))?.collection?.status).toBe('IN_PROGRESS');

    await sendAllPhotos(inspection.id, rec);
    let doc = await inspections().findOne({ _id: new ObjectId(inspection.id) });
    expect(doc?.collection?.status).toBe('PARTIAL');
    expect(doc?.collection?.receivedSlots.sort()).toEqual([...SLOT_CODES].sort());
    expect(doc?.photos).toHaveLength(5);
    expect(doc?.status).toBe('PENDING');

    await fake.emit('session.text_received', { slotCode: 'ODOMETER', value: '45.210' }, ref);
    await fake.emit('session.completed', { round: 0 }, ref);
    doc = await inspections().findOne({ _id: new ObjectId(inspection.id) });
    expect(doc?.status).toBe('SUBMITTED'); // aguardando revisão — NUNCA aprovada sozinha
    expect(doc?.odometerKm).toBe(45210);
    expect(doc?.collection?.status).toBe('COMPLETE');
    const audit = await harness.ctx.mongo.collections.auditLogs.findOne({ entityId: doc!._id, action: 'inspection.submitted' });
    expect(audit?.after).toMatchObject({ source: 'WHATSAPP' });

    // Responsável aprova; segunda decisão concorrente é recusada.
    const [first, second] = await Promise.all([
      req(cookie).post(`/api/v1/inspections/${inspection.id}/review`, { decision: 'APPROVE' }),
      req(cookie).post(`/api/v1/inspections/${inspection.id}/review`, { decision: 'REJECT' }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const decided = await inspections().findOne({ _id: new ObjectId(inspection.id) });
    expect(['APPROVED', 'REJECTED']).toContain(decided?.status);
    expect(await harness.ctx.mongo.collections.auditLogs.countDocuments({ entityId: decided!._id, action: { $in: ['inspection.approved', 'inspection.rejected'] } })).toBe(1);

    // Histórico mostra coleta e evidências por ângulo.
    const history = await req(cookie).get(`/api/v1/vehicles/${v.vehicleId}/inspections`);
    const dto = (history.json().data as Array<{ id: string; collection: { statusLabel: string }; evidence: unknown[] }>).find((i) => i.id === inspection.id)!;
    expect(dto.collection.statusLabel).toBe('Fotos completas');
    expect(dto.evidence).toHaveLength(5);
  });

  /* --------------------- consentimento e elegibilidade -------------- */
  it('WA41 — sem consentimento não agenda pelo WhatsApp e mantém o link manual', async () => {
    const v = await rentedVehicle({ consent: false });
    const { inspection } = await requestInspection(v);
    expect(inspection.collection?.status).toBe('BLOCKED_NO_CONSENT');
    expect(inspection.delivery.channel).toBe('MANUAL');
    await dispatchDueInspections(harness.ctx, later());
    await sendPendingMessages(harness.ctx, later());
    expect(fake.requests.size).toBe(0);
  });

  it('WA41b — consentimento revogado depois do agendamento bloqueia o disparo', async () => {
    const v = await rentedVehicle();
    const { inspection } = await requestInspection(v);
    await req(cookie).put(`/api/v1/drivers/${v.driverId}/whatsapp-consent`, { action: 'REVOKE', reason: 'pedido do cliente' });
    await dispatchDueInspections(harness.ctx, later());
    const doc = await inspections().findOne({ _id: new ObjectId(inspection.id) });
    expect(doc?.collection?.status).toBe('BLOCKED_NO_CONSENT');
    expect(await messages().countDocuments({ inspectionId: doc!._id })).toBe(0);
    const audit = await harness.ctx.mongo.collections.auditLogs.findOne({ entityId: new ObjectId(v.driverId), action: 'driver.consent_revoked' });
    expect(audit).toBeTruthy();
  });

  it('WA41c — telefone diferente do cadastro não é coberto pelo consentimento', async () => {
    const v = await rentedVehicle();
    const res = await req(cookie).post(`/api/v1/vehicles/${v.vehicleId}/inspections/request`, {
      responsibleName: v.name,
      phone: '11900001111',
      scheduledAt: '2026-11-20',
    });
    expect(res.json().inspection.collection.status).toBe('BLOCKED_NO_CONSENT');
  });

  /* --------------------------- falhas de envio ----------------------- */
  it('WA33 — timeout com confirmação posterior: retry com a MESMA chave não duplica', async () => {
    const v = await rentedVehicle();
    const { inspection } = await requestInspection(v);
    await dispatchDueInspections(harness.ctx, later());
    fake.enqueue({ kind: 'accept-then-hang' });
    await sendPendingMessages(harness.ctx, later());
    let msg = await messages().findOne({ inspectionId: new ObjectId(inspection.id) });
    expect(msg?.status).toBe('RETRY_SCHEDULED');
    expect(msg?.lastError?.source).toBe('TRANSPORT');
    expect(fake.requests.size).toBe(1); // o Whaply aceitou

    await sendPendingMessages(harness.ctx, later(DAY));
    msg = await messages().findOne({ _id: msg!._id });
    expect(msg?.status).toBe('ACCEPTED_BY_WHAPLY');
    expect(fake.requests.size).toBe(1);
    expect(fake.latest()?.posts).toBe(2); // mesmo pedido, mesma chave
    expect(msg?.whaplyRequestId).toBe(fake.latest()?.requestId);
  });

  it('WA31 — Whaply indisponível (503) agenda nova tentativa e depois envia', async () => {
    const v = await rentedVehicle();
    const { inspection } = await requestInspection(v);
    await dispatchDueInspections(harness.ctx, later());
    fake.enqueue({ kind: 'status', status: 503, body: { error: { code: 'CHANNEL_UNAVAILABLE', message: 'manutenção', retryable: true } }, headers: { 'retry-after': '120' } });
    await sendPendingMessages(harness.ctx, later());
    let msg = await messages().findOne({ inspectionId: new ObjectId(inspection.id) });
    expect(msg?.status).toBe('RETRY_SCHEDULED');
    expect(msg!.nextAttemptAt!.getTime() - later().getTime()).toBeGreaterThanOrEqual(119_000);
    // Antes do horário de retry nada é enviado.
    await sendPendingMessages(harness.ctx, later(10_000));
    expect(fake.requests.size).toBe(0);
    await sendPendingMessages(harness.ctx, later(DAY));
    msg = await messages().findOne({ _id: msg!._id });
    expect(msg?.status).toBe('ACCEPTED_BY_WHAPLY');
  });

  it('WA39 — template não aprovado: falha definitiva, link manual e alerta (sem retry)', async () => {
    const v = await rentedVehicle();
    const { inspection } = await requestInspection(v);
    await dispatchDueInspections(harness.ctx, later());
    fake.enqueue({ kind: 'status', status: 422, body: { error: { code: 'TEMPLATE_NOT_APPROVED', message: 'Template pausado', retryable: false } } });
    await sendPendingMessages(harness.ctx, later());
    const msg = await messages().findOne({ inspectionId: new ObjectId(inspection.id) });
    expect(msg?.status).toBe('FAILED');
    expect(msg?.lastError).toMatchObject({ code: 'TEMPLATE_NOT_APPROVED', source: 'WHAPLY' });
    const doc = await inspections().findOne({ _id: new ObjectId(inspection.id) });
    expect(doc?.collection?.status).toBe('FAILED');
    expect(doc?.delivery?.channel).toBe('MANUAL');
    expect(doc?.delivery?.manualLink).toContain('/vistoria/');
    const alert = await harness.ctx.mongo.collections.notifications.findOne({ dedupeKey: `wa-failed:${msg!._id.toHexString()}` });
    expect(alert?.severity).toBe('CRITICAL');
    // Não reprocessa sozinho; reprocessar manual só para falha de transporte.
    await sendPendingMessages(harness.ctx, later(DAY));
    expect(fake.requests.size).toBe(0);
    const retry = await req(cookie).post(`/api/v1/messaging/messages/${msg!._id.toHexString()}/retry`);
    expect(retry.statusCode).toBe(409);
  });

  it('WA36 — processo caiu durante o POST: reconciliação reenfileira com a mesma chave', async () => {
    const v = await rentedVehicle();
    const { inspection } = await requestInspection(v);
    await dispatchDueInspections(harness.ctx, later());
    const msg = await messages().findOne({ inspectionId: new ObjectId(inspection.id) });
    await messages().updateOne({ _id: msg!._id }, { $set: { status: 'SUBMITTED_TO_WHAPLY', leaseUntil: new Date(Date.now() - 1000), attempts: 1 } });
    const result = await reconcileMessages(harness.ctx, new Date());
    expect(result.recovered).toBeGreaterThanOrEqual(1);
    expect((await messages().findOne({ _id: msg!._id }))?.status).toBe('RETRY_SCHEDULED');
    await sendPendingMessages(harness.ctx, later());
    expect((await messages().findOne({ _id: msg!._id }))?.status).toBe('ACCEPTED_BY_WHAPLY');
    expect(fake.latest()?.idempotencyKey).toBe(msg!.idempotencyKey);
  });

  it('WA37 — vistoria cancelada antes do disparo não envia nada', async () => {
    const v = await rentedVehicle();
    const { inspection } = await requestInspection(v);
    expect((await req(cookie).del(`/api/v1/inspections/${inspection.id}`)).statusCode).toBe(200);
    await dispatchDueInspections(harness.ctx, later());
    await sendPendingMessages(harness.ctx, later());
    expect(fake.requests.size).toBe(0);
    expect(await messages().countDocuments({ inspectionId: new ObjectId(inspection.id) })).toBe(0);
  });

  it('WA37b — cancelada entre a intenção e o envio: intenção cancelada, sem POST', async () => {
    const v = await rentedVehicle();
    const { inspection } = await requestInspection(v);
    await dispatchDueInspections(harness.ctx, later());
    await req(cookie).del(`/api/v1/inspections/${inspection.id}`);
    await sendPendingMessages(harness.ctx, later());
    expect(fake.requests.size).toBe(0);
    expect((await messages().findOne({ inspectionId: new ObjectId(inspection.id) }))?.status).toBe('CANCELED');
  });

  it('WA38 — reagendamento antes do disparo move o horário; depois do envio é recusado', async () => {
    const v = await rentedVehicle();
    const { inspection } = await requestInspection(v, '2026-12-20');
    const moved = await req(cookie).patch(`/api/v1/inspections/${inspection.id}/schedule`, { scheduledAt: '2026-12-22' });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().scheduledSendAt).toBe('2026-12-22T12:00:00.000Z');
    // No dia antigo, não dispara.
    expect(await dispatchDueInspections(harness.ctx, new Date('2026-12-21T12:00:00Z'))).toBe(0);
    await dispatchDueInspections(harness.ctx, new Date('2026-12-22T12:00:01Z'));
    const again = await req(cookie).patch(`/api/v1/inspections/${inspection.id}/schedule`, { scheduledAt: '2026-12-24' });
    expect(again.statusCode).toBe(409);
  });

  /* -------------------------- eventos e webhooks -------------------- */
  it('WA34/WA35 — evento duplicado é idempotente e fora de ordem não regride', async () => {
    const v = await rentedVehicle();
    const { rec } = await dispatchAndSend(v);
    await fake.metaAccept(rec);
    const read = fake.record(
      'message.read',
      { idempotencyKey: rec.idempotencyKey, wamid: rec.wamid, pricing: { billable: true, category: 'utility' } },
      { inspectionId: rec.body.externalRef.id, requestId: rec.requestId },
    );
    const first = await fake.deliver(read);
    expect(first.statusCode).toBe(204);
    expect(first.headers['x-yu-outcome']).toBe('processed');
    const dup = await fake.deliver(read);
    expect(dup.statusCode).toBe(204);
    expect(dup.headers['x-yu-outcome']).toBe('duplicate');

    // "delivered" e "sent" atrasados não regridem de READ.
    await fake.status(rec, 'delivered');
    await fake.status(rec, 'sent');
    const msg = await messages().findOne({ whaplyRequestId: rec.requestId });
    expect(msg?.status).toBe('READ');
    expect(msg?.timestamps.deliveredAt).toBeTruthy();
    // Falha depois de lida é ignorada.
    await fake.status(rec, 'failed', { code: 131026, title: 'tarde demais' });
    expect((await messages().findOne({ _id: msg!._id }))?.status).toBe('READ');
  });

  it('WA42 — segurança da rota de eventos: assinatura, replay, chave errada e relógio', async () => {
    const event = fake.record('message.sent', { wamid: 'wamid.x' }, {});
    expect((await fake.deliver(event, { tamper: true })).statusCode).toBe(401);
    expect((await fake.deliver(event, { key: { keyId: FAKE_KEYS.inbound.keyId, secret: 'x'.repeat(40) } })).statusCode).toBe(401);
    expect((await fake.deliver(event, { key: FAKE_KEYS.outbound })).statusCode).toBe(401);
    expect((await fake.deliver(event, { now: new Date(Date.now() - 20 * 60 * 1000) })).statusCode).toBe(401);
    const unknown = fake.record('evento.futuro', { qualquer: 1 }, {});
    const okNonce = 'nonce-fixo-para-replay-123456';
    expect((await fake.deliver(unknown, { nonce: okNonce })).statusCode).toBe(204);
    expect((await fake.deliver(unknown, { nonce: okNonce })).statusCode).toBe(401);
    const noHeaders = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/whaply/events',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(event),
    });
    expect(noHeaders.statusCode).toBe(401);
  });

  it('WA43 — evento de tipo desconhecido é aceito e ignorado (compatibilidade)', async () => {
    const res = await fake.emit('session.algo_novo', { x: 1 }, {});
    expect(res.statusCode).toBe(204);
    expect(res.headers['x-yu-outcome']).toBe('ignored');
  });

  it('WA48 — callback perdido é recuperado pela reconciliação (replay por sequência)', async () => {
    const v = await rentedVehicle();
    const { rec } = await dispatchAndSend(v);
    rec.wamid = 'wamid.perdido.001';
    // Eventos gerados no Whaply mas NUNCA entregues.
    fake.record('message.accepted', { idempotencyKey: rec.idempotencyKey, wamid: rec.wamid }, { inspectionId: rec.body.externalRef.id, requestId: rec.requestId });
    fake.record('message.delivered', { idempotencyKey: rec.idempotencyKey, wamid: rec.wamid, pricing: { billable: true, category: 'utility' } }, { inspectionId: rec.body.externalRef.id, requestId: rec.requestId });
    const result = await reconcileMessages(harness.ctx, new Date());
    expect(result.replayed).toBeGreaterThanOrEqual(2);
    const msg = await messages().findOne({ whaplyRequestId: rec.requestId });
    expect(msg?.status).toBe('DELIVERED');
    const cursor = await harness.ctx.mongo.collections.integrationCursors.findOne({ _id: 'whaply' });
    expect(cursor?.lastSeq).toBe(fake.events.at(-1)?.seq);
  });

  it('WA48b — mensagem aceita sem eventos é consultada no Whaply (polling de reconciliação)', async () => {
    const v = await rentedVehicle();
    const { rec } = await dispatchAndSend(v);
    rec.state = 'DELIVERED';
    rec.wamid = 'wamid.poll.001';
    await messages().updateOne({ whaplyRequestId: rec.requestId }, { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } });
    await reconcileMessages(harness.ctx, new Date());
    const msg = await messages().findOne({ whaplyRequestId: rec.requestId });
    expect(msg?.status).toBe('DELIVERED');
    expect(msg?.wamid).toBe('wamid.poll.001');
  });

  /* ------------------------------ fotos ----------------------------- */
  it('WA25/WA27 — fotos parciais: encerramento sem todas mantém PENDING e alerta', async () => {
    const v = await rentedVehicle();
    const { inspectionId, rec } = await dispatchAndSend(v);
    await sendAllPhotos(inspectionId, rec, { codes: ['FRONT', 'REAR'] });
    await fake.emit('session.completed', { round: 0 }, { inspectionId, requestId: rec.requestId });
    const doc = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    expect(doc?.status).toBe('PENDING');
    expect(doc?.collection?.status).toBe('PARTIAL');
    expect(doc?.collection?.receivedSlots).toEqual(['FRONT', 'REAR']);
    expect(await harness.ctx.mongo.collections.notifications.countDocuments({ dedupeKey: `wa-incomplete:${inspectionId}:r0` })).toBe(1);
  });

  it('WA27b — foto duplicada (mesmo wamid) não gera evidência repetida', async () => {
    const v = await rentedVehicle();
    const { inspectionId, rec } = await dispatchAndSend(v);
    const media = fake.addMedia(tinyPng(7));
    const data = { slotCode: 'FRONT', mediaRef: media.mediaRef, sha256: media.sha256, mimeType: 'image/png', size: 80, wamid: 'wamid.dup.1', round: 0 };
    await fake.emit('session.media_received', data, { inspectionId });
    await fake.emit('session.media_received', data, { inspectionId }); // reenvio do Whaply com outro eventId
    const doc = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    expect(doc?.photoEvidence?.filter((e) => e.wamid === 'wamid.dup.1')).toHaveLength(1);
    void rec;
  });

  it('WA28 — mídia inválida ou corrompida não é associada e gera alerta', async () => {
    const v = await rentedVehicle();
    const { inspectionId } = await dispatchAndSend(v);
    const text = fake.addMedia(Buffer.from('isto não é uma imagem'), 'image/png');
    await fake.emit('session.media_received', { slotCode: 'FRONT', mediaRef: text.mediaRef, sha256: text.sha256, mimeType: 'image/png', size: 20, wamid: 'wamid.bad.1' }, { inspectionId });
    const corrupt = fake.addMedia(tinyPng(3));
    await fake.emit('session.media_received', { slotCode: 'REAR', mediaRef: corrupt.mediaRef, sha256: 'a'.repeat(64), mimeType: 'image/png', size: 80, wamid: 'wamid.bad.2' }, { inspectionId });
    const doc = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    expect(doc?.photoEvidence ?? []).toHaveLength(0);
    expect(doc?.collection?.receivedSlots ?? []).toHaveLength(0);
    expect(await harness.ctx.mongo.collections.notifications.countDocuments({ title: 'Problema com foto da vistoria', entityId: doc!._id })).toBe(2);
  });

  it('WA47 — mídia temporariamente indisponível: evento fica no inbox e é reprocessado', async () => {
    const v = await rentedVehicle();
    const { inspectionId } = await dispatchAndSend(v);
    const media = fake.addMedia(tinyPng(11), 'image/png', false);
    const res = await fake.emit('session.media_received', { slotCode: 'FRONT', mediaRef: media.mediaRef, sha256: media.sha256, mimeType: 'image/png', size: 80, wamid: 'wamid.later.1' }, { inspectionId });
    expect(res.statusCode).toBe(500); // Whaply reenviará
    fake.media.get(media.mediaRef)!.available = true;
    await reconcileMessages(harness.ctx, new Date(Date.now() + 5 * 60 * 1000));
    const doc = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    expect(doc?.collection?.receivedSlots).toContain('FRONT');
  });

  it('WA29 — foto de ângulo não exigido vira evidência adicional, sem ocupar ângulo', async () => {
    const v = await rentedVehicle();
    const { inspectionId } = await dispatchAndSend(v);
    const media = fake.addMedia(tinyPng(21));
    await fake.emit('session.media_received', { slotCode: 'TETO', mediaRef: media.mediaRef, sha256: media.sha256, mimeType: 'image/png', size: 80, wamid: 'wamid.extra.1' }, { inspectionId });
    const doc = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    expect(doc?.photoEvidence?.[0]?.slotCode).toBeNull();
    expect(doc?.photos).toHaveLength(0);
  });

  it('WA30 — foto que chega após a aprovação é registrada como evidência tardia', async () => {
    const v = await rentedVehicle();
    const { inspectionId, rec } = await dispatchAndSend(v);
    const ref = { inspectionId, requestId: rec.requestId };
    await sendAllPhotos(inspectionId, rec);
    await fake.emit('session.text_received', { slotCode: 'ODOMETER', value: '1200' }, ref);
    await fake.emit('session.completed', {}, ref);
    expect((await req(cookie).post(`/api/v1/inspections/${inspectionId}/review`, { decision: 'APPROVE' })).statusCode).toBe(200);
    const before = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    const media = fake.addMedia(tinyPng(31));
    await fake.emit('session.media_received', { slotCode: 'FRONT', mediaRef: media.mediaRef, sha256: media.sha256, mimeType: 'image/png', size: 80, wamid: 'wamid.late.1' }, ref);
    const after = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    expect(after?.status).toBe('APPROVED');
    expect(after?.photos).toEqual(before?.photos);
    expect(after?.photoEvidence?.find((e) => e.wamid === 'wamid.late.1')?.late).toBe(true);
  });

  it('WA44 — foto sem vínculo vai para resolução manual e só entra na vistoria por atribuição auditada', async () => {
    const media = fake.addMedia(tinyPng(41));
    const res = await fake.emit('media.unmatched', { slotCode: null, mediaRef: media.mediaRef, sha256: media.sha256, mimeType: 'image/png', size: 80, wamid: 'wamid.unmatched.1', reason: 'sem coleta ativa' }, {});
    expect(res.statusCode).toBe(204);
    const list = await req(cookie).get('/api/v1/messaging/unmatched-media');
    const item = (list.json().data as Array<{ id: string }>)[0]!;
    expect(item).toBeTruthy();

    const v = await rentedVehicle();
    const { inspectionId } = await dispatchAndSend(v);
    const forbidden = await req(memberCookie).post(`/api/v1/messaging/unmatched-media/${item.id}/assign`, { inspectionId, slotCode: 'FRONT' });
    expect(forbidden.statusCode).toBe(403);
    const assign = await req(cookie).post(`/api/v1/messaging/unmatched-media/${item.id}/assign`, { inspectionId, slotCode: 'FRONT' });
    expect(assign.statusCode).toBe(200);
    const doc = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    expect(doc?.photoEvidence?.at(-1)?.source).toBe('OPERATOR');
    expect(await harness.ctx.mongo.collections.auditLogs.countDocuments({ action: 'inspection.photo_assigned', entityId: doc!._id })).toBe(1);
  });

  /* --------------------- correção e versionamento ------------------- */
  it('WA45 — correção: volta a PENDING, pede só os ângulos escolhidos e versiona evidências', async () => {
    const v = await rentedVehicle();
    const { inspectionId, rec } = await dispatchAndSend(v);
    const ref = { inspectionId, requestId: rec.requestId };
    await sendAllPhotos(inspectionId, rec);
    await fake.emit('session.text_received', { slotCode: 'ODOMETER', value: '3000' }, ref);
    await fake.emit('session.completed', {}, ref);
    const firstFront = (await inspections().findOne({ _id: new ObjectId(inspectionId) }))!.photos.find((p) => p.slotCode === 'FRONT')!;

    const invalidState = await req(cookie).post(`/api/v1/inspections/${new ObjectId().toHexString()}/request-correction`, { slots: ['FRONT'], reason: 'Foto escura' });
    expect(invalidState.statusCode).toBe(404);
    const corr = await req(cookie).post(`/api/v1/inspections/${inspectionId}/request-correction`, { slots: ['FRONT'], reason: 'Foto escura' });
    expect(corr.statusCode).toBe(200);
    expect(corr.json().guided).toBe(true);
    let doc = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    expect(doc?.status).toBe('PENDING');
    expect(doc?.correctionRound).toBe(1);
    expect(doc?.collection?.requiredSlots.map((s) => s.code)).toEqual(['FRONT']);
    expect(doc?.photos.some((p) => p.slotCode === 'FRONT')).toBe(false);
    expect(doc?.photos).toHaveLength(4);

    await sendPendingMessages(harness.ctx, later());
    const corrRec = [...fake.requests.values()].find((r) => r.body.kind === 'CORRECTION' && r.body.externalRef.id === inspectionId)!;
    expect(corrRec.body.template.name).toBe('yudirect_vistoria_correcao');
    expect(corrRec.body.template.bodyParams).toContain('Foto escura');
    expect(corrRec.body.session?.steps.map((s) => s.code)).toEqual(['FRONT']);
    expect(corrRec.body.session?.round).toBe(1);

    // Foto da rodada antiga chegando atrasada não conta para a nova.
    const stale = fake.addMedia(tinyPng(51));
    await fake.emit('session.media_received', { slotCode: 'FRONT', mediaRef: stale.mediaRef, sha256: stale.sha256, mimeType: 'image/png', size: 80, wamid: 'wamid.stale.r0', round: 0 }, { inspectionId });
    doc = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    expect(doc?.collection?.receivedSlots).toEqual([]);

    await sendAllPhotos(inspectionId, corrRec, { codes: ['FRONT'], round: 1, variant: 9 });
    await fake.emit('session.completed', { round: 1 }, { inspectionId });
    doc = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    expect(doc?.status).toBe('SUBMITTED');
    const newFront = doc!.photos.find((p) => p.slotCode === 'FRONT')!;
    expect(newFront.fileId.equals(firstFront.fileId)).toBe(false);
    const fronts = doc!.photoEvidence!.filter((e) => e.slotCode === 'FRONT' && !e.late);
    expect(fronts.filter((e) => e.supersededAt)).toHaveLength(1);
    expect(await harness.ctx.mongo.collections.auditLogs.countDocuments({ action: 'inspection.correction_requested', entityId: doc!._id })).toBe(1);
  });

  it('WA46 — aprovação/correção em estado inválido é recusada', async () => {
    const v = await rentedVehicle();
    const { inspectionId } = await dispatchAndSend(v);
    expect((await req(cookie).post(`/api/v1/inspections/${inspectionId}/review`, { decision: 'APPROVE' })).statusCode).toBe(409);
    expect((await req(cookie).post(`/api/v1/inspections/${inspectionId}/request-correction`, { slots: ['FRONT'], reason: 'teste' })).statusCode).toBe(409);
    expect((await req(memberCookie).post(`/api/v1/inspections/${inspectionId}/review`, { decision: 'APPROVE' })).statusCode).toBe(403);
  });

  /* ---------------------- opt-out, lembrete, expiração -------------- */
  it('WA40 — opt-out pelo WhatsApp revoga consentimento e cancela envios pendentes', async () => {
    const v = await rentedVehicle();
    const { inspectionId, rec } = await dispatchAndSend(v);
    await fake.emit('session.opted_out', { keyword: 'SAIR' }, { inspectionId, requestId: rec.requestId });
    const driver = await harness.ctx.mongo.collections.drivers.findOne({ _id: new ObjectId(v.driverId) });
    expect(driver?.whatsappConsent).toMatchObject({ status: 'REVOKED', revokedSource: 'WHATSAPP_STOP' });
    const doc = await inspections().findOne({ _id: new ObjectId(inspectionId) });
    expect(doc?.collection?.status).toBe('FAILED');
  });

  it('WA32 — lembrete único após o prazo configurado e expiração cancela a sessão', async () => {
    const v = await rentedVehicle();
    const { inspectionId, rec } = await dispatchAndSend(v);
    const requestedAt = (await inspections().findOne({ _id: new ObjectId(inspectionId) }))!.collection!.requestedAt!;
    // Antes de 24h: nenhum lembrete para esta vistoria.
    await runCollectionLifecycle(harness.ctx, new Date(requestedAt.getTime() + 23 * 3600_000));
    expect(await messages().countDocuments({ inspectionId: new ObjectId(inspectionId), kind: 'REMINDER' })).toBe(0);
    // Depois de 24h, dois workers: um único lembrete.
    const at = new Date(requestedAt.getTime() + 25 * 3600_000);
    await Promise.all([runCollectionLifecycle(harness.ctx, at), runCollectionLifecycle(harness.ctx, at)]);
    expect(await messages().countDocuments({ inspectionId: new ObjectId(inspectionId), kind: 'REMINDER' })).toBe(1);
    await runCollectionLifecycle(harness.ctx, new Date(requestedAt.getTime() + 50 * 3600_000));
    expect(await messages().countDocuments({ inspectionId: new ObjectId(inspectionId), kind: 'REMINDER' })).toBe(1);
    await sendPendingMessages(harness.ctx, at);
    const reminder = [...fake.requests.values()].find((r) => r.body.kind === 'REMINDER')!;
    expect(reminder.body.template.name).toBe('yudirect_vistoria_lembrete');
    expect(reminder.body.session).toBeNull();

    // Sessão registrada pela resposta do Whaply → CANCEL na expiração.
    await inspections().updateOne({ _id: new ObjectId(inspectionId) }, { $set: { 'collection.sessionId': rec.sessionId } });
    const exp = await runCollectionLifecycle(harness.ctx, new Date(requestedAt.getTime() + 73 * 3600_000));
    expect(exp.expired).toBeGreaterThanOrEqual(1);
    expect((await inspections().findOne({ _id: new ObjectId(inspectionId) }))?.collection?.status).toBe('EXPIRED');
    expect(fake.commands.some((c) => c.sessionId === rec.sessionId && (c.body as { type: string }).type === 'CANCEL')).toBe(true);
  });

  it('WA34b — duas vistorias para o mesmo telefone: a segunda aguarda (SESSION_BUSY) sem estourar o limite', async () => {
    const v = await rentedVehicle();
    const { inspectionId } = await dispatchAndSend(v);
    void inspectionId;
    // Segunda vistoria do mesmo motorista/telefone em outro veículo não é
    // possível pela locação ativa; simulamos a resposta do Whaply.
    const { inspection } = await requestInspection(v, '2026-11-25');
    await dispatchDueInspections(harness.ctx, later());
    fake.enqueue({ kind: 'status', status: 409, body: { error: { code: 'SESSION_BUSY', message: 'contato ocupado', retryable: false } } });
    await sendPendingMessages(harness.ctx, later());
    const msg = await messages().findOne({ inspectionId: new ObjectId(inspection.id) });
    expect(msg?.status).toBe('RETRY_SCHEDULED');
    expect(msg?.attempts).toBe(0);
    expect(msg!.nextAttemptAt!.getTime()).toBeGreaterThan(later().getTime() + 10 * 60_000);
  });

  /* ---------------- reenvio manual e reprocessamento ---------------- */
  it('WA49 — reenvio manual usa nova chave, é auditado e bloqueia duplicidade em andamento', async () => {
    const v = await rentedVehicle();
    const { inspection } = await requestInspection(v);
    await dispatchDueInspections(harness.ctx, later());
    fake.enqueue({ kind: 'status', status: 422, body: { error: { code: 'RECIPIENT_INVALID', message: 'número sem WhatsApp', retryable: false } } });
    await sendPendingMessages(harness.ctx, later());
    const failed = await messages().findOne({ inspectionId: new ObjectId(inspection.id) });
    expect(failed?.status).toBe('FAILED');

    const noConfirm = await req(cookie).post(`/api/v1/messaging/messages/${failed!._id.toHexString()}/resend`, {});
    expect(noConfirm.statusCode).toBe(422);
    const resend = await req(cookie).post(`/api/v1/messaging/messages/${failed!._id.toHexString()}/resend`, { confirm: true });
    expect(resend.statusCode).toBe(201);
    const twice = await req(cookie).post(`/api/v1/messaging/messages/${failed!._id.toHexString()}/resend`, { confirm: true });
    expect(twice.statusCode).toBe(409);
    const created = await messages().findOne({ _id: new ObjectId(resend.json().id) });
    expect(created?.idempotencyKey).toMatch(/^manual:/);
    expect(created?.manualOf?.equals(failed!._id)).toBe(true);
    await sendPendingMessages(harness.ctx, later());
    expect((await messages().findOne({ _id: created!._id }))?.status).toBe('ACCEPTED_BY_WHAPLY');
    expect(await harness.ctx.mongo.collections.auditLogs.countDocuments({ action: 'whatsapp.message_resent' })).toBeGreaterThanOrEqual(1);
  });

  it('WA49b — falha de transporte esgotada pode ser reprocessada com a mesma chave', async () => {
    const v = await rentedVehicle();
    const { inspection } = await requestInspection(v);
    await dispatchDueInspections(harness.ctx, later());
    const msg = await messages().findOne({ inspectionId: new ObjectId(inspection.id) });
    await messages().updateOne(
      { _id: msg!._id },
      { $set: { status: 'FAILED', lastError: { code: 'TIMEOUT', message: 'timeout', source: 'TRANSPORT', at: new Date() } } },
    );
    const retry = await req(cookie).post(`/api/v1/messaging/messages/${msg!._id.toHexString()}/retry`);
    expect(retry.statusCode).toBe(200);
    await sendPendingMessages(harness.ctx, later());
    const after = await messages().findOne({ _id: msg!._id });
    expect(after?.status).toBe('ACCEPTED_BY_WHAPLY');
    expect(fake.latest()?.idempotencyKey).toBe(msg!.idempotencyKey);
  });

  /* ------------------------------ painel ---------------------------- */
  it('WA23/WA24 — painel: resumo, filtros, detalhe com linha do tempo e máscara de telefone', async () => {
    const summary = await req(cookie).get('/api/v1/messaging/summary');
    expect(summary.statusCode).toBe(200);
    const body = summary.json();
    expect(body.messages.total).toBeGreaterThan(0);
    expect(body.messages.read).toBeGreaterThanOrEqual(1);
    expect(body.messages.failed).toBeGreaterThanOrEqual(1);
    expect(body.collections.complete).toBeGreaterThanOrEqual(1);

    const failedOnly = await req(cookie).get('/api/v1/messaging/messages?needsAction=true');
    const rows = failedOnly.json().data as Array<{ id: string; needsAction: boolean; phone: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.needsAction)).toBe(true);

    const all = await req(cookie).get('/api/v1/messaging/messages?status=READ');
    const readRow = (all.json().data as Array<{ id: string; phone: string; status: string }>)[0]!;
    expect(readRow.status).toBe('READ');
    expect(readRow.phone).toMatch(/^\(11\) 9\d{4}-\d{4}$/);
    const detail = await req(cookie).get(`/api/v1/messaging/messages/${readRow.id}`);
    expect(detail.statusCode).toBe(200);
    expect((detail.json().events as Array<{ type: string }>).map((e) => e.type)).toEqual(
      expect.arrayContaining(['intent.created', 'submit.attempt', 'message.accepted', 'message.read']),
    );
    expect(detail.json().idempotencyKey).toMatch(/^inspection:/);

    // Membro sem acesso a notificações não vê o painel.
    expect((await req(memberCookie).get('/api/v1/messaging/summary')).statusCode).toBe(403);
  });

  it('WA26 — custos: estimativa por categoria com tarifa de referência (nunca como cobrança)', async () => {
    const rate = await req(cookie).post('/api/v1/messaging/rates', {
      category: 'UTILITY',
      currency: 'BRL',
      amount: 0.0368,
      effectiveFrom: '2026-01-01',
      source: 'Teste — tabela de referência cadastrada manualmente',
    });
    expect(rate.statusCode).toBe(201);
    const costs = await req(cookie).get('/api/v1/messaging/costs?months=3');
    expect(costs.statusCode).toBe(200);
    expect(costs.json().confirmedBillingAvailable).toBe(false);
    expect(costs.json().disclaimer).toContain('Estimativa');
    const utility = (costs.json().data as Array<{ category: string; billable: boolean | null; delivered: number; estimated: number | null; rate: { currency: string } | null }>).find(
      (r) => r.category === 'UTILITY' && r.billable === true,
    )!;
    expect(utility.delivered).toBeGreaterThan(0);
    expect(utility.rate?.currency).toBe('BRL');
    expect(utility.estimated).toBeCloseTo(utility.delivered * 0.0368, 6);
  });

  it('WA50 — instruções da coleta (mensagens de serviço) entram no histórico pelo wamid', async () => {
    const v = await rentedVehicle();
    const { inspectionId, rec } = await dispatchAndSend(v);
    const ref = { inspectionId, requestId: null, sessionId: rec.sessionId };
    await fake.emit('message.sent', { wamid: 'wamid.prompt.1', kind: 'SESSION_PROMPT' }, ref);
    await fake.emit('message.delivered', { wamid: 'wamid.prompt.1', kind: 'SESSION_PROMPT', pricing: { billable: true, category: 'service' } }, ref);
    const prompt = await messages().findOne({ wamid: 'wamid.prompt.1' });
    expect(prompt?.kind).toBe('SESSION_PROMPT');
    expect(prompt?.status).toBe('DELIVERED');
    expect(prompt?.pricing?.category).toBe('SERVICE');
  });

  /* ------------------ link web e regressões de segurança ------------ */
  it('WA21 — envio pelo link web valida que os arquivos são desta organização (IDOR)', async () => {
    const v = await rentedVehicle({ consent: false });
    const { link } = await requestInspection(v);
    const token = link.split('/').pop()!;
    const foreignFile = await harness.ctx.mongo.collections.files.insertOne({
      _id: new ObjectId(),
      organizationId: new ObjectId(),
      originalName: 'x.png',
      contentType: 'image/png',
      size: 10,
      storageKey: 'x',
      checksum: 'x',
      purpose: 'INSPECTION_PHOTO',
      uploadedBy: null,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/inspection-public/${token}/submit`,
      payload: {
        odometerKm: 10,
        photos: SLOT_CODES.map((slotCode) => ({ slotCode, fileId: foreignFile.insertedId.toHexString() })),
      },
    });
    expect(res.statusCode).toBe(404);
    const doc = await inspections().findOne({ requestTokenHash: { $ne: null }, vehicleId: new ObjectId(v.vehicleId) });
    expect(doc?.status).toBe('PENDING');
  });

  it('WA42b — integração desligada recusa eventos (503) e não planeja WhatsApp', async () => {
    const off = await createHarness({ ...fake.env(), WHAPLY_INTEGRATION_ENABLED: 'false' });
    try {
      const event = fake.record('message.sent', {}, {});
      const body = JSON.stringify(event);
      const url = '/api/v1/integrations/whaply/events';
      const res = await off.app.inject({
        method: 'POST',
        url,
        headers: { ...signRequest(FAKE_KEYS.inbound, { method: 'POST', path: url, body }), 'content-type': 'application/json' },
        payload: body,
      });
      expect(res.statusCode).toBe(503);
      expect(off.ctx.integrations.whaply.status().connected).toBe(false);
    } finally {
      await off.close();
    }
  });

  it('lease: apenas uma instância obtém a trava por vez', async () => {
    const results = await Promise.all([
      tryAcquireLease(harness.ctx, 'teste:lease', 60_000, 'a'),
      tryAcquireLease(harness.ctx, 'teste:lease', 60_000, 'b'),
      tryAcquireLease(harness.ctx, 'teste:lease', 60_000, 'c'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    void vehicleId;
    void driverId;
  });
});
