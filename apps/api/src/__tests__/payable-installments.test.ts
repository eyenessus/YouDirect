import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { installmentDueDates } from '../services/finance.js';

/**
 * Parcelamento de contas a pagar (financiamento, seguro, IPVA, licenciamento):
 * todas as parcelas nascem na criação, cada uma com baixa individual.
 */
describe('installmentDueDates', () => {
  it('mensal: mantém o dia e ajusta meses curtos sem "derivar" para o dia 28', () => {
    expect(installmentDueDates('2026-01-31', 4, 'MONTHLY')).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ]);
  });

  it('trimestral e semestral andam 3 e 6 meses', () => {
    expect(installmentDueDates('2026-11-10', 3, 'QUARTERLY')).toEqual(['2026-11-10', '2027-02-10', '2027-05-10']);
    expect(installmentDueDates('2026-11-10', 3, 'SEMIANNUAL')).toEqual(['2026-11-10', '2027-05-10', '2027-11-10']);
  });

  it('anual vira o ano e trata 29/02 em ano não bissexto', () => {
    expect(installmentDueDates('2028-02-29', 3, 'ANNUAL')).toEqual(['2028-02-29', '2029-02-28', '2030-02-28']);
  });

  it('48 parcelas mensais terminam 47 meses depois', () => {
    const dates = installmentDueDates('2026-11-27', 48, 'MONTHLY');
    expect(dates).toHaveLength(48);
    expect(dates[47]).toBe('2030-10-27');
  });
});

describe('contas a pagar parceladas — criação e baixa por parcela', () => {
  let harness: TestHarness;
  let cookie: string;
  let accountId: string;
  let financingId: string;
  let categories: Array<{ id: string; label: string }>;

  interface PayableRow {
    id: string;
    description: string;
    amountCents: number;
    dueDate: string;
    status: string;
    remainingCents: number;
    installment: { seriesId: string; number: number; total: number; frequency: string } | null;
  }

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    harness.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

  /** Parcelas de uma descrição, em ordem de número. */
  const series = async (description: string) =>
    (((await call('GET', `/api/v1/payables?limit=100&q=${encodeURIComponent(description)}`)).json().data ??
      []) as PayableRow[])
      .filter((p) => p.description === description)
      .sort((a, b) => (a.installment?.number ?? 0) - (b.installment?.number ?? 0));

  const category = (label: string) => categories.find((c) => c.label === label)!.id;

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness.ctx);
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD },
    });
    cookie = sessionCookie(login.headers as Record<string, unknown>);
    const accounts = (await call('GET', '/api/v1/bank-accounts')).json();
    accountId = ((accounts.data ?? accounts) as Array<{ id: string; isDefault: boolean }>).find((a) => a.isDefault)!.id;
    categories = (await call('GET', '/api/v1/expense-categories')).json().data;
    financingId = category('Financiamento');
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('financiamento: 12 parcelas mensais criadas de uma vez, numeradas 1/12..12/12', async () => {
    const res = await call('POST', '/api/v1/payables', {
      categoryId: financingId,
      description: 'FINANCIAMENTO TESTE 12X',
      amountCents: 150000,
      dueDate: '2026-12-05',
      installments: { count: 12, frequency: 'MONTHLY' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().installment).toMatchObject({ number: 1, total: 12, frequency: 'MONTHLY' });

    const rows = await series('FINANCIAMENTO TESTE 12X');
    expect(rows).toHaveLength(12);
    expect(rows.map((p) => p.installment!.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(rows.map((p) => p.installment!.seriesId)).size).toBe(1);
    expect(rows[0]!.dueDate).toBe('2026-12-05');
    expect(rows[11]!.dueDate).toBe('2027-11-05');
    expect(rows.every((p) => p.amountCents === 150000 && p.status === 'PENDING')).toBe(true);
  });

  it('cada parcela tem baixa individual: pagar a 1ª não mexe nas demais', async () => {
    const before = (await call('GET', '/api/v1/finance/dashboard?month=11&year=2026')).json().expensesCents as number;
    const first = (await series('FINANCIAMENTO TESTE 12X'))[0]!;

    const paid = await call('POST', `/api/v1/payables/${first.id}/payments`, {
      amountCents: 150000,
      paidAt: '2026-11-10',
      method: 'PIX',
      bankAccountId: accountId,
    });
    expect(paid.statusCode).toBe(201);
    expect(paid.json().payable.status).toBe('PAID');

    const after = await series('FINANCIAMENTO TESTE 12X');
    expect(after[0]!.status).toBe('PAID');
    expect(after.slice(1).every((p) => p.status === 'PENDING' && p.remainingCents === 150000)).toBe(true);

    // A despesa entra no dashboard financeiro do mês do pagamento.
    const expenses = (await call('GET', '/api/v1/finance/dashboard?month=11&year=2026')).json().expensesCents as number;
    expect(expenses).toBe(before + 150000);
  });

  it('IPVA anual, licenciamento semestral e seguro trimestral', async () => {
    const make = (label: string, description: string, count: number, frequency: string) =>
      call('POST', '/api/v1/payables', {
        categoryId: category(label),
        description,
        amountCents: 100000,
        dueDate: '2027-03-15',
        installments: { count, frequency },
      });
    expect((await make('IPVA', 'IPVA TESTE ANUAL', 3, 'ANNUAL')).statusCode).toBe(201);
    expect((await make('Licenciamento', 'LICENC TESTE SEMESTRAL', 4, 'SEMIANNUAL')).statusCode).toBe(201);
    expect((await make('Seguro', 'SEGURO TESTE TRIMESTRAL', 4, 'QUARTERLY')).statusCode).toBe(201);

    expect((await series('IPVA TESTE ANUAL')).map((p) => p.dueDate)).toEqual([
      '2027-03-15',
      '2028-03-15',
      '2029-03-15',
    ]);
    expect((await series('LICENC TESTE SEMESTRAL')).map((p) => p.dueDate)).toEqual([
      '2027-03-15',
      '2027-09-15',
      '2028-03-15',
      '2028-09-15',
    ]);
    expect((await series('SEGURO TESTE TRIMESTRAL')).map((p) => p.dueDate)).toEqual([
      '2027-03-15',
      '2027-06-15',
      '2027-09-15',
      '2027-12-15',
    ]);
  });

  it('"já paga" com parcelamento quita só a 1ª parcela', async () => {
    const res = await call('POST', '/api/v1/payables', {
      categoryId: financingId,
      description: 'PARCELADO JA PAGO',
      amountCents: 50000,
      dueDate: '2026-11-10',
      alreadyPaid: true,
      paidBankAccountId: accountId,
      installments: { count: 3, frequency: 'MONTHLY' },
    });
    expect(res.statusCode).toBe(201);
    expect((await series('PARCELADO JA PAGO')).map((p) => p.status)).toEqual(['PAID', 'PENDING', 'PENDING']);
  });

  it('rejeita parcelamento inválido ou combinado com recorrência, sem criar nada', async () => {
    const base = { categoryId: financingId, description: 'PARCELA INVALIDA', amountCents: 1000, dueDate: '2026-12-01' };
    const post = (extra: Record<string, unknown>) => call('POST', '/api/v1/payables', { ...base, ...extra });

    expect((await post({ installments: { count: 1, frequency: 'MONTHLY' } })).statusCode).toBe(422);
    expect((await post({ installments: { count: 500, frequency: 'MONTHLY' } })).statusCode).toBe(422);
    expect((await post({ installments: { count: 3, frequency: 'WEEKLY' } })).statusCode).toBe(422);
    expect((await post({ recurring: true, installments: { count: 3, frequency: 'MONTHLY' } })).statusCode).toBe(422);
    expect(await series('PARCELA INVALIDA')).toHaveLength(0);
  });

  it('conta avulsa continua sem parcelamento (installment = null)', async () => {
    const res = await call('POST', '/api/v1/payables', {
      categoryId: financingId,
      description: 'AVULSA SIMPLES',
      amountCents: 9900,
      dueDate: '2026-12-01',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().installment).toBeNull();
    expect(await series('AVULSA SIMPLES')).toHaveLength(1);
  });
});
