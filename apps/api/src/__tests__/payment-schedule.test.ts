import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDaysIso, businessDate, type RentalPaymentSchedule } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { buildPaymentSchedule } from '../services/finance.js';

/* ------------------------------------------------------------------ *
 * Função pura: cronograma semanal calculado sobre a conta única do contrato
 * ------------------------------------------------------------------ */
describe('buildPaymentSchedule', () => {
  const rental = { startDate: '2026-11-01', rentalType: 'WEEKLY' as const, periodicAmountCents: 70000 };
  const build = (gross: number, paid: number, today = '2026-11-10') =>
    buildPaymentSchedule(rental, { grossAmountCents: gross, paidAmountCents: paid }, today);

  it('divide o total em semanas, com vencimentos de 7 em 7 dias a partir do início', () => {
    const { weeks, totals } = build(280000, 0);
    expect(weeks.map((w) => w.number)).toEqual([1, 2, 3, 4]);
    expect(weeks.map((w) => w.dueDate)).toEqual(['2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']);
    expect(weeks.every((w) => w.amountCents === 70000)).toBe(true);
    expect(totals).toEqual({ amountCents: 280000, paidCents: 0, remainingCents: 280000 });
  });

  it('o pago abate da semana mais antiga para a mais nova (FIFO) e marca parcial', () => {
    const { weeks } = build(280000, 105000); // 1,5 semana
    expect(weeks.map((w) => w.paidCents)).toEqual([70000, 35000, 0, 0]);
    expect(weeks.map((w) => w.remainingCents)).toEqual([0, 35000, 70000, 70000]);
    expect(weeks[0]!.status).toBe('PAID');
  });

  it('semana vencida e não quitada é OVERDUE; a parcial dentro do prazo é PARTIAL', () => {
    // hoje 10/11: semana 1 venceu em 08/11
    const late = build(280000, 0).weeks;
    expect(late.map((w) => w.status)).toEqual(['OVERDUE', 'OPEN', 'OPEN', 'OPEN']);
    // pago 1 semana + 10 reais: semana 1 PAID, semana 2 (vence 15/11) PARTIAL
    const partial = build(280000, 71000).weeks;
    expect(partial.map((w) => w.status)).toEqual(['PAID', 'PARTIAL', 'OPEN', 'OPEN']);
  });

  it('semana vencida mesmo parcialmente paga continua OVERDUE', () => {
    const { weeks } = build(280000, 30000, '2026-11-20'); // semanas 1 e 2 já venceram
    expect(weeks.map((w) => w.status)).toEqual(['OVERDUE', 'OVERDUE', 'OPEN', 'OPEN']);
    expect(weeks[0]!.paidCents).toBe(30000);
  });

  it('a última semana absorve a diferença e a soma sempre bate com o total', () => {
    const { weeks, totals } = build(150000, 0); // 2 × 700 + 100
    expect(weeks.map((w) => w.amountCents)).toEqual([70000, 70000, 10000]);
    expect(weeks.reduce((a, w) => a + w.amountCents, 0)).toBe(150000);
    expect(totals.remainingCents).toBe(150000);
  });

  it('tudo pago: todas PAID, nada pendente e nunca passa do total', () => {
    const { weeks, totals } = build(280000, 280000, '2027-01-01');
    expect(weeks.every((w) => w.status === 'PAID' && w.remainingCents === 0)).toBe(true);
    expect(totals.remainingCents).toBe(0);
    const over = build(280000, 999999, '2027-01-01');
    expect(over.totals.paidCents).toBe(280000);
  });

  it('locação mensal usa 30 dias por período', () => {
    const monthly = buildPaymentSchedule(
      { startDate: '2026-11-01', rentalType: 'MONTHLY', periodicAmountCents: 300000 },
      { grossAmountCents: 600000, paidAmountCents: 0 },
      '2026-11-10',
    );
    expect(monthly.weeks.map((w) => w.dueDate)).toEqual(['2026-12-01', '2026-12-31']);
  });
});

/* ------------------------------------------------------------------ *
 * API: cronograma + baixa por semana, sobre o seed
 * ------------------------------------------------------------------ */
describe('GET /rentals/:id/payment-schedule e baixa por semana', () => {
  let harness: TestHarness;
  let cookie: string;
  let accountId: string;
  const today = businessDate();

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    harness.app.inject({ method, url, headers: { cookie, ...headers }, ...(payload ? { payload } : {}) });
  const schedule = async (rentalId: string) =>
    (await call('GET', `/api/v1/rentals/${rentalId}/payment-schedule`)).json() as RentalPaymentSchedule;
  const pay = (receivableId: string, amountCents: number, key: string) =>
    call(
      'POST',
      `/api/v1/receivables/${receivableId}/payments`,
      { amountCents, paidAt: today, method: 'PIX', bankAccountId: accountId },
      { 'idempotency-key': key },
    );

  /** Locação semanal nova: cada teste cria a sua para não depender da ordem. */
  let plate = 0;
  const createRental = async (extra: Record<string, unknown>) => {
    plate += 1;
    const vehicle = await call('POST', '/api/v1/vehicles', {
      plate: `SCH${plate}A${plate}${plate}`.slice(0, 7),
      brand: 'VW',
      model: 'GOL',
      mileageKm: 1,
    });
    const driver = await call('POST', '/api/v1/drivers', { fullName: `Semanal ${plate}`, phone: `1199990${1000 + plate}` });
    const rental = await call('POST', '/api/v1/rentals', {
      vehicleId: vehicle.json().id,
      driverId: driver.json().id,
      rentalType: 'WEEKLY',
      periodicAmountCents: 70000,
      ...extra,
    });
    expect(rental.statusCode).toBe(201);
    return rental.json().id as string;
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
    const accounts = (await call('GET', '/api/v1/bank-accounts')).json();
    accountId = ((accounts.data ?? accounts) as Array<{ id: string; isDefault: boolean }>).find((a) => a.isDefault)!.id;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  it('contrato do seed: soma das semanas = total da conta e FIFO consistente', async () => {
    const list = (await call('GET', '/api/v1/receivables?q=LOC-2026-007&limit=5')).json().data as Array<{
      id: string;
      rental: { id: string };
      grossAmountCents: number;
      paidAmountCents: number;
    }>;
    const rec = list[0]!;
    const s = await schedule(rec.rental.id);

    expect(s.receivableId).toBe(rec.id);
    expect(s.totals.amountCents).toBe(rec.grossAmountCents);
    expect(s.totals.paidCents).toBe(Math.min(rec.paidAmountCents, rec.grossAmountCents));
    expect(s.weeks.reduce((a, w) => a + w.amountCents, 0)).toBe(rec.grossAmountCents);
    expect(s.weeks.reduce((a, w) => a + w.paidCents, 0)).toBe(s.totals.paidCents);
    // FIFO: depois da primeira semana não quitada, nenhuma outra tem pagamento.
    const firstOpen = s.weeks.findIndex((w) => w.remainingCents > 0);
    expect(s.weeks.slice(firstOpen + 1).every((w) => w.paidCents === 0)).toBe(true);
    // Vencimentos sempre 7 dias apart.
    for (let i = 1; i < s.weeks.length; i += 1) {
      expect(addDaysIso(s.weeks[i - 1]!.dueDate, 7)).toBe(s.weeks[i]!.dueDate);
    }
  });

  it('dar baixa de uma semana (R$ 700) quita exatamente a primeira semana em aberto', async () => {
    const id = await createRental({ startDate: addDaysIso(today, -10), endDate: addDaysIso(today, 18) });
    const before = await schedule(id);
    expect(before.weeks).toHaveLength(4);
    expect(before.weeks[0]!.status).toBe('OVERDUE');

    expect((await pay(before.receivableId!, 70000, 'sem-1')).statusCode).toBe(201);
    const after = await schedule(id);
    expect(after.weeks.map((w) => w.status)[0]).toBe('PAID');
    expect(after.weeks[1]!.paidCents).toBe(0);
    expect(after.totals.remainingCents).toBe(before.totals.remainingCents - 70000);
  });

  it('valor de uma semana e meia: semana 1 paga, semana 2 parcial', async () => {
    const id = await createRental({ startDate: addDaysIso(today, -3), endDate: addDaysIso(today, 25) });
    const before = await schedule(id);
    expect((await pay(before.receivableId!, 105000, 'sem-meia')).statusCode).toBe(201);
    const after = await schedule(id);
    expect(after.weeks.slice(0, 3).map((w) => [w.paidCents, w.status])).toEqual([
      [70000, 'PAID'],
      [35000, 'PARTIAL'],
      [0, 'OPEN'],
    ]);
  });

  it('"Dar baixa até a semana N" (acumulado) quita as N primeiras de uma vez', async () => {
    const id = await createRental({ startDate: addDaysIso(today, -3), endDate: addDaysIso(today, 25) });
    const before = await schedule(id);
    const upTo3 = before.weeks.slice(0, 3).reduce((a, w) => a + w.remainingCents, 0);
    expect((await pay(before.receivableId!, upTo3, 'sem-ate-3')).statusCode).toBe(201);
    const after = await schedule(id);
    expect(after.weeks.slice(0, 3).every((w) => w.status === 'PAID')).toBe(true);
    expect(after.weeks[3]!.paidCents).toBe(0);
  });

  it('1ª semana marcada como já paga no cadastro aparece como Paga', async () => {
    const id = await createRental({
      startDate: addDaysIso(today, -2),
      endDate: addDaysIso(today, 26),
      firstPeriodPrepaid: true,
    });
    const s = await schedule(id);
    expect(s.weeks[0]).toMatchObject({ number: 1, paidCents: 70000, remainingCents: 0, status: 'PAID' });
    expect(s.weeks.slice(1).every((w) => w.paidCents === 0)).toBe(true);
  });

  it('caução marcada como paga não entra no cronograma', async () => {
    const id = await createRental({
      startDate: addDaysIso(today, -2),
      endDate: addDaysIso(today, 26),
      depositCents: 150000,
      depositPrepaid: true,
    });
    const s = await schedule(id);
    expect(s.totals.paidCents).toBe(0);
    expect(s.totals.amountCents).toBe(280000);
  });

  it('não aceita pagar mais que o saldo do contrato', async () => {
    const id = await createRental({ startDate: addDaysIso(today, -3), endDate: addDaysIso(today, 25) });
    const s = await schedule(id);
    const res = await pay(s.receivableId!, s.totals.remainingCents + 1, 'sem-excesso');
    expect(res.statusCode).toBe(422);
    expect((await schedule(id)).totals.paidCents).toBe(0);
  });

  it('locação sem data de término ganha uma semana nova a cada semana iniciada', async () => {
    const id = await createRental({ startDate: addDaysIso(today, -21) });
    const s = await schedule(id);
    // dias 0, 7, 14, 21 → 4 períodos iniciados
    expect(s.weeks).toHaveLength(4);
    expect(s.totals.amountCents).toBe(4 * 70000);
    expect(s.weeks.map((w) => w.status)).toEqual(['OVERDUE', 'OVERDUE', 'OPEN', 'OPEN']);

    // Chamar de novo não duplica o valor (idempotente).
    expect((await schedule(id)).totals.amountCents).toBe(4 * 70000);
    // Dá para dar baixa na semana atual, que só existe por causa da extensão.
    expect((await pay(s.receivableId!, 4 * 70000, 'sem-aberta-total')).statusCode).toBe(201);
    expect((await schedule(id)).weeks.every((w) => w.status === 'PAID')).toBe(true);
  });

  it('baixa por semana move receita nos dois dashboards', async () => {
    const id = await createRental({ startDate: addDaysIso(today, -3), endDate: addDaysIso(today, 25) });
    const s = await schedule(id);
    const month = Number(today.slice(5, 7));
    const year = Number(today.slice(0, 4));
    const rev = async () =>
      (await call('GET', `/api/v1/finance/dashboard?month=${month}&year=${year}`)).json().revenueCents as number;
    const before = await rev();
    expect((await pay(s.receivableId!, 70000, 'sem-dash')).statusCode).toBe(201);
    expect(await rev()).toBe(before + 70000);
  });

  it('locação inexistente devolve 404', async () => {
    const res = await call('GET', '/api/v1/rentals/64b64b64b64b64b64b64b64b/payment-schedule');
    expect(res.statusCode).toBe(404);
  });
});
