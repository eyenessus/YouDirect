import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { hashPassword } from '../common/helpers.js';

/**
 * Baixa de pagamentos do motorista: ao registrar o recebimento, a conta a
 * receber, o extrato bancário e AMBOS os dashboards precisam refletir o valor.
 * Roda sobre o seed (novembro/2026, mesma base de reference-figures.test.ts).
 */
describe('baixa de pagamentos — efeito em conta, extrato e dashboards', () => {
  let harness: TestHarness;
  let cookie: string;
  let restrictedCookie: string;
  let accountId: string;

  interface ReceivableDTO {
    id: string;
    status: string;
    grossAmountCents: number;
    paidAmountCents: number;
    remainingCents: number;
    driver: { id: string };
    rental: { id: string } | null;
  }

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, c = cookie, payload?: unknown, headers: Record<string, string> = {}) =>
    harness.app.inject({ method, url, headers: { cookie: c, ...headers }, ...(payload ? { payload } : {}) });

  const summaryRevenue = async () =>
    (await call('GET', '/api/v1/dashboard/summary')).json().totals.monthlyRevenueCents as number;
  const financeRevenue = async () =>
    (await call('GET', '/api/v1/finance/dashboard?month=11&year=2026')).json().revenueCents as number;
  const balance = async () => {
    const res = await call('GET', '/api/v1/bank-accounts');
    const list = (res.json().data ?? res.json()) as Array<{ id: string; currentBalanceCents: number }>;
    return list.find((a) => a.id === accountId)!.currentBalanceCents;
  };
  const openReceivables = async (query = '') =>
    (await call('GET', `/api/v1/receivables?openOnly=true&limit=100${query}`)).json().data as ReceivableDTO[];
  const getReceivable = async (id: string) => (await call('GET', `/api/v1/receivables/${id}`)).json() as ReceivableDTO;
  const pay = (id: string, amountCents: number, key: string, paidAt = '2026-11-10') =>
    call('POST', `/api/v1/receivables/${id}/payments`, cookie, { amountCents, paidAt, method: 'PIX', bankAccountId: accountId }, {
      'idempotency-key': key,
    });

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness.ctx);
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD },
    });
    cookie = sessionCookie(login.headers as Record<string, unknown>);

    const accounts = await call('GET', '/api/v1/bank-accounts');
    const list = (accounts.json().data ?? accounts.json()) as Array<{ id: string; isDefault: boolean }>;
    accountId = list.find((a) => a.isDefault)!.id;

    // Usuário MEMBER sem a ação finance.pay (só leitura do financeiro).
    const owner = await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' });
    const now = new Date();
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: 'Somente leitura',
      emailLower: 'leitura@exemplo.test',
      passwordHash: await hashPassword('Leitura@123'),
      phone: null,
      status: 'ACTIVE',
      browserNotificationsEnabled: false,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await harness.ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(),
      organizationId: owner!.organizationId,
      userId,
      role: 'MEMBER',
      permissions: { finance: ['read'] },
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    const restricted = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'leitura@exemplo.test', password: 'Leitura@123' },
    });
    restrictedCookie = sessionCookie(restricted.headers as Record<string, unknown>);
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('o filtro por motorista e por locação só traz contas dele e em aberto', async () => {
    const all = await openReceivables();
    const sample = all.find((r) => r.rental)!;

    const byDriver = await openReceivables(`&driverId=${sample.driver.id}`);
    expect(byDriver.length).toBeGreaterThan(0);
    expect(byDriver.every((r) => r.driver.id === sample.driver.id)).toBe(true);
    expect(byDriver.every((r) => r.remainingCents > 0 && r.status !== 'PAID' && r.status !== 'CANCELED')).toBe(true);

    const byRental = await openReceivables(`&rentalId=${sample.rental!.id}`);
    expect(byRental.length).toBeGreaterThan(0);
    expect(byRental.every((r) => r.rental?.id === sample.rental!.id)).toBe(true);

    // Id de outro motorista nunca vaza contas alheias.
    const stranger = await openReceivables(`&driverId=${new ObjectId().toHexString()}`);
    expect(stranger).toHaveLength(0);
  });

  it('pagamento parcial: reduz o saldo, entra no extrato e move os dois dashboards', async () => {
    const target = (await openReceivables()).find((r) => r.remainingCents > 30000)!;
    const [summaryBefore, financeBefore, balanceBefore] = await Promise.all([
      summaryRevenue(),
      financeRevenue(),
      balance(),
    ]);

    const res = await pay(target.id, 30000, 'baixa-parcial-1');
    expect(res.statusCode).toBe(201);

    const after = await getReceivable(target.id);
    expect(after.paidAmountCents).toBe(target.paidAmountCents + 30000);
    expect(after.remainingCents).toBe(target.remainingCents - 30000);
    expect(after.status).not.toBe('PAID');

    expect(await summaryRevenue()).toBe(summaryBefore + 30000);
    expect(await financeRevenue()).toBe(financeBefore + 30000);
    expect(await balance()).toBe(balanceBefore + 30000);

    const statement = await call('GET', `/api/v1/bank-accounts/${accountId}/statement?from=2026-11-01&to=2026-11-30`);
    const tx = statement.json().transactions as Array<{ direction?: string; amountCents?: number; description: string }>;
    expect(tx.some((t) => t.description.includes('Pagamento da locação'))).toBe(true);
  });

  it('dois pagamentos idênticos no mesmo dia com chaves distintas contam duas vezes', async () => {
    const target = (await openReceivables()).find((r) => r.remainingCents > 20000)!;
    const before = await financeRevenue();
    expect((await pay(target.id, 5000, 'dup-a')).statusCode).toBe(201);
    expect((await pay(target.id, 5000, 'dup-b')).statusCode).toBe(201);
    expect(await financeRevenue()).toBe(before + 10000);
    expect((await getReceivable(target.id)).remainingCents).toBe(target.remainingCents - 10000);
  });

  it('reenvio com a MESMA chave não duplica o recebimento nem o dashboard', async () => {
    const target = (await openReceivables()).find((r) => r.remainingCents > 10000)!;
    const before = await financeRevenue();
    expect((await pay(target.id, 4000, 'retry-1')).statusCode).toBe(201);
    const retry = await pay(target.id, 4000, 'retry-1');
    expect(retry.statusCode).toBe(200);
    expect(await financeRevenue()).toBe(before + 4000);
    expect((await getReceivable(target.id)).remainingCents).toBe(target.remainingCents - 4000);
  });

  it('quitação total: vira PAID, sai da lista de abertos e nada passa do saldo', async () => {
    const target = (await openReceivables()).find((r) => r.remainingCents > 0)!;

    const over = await pay(target.id, target.remainingCents + 1, 'over-1');
    expect(over.statusCode).toBe(422);

    expect((await pay(target.id, target.remainingCents, 'quita-1')).statusCode).toBe(201);
    const after = await getReceivable(target.id);
    expect(after.status).toBe('PAID');
    expect(after.remainingCents).toBe(0);
    expect((await openReceivables()).some((r) => r.id === target.id)).toBe(false);

    const again = await pay(target.id, 100, 'quita-2');
    expect(again.statusCode).toBe(409);
  });

  it('pagamento de outro mês aparece no mês dele, não no corrente', async () => {
    const target = (await openReceivables()).find((r) => r.remainingCents > 10000)!;
    const novBefore = await financeRevenue();
    const octBefore = (await call('GET', '/api/v1/finance/dashboard?month=10&year=2026')).json().revenueCents as number;

    expect((await pay(target.id, 7000, 'out-1', '2026-10-20')).statusCode).toBe(201);

    expect(await financeRevenue()).toBe(novBefore);
    const octAfter = (await call('GET', '/api/v1/finance/dashboard?month=10&year=2026')).json().revenueCents as number;
    expect(octAfter).toBe(octBefore + 7000);
  });

  it('quem não tem finance.pay recebe 403 e nada é gravado', async () => {
    const target = (await openReceivables()).find((r) => r.remainingCents > 0)!;
    const before = await financeRevenue();
    const res = await call(
      'POST',
      `/api/v1/receivables/${target.id}/payments`,
      restrictedCookie,
      { amountCents: 1000, paidAt: '2026-11-10', method: 'PIX', bankAccountId: accountId },
      { 'idempotency-key': 'sem-permissao' },
    );
    expect(res.statusCode).toBe(403);
    expect(await financeRevenue()).toBe(before);
  });

  it('locação com 1º período já pago: status da conta coerente com o saldo', async () => {
    const vehicle = await call('POST', '/api/v1/vehicles', cookie, {
      plate: 'ZZZ9Z99',
      brand: 'VW',
      model: 'POLO',
      mileageKm: 10,
    });
    const driver = await call('POST', '/api/v1/drivers', cookie, { fullName: 'Adiantado Teste', phone: '11999990099' });
    const rental = await call('POST', '/api/v1/rentals', cookie, {
      vehicleId: vehicle.json().id,
      driverId: driver.json().id,
      startDate: '2026-11-10',
      endDate: '2026-12-10',
      rentalType: 'WEEKLY',
      periodicAmountCents: 70000,
      firstPeriodPrepaid: true,
    });
    expect(rental.statusCode).toBe(201);

    const rows = (await call('GET', `/api/v1/receivables?rentalId=${rental.json().id}`)).json().data as ReceivableDTO[];
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.paidAmountCents).toBe(70000);
    expect(r.remainingCents).toBe(r.grossAmountCents - 70000);
    if (r.remainingCents === 0) expect(r.status).toBe('PAID');
    else expect(['PARTIAL', 'OVERDUE']).toContain(r.status);
    // O adiantamento pago nunca pode deixar a conta como "em aberto" (OPEN).
    expect(r.status).not.toBe('OPEN');
  });

  it('categorias: IPVA, Licenciamento e Outro existem e são recriadas sem duplicar nem reativar', async () => {
    const orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
    const col = harness.ctx.mongo.collections.expenseCategories;

    // Simula organização antiga: só tinha as 3 categorias originais.
    await col.deleteMany({ organizationId: orgId, slug: { $in: ['ipva', 'licenciamento'] } });
    await col.updateOne({ organizationId: orgId, slug: 'seguro' }, { $set: { active: false } });

    const first = await call('GET', '/api/v1/expense-categories');
    const second = await call('GET', '/api/v1/expense-categories');
    const labels = (second.json().data as Array<{ label: string }>).map((c) => c.label);
    // A listagem só devolve ativas: Seguro (desativada pelo usuário) segue fora.
    for (const label of ['Financiamento', 'IPVA', 'Licenciamento', 'Outro']) {
      expect(labels.filter((l) => l === label)).toHaveLength(1);
    }
    expect(labels).not.toContain('Seguro');
    expect((first.json().data as unknown[]).length).toBe((second.json().data as unknown[]).length);
    // Sem duplicar no banco e sem reativar a categoria desativada.
    expect(await col.countDocuments({ organizationId: orgId, slug: 'seguro' })).toBe(1);
    expect((await col.findOne({ organizationId: orgId, slug: 'seguro' }))!.active).toBe(false);
    expect(await col.countDocuments({ organizationId: orgId, slug: { $in: ['ipva', 'licenciamento'] } })).toBe(2);

    // E dá para lançar uma conta a pagar de IPVA/Licenciamento.
    const cats = second.json().data as Array<{ id: string; label: string }>;
    for (const label of ['IPVA', 'Licenciamento']) {
      const created = await call('POST', '/api/v1/payables', cookie, {
        categoryId: cats.find((c) => c.label === label)!.id,
        description: `${label} TESTE`,
        amountCents: 10000,
        dueDate: '2026-11-30',
      });
      expect(created.statusCode).toBe(201);
    }
  });
});
