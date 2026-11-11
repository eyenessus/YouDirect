import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { addDaysIso, businessDate, zonedDateTimeToUtc, type VehicleDueItem } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { generateBillingEscalations, generateBillingReminders } from '../services/billing-reminders.js';
import { generateVehicleDueNotifications } from '../services/notifications.js';
import { dueBucket } from '../services/vehicle-due.js';

/** Vencimentos da frota (IPVA, licenciamento, seguro) e acabamento da régua de cobrança. */
describe('vencimentos da frota e régua de cobrança', () => {
  let harness: TestHarness;
  let staff: string;
  let orgId: ObjectId;
  const today = businessDate();

  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const call = (method: Method, url: string, payload?: unknown, cookie?: string) =>
    harness.app.inject({
      method,
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness.ctx);
    const login = await call('POST', '/api/v1/auth/login', { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD });
    staff = sessionCookie(login.headers as Record<string, unknown>);
    orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  /* ------------------------- vencimentos ------------------------- */
  it('as faixas dos alertas: vencido, hoje, 7, 15 e 30 dias; longe não alerta', () => {
    expect(dueBucket(-3)).toBe('overdue');
    expect(dueBucket(0)).toBe('today');
    expect(dueBucket(5)).toBe('d7');
    expect(dueBucket(7)).toBe('d7');
    expect(dueBucket(8)).toBe('d15');
    expect(dueBucket(30)).toBe('d30');
    expect(dueBucket(31)).toBeNull();
  });

  let vehicleId: string;
  it('cadastra os vencimentos no veículo, lista ordenado e permite limpar uma data', async () => {
    const created = await call(
      'POST',
      '/api/v1/vehicles',
      {
        plate: 'VDU1A23',
        brand: 'Fiat',
        model: 'Cronos',
        mileageKm: 10,
        ipvaDueDate: addDaysIso(today, -2),
        licensingDueDate: addDaysIso(today, 10),
        insuranceDueDate: addDaysIso(today, 200),
        insurerName: 'Porto',
        policyNumber: 'AP-123',
      },
      staff,
    );
    expect(created.statusCode).toBe(201);
    vehicleId = created.json().id;
    expect(created.json()).toMatchObject({ ipvaDueDate: addDaysIso(today, -2), insurerName: 'Porto', policyNumber: 'AP-123' });

    const list = (await call('GET', '/api/v1/vehicles/due?withinDays=60', undefined, staff)).json().data as VehicleDueItem[];
    const mine = list.filter((i) => i.vehicleId === vehicleId);
    // O seguro vence em 200 dias: fora da janela de 60.
    expect(mine.map((i) => [i.kind, i.status])).toEqual([
      ['IPVA', 'OVERDUE'],
      ['LICENSING', 'SOON'],
    ]);
    expect(mine[0]!.daysLeft).toBe(-2);

    const wide = (await call('GET', '/api/v1/vehicles/due?withinDays=365&kind=INSURANCE', undefined, staff)).json().data as VehicleDueItem[];
    expect(wide.filter((i) => i.vehicleId === vehicleId).map((i) => i.kind)).toEqual(['INSURANCE']);

    const cleared = await call('PATCH', `/api/v1/vehicles/${vehicleId}`, { licensingDueDate: '', insurerName: '' }, staff);
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().licensingDueDate).toBeNull();
    expect(cleared.json().insurerName).toBeNull();
    expect(cleared.json().ipvaDueDate).toBe(addDaysIso(today, -2)); // o que não foi enviado fica
  });

  it('exige sessão para ver os vencimentos', async () => {
    expect((await call('GET', '/api/v1/vehicles/due')).statusCode).toBe(401);
  });

  it('gera um alerta por vencimento e não repete ao rodar de novo; vencido repete na semana seguinte', async () => {
    await harness.ctx.mongo.collections.notifications.deleteMany({ type: 'VEHICLE' });
    await call('PATCH', `/api/v1/vehicles/${vehicleId}`, { licensingDueDate: addDaysIso(today, 5) }, staff);
    const first = await generateVehicleDueNotifications(harness.ctx, orgId, today);
    expect(first).toBeGreaterThanOrEqual(2);
    const mine = await harness.ctx.mongo.collections.notifications.find({ type: 'VEHICLE', entityId: new ObjectId(vehicleId) }).toArray();
    expect(mine.map((n) => n.title).sort()).toEqual(['IPVA vencido', 'Licenciamento próximo do vencimento']);
    expect(mine.find((n) => n.title === 'IPVA vencido')!.severity).toBe('CRITICAL');
    expect(mine.find((n) => n.title === 'IPVA vencido')!.targetPath).toBe('/dashboard/vehicles/due');

    expect(await generateVehicleDueNotifications(harness.ctx, orgId, today)).toBe(0);
    // Uma semana depois o vencido avisa de novo (reaviso semanal).
    const later = await generateVehicleDueNotifications(harness.ctx, orgId, addDaysIso(today, 7));
    expect(later).toBeGreaterThanOrEqual(1);
  });

  it('veículo arquivado não gera alerta', async () => {
    await harness.ctx.mongo.collections.notifications.deleteMany({ type: 'VEHICLE' });
    await harness.ctx.mongo.collections.vehicles.updateOne({ _id: new ObjectId(vehicleId) }, { $set: { archivedAt: new Date() } });
    await generateVehicleDueNotifications(harness.ctx, orgId, today);
    expect(await harness.ctx.mongo.collections.notifications.countDocuments({ type: 'VEHICLE', entityId: new ObjectId(vehicleId) })).toBe(0);
  });

  /* --------------------------- cobrança --------------------------- */
  const lateRental = async (plate: string, phone: string) => {
    const vehicle = await call('POST', '/api/v1/vehicles', { plate, brand: 'VW', model: 'Gol', mileageKm: 1 }, staff);
    const driver = await call('POST', '/api/v1/drivers', { fullName: `Atrasado ${plate}`, phone }, staff);
    const rental = await call(
      'POST',
      '/api/v1/rentals',
      {
        vehicleId: vehicle.json().id,
        driverId: driver.json().id,
        rentalType: 'WEEKLY',
        periodicAmountCents: 60000,
        depositCents: 0,
        startDate: addDaysIso(today, -10),
        endDate: addDaysIso(today, 18),
      },
      staff,
    );
    expect(rental.statusCode).toBe(201);
    return driver.json().id as string;
  };

  it('avisa a equipe de fatura muito atrasada, uma vez por semana, mesmo sem WhatsApp', async () => {
    const driverId = await lateRental('BIL1A23', '11977770001');
    // A semana 1 venceu há 3 dias: abaixo do limite padrão (7), sem alerta.
    await harness.ctx.mongo.collections.notifications.deleteMany({ type: 'BILLING' });
    await generateBillingEscalations(harness.ctx, orgId, today);
    expect(await harness.ctx.mongo.collections.notifications.countDocuments({ type: 'BILLING', entityId: new ObjectId(driverId) })).toBe(0);

    // Com o limite em 2 dias passa a avisar.
    await call('PUT', '/api/v1/billing/settings', { remindersEnabled: true, reminderDaysBefore: 2, overdueReminderDays: [1, 3], escalationDays: 2 }, staff);
    expect(await generateBillingEscalations(harness.ctx, orgId, today)).toBeGreaterThanOrEqual(1);
    const n = await harness.ctx.mongo.collections.notifications.findOne({ type: 'BILLING', entityId: new ObjectId(driverId) });
    expect(n?.severity).toBe('CRITICAL');
    expect(n?.message).toContain('R$');
    // Mesma semana: não repete.
    expect(await generateBillingEscalations(harness.ctx, orgId, today)).toBe(0);

    const settings = (await call('GET', '/api/v1/billing/settings', undefined, staff)).json().settings;
    expect(settings.escalationDays).toBe(2);
  });

  it('configuração antiga, sem o limite de alerta, assume 7 dias', async () => {
    await harness.ctx.mongo.collections.organizations.updateOne(
      { _id: orgId },
      { $set: { 'settings.billing': { remindersEnabled: true, reminderDaysBefore: 2, overdueReminderDays: [1, 3] } } },
    );
    const settings = (await call('GET', '/api/v1/billing/settings', undefined, staff)).json().settings;
    expect(settings.escalationDays).toBe(7);
  });

  it('lembrete que falhou é reenviado depois de 30 minutos, até 3 tentativas, e aparece no histórico', async () => {
    await harness.ctx.mongo.collections.billingReminders.deleteMany({});
    await lateRental('BIL2A23', '11977770002');
    const keys: string[] = [];
    let ok = false;
    const original = harness.ctx.integrations.whatsapp;
    harness.ctx.integrations.whatsapp = {
      status: () => ({ name: 'fake', connected: true, message: 'ok' }),
      manualLink: original.manualLink,
      send: async (_to, _body, key) => {
        keys.push(key);
        return ok
          ? { delivered: true, providerMessageId: 'x', error: null, manualLink: null }
          : { delivered: false, providerMessageId: null, error: 'HTTP 503', manualLink: null };
      },
    };
    const t0 = zonedDateTimeToUtc(today, '10:00');
    const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
    try {
      expect((await generateBillingReminders(harness.ctx, orgId, t0)).failed).toBeGreaterThan(0);
      const afterFirst = keys.length;
      // Antes de 30 minutos não tenta de novo.
      expect((await generateBillingReminders(harness.ctx, orgId, at(10))).failed).toBe(0);
      expect(keys.length).toBe(afterFirst);
      // Depois de 30 minutos tenta de novo, com chave nova para o provedor não devolver a falha antiga.
      expect((await generateBillingReminders(harness.ctx, orgId, at(40))).failed).toBeGreaterThan(0);
      expect(new Set(keys).size).toBe(keys.length);
      ok = true;
      expect((await generateBillingReminders(harness.ctx, orgId, at(80))).sent).toBeGreaterThan(0);
      const rows = await harness.ctx.mongo.collections.billingReminders.find({}).toArray();
      expect(rows.every((r) => r.status === 'SENT' && r.error === null && r.attempts === 3)).toBe(true);
      // Entregue: não reenvia.
      expect((await generateBillingReminders(harness.ctx, orgId, at(120))).sent).toBe(0);

      const history = (await call('GET', '/api/v1/billing/reminders', undefined, staff)).json().data as Array<{ driverName: string; status: string; attempts: number }>;
      expect(history[0]).toMatchObject({ status: 'SENT', attempts: 3 });
      expect(history[0]!.driverName).toContain('Atrasado');
    } finally {
      harness.ctx.integrations.whatsapp = original;
    }
  });

  it('para de tentar depois da terceira falha', async () => {
    await harness.ctx.mongo.collections.billingReminders.deleteMany({});
    const original = harness.ctx.integrations.whatsapp;
    let calls = 0;
    harness.ctx.integrations.whatsapp = {
      status: () => ({ name: 'fake', connected: true, message: 'ok' }),
      manualLink: original.manualLink,
      send: async () => {
        calls += 1;
        return { delivered: false, providerMessageId: null, error: 'HTTP 500', manualLink: null };
      },
    };
    const t0 = zonedDateTimeToUtc(today, '10:00');
    try {
      for (let i = 0; i < 6; i += 1) await generateBillingReminders(harness.ctx, orgId, new Date(t0.getTime() + i * 40 * 60_000));
      const rows = await harness.ctx.mongo.collections.billingReminders.find({}).toArray();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status === 'FAILED' && (r.attempts ?? 1) === 3)).toBe(true);
      expect(calls).toBe(rows.length * 3);
    } finally {
      harness.ctx.integrations.whatsapp = original;
    }
  });
});
