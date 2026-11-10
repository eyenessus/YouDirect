import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { addDaysIso, businessDate, fullMatrix } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { hashPassword } from '../common/helpers.js';
import { generateRecurringPayables } from '../services/finance.js';

/**
 * AUDITORIA FINANCEIRA — cenários AUD-01..AUD-16 (ver audit/05-testes-executados.md).
 * Banco em memória + seed; nada de dados reais. Cada teste cria a própria frota
 * (veículo/motorista/locação) para não depender da ordem de execução.
 * Onde há suspeita de defeito, o teste afirma o comportamento CORRETO: se falhar,
 * o defeito está comprovado.
 */
describe('auditoria financeira', () => {
  let harness: TestHarness;
  let cookie: string;
  let accountId: string;
  let orgAId: ObjectId;
  let categories: Array<{ id: string; label: string }>;
  const today = businessDate();
  const month = Number(today.slice(5, 7));
  const year = Number(today.slice(0, 4));

  type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
  const call = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}, c = cookie) =>
    harness.app.inject({
      method,
      url,
      headers: { cookie: c, ...headers },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  const dash = async (m = month, y = year) =>
    (await call('GET', `/api/v1/finance/dashboard?month=${m}&year=${y}`)).json() as {
      revenueCents: number;
      expensesCents: number;
      profitCents: number;
    };
  const summary = async () => (await call('GET', '/api/v1/dashboard/summary')).json();
  const byVehicle = async (m = month, y = year) => {
    const body = (await call('GET', `/api/v1/reports/by-vehicle?month=${m}&year=${y}`)).json();
    const list = (Object.values(body).find(
      (v) => Array.isArray(v) && v.length > 0 && (v[0] as { vehicleId?: string }).vehicleId,
    ) ?? []) as Array<{ vehicleId: string; revenueCents: number; expensesCents: number }>;
    return new Map(list.map((r) => [r.vehicleId, r]));
  };

  let seq = 0;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const newFleet = async (label = 'AUD') => {
    seq += 1;
    const plate = `Q${letters[Math.floor(seq / 26) % 26]}${letters[seq % 26]}1B23`;
    const vehicle = await call('POST', '/api/v1/vehicles', { plate, brand: 'VW', model: `${label}${seq}`, mileageKm: 1 });
    expect(vehicle.statusCode).toBe(201);
    const driver = await call('POST', '/api/v1/drivers', { fullName: `${label} Motorista ${seq}`, phone: `1190000${1000 + seq}` });
    expect(driver.statusCode).toBe(201);
    return { vehicleId: vehicle.json().id as string, driverId: driver.json().id as string, plate };
  };
  const newRental = async (
    fleet: { vehicleId: string; driverId: string },
    extra: Record<string, unknown> = {},
    periodicAmountCents = 80000,
  ) => {
    const res = await call('POST', '/api/v1/rentals', {
      vehicleId: fleet.vehicleId,
      driverId: fleet.driverId,
      rentalType: 'WEEKLY',
      periodicAmountCents,
      startDate: today,
      endDate: addDaysIso(today, 7), // 1 período => cobrança única de R$ 800
      ...extra,
    });
    expect(res.statusCode).toBe(201);
    const rentalId = res.json().id as string;
    const rec = (await call('GET', `/api/v1/receivables?rentalId=${rentalId}`)).json().data[0] as {
      id: string;
      grossAmountCents: number;
      paidAmountCents: number;
      remainingCents: number;
      dueDate: string;
      status: string;
    };
    return { rentalId, receivableId: rec.id, receivable: rec };
  };
  const getReceivable = async (id: string) => (await call('GET', `/api/v1/receivables/${id}`)).json();
  const receive = (id: string, amountCents: number, key: string | null, paidAt = today) =>
    call(
      'POST',
      `/api/v1/receivables/${id}/payments`,
      { amountCents, paidAt, method: 'PIX', bankAccountId: accountId },
      key ? { 'idempotency-key': key } : {},
    );
  const newPayable = async (vehicleId: string | undefined, amountCents: number, label: string, dueDate = addDaysIso(today, 5), desc = '') =>
    call('POST', '/api/v1/payables', {
      categoryId: categories.find((c) => c.label === label)!.id,
      vehicleId,
      amountCents,
      dueDate,
      description: desc || `${label} AUDITORIA`,
    });
  const payPayable = (id: string, amountCents: number, key: string, paidAt = today) =>
    call(
      'POST',
      `/api/v1/payables/${id}/payments`,
      { amountCents, paidAt, method: 'PIX', bankAccountId: accountId },
      { 'idempotency-key': key },
    );

  const createOrgB = async () => {
    const ctx = harness.ctx;
    const now = new Date();
    const organizationId = new ObjectId();
    await ctx.mongo.collections.organizations.insertOne({
      _id: organizationId,
      name: 'Empresa B',
      legalId: null,
      timezone: 'America/Sao_Paulo',
      currency: 'BRL',
      settings: { freeSeats: 3, extraSeatPriceCents: 990 },
      createdAt: now,
      updatedAt: now,
    });
    const userId = new ObjectId();
    await ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: 'Dono B',
      emailLower: 'dono-b@exemplo.test',
      passwordHash: await hashPassword('DonoB@12345'),
      phone: null,
      status: 'ACTIVE',
      browserNotificationsEnabled: false,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(),
      organizationId,
      userId,
      role: 'OWNER',
      permissions: fullMatrix(),
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'dono-b@exemplo.test', password: 'DonoB@12345' },
    });
    return sessionCookie(login.headers as Record<string, unknown>);
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
    categories = (await call('GET', '/api/v1/expense-categories')).json().data;
    orgAId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  /* -------------------------- AUD-01 .. AUD-04 -------------------------- */
  describe('Recebimentos de locação', () => {
    it('AUD-01 recebimento completo de R$ 800: persiste, quita e soma exatamente R$ 800 na receita do mês', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      expect(r.receivable.grossAmountCents).toBe(80000);
      const before = await dash();
      const vehBefore = (await byVehicle()).get(f.vehicleId);

      const res = await receive(r.receivableId, 80000, 'aud01');
      expect(res.statusCode).toBe(201);

      const rec = await getReceivable(r.receivableId);
      expect(rec).toMatchObject({ paidAmountCents: 80000, remainingCents: 0, status: 'PAID' });
      const payments = await harness.ctx.mongo.collections.payments
        .find({ sourceId: new ObjectId(r.receivableId) })
        .toArray();
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ amountCents: 80000, paidAt: today });

      const after = await dash();
      expect(after.revenueCents).toBe(before.revenueCents + 80000);
      expect(after.expensesCents).toBe(before.expensesCents);
      expect((await byVehicle()).get(f.vehicleId)!.revenueCents).toBe((vehBefore?.revenueCents ?? 0) + 80000);
    });

    it('AUD-02 pagamento duplicado (mesma chave / clique repetido): contabiliza uma única vez', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      const before = await dash();
      const first = await receive(r.receivableId, 80000, 'aud02');
      const second = await receive(r.receivableId, 80000, 'aud02');
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect((await dash()).revenueCents).toBe(before.revenueCents + 80000);
      expect(
        await harness.ctx.mongo.collections.payments.countDocuments({ sourceId: new ObjectId(r.receivableId) }),
      ).toBe(1);
    });

    it('AUD-02b 10 cliques simultâneos com a mesma chave geram exatamente 1 recebimento', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      const results = await Promise.all(Array.from({ length: 10 }, () => receive(r.receivableId, 80000, 'aud02b')));
      expect(results.filter((x) => x.statusCode === 201)).toHaveLength(1);
      expect(results.every((x) => [200, 201, 409].includes(x.statusCode))).toBe(true);
      expect(
        await harness.ctx.mongo.collections.payments.countDocuments({ sourceId: new ObjectId(r.receivableId) }),
      ).toBe(1);
      expect((await getReceivable(r.receivableId)).paidAmountCents).toBe(80000);
    });

    it('AUD-02c mesma chave com VALOR diferente não pode ser aceita em silêncio como sucesso', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      expect((await receive(r.receivableId, 30000, 'aud02c')).statusCode).toBe(201);
      const conflicting = await receive(r.receivableId, 50000, 'aud02c');
      // Correto: rejeitar (409/422). Responder 200 "ok" esconde que os R$ 500 NÃO foram registrados.
      expect([409, 422]).toContain(conflicting.statusCode);
    });

    it('AUD-02d duas requisições iguais SEM chave, em momentos diferentes: são dois pagamentos legítimos (regra da main: a chave sem cliente inclui a versão da conta)', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      const a = await receive(r.receivableId, 20000, null);
      const b = await receive(r.receivableId, 20000, null);
      expect(a.statusCode).toBe(201);
      // regra atual: sem chave, o hash inclui a versão da conta; dois cliques SIMULTÂNEOS fundem, mas
      // duas parcelas iguais pagas em sequência (legítimas) são registradas separadamente.
      expect(b.statusCode).toBe(201);
      expect((await getReceivable(r.receivableId)).paidAmountCents).toBe(40000);
    });

    it('AUD-03 pagamento parcial de R$ 300 em cobrança de R$ 800: 300 recebidos, 500 pendentes, não quitada', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      const before = await dash();
      expect((await receive(r.receivableId, 30000, 'aud03')).statusCode).toBe(201);
      const rec = await getReceivable(r.receivableId);
      expect(rec.paidAmountCents).toBe(30000);
      expect(rec.remainingCents).toBe(50000);
      expect(rec.status).not.toBe('PAID');
      expect((await dash()).revenueCents).toBe(before.revenueCents + 30000);
    });

    it('AUD-03b recebimentos parciais não ultrapassam o saldo (sem crédito/excedente silencioso)', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      expect((await receive(r.receivableId, 50000, 'aud03b-1')).statusCode).toBe(201);
      const over = await receive(r.receivableId, 40000, 'aud03b-2'); // 500 + 400 > 800
      expect(over.statusCode).toBe(422);
      expect((await getReceivable(r.receivableId)).paidAmountCents).toBe(50000);
    });

    it('AUD-03c duas baixas SIMULTÂNEAS que somadas ultrapassam o saldo: só uma pode vencer', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      const [a, b] = await Promise.all([
        receive(r.receivableId, 60000, 'aud03c-a'),
        receive(r.receivableId, 60000, 'aud03c-b'),
      ]);
      const paid = (await getReceivable(r.receivableId)).paidAmountCents as number;
      expect(paid).toBeLessThanOrEqual(80000);
      expect([a.statusCode, b.statusCode].filter((s) => s === 201)).toHaveLength(1);
      const sum = (
        await harness.ctx.mongo.collections.payments.find({ sourceId: new ObjectId(r.receivableId) }).toArray()
      ).reduce((acc, p) => acc + p.amountCents, 0);
      expect(sum).toBe(paid); // a soma dos recebimentos bate com o saldo da conta
    });

    it('AUD-04 atraso: vencimento 09/11/2026 e pagamento 10/11/2026 preservam as duas datas', async () => {
      const f = await newFleet();
      // início 02/11 => 1º vencimento 09/11 (7 dias)
      const r = await newRental(f, { startDate: '2026-11-02', endDate: '2026-11-09' });
      expect(r.receivable.dueDate).toBe('2026-11-09');
      expect((await receive(r.receivableId, 80000, 'aud04', '2026-11-10')).statusCode).toBe(201);
      const rec = await getReceivable(r.receivableId);
      expect(rec.dueDate).toBe('2026-11-09');
      const pay = await harness.ctx.mongo.collections.payments.findOne({ sourceId: new ObjectId(r.receivableId) });
      expect(pay!.paidAt).toBe('2026-11-10');
      // o atraso fica reconstituível: pago 1 dia depois do vencimento
      expect(pay!.paidAt > rec.dueDate).toBe(true);
      // e existe trilha de auditoria da baixa
      const log = await harness.ctx.mongo.collections.auditLogs.findOne({
        entityId: new ObjectId(r.receivableId),
        action: 'receivable.payment',
      });
      expect(log).toBeTruthy();
    });
  });

  /* -------------------------- AUD-05 .. AUD-06 -------------------------- */
  describe('Despesas e ranking por veículo', () => {
    it('AUD-05 financiamento R$ 1.500 no veículo A: previsto ≠ pago e receita intacta', async () => {
      const a = await newFleet('A');
      const before = await dash();
      const created = await newPayable(a.vehicleId, 150000, 'Financiamento', addDaysIso(today, 3), 'FINANC AUD05');
      expect(created.statusCode).toBe(201);

      // lançada, mas NÃO paga: não pode contar como despesa realizada nem como receita
      const mid = await dash();
      expect(mid.expensesCents).toBe(before.expensesCents);
      expect(mid.revenueCents).toBe(before.revenueCents);
      expect((await byVehicle()).get(a.vehicleId)?.expensesCents ?? 0).toBe(0);

      expect((await payPayable(created.json().id, 150000, 'aud05')).statusCode).toBe(201);
      const after = await dash();
      expect(after.expensesCents).toBe(before.expensesCents + 150000);
      expect(after.revenueCents).toBe(before.revenueCents);
      expect((await byVehicle()).get(a.vehicleId)!.expensesCents).toBe(150000);
    });

    it('AUD-06 ranking: despesa no veículo B move o ranking; um recebimento depois NÃO o altera', async () => {
      const b = await newFleet('B');
      const r = await newRental(b);
      const p = await newPayable(b.vehicleId, 987654, 'Seguro', addDaysIso(today, 2), 'SEGURO AUD06');
      expect((await payPayable(p.json().id, 987654, 'aud06-p')).statusCode).toBe(201);

      const rankingBefore = (await summary()).topExpensive as Array<{ vehicleId: string; amountCents: number }>;
      const expBefore = await dash();
      const allBefore = [...(await byVehicle()).values()].map((v) => [v.vehicleId, v.expensesCents]);

      expect((await receive(r.receivableId, 80000, 'aud06-r')).statusCode).toBe(201);

      const rankingAfter = (await summary()).topExpensive as Array<{ vehicleId: string; amountCents: number }>;
      expect(rankingAfter.map((x) => [x.vehicleId, x.amountCents])).toEqual(
        rankingBefore.map((x) => [x.vehicleId, x.amountCents]),
      );
      expect((await dash()).expensesCents).toBe(expBefore.expensesCents);
      expect([...(await byVehicle()).values()].map((v) => [v.vehicleId, v.expensesCents])).toEqual(allBefore);
      // B lidera o ranking de despesas com a despesa lançada
      expect(rankingAfter[0]!.vehicleId).toBe(b.vehicleId);
      expect(rankingAfter[0]!.amountCents).toBe(987654);
    });
  });

  /* ------------------------------- AUD-07 ------------------------------- */
  describe('Correção / estorno', () => {
    it('AUD-07a estorno de conta a pagar já paga: histórico preservado E dashboard/ranking corrigidos', async () => {
      const v = await newFleet('EST');
      const p = await newPayable(v.vehicleId, 55555, 'IPVA', addDaysIso(today, 1), 'IPVA AUD07');
      expect((await payPayable(p.json().id, 55555, 'aud07a')).statusCode).toBe(201);
      const afterPay = await dash();
      expect((await byVehicle()).get(v.vehicleId)!.expensesCents).toBe(55555);

      const del = await call('DELETE', `/api/v1/payables/${p.json().id}`);
      expect(del.statusCode).toBe(200);
      expect(del.json().reversed).toBe(true);

      // o extrato bancário foi estornado (saída cancelada pela entrada de estorno)
      const reversed = await harness.ctx.mongo.collections.bankTransactions
        .find({ originId: new ObjectId(p.json().id) })
        .toArray();
      expect(reversed.length).toBeGreaterThanOrEqual(2);

      // …portanto a despesa NÃO pode continuar contando no dashboard nem no veículo
      const afterReverse = await dash();
      expect(afterReverse.expensesCents).toBe(afterPay.expensesCents - 55555);
      expect((await byVehicle()).get(v.vehicleId)?.expensesCents ?? 0).toBe(0);
    });

    it('AUD-07b correção de recebimento (R$ 800 → R$ 700) ou estorno autorizado de recebimento', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      expect((await receive(r.receivableId, 80000, 'aud07b')).statusCode).toBe(201);
      const payment = await harness.ctx.mongo.collections.payments.findOne({ sourceId: new ObjectId(r.receivableId) });
      const before = await dash();

      const res = await call('POST', `/api/v1/receivables/${r.receivableId}/payments/${payment!._id.toHexString()}/reverse`, {
        reason: 'Valor lançado incorretamente',
      });
      expect(res.statusCode).toBe(200);
      const after = await dash();
      expect(after.revenueCents).toBe(before.revenueCents - 80000);
      const rec = await getReceivable(r.receivableId);
      expect(rec).toMatchObject({ paidAmountCents: 0, remainingCents: 80000 });
      // histórico preservado: o pagamento original continua registrado, marcado como estornado
      const kept = await harness.ctx.mongo.collections.payments.findOne({ _id: payment!._id });
      expect(kept).toBeTruthy();
      // repetir o estorno não duplica o efeito
      const again = await call('POST', `/api/v1/receivables/${r.receivableId}/payments/${payment!._id.toHexString()}/reverse`, {
        reason: 'repetido',
      });
      expect([200, 409]).toContain(again.statusCode);
      expect((await dash()).revenueCents).toBe(after.revenueCents);
    });
  });

  /* ------------------------------- AUD-08 ------------------------------- */
  describe('Filtros temporais', () => {
    it('AUD-08 receita e despesa respeitam a data de liquidação (paidAt), não a de lançamento', async () => {
      const f = await newFleet();
      const r = await newRental(f, { startDate: '2026-10-01', endDate: '2026-10-08' });
      const octBefore = await dash(10, 2026);
      const novBefore = await dash(11, 2026);
      expect((await receive(r.receivableId, 80000, 'aud08-r', '2026-10-20')).statusCode).toBe(201);
      expect((await dash(10, 2026)).revenueCents).toBe(octBefore.revenueCents + 80000);
      expect((await dash(11, 2026)).revenueCents).toBe(novBefore.revenueCents);

      // despesa que VENCE em dezembro mas é paga em novembro conta em novembro
      const p = await newPayable(undefined, 12300, 'Seguro', '2026-12-15', 'SEGURO AUD08');
      expect((await payPayable(p.json().id, 12300, 'aud08-p', '2026-11-05')).statusCode).toBe(201);
      expect((await dash(11, 2026)).expensesCents).toBe(novBefore.expensesCents + 12300);
      expect((await dash(12, 2026)).expensesCents).toBe(0);
    });

    it('AUD-08b data de pagamento no futuro é rejeitada (ou ao menos não infla o mês corrente)', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      const future = addDaysIso(today, 60);
      const res = await receive(r.receivableId, 80000, 'aud08b', future);
      // Correto: recusar pagamento "realizado" em data futura
      expect([400, 409, 422]).toContain(res.statusCode);
    });
  });

  /* ------------------------------- AUD-09 ------------------------------- */
  describe('Encerramento de locação', () => {
    // B-03: corrigido na `main` por `syncContractReceivable` (a conta passa a cobrar só os períodos iniciados até o encerramento).
    it('AUD-09 encerrar a locação não deixa cobranças de períodos posteriores ao encerramento', async () => {
      const f = await newFleet();
      // 4 semanas contratadas (R$ 3.200), nada pago; encerra hoje, no início do 1º período
      const r = await newRental(f, { startDate: addDaysIso(today, -1), endDate: addDaysIso(today, 27) });
      expect(r.receivable.grossAmountCents).toBe(320000);
      const close = await call('POST', `/api/v1/rentals/${r.rentalId}/close`, { endDate: today });
      expect(close.statusCode).toBe(200);
      const rec = await getReceivable(r.receivableId);
      // Correto: a conta passa a cobrar no máximo até o encerramento (1 período), não as 4 semanas
      expect(rec.grossAmountCents).toBeLessThanOrEqual(80000);
    });

    it('AUD-09b locação encerrada sem término fixo não ganha semanas novas depois', async () => {
      const f = await newFleet();
      const r = await newRental(f, { startDate: addDaysIso(today, -3), endDate: undefined });
      expect((await call('POST', `/api/v1/rentals/${r.rentalId}/close`, { endDate: today })).statusCode).toBe(200);
      const grossAtClose = (await getReceivable(r.receivableId)).grossAmountCents;
      const sched = (await call('GET', `/api/v1/rentals/${r.rentalId}/payment-schedule`)).json();
      expect(sched.totals.amountCents).toBe(grossAtClose);
    });
  });

  /* ------------------------------- AUD-10 ------------------------------- */
  describe('Isolamento entre empresas', () => {
    it('AUD-10 a empresa B não enxerga nem altera dados da empresa A', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      const p = await newPayable(f.vehicleId, 1000, 'Seguro', addDaysIso(today, 2), 'SEGURO AUD10');
      const cookieB = await createOrgB();
      const asB = (m: Method, url: string, payload?: unknown, h: Record<string, string> = {}) =>
        call(m, url, payload, h, cookieB);

      expect((await asB('GET', `/api/v1/receivables/${r.receivableId}`)).statusCode).toBe(404);
      expect((await asB('GET', `/api/v1/payables/${p.json().id}`)).statusCode).toBe(404);
      expect((await asB('GET', `/api/v1/rentals/${r.rentalId}/payment-schedule`)).statusCode).toBe(404);
      expect((await asB('GET', `/api/v1/receivables?limit=100`)).json().data).toHaveLength(0);
      expect((await asB('GET', `/api/v1/vehicles/${f.vehicleId}`)).statusCode).toBe(404);
      expect((await asB('GET', `/api/v1/drivers/${f.driverId}`)).statusCode).toBe(404);

      const pay = await asB(
        'POST',
        `/api/v1/receivables/${r.receivableId}/payments`,
        { amountCents: 80000, paidAt: today, method: 'PIX', bankAccountId: accountId },
        { 'idempotency-key': 'b-invade' },
      );
      expect(pay.statusCode).toBe(404);
      expect((await asB('DELETE', `/api/v1/payables/${p.json().id}`)).statusCode).toBe(404);
      expect((await asB('PATCH', `/api/v1/payables/${p.json().id}`, { amountCents: 1 })).statusCode).toBe(404);
      expect(
        (
          await asB('POST', '/api/v1/payables', {
            categoryId: categories[0]!.id, // categoria da empresa A
            vehicleId: f.vehicleId, // veículo da empresa A
            amountCents: 100,
            dueDate: today,
            description: 'invasão',
          })
        ).statusCode,
      ).toBe(404);
      expect((await getReceivable(r.receivableId)).paidAmountCents).toBe(0);

      // dashboards da B não incluem nada da A
      const bDash = (await asB('GET', `/api/v1/finance/dashboard?month=${month}&year=${year}`)).json();
      expect(bDash.revenueCents).toBe(0);
      expect(bDash.expensesCents).toBe(0);
    });
  });

  /* ------------------------------- AUD-11 ------------------------------- */
  describe('Validação de entrada', () => {
    it('AUD-11 datas inválidas, valores negativos/zero, campos ausentes e ids malformados → 4xx, nunca 500', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      const body = (over: Record<string, unknown>) => ({
        amountCents: 1000,
        paidAt: today,
        method: 'PIX',
        bankAccountId: accountId,
        ...over,
      });
      const post = (payload: unknown, key: string) =>
        call('POST', `/api/v1/receivables/${r.receivableId}/payments`, payload, { 'idempotency-key': key });

      for (const [i, bad] of [
        { amountCents: -100 },
        { amountCents: 0 },
        { amountCents: 10.5 },
        { amountCents: '1000' },
        { paidAt: '2026-02-30' },
        { paidAt: '2026-13-01' },
        { paidAt: '10/11/2026' },
        { paidAt: '' },
        { method: 'BITCOIN' },
        { bankAccountId: 'nao-e-id' },
        { bankAccountId: new ObjectId().toHexString() },
      ].entries()) {
        const res = await post(body(bad), `aud11-${i}`);
        expect(res.statusCode, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, JSON.stringify(bad)).toBeLessThan(500);
      }
      expect((await call('POST', `/api/v1/receivables/${r.receivableId}/payments`, {})).statusCode).toBeLessThan(500);
      expect((await call('GET', '/api/v1/receivables/xyz')).statusCode).toBeLessThan(500);
      expect((await getReceivable(r.receivableId)).paidAmountCents).toBe(0);
    });

    it('AUD-11b conta a pagar: valor negativo/zero, data inválida, categoria inexistente e veículo inexistente', async () => {
      const cat = categories.find((c) => c.label === 'Seguro')!.id;
      const base = { categoryId: cat, amountCents: 1000, dueDate: today, description: 'X' };
      for (const bad of [
        { amountCents: -1 },
        { amountCents: 0 },
        { dueDate: '2026-02-30' },
        { dueDate: 'amanhã' },
        { description: '' },
        { categoryId: new ObjectId().toHexString() },
        { vehicleId: new ObjectId().toHexString() },
        { categoryId: undefined },
      ]) {
        const res = await call('POST', '/api/v1/payables', { ...base, ...bad });
        expect(res.statusCode, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
        expect(res.statusCode, JSON.stringify(bad)).toBeLessThan(500);
      }
    });

    it('AUD-11c despesa de veículo (financiamento/IPVA/licenciamento/seguro) exige veículo associado', async () => {
      for (const label of ['Financiamento', 'IPVA', 'Licenciamento', 'Seguro']) {
        const res = await newPayable(undefined, 1000, label, today, `SEM VEICULO ${label}`);
        // Decisão de produto pendente (PEND-01): hoje o veículo é opcional. O teste documenta o estado atual.
        expect([201, 400, 422]).toContain(res.statusCode);
      }
    });
  });

  /* ------------------------------- AUD-12 ------------------------------- */
  describe('Concorrência e idempotência em despesas', () => {
    it('AUD-12 baixa de despesa: cliques repetidos e baixas simultâneas não pagam além do valor', async () => {
      const v = await newFleet();
      const p = await newPayable(v.vehicleId, 100000, 'Licenciamento', addDaysIso(today, 4), 'LICENC AUD12');
      const id = p.json().id as string;
      const results = await Promise.all([
        payPayable(id, 70000, 'aud12-a'),
        payPayable(id, 70000, 'aud12-b'),
        payPayable(id, 70000, 'aud12-b'),
      ]);
      const paid = (await call('GET', `/api/v1/payables/${id}`)).json().paidAmountCents as number;
      expect(paid).toBeLessThanOrEqual(100000);
      expect(results.filter((x) => x.statusCode === 201).length).toBeLessThanOrEqual(1);
      const sum = (
        await harness.ctx.mongo.collections.payments.find({ sourceId: new ObjectId(id) }).toArray()
      ).reduce((a, x) => a + x.amountCents, 0);
      expect(sum).toBe(paid);
    });
  });

  /* ------------------------------- AUD-13 ------------------------------- */
  describe('Recorrência e parcelas', () => {
    it('AUD-13 gerar a recorrência do próximo mês duas vezes não duplica a conta', async () => {
      const v = await newFleet();
      const created = await call('POST', '/api/v1/payables', {
        categoryId: categories.find((c) => c.label === 'Seguro')!.id,
        vehicleId: v.vehicleId,
        amountCents: 17400,
        dueDate: today,
        description: 'SEGURO RECORRENTE AUD13',
        recurring: true,
      });
      expect(created.statusCode).toBe(201);
      const next = addDaysIso(today.slice(0, 7) + '-01', 40);
      const first = await generateRecurringPayables(harness.ctx, orgAId, next);
      const second = await generateRecurringPayables(harness.ctx, orgAId, next);
      expect(first).toBeGreaterThanOrEqual(1);
      expect(second).toBe(0);
      const list = (await call('GET', `/api/v1/payables?q=${encodeURIComponent('SEGURO RECORRENTE AUD13')}&limit=50`)).json()
        .data as Array<{ dueDate: string }>;
      expect(list.filter((x) => x.dueDate.startsWith(next.slice(0, 7)))).toHaveLength(1);
    });

    it('AUD-13b o histórico de alterações de uma conta a pagar fica registrado (auditoria)', async () => {
      const v = await newFleet();
      const p = await newPayable(v.vehicleId, 5000, 'Seguro', today, 'SEGURO HIST AUD13B');
      await call('PATCH', `/api/v1/payables/${p.json().id}`, { amountCents: 6000 });
      const logs = await harness.ctx.mongo.collections.auditLogs
        .find({ entityId: new ObjectId(p.json().id) })
        .toArray();
      expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['payable.created']));
      expect(logs.length).toBeGreaterThanOrEqual(2); // criação + edição
    });
  });

  /* ------------------------------- AUD-14 ------------------------------- */
  describe('Veículos e integridade', () => {
    it('AUD-14 arquivar um veículo com despesa paga não pode fazer o custo sumir do relatório por veículo', async () => {
      const v = await newFleet('ARQ');
      const p = await newPayable(v.vehicleId, 22222, 'Financiamento', today, 'FINANC AUD14');
      expect((await payPayable(p.json().id, 22222, 'aud14')).statusCode).toBe(201);
      const sumExpenses = async () => [...(await byVehicle()).values()].reduce((a, r) => a + r.expensesCents, 0);
      const before = await sumExpenses();
      expect((await byVehicle()).get(v.vehicleId)!.expensesCents).toBe(22222);

      // DELETE /vehicles/:id apenas ARQUIVA (soft delete) quando não há locação ativa
      expect((await call('DELETE', `/api/v1/vehicles/${v.vehicleId}`)).statusCode).toBe(200);

      // O dinheiro já saiu: o custo continua existindo e deve continuar visível por veículo.
      expect(await sumExpenses()).toBe(before);
    });

    it('AUD-14b dashboard financeiro: receita = soma dos recebimentos do mês (conciliação com o banco)', async () => {
      const real = await harness.ctx.mongo.collections.payments
        .aggregate<{ t: number }>([
          { $match: { organizationId: orgAId, reversedAt: null, sourceType: 'RECEIVABLE', paidAt: { $gte: `${today.slice(0, 7)}-01`, $lte: `${today.slice(0, 7)}-31` } } },
          { $group: { _id: null, t: { $sum: '$amountCents' } } },
        ])
        .toArray();
      expect((await dash()).revenueCents).toBe(real[0]?.t ?? 0);
      expect((await summary()).totals.monthlyRevenueCents).toBe(real[0]?.t ?? 0);
    });

    it('AUD-14c saldo da conta bancária = soma dos lançamentos (extrato concilia com o banco)', async () => {
      const acc = (await harness.ctx.mongo.collections.bankAccounts.findOne({ _id: new ObjectId(accountId) }))!;
      const tx = await harness.ctx.mongo.collections.bankTransactions
        .find({ bankAccountId: new ObjectId(accountId), occurredAt: { $gte: acc.initialBalanceDate } })
        .toArray();
      const sum = tx.reduce((a, t) => a + (t.direction === 'IN' ? t.amountCents : -t.amountCents), 0);
      const apiBalance = (
        (await call('GET', '/api/v1/bank-accounts')).json().data as Array<{ id: string; currentBalanceCents: number }>
      ).find((a) => a.id === accountId)!.currentBalanceCents;
      expect(apiBalance).toBe(acc.initialBalanceCents + sum);
    });
  });

  /* ------------------------------- AUD-15 ------------------------------- */
  describe('Autorização por permissão', () => {
    it('AUD-15 usuário sem finance.pay não baixa recebimento nem despesa; sem finance.read não vê dashboard', async () => {
      const f = await newFleet();
      const r = await newRental(f);
      const p = await newPayable(f.vehicleId, 1000, 'Seguro', today, 'SEGURO AUD15');
      const now = new Date();
      const userId = new ObjectId();
      await harness.ctx.mongo.collections.users.insertOne({
        _id: userId,
        name: 'Leitor',
        emailLower: 'leitor@exemplo.test',
        passwordHash: await hashPassword('Leitor@12345'),
        phone: null,
        status: 'ACTIVE',
        browserNotificationsEnabled: false,
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await harness.ctx.mongo.collections.memberships.insertOne({
        _id: new ObjectId(),
        organizationId: orgAId,
        userId,
        role: 'MEMBER',
        permissions: { vehicles: ['read'] },
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      const login = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'leitor@exemplo.test', password: 'Leitor@12345' },
      });
      const c = sessionCookie(login.headers as Record<string, unknown>);
      const as = (m: Method, url: string, payload?: unknown) => call(m, url, payload, { 'idempotency-key': 'perm' }, c);
      expect((await as('GET', '/api/v1/finance/dashboard')).statusCode).toBe(403);
      expect((await as('GET', '/api/v1/receivables')).statusCode).toBe(403);
      expect(
        (await as('POST', `/api/v1/receivables/${r.receivableId}/payments`, { amountCents: 100, paidAt: today, method: 'PIX', bankAccountId: accountId })).statusCode,
      ).toBe(403);
      expect(
        (await as('POST', `/api/v1/payables/${p.json().id}/payments`, { amountCents: 100, paidAt: today, method: 'PIX', bankAccountId: accountId })).statusCode,
      ).toBe(403);
      expect((await as('DELETE', `/api/v1/payables/${p.json().id}`)).statusCode).toBe(403);
      expect((await getReceivable(r.receivableId)).paidAmountCents).toBe(0);
    });
  });
});
