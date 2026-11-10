import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { fullMatrix } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { FakeWhaply } from '../testing/fake-whaply.js';
import { hashPassword } from '../common/helpers.js';
import {
  alignToWeekday,
  generateScheduledInspections,
  nextOccurrence,
  occurrencesBetween,
} from '../services/inspection-schedule.js';
import { dispatchDueInspections, sendPendingMessages } from '../services/whatsapp-inspection.js';

/* ------------------------------------------------------------------ *
 * WA51–WA60 — vistorias recorrentes geradas pela regra da locação
 * (prompt master §7 item 9: "vistorias agendadas sem duplicidade").
 * ------------------------------------------------------------------ */

describe('regra de recorrência (unitário)', () => {
  it('alinha ao próximo dia da semana (nunca antes da data-base)', () => {
    expect(alignToWeekday('2026-11-10', 'MON')).toBe('2026-11-16'); // terça → segunda seguinte
    expect(alignToWeekday('2026-11-10', 'TUE')).toBe('2026-11-10');
    expect(alignToWeekday('2026-11-10', 'ANY')).toBe('2026-11-10');
    expect(alignToWeekday('2026-11-15', 'SUN')).toBe('2026-11-15');
  });

  it('semanal a cada 7 dias a partir do início, sem a data de retirada', () => {
    const rule = { period: 'WEEKLY' as const, weekday: 'ANY' as const };
    expect(occurrencesBetween(rule, '2026-11-01', '2026-11-01', '2026-11-30')).toEqual([
      '2026-11-08',
      '2026-11-15',
      '2026-11-22',
      '2026-11-29',
    ]);
  });

  it('semanal no dia da semana escolhido', () => {
    const rule = { period: 'WEEKLY' as const, weekday: 'MON' as const };
    // 01/11/2026 é domingo: primeira ocorrência na segunda 09/11.
    expect(occurrencesBetween(rule, '2026-11-01', '2026-11-01', '2026-11-30')).toEqual([
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
      '2026-11-30',
    ]);
  });

  it('mensal a cada 30 dias e respeita o fim da locação', () => {
    const rule = { period: 'MONTHLY' as const, weekday: 'ANY' as const };
    expect(occurrencesBetween(rule, '2026-11-01', '2026-11-01', '2027-02-28')).toEqual([
      '2026-12-01',
      '2026-12-31',
      '2027-01-30',
    ]);
    expect(occurrencesBetween(rule, '2026-11-01', '2026-11-01', '2027-02-28', '2027-01-15')).toEqual([
      '2026-12-01',
      '2026-12-31',
    ]);
  });

  it('locação longa: calcula perto da janela sem perder ocorrências', () => {
    const rule = { period: 'WEEKLY' as const, weekday: 'FRI' as const };
    const dates = occurrencesBetween(rule, '2020-01-01', '2026-11-01', '2026-11-30');
    expect(dates).toEqual(['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27']);
  });

  it('próxima ocorrência a partir de hoje', () => {
    expect(nextOccurrence({ period: 'WEEKLY', weekday: 'MON' }, '2026-11-01', '2026-11-10')).toBe('2026-11-16');
    expect(nextOccurrence({ period: null, weekday: 'ANY' }, '2026-11-01', '2026-11-10')).toBeNull();
    expect(nextOccurrence({ period: 'WEEKLY', weekday: 'ANY' }, '2026-11-01', '2026-11-10', '2026-11-12')).toBeNull();
  });
});

describe('geração automática de vistorias (integração)', () => {
  let harness: TestHarness;
  const fake = new FakeWhaply();
  let cookie: string;
  let organizationId: ObjectId;
  let n = 0;

  const req = (c: string) => ({
    get: (url: string) => harness.app.inject({ method: 'GET', url, headers: { cookie: c } }),
    post: (url: string, payload?: unknown) => harness.app.inject({ method: 'POST', url, headers: { cookie: c }, payload: payload as never }),
    put: (url: string, payload?: unknown) => harness.app.inject({ method: 'PUT', url, headers: { cookie: c }, payload: payload as never }),
    del: (url: string) => harness.app.inject({ method: 'DELETE', url, headers: { cookie: c } }),
  });
  const inspections = () => harness.ctx.mongo.collections.inspections;

  async function rental(opts: { period?: 'WEEKLY' | 'MONTHLY' | null; weekday?: string; consent?: boolean; endDate?: string } = {}) {
    n += 1;
    const plate = `GR${String.fromCharCode(65 + n)}${n % 10}${String.fromCharCode(66 + n)}${String(n).padStart(2, '0')}`;
    const vehicle = await req(cookie).post('/api/v1/vehicles', { plate, brand: 'Renault', model: 'Kwid' });
    expect(vehicle.statusCode, vehicle.body).toBe(201);
    const driver = await req(cookie).post('/api/v1/drivers', { fullName: `Motorista Recorrente ${n}`, phone: `1196666${String(1000 + n).slice(-4)}` });
    if (opts.consent !== false) {
      await req(cookie).put(`/api/v1/drivers/${driver.json().id}/whatsapp-consent`, { action: 'GRANT', source: 'CONTRACT' });
    }
    const r = await req(cookie).post('/api/v1/rentals', {
      vehicleId: vehicle.json().id,
      driverId: driver.json().id,
      startDate: '2026-11-01',
      endDate: opts.endDate,
      rentalType: 'WEEKLY',
      periodicAmountCents: 50000,
      depositCents: 0,
      ...(opts.period === null ? {} : { inspectionPeriod: opts.period ?? 'WEEKLY', inspectionWeekday: opts.weekday ?? 'MON' }),
    });
    expect(r.statusCode, r.body).toBe(201);
    return { rentalId: new ObjectId(r.json().id as string), vehicleId: vehicle.json().id as string, plate };
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
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: 'Dono',
      emailLower: 'dono@rec.test',
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
    const login = await harness.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'dono@rec.test', password: 'Dono@123456' } });
    cookie = sessionCookie(login.headers as Record<string, unknown>);
    await req(cookie).put('/api/v1/inspection/whatsapp-settings', {
      enabled: true,
      sendTime: '09:00',
      reminderAfterHours: 24,
      maxReminders: 1,
      collectionTtlHours: 72,
      instructions: {},
    });
  });

  afterAll(async () => {
    await harness?.close();
    await fake.stop();
  });

  beforeEach(() => fake.reset());

  it('WA51 — gera a ocorrência da janela uma única vez, mesmo com dois workers', async () => {
    const r = await rental();
    const [a, b] = await Promise.all([
      generateScheduledInspections(harness.ctx, organizationId, '2026-11-07'),
      generateScheduledInspections(harness.ctx, organizationId, '2026-11-07'),
    ]);
    expect(a.created + b.created).toBe(1);
    const docs = await inspections().find({ rentalId: r.rentalId }).toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ source: 'SCHEDULED', scheduledAt: '2026-11-09', dueDate: '2026-11-11', status: 'PENDING', createdBy: null });
    expect(docs[0]!.responsibleName).toMatch(/^Motorista Recorrente/);
    // Rodar de novo no mesmo dia (job a cada 30 min) não duplica.
    expect((await generateScheduledInspections(harness.ctx, organizationId, '2026-11-08')).created).toBe(0);
    expect(await inspections().countDocuments({ rentalId: r.rentalId })).toBe(1);
    const audit = await harness.ctx.mongo.collections.auditLogs.findOne({ action: 'inspection.scheduled_generated', entityId: docs[0]!._id });
    expect(audit?.after).toMatchObject({ scheduledAt: '2026-11-09', channel: 'WHATSAPP' });
  });

  it('WA52 — com consentimento: coleta pelo WhatsApp no horário configurado da data', async () => {
    const r = await rental();
    // Datas futuras: o horário de disparo nunca é antecipado para 'agora'.
    await generateScheduledInspections(harness.ctx, organizationId, '2026-12-05');
    const doc = await inspections().findOne({ rentalId: r.rentalId, scheduledAt: '2026-12-07' });
    expect(doc?.collection).toMatchObject({ mode: 'WHATSAPP', status: 'SCHEDULED' });
    expect(doc?.scheduledSendAt?.toISOString()).toBe('2026-12-07T12:00:00.000Z');
    expect(doc?.delivery).toMatchObject({ channel: 'WHATSAPP', status: 'PENDING' });

    // Antes do horário: nada; no horário: uma intenção e o envio ao Whaply.
    await dispatchDueInspections(harness.ctx, new Date('2026-12-07T11:59:00Z'));
    expect((await inspections().findOne({ _id: doc!._id }))?.collection?.status).toBe('SCHEDULED');
    await dispatchDueInspections(harness.ctx, new Date('2026-12-07T12:00:01Z'));
    await sendPendingMessages(harness.ctx, new Date('2026-12-07T12:00:02Z'));
    const sent = [...fake.requests.values()].find((x) => x.body.externalRef.id === doc!._id.toHexString());
    expect(sent?.body.kind).toBe('INSPECTION_REQUEST');
    expect(sent?.body.template.bodyParams[1]).toBe(r.plate);
  });

  it('WA53 — sem consentimento: gera com link manual e avisa a equipe (nada é enviado)', async () => {
    const r = await rental({ consent: false });
    await generateScheduledInspections(harness.ctx, organizationId, '2026-11-07');
    const doc = await inspections().findOne({ rentalId: r.rentalId });
    expect(doc?.collection?.status).toBe('BLOCKED_NO_CONSENT');
    expect(doc?.delivery).toMatchObject({ channel: 'MANUAL', status: 'UNAVAILABLE' });
    expect(doc?.delivery?.manualLink).toContain('/vistoria/');
    const alert = await harness.ctx.mongo.collections.notifications.findOne({ dedupeKey: `inspection-generated-manual:${doc!._id.toHexString()}` });
    expect(alert?.title).toBe('Vistoria recorrente aguardando envio');
    await dispatchDueInspections(harness.ctx, new Date('2026-11-10T00:00:00Z'));
    await sendPendingMessages(harness.ctx, new Date('2026-11-10T00:00:00Z'));
    expect([...fake.requests.values()].some((x) => x.body.externalRef.id === doc!._id.toHexString())).toBe(false);
  });

  it('WA54 — vistoria gerada e cancelada não é recriada; a semana seguinte é gerada', async () => {
    const r = await rental();
    await generateScheduledInspections(harness.ctx, organizationId, '2026-11-07');
    const first = await inspections().findOne({ rentalId: r.rentalId });
    expect((await req(cookie).del(`/api/v1/inspections/${first!._id.toHexString()}`)).statusCode).toBe(200);
    expect((await generateScheduledInspections(harness.ctx, organizationId, '2026-11-08')).created).toBeGreaterThanOrEqual(0);
    expect(await inspections().countDocuments({ rentalId: r.rentalId, scheduledAt: '2026-11-09' })).toBe(1);

    await generateScheduledInspections(harness.ctx, organizationId, '2026-11-14');
    const next = await inspections().findOne({ rentalId: r.rentalId, scheduledAt: '2026-11-16' });
    expect(next?.status).toBe('PENDING');
  });

  it('WA55 — vistoria aberta perto da data (ex.: manual) evita empilhar outra', async () => {
    const r = await rental();
    // Manual para 22/11 cobre a ocorrência de 23/11.
    const manual = await req(cookie).post(`/api/v1/vehicles/${r.vehicleId}/inspections/request`, {
      responsibleName: 'Responsável',
      phone: '11955550000',
      scheduledAt: '2026-11-22',
    });
    expect(manual.statusCode).toBe(201);
    const res = await generateScheduledInspections(harness.ctx, organizationId, '2026-11-21');
    expect(await inspections().countDocuments({ rentalId: r.rentalId, source: 'SCHEDULED', scheduledAt: '2026-11-23' })).toBe(0);
    expect(res.skippedOpen).toBeGreaterThanOrEqual(1);
  });

  it('WA56 — não gera atrasados nem após o fim da locação; locação sem regra fica de fora', async () => {
    const noRule = await rental({ period: null });
    const ended = await rental({ endDate: '2026-11-12' });
    // Hoje 20/11: a ocorrência de 16/11 já passou (não é criada em atraso).
    await generateScheduledInspections(harness.ctx, organizationId, '2026-11-20');
    expect(await inspections().countDocuments({ rentalId: noRule.rentalId })).toBe(0);
    expect(await inspections().countDocuments({ rentalId: ended.rentalId })).toBe(0);
  });

  it('WA57 — o cartão do painel mostra a próxima data pela mesma regra', async () => {
    const r = await rental({ weekday: 'FRI' });
    const cards = await req(cookie).get('/api/v1/inspections/vehicles');
    const card = (cards.json().data as Array<{ vehicle: { id: string }; nextInspectionAt: string | null }>).find((c) => c.vehicle.id === r.vehicleId)!;
    const today = new Date().toISOString().slice(0, 10);
    expect(card.nextInspectionAt).toBe(nextOccurrence({ period: 'WEEKLY', weekday: 'FRI' }, '2026-11-01', today));
  });

  it('WA58 — histórico identifica a vistoria recorrente', async () => {
    const r = await rental();
    await generateScheduledInspections(harness.ctx, organizationId, '2026-11-07');
    const history = await req(cookie).get(`/api/v1/vehicles/${r.vehicleId}/inspections`);
    const item = (history.json().data as Array<{ source: string; scheduledAt: string }>)[0]!;
    expect(item).toMatchObject({ source: 'SCHEDULED', scheduledAt: '2026-11-09' });
  });
});
