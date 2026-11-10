import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { expensesInPeriod } from '../services/analytics.js';
import { generateRecurringPayables } from '../services/finance.js';
import { MIGRATIONS, runMigrations } from '../database/migrations.js';
import { businessDate } from '@yudirect/contracts';

/* ------------------------------------------------------------------ *
 * Fase 2 do plano de correções — integridade financeira e de dados.
 * ------------------------------------------------------------------ */

describe('integridade financeira (fase 2)', () => {
  let harness: TestHarness;
  let cookie: string;
  let organizationId: ObjectId;
  let accountId: string;
  let categoryId: string;
  const today = businessDate();

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    harness.app.inject({ method, url: `/api/v1${url}`, headers: { cookie, ...headers }, ...(payload ? { payload } : {}) });

  const createPayable = async (extra: Record<string, unknown>) => {
    const res = await call('POST', '/payables', {
      categoryId,
      amountCents: 12_345,
      dueDate: today,
      description: `Teste ${new ObjectId().toHexString()}`,
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; description: string };
  };

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness.ctx);
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD },
    });
    cookie = sessionCookie(login.headers as Record<string, unknown>);
    const accounts = (await call('GET', '/bank-accounts')).json();
    accountId = ((accounts.data ?? accounts) as Array<{ id: string; isDefault: boolean }>).find((a) => a.isDefault)!.id;
    categoryId = ((await call('GET', '/expense-categories')).json().data as Array<{ id: string }>)[0]!.id;
    organizationId = (await harness.ctx.mongo.collections.bankAccounts.findOne({ _id: new ObjectId(accountId) }))!
      .organizationId;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('D1: conta paga e depois excluída sai das despesas (DRE bate com o extrato)', async () => {
    const before = await expensesInPeriod(harness.ctx, organizationId, today, today);
    const payable = await createPayable({ alreadyPaid: true, paidBankAccountId: accountId });
    expect(await expensesInPeriod(harness.ctx, organizationId, today, today)).toBe(before + 12_345);

    const del = await call('DELETE', `/payables/${payable.id}`);
    expect(del.json()).toMatchObject({ reversed: true });
    expect(await expensesInPeriod(harness.ctx, organizationId, today, today)).toBe(before);

    const payment = await harness.ctx.mongo.collections.payments.findOne({ sourceId: new ObjectId(payable.id) });
    expect(payment?.reversedAt).toBeInstanceOf(Date);
    expect(payment?.reversalTransactionId).toBeInstanceOf(ObjectId);
  });

  it('D1: a migração marca estornos antigos (sem reversedAt) e é idempotente', async () => {
    const payable = await createPayable({ alreadyPaid: true, paidBankAccountId: accountId });
    await call('DELETE', `/payables/${payable.id}`);
    // Simula o dado legado: estorno no extrato, pagamento sem marca.
    await harness.ctx.mongo.collections.payments.updateOne(
      { sourceId: new ObjectId(payable.id) },
      { $set: { reversedAt: null, reversalTransactionId: null } },
    );
    const migration = { ...MIGRATIONS[0]!, id: `teste-${new ObjectId().toHexString()}` };
    expect(await runMigrations(harness.ctx, undefined, [migration])).toEqual([migration.id]);
    const payment = await harness.ctx.mongo.collections.payments.findOne({ sourceId: new ObjectId(payable.id) });
    expect(payment?.reversedAt).toBeInstanceOf(Date);
    // Segunda execução: já registrada, não roda de novo.
    expect(await runMigrations(harness.ctx, undefined, [migration])).toEqual([]);
  });

  it('D5: recorrência recupera meses perdidos e para quando desligada', async () => {
    const [y, m] = today.split('-').map(Number) as [number, number];
    const threeAgo = new Date(Date.UTC(y, m - 1 - 3, 5)).toISOString().slice(0, 10);
    const first = await createPayable({ dueDate: threeAgo, recurring: true });
    const seriesId = (await harness.ctx.mongo.collections.payables.findOne({ _id: new ObjectId(first.id) }))!.recurring
      .seriesId!;

    expect(await generateRecurringPayables(harness.ctx, organizationId, today)).toBeGreaterThanOrEqual(3);
    const count = () => harness.ctx.mongo.collections.payables.countDocuments({ 'recurring.seriesId': seriesId });
    expect(await count()).toBe(4);
    // Idempotente.
    await generateRecurringPayables(harness.ctx, organizationId, today);
    expect(await count()).toBe(4);

    const off = await call('PATCH', `/payables/${first.id}`, { recurring: false });
    expect(off.statusCode, off.body).toBe(200);
    const nextMonth = new Date(Date.UTC(y, m, 10)).toISOString().slice(0, 10);
    await generateRecurringPayables(harness.ctx, organizationId, nextMonth);
    expect(await count()).toBe(4);
  });

  it('D6: "já paga" com conta bancária inexistente não grava a conta', async () => {
    const description = `Sem banco ${new ObjectId().toHexString()}`;
    const res = await call('POST', '/payables', {
      categoryId,
      amountCents: 500,
      dueDate: today,
      description,
      alreadyPaid: true,
      paidBankAccountId: new ObjectId().toHexString(),
    });
    expect(res.statusCode).toBe(404);
    expect(await harness.ctx.mongo.collections.payables.countDocuments({ description })).toBe(0);
  });

  it('D8: duas parcelas iguais pagas no mesmo dia não se fundem', async () => {
    const payable = await createPayable({ amountCents: 20_000 });
    const pay = () =>
      call('POST', `/payables/${payable.id}/payments`, {
        amountCents: 10_000,
        paidAt: today,
        method: 'PIX',
        bankAccountId: accountId,
      });
    expect((await pay()).statusCode).toBe(201);
    expect((await pay()).statusCode).toBe(201);
    expect(
      await harness.ctx.mongo.collections.payments.countDocuments({ sourceId: new ObjectId(payable.id) }),
    ).toBe(2);
  });

  it('D8: a mesma Idempotency-Key devolve o mesmo pagamento', async () => {
    const payable = await createPayable({ amountCents: 20_000 });
    const pay = () =>
      call(
        'POST',
        `/payables/${payable.id}/payments`,
        { amountCents: 10_000, paidAt: today, method: 'PIX', bankAccountId: accountId },
        { 'idempotency-key': 'chave-fixa-1' },
      );
    const a = await pay();
    const b = await pay();
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().payment.id).toBe(a.json().payment.id);
  });

  it('D3: locação encerrada não é editada e o pré-pago não muda depois', async () => {
    const rental = await harness.ctx.mongo.collections.rentals.findOne({ organizationId, status: 'ACTIVE' });
    expect(rental).toBeTruthy();
    const id = rental!._id.toHexString();

    const prepaid = await call('PATCH', `/rentals/${id}`, { firstPeriodPrepaid: !rental!.firstPeriodPrepaid });
    expect(prepaid.statusCode).toBe(409);

    const close = await call('POST', `/rentals/${id}/close`, { endDate: today });
    expect(close.statusCode, close.body).toBe(200);
    const again = await call('POST', `/rentals/${id}/close`, { endDate: today });
    expect(again.statusCode).toBe(409);

    const edit = await call('PATCH', `/rentals/${id}`, { notes: 'depois de encerrada' });
    expect(edit.statusCode).toBe(409);
  });

  it('D9: lançamento manual pode ser estornado uma única vez', async () => {
    const created = await call('POST', `/bank-accounts/${accountId}/manual-transactions`, {
      direction: 'OUT',
      amountCents: 777,
      occurredAt: today,
      description: 'Tarifa lançada errado',
    });
    expect(created.statusCode).toBe(201);
    const txId = created.json().id as string;
    const reverse = await call('POST', `/bank-transactions/${txId}/reverse`);
    expect(reverse.statusCode, reverse.body).toBe(201);
    expect((await call('POST', `/bank-transactions/${txId}/reverse`)).statusCode).toBe(409);
    // O próprio estorno não pode ser estornado por aqui.
    expect((await call('POST', `/bank-transactions/${reverse.json().id}/reverse`)).statusCode).toBe(409);
  });

  it('D9: conta padrão não é excluída enquanto há outra ativa', async () => {
    const other = await call('POST', '/bank-accounts', {
      name: 'Conta reserva',
      type: 'CHECKING',
      initialBalanceCents: 0,
      initialBalanceDate: today,
    });
    expect(other.statusCode, other.body).toBe(201);
    expect((await call('DELETE', `/bank-accounts/${accountId}`)).statusCode).toBe(409);
  });

  it('D10: disparo pula quem revogou o consentimento e respeita a Idempotency-Key', async () => {
    const drivers = await harness.ctx.mongo.collections.drivers.find({ organizationId, archivedAt: null }).limit(2).toArray();
    expect(drivers).toHaveLength(2);
    await harness.ctx.mongo.collections.drivers.updateOne(
      { _id: drivers[1]!._id },
      { $set: { whatsappConsent: { status: 'REVOKED', grantedAt: null, source: null, revokedAt: new Date(), revokedSource: 'WHATSAPP' } as never } },
    );
    const payload = {
      body: 'Olá {{nome}}, teste.',
      driverIds: drivers.map((d) => d._id.toHexString()),
      consentConfirmed: true,
    };
    const a = await call('POST', '/message-dispatches', payload, { 'idempotency-key': 'disparo-1' });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().deliveries).toHaveLength(1);
    const b = await call('POST', '/message-dispatches', payload, { 'idempotency-key': 'disparo-1' });
    expect(b.json().id).toBe(a.json().id);
    expect(await harness.ctx.mongo.collections.messageDispatches.countDocuments({ requestKey: 'disparo-1' })).toBe(1);
  });
});
