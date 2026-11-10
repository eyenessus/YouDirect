import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import {
  addDaysIso,
  businessDate,
  zonedDateTimeToUtc,
  type DriverPortalAccessResult,
  type PixCharge,
  type PortalInvoices,
} from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { startFakeProviders, type FakeProviders } from '../testing/fake-providers.js';
import { seed } from '../database/seed.js';
import { hashPassword } from '../common/helpers.js';
import { reconcilePixCharges } from '../services/pix.js';
import { generateBillingReminders } from '../services/billing-reminders.js';
import { createPixProvider } from '../integrations/mercadopago.js';

/**
 * Cobrança Pix com baixa automática (Mercado Pago falso local) e régua de
 * lembretes pelo WhatsApp.
 */
const SECRET = 'whsec-teste-mercado-pago';

describe('cobrança Pix e régua de cobrança', () => {
  let harness: TestHarness;
  let fake: FakeProviders;
  let staff: string;
  let orgId: ObjectId;
  const today = businessDate();

  type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  const call = (method: Method, url: string, payload?: unknown, cookie?: string, headers: Record<string, string> = {}) =>
    harness.app.inject({
      method,
      url,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  let seq = 0;
  const newRental = async (phone?: string) => {
    seq += 1;
    const vehicle = await call('POST', '/api/v1/vehicles', { plate: `X${'ABCDEFGHIJ'[seq % 10]}P1C${10 + seq}`, brand: 'VW', model: `PIX${seq}`, mileageKm: 1 }, staff);
    const driver = await call('POST', '/api/v1/drivers', { fullName: `Pagador Pix ${seq}`, phone: phone ?? `1166655${1000 + seq}` }, staff);
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
    return { vehicleId: vehicle.json().id as string, driverId: driver.json().id as string, rentalId: rental.json().id as string };
  };
  const loginDriver = async (driverId: string) => {
    const access = (await call('POST', `/api/v1/drivers/${driverId}/portal-access`, undefined, staff)).json() as DriverPortalAccessResult;
    const res = await call('POST', '/api/v1/driver/login', { token: access.link.split('/motorista/entrar/')[1] });
    return sessionCookie(res.headers as Record<string, unknown>, 'yudirect_driver');
  };
  const webhook = (dataId: string, opts: { secret?: string; ts?: number } = {}) => {
    const ts = opts.ts ?? Date.now();
    const requestId = `req-${Math.random().toString(36).slice(2)}`;
    const v1 = createHmac('sha256', opts.secret ?? SECRET).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
    return call('POST', `/api/v1/webhooks/mercadopago?data.id=${dataId}&type=payment`, { type: 'payment', data: { id: dataId } }, undefined, {
      'x-signature': `ts=${ts},v1=${v1}`,
      'x-request-id': requestId,
    });
  };
  const paymentsOf = (receivableId: string) =>
    harness.ctx.mongo.collections.payments.find({ sourceId: new ObjectId(receivableId), reversedAt: null }).toArray();

  beforeAll(async () => {
    fake = await startFakeProviders();
    harness = await createHarness({
      MERCADOPAGO_ACCESS_TOKEN: 'TEST-token',
      MERCADOPAGO_WEBHOOK_SECRET: SECRET,
      MERCADOPAGO_API_URL: fake.url,
    });
    await seed(harness.ctx);
    const login = await call('POST', '/api/v1/auth/login', { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD });
    staff = sessionCookie(login.headers as Record<string, unknown>);
    orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
    await fake?.close();
  });

  /* ------------------------------ Pix ------------------------------ */
  let first: { rentalId: string; driverId: string; cookie: string; charge: PixCharge; receivableId: string };

  it('motorista gera Pix da fatura e a mesma fatura reaproveita a cobrança', async () => {
    const r = await newRental();
    const cookie = await loginDriver(r.driverId);
    const inv = (await call('GET', '/api/v1/driver/invoices', undefined, cookie)).json() as PortalInvoices;
    const week1 = inv.invoices.find((i) => i.description === 'Semana 1')!;
    expect(week1.status).toBe('OVERDUE');

    const res = await call('POST', '/api/v1/driver/invoices/pix', { key: week1.key }, cookie);
    expect(res.statusCode).toBe(201);
    const charge = res.json() as PixCharge;
    expect(charge).toMatchObject({ status: 'PENDING', amountCents: 60000 });
    expect(charge.qrCode).toContain('br.gov.bcb.pix');
    expect(charge.qrCodeBase64).toBeTruthy();

    const again = (await call('POST', '/api/v1/driver/invoices/pix', { key: week1.key }, cookie)).json() as PixCharge;
    expect(again.id).toBe(charge.id);
    expect(fake.payments.size).toBe(1);

    const sent = [...fake.payments.values()][0]!;
    expect(sent.amount).toBe(600);
    expect(sent.idempotencyKey).toBe(`pix:${charge.id}`);
    expect(sent.externalReference).toBe(charge.id);
    expect((sent.body.payer as { email: string }).email).toMatch(/@/);
    expect(sent.body.payment_method_id).toBe('pix');
    first = { ...r, cookie, charge, receivableId: charge.receivableId };
  });

  it('webhook com assinatura inválida é recusado; pendente não dá baixa', async () => {
    const providerId = [...fake.payments.values()][0]!.id;
    expect((await webhook(providerId, { secret: 'segredo-errado' })).statusCode).toBe(403);
    expect((await webhook(providerId, { ts: Date.now() - 60 * 60 * 1000 })).statusCode).toBe(403);
    const pending = await webhook(providerId);
    expect(pending.statusCode).toBe(200);
    expect(pending.json().result).toBe('PENDING');
    expect(await paymentsOf(first.receivableId)).toHaveLength(0);
  });

  it('pagamento aprovado: baixa automática, recibo na aba Pagamentos, extrato e aviso', async () => {
    const providerId = [...fake.payments.values()][0]!.id;
    fake.approve(providerId);
    const res = await webhook(providerId);
    expect(res.json().result).toBe('PAID');

    const payments = await paymentsOf(first.receivableId);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amountCents: 60000, method: 'PIX', origin: 'PIX' });
    expect(payments[0]!.transactionId).toBeTruthy();

    const entry = await harness.ctx.mongo.collections.rentalPayments.findOne({ paymentId: payments[0]!._id });
    expect(entry).toMatchObject({ status: 'PAID', method: 'PIX', category: 'RENT' });
    expect(entry?.receiptNumber).toMatch(/^INV-/);

    const note = await harness.ctx.mongo.collections.notifications.findOne({ dedupeKey: `pix-paid:${first.charge.id}` });
    expect(note?.title).toBe('Pix recebido');

    const status = (await call('GET', `/api/v1/driver/pix/${first.charge.id}`, undefined, first.cookie)).json() as PixCharge;
    expect(status.status).toBe('PAID');
    expect(status.qrCode).toBeNull();
    const inv = (await call('GET', '/api/v1/driver/invoices', undefined, first.cookie)).json() as PortalInvoices;
    expect(inv.invoices.find((i) => i.description === 'Semana 1')!.status).toBe('PAID');
  });

  it('webhook repetido não gera segunda baixa', async () => {
    const providerId = [...fake.payments.values()][0]!.id;
    const [a, b] = await Promise.all([webhook(providerId), webhook(providerId)]);
    expect([a.json().result, b.json().result].every((r) => r === 'ALREADY_PAID')).toBe(true);
    expect(await paymentsOf(first.receivableId)).toHaveLength(1);
  });

  it('conciliação dá baixa quando o webhook não chega', async () => {
    const inv = (await call('GET', '/api/v1/driver/invoices', undefined, first.cookie)).json() as PortalInvoices;
    const week2 = inv.invoices.find((i) => i.description === 'Semana 2')!;
    const charge = (await call('POST', '/api/v1/driver/invoices/pix', { key: week2.key }, first.cookie)).json() as PixCharge;
    const p = [...fake.payments.values()].find((x) => x.externalReference === charge.id)!;
    fake.approve(p.id);
    await harness.ctx.mongo.collections.pixCharges.updateOne({ _id: new ObjectId(charge.id) }, { $set: { createdAt: new Date(Date.now() - 5 * 60 * 1000) } });
    const res = await reconcilePixCharges(harness.ctx, orgId);
    expect(res.paid).toBeGreaterThanOrEqual(1);
    expect(await paymentsOf(first.receivableId)).toHaveLength(2);
  });

  it('Pix pago depois de baixa manual: aplica só o saldo e avisa o excedente; multa fica paga', async () => {
    const r = await newRental();
    const fine = (
      await call(
        'POST',
        '/api/v1/traffic-fines',
        { vehicleId: r.vehicleId, aitNumber: `PIX-${r.vehicleId.slice(-6)}`, authorityName: 'DETRAN-SP', infractionDescription: 'Estacionar em local proibido', occurredDate: addDaysIso(today, -3), occurredTime: '09:00', amountCents: 19523 },
        staff,
      )
    ).json();
    const charged = (await call('POST', `/api/v1/traffic-fines/${fine.id}/charge`, { version: fine.version }, staff)).json().fine;
    const recId = charged.receivable.id as string;
    const pix = await call('POST', `/api/v1/receivables/${recId}/pix`, {}, staff);
    expect(pix.statusCode).toBe(201);
    const charge = pix.json() as PixCharge;
    expect(charge.amountCents).toBe(19523);

    const acc = (await call('GET', '/api/v1/bank-accounts', undefined, staff)).json();
    const accountId = ((acc.data ?? acc) as Array<{ id: string; isDefault: boolean }>).find((a) => a.isDefault)!.id;
    await call('POST', `/api/v1/receivables/${recId}/payments`, { amountCents: 10000, paidAt: today, method: 'CASH', bankAccountId: accountId }, staff);

    const p = [...fake.payments.values()].find((x) => x.externalReference === charge.id)!;
    fake.approve(p.id);
    expect((await webhook(p.id)).json().result).toBe('PAID');
    const pays = await paymentsOf(recId);
    expect(pays.map((x) => x.amountCents).sort()).toEqual([10000, 9523]);
    const doc = await harness.ctx.mongo.collections.pixCharges.findOne({ _id: new ObjectId(charge.id) });
    expect(doc?.excessCents).toBe(10000);
    const note = await harness.ctx.mongo.collections.notifications.findOne({ dedupeKey: `pix-paid:${charge.id}` });
    expect(note?.severity).toBe('WARNING');
    expect((await call('GET', `/api/v1/traffic-fines/${fine.id}`, undefined, staff)).json().status).toBe('PAID');
    // Conta quitada não gera novo Pix.
    expect((await call('POST', `/api/v1/receivables/${recId}/pix`, {}, staff)).statusCode).toBe(409);
  });

  it('provedor recusando ou desligado responde 503 sem fingir sucesso', async () => {
    const r = await newRental();
    const cookie = await loginDriver(r.driverId);
    const inv = (await call('GET', '/api/v1/driver/invoices', undefined, cookie)).json() as PortalInvoices;
    const key = inv.invoices.find((i) => i.status !== 'PAID')!.key;
    fake.failNextCreate = 1;
    const refused = await call('POST', '/api/v1/driver/invoices/pix', { key }, cookie);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.message).toContain('Mercado Pago recusou');

    const original = harness.ctx.integrations.pix;
    harness.ctx.integrations.pix = createPixProvider({ ...harness.env, MERCADOPAGO_ACCESS_TOKEN: undefined });
    try {
      const off = await call('POST', '/api/v1/driver/invoices/pix', { key }, cookie);
      expect(off.statusCode).toBe(503);
      expect(off.json().error.message).toContain('não configurada');
    } finally {
      harness.ctx.integrations.pix = original;
    }
  });

  it('fatura de outro motorista ou chave inválida não gera Pix; permissão finance.pay é exigida', async () => {
    const other = (await call('GET', '/api/v1/driver/invoices', undefined, first.cookie)).json() as PortalInvoices;
    const r = await newRental();
    const cookie = await loginDriver(r.driverId);
    expect((await call('POST', '/api/v1/driver/invoices/pix', { key: other.invoices[0]!.key }, cookie)).statusCode).toBe(404);
    expect((await call('POST', '/api/v1/driver/invoices/pix', { key: 'x' }, cookie)).statusCode).toBe(422);

    const now = new Date();
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId, name: 'leitor', emailLower: 'leitor-pix@exemplo.test', passwordHash: await hashPassword('Senha@12345'),
      phone: null, status: 'ACTIVE', browserNotificationsEnabled: false, lastLoginAt: null, createdAt: now, updatedAt: now,
    });
    await harness.ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(), organizationId: orgId, userId, role: 'MEMBER', permissions: { finance: ['read'] } as never, status: 'ACTIVE', createdAt: now, updatedAt: now,
    });
    const reader = sessionCookie((await call('POST', '/api/v1/auth/login', { email: 'leitor-pix@exemplo.test', password: 'Senha@12345' })).headers as Record<string, unknown>);
    expect((await call('POST', `/api/v1/receivables/${first.receivableId}/pix`, {}, reader)).statusCode).toBe(403);
    expect((await call('GET', `/api/v1/receivables/${first.receivableId}/pix`, undefined, reader)).json().data.length).toBeGreaterThanOrEqual(2);
  });

  /* ------------------------------ régua ------------------------------ */
  it('lembretes: só em horário comercial, um por marco, respeitando consentimento', async () => {
    const r = await newRental('11955554444');
    const revoked = await newRental('11955553333');
    await harness.ctx.mongo.collections.drivers.updateOne(
      { _id: new ObjectId(revoked.driverId) },
      { $set: { whatsappConsent: { status: 'REVOKED', grantedAt: null, source: null, recordedBy: null, revokedAt: new Date(), revokedSource: 'OPERATOR' } } },
    );
    const sent: Array<{ to: string; body: string }> = [];
    const original = harness.ctx.integrations.whatsapp;
    harness.ctx.integrations.whatsapp = {
      status: () => ({ name: 'fake', connected: true, message: 'ok' }),
      manualLink: original.manualLink,
      send: async (to, body) => {
        sent.push({ to, body });
        return { delivered: true, providerMessageId: 'x', error: null, manualLink: null };
      },
    };
    try {
      // 22h: fora do horário, nada sai.
      await generateBillingReminders(harness.ctx, orgId, zonedDateTimeToUtc(today, '22:00'));
      expect(sent.filter((s) => s.to === '11955554444')).toHaveLength(0);

      const noon = zonedDateTimeToUtc(today, '12:00');
      await generateBillingReminders(harness.ctx, orgId, noon);
      const mine = sent.filter((s) => s.to === '11955554444');
      // Semana 1 venceu há 3 dias (D+3); a semana 2 vence em 4 dias (sem marco hoje).
      expect(mine).toHaveLength(1);
      expect(mine[0]!.body).toContain('Semana 1');
      expect(mine[0]!.body).toContain('/motorista/faturas');
      expect(sent.some((s) => s.to === '11955553333')).toBe(false);

      await generateBillingReminders(harness.ctx, orgId, noon);
      expect(sent.filter((s) => s.to === '11955554444')).toHaveLength(1);

      // Régua desligada pela empresa: nada é enviado.
      expect((await call('PUT', '/api/v1/billing/settings', { remindersEnabled: false, reminderDaysBefore: 2, overdueReminderDays: [1, 3] }, staff)).statusCode).toBe(200);
      const before = sent.length;
      await harness.ctx.mongo.collections.billingReminders.deleteMany({});
      await generateBillingReminders(harness.ctx, orgId, noon);
      expect(sent.length).toBe(before);
      await call('PUT', '/api/v1/billing/settings', { remindersEnabled: true, reminderDaysBefore: 2, overdueReminderDays: [1, 3] }, staff);
      void r;
    } finally {
      harness.ctx.integrations.whatsapp = original;
    }
  });

  it('sem provedor de WhatsApp a régua não envia nem registra nada', async () => {
    await harness.ctx.mongo.collections.billingReminders.deleteMany({});
    const res = await generateBillingReminders(harness.ctx, orgId, zonedDateTimeToUtc(today, '12:00'));
    expect(res).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(await harness.ctx.mongo.collections.billingReminders.countDocuments({})).toBe(0);
  });
});
