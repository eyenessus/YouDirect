import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { addDaysIso, businessDate, fullMatrix, type RentalPaymentsView } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { hashPassword } from '../common/helpers.js';
import { backfillRentalPaymentEntries } from '../services/rental-payments.js';

/**
 * Aba "Pagamentos" da locação (fluxo do Frota One): lançamentos com recibo INV, categorias
 * "Pagamento da Locação" e "KM Excedente", "Já foi pago?", Marcar como pago, Editar e Excluir.
 * O dinheiro (extrato, receita, dashboards) é validado por deltas, nunca por valores fixos.
 */
describe('pagamentos da locação (página da locação)', () => {
  let harness: TestHarness;
  let cookie: string;
  let orgId: ObjectId;
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

  const revenue = async () =>
    (await call('GET', `/api/v1/finance/dashboard?month=${month}&year=${year}`)).json().revenueCents as number;
  const view = async (rentalId: string, q = '') =>
    (await call('GET', `/api/v1/rentals/${rentalId}/payments${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json() as RentalPaymentsView;

  let seq = 0;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const newRental = async (extra: Record<string, unknown> = {}) => {
    seq += 1;
    const vehicle = await call('POST', '/api/v1/vehicles', {
      plate: `E${letters[seq % 26]}${letters[Math.floor(seq / 26) % 26]}3D45`,
      brand: 'VW',
      model: `PAG${seq}`,
      mileageKm: 1,
    });
    const driver = await call('POST', '/api/v1/drivers', { fullName: `Pagamentos ${seq}`, phone: `1177700${1000 + seq}` });
    const rental = await call('POST', '/api/v1/rentals', {
      vehicleId: vehicle.json().id,
      driverId: driver.json().id,
      rentalType: 'WEEKLY',
      periodicAmountCents: 80000,
      depositCents: 150000,
      startDate: addDaysIso(today, -3),
      endDate: addDaysIso(today, 25), // 4 períodos => R$ 3.200
      ...extra,
    });
    expect(rental.statusCode).toBe(201);
    return { rentalId: rental.json().id as string, vehicleId: vehicle.json().id as string };
  };

  type Create = {
    category?: 'RENT' | 'EXTRA_KM';
    amountCents?: number;
    expectedDate?: string;
    alreadyPaid?: boolean;
    paidAt?: string;
    method?: string;
    notes?: string;
  };
  const add = (rentalId: string, body: Create, key: string | null = null) =>
    call(
      'POST',
      `/api/v1/rentals/${rentalId}/payments`,
      { category: 'RENT', amountCents: 80000, expectedDate: today, ...body },
      key ? { 'idempotency-key': key } : {}
    );
  const paymentDocs = (rentalId: string) =>
    harness.ctx.mongo.collections.rentalPayments.find({ rentalId: new ObjectId(rentalId) }).toArray();

  const createOrgB = async () => {
    const now = new Date();
    const organizationId = new ObjectId();
    await harness.ctx.mongo.collections.organizations.insertOne({
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
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: 'Dono B',
      emailLower: 'dono-b-pag@exemplo.test',
      passwordHash: await hashPassword('DonoB@12345'),
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
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'dono-b-pag@exemplo.test', password: 'DonoB@12345' },
    });
    return sessionCookie(login.headers as Record<string, unknown>);
  };

  const memberCookie = async (email: string, permissions: Record<string, string[]>) => {
    const now = new Date();
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: email,
      emailLower: email,
      passwordHash: await hashPassword('Membro@12345'),
      phone: null,
      status: 'ACTIVE',
      browserNotificationsEnabled: false,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await harness.ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(),
      organizationId: orgId,
      userId,
      role: 'MEMBER',
      permissions: permissions as never,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'Membro@12345' },
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
    orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  /* ------------------------------ cartões e lista ------------------------------ */
  it('locação sem pagamentos: cartões com o total do contrato (sem caução), lista vazia', async () => {
    const { rentalId } = await newRental();
    const v = await view(rentalId);
    expect(v.summary).toEqual({ totalCents: 320000, paidCents: 0, pendingCents: 320000, depositCents: 150000 });
    expect(v.entries).toEqual([]);
    expect(v.rentalStatus).toBe('ACTIVE');
  });

  it('os recebimentos que já existiam (seed) aparecem na lista com recibo INV e batem com o cartão "Valor Pago"', async () => {
    const rentals = (await call('GET', '/api/v1/rentals?q=LOC-2026-001')).json().data as Array<{ id: string }>;
    const v = await view(rentals[0]!.id);
    expect(v.entries.length).toBeGreaterThan(0);
    expect(v.entries.every((e) => /^INV-\d{4}-\d{3,}$/.test(e.receiptNumber))).toBe(true);
    expect(v.entries.every((e) => e.status === 'PAID' && e.paidAt)).toBe(true);
    expect(v.entries.reduce((a, e) => a + e.amountCents, 0)).toBe(v.summary.paidCents);
  });

  it('o backfill é idempotente (rodar de novo não cria nada)', async () => {
    const again = await backfillRentalPaymentEntries(harness.ctx);
    expect(again.created).toBe(0);
  });

  /* ------------------------------ Pagamento da Locação ------------------------------ */
  it('pagamento da locação JÁ PAGO: recibo, cartões, extrato e dashboard +R$ 800 uma única vez', async () => {
    const { rentalId } = await newRental();
    const before = await revenue();
    const expected = addDaysIso(today, -2);
    const paid = addDaysIso(today, -1);
    const res = await add(rentalId, { amountCents: 80000, expectedDate: expected, alreadyPaid: true, paidAt: paid, method: 'PIX', notes: 'semana 1' });
    expect(res.statusCode).toBe(201);
    const v = res.json() as RentalPaymentsView;
    expect(v.entries).toHaveLength(1);
    expect(v.entries[0]).toMatchObject({
      category: 'RENT',
      description: expect.stringContaining('Pagamento da Locação - Contrato LOC-'),
      amountCents: 80000,
      expectedDate: expected,
      paidAt: paid,
      method: 'PIX',
      status: 'PAID',
      notes: 'semana 1',
    });
    expect(v.entries[0]!.receiptNumber).toMatch(/^INV-\d{4}-\d{3,}$/);
    expect(v.summary).toMatchObject({ totalCents: 320000, paidCents: 80000, pendingCents: 240000 });
    expect(await revenue()).toBe(before + 80000);
    // o dinheiro foi para o extrato pelo fluxo oficial
    const docs = await paymentDocs(rentalId);
    expect(docs[0]!.paymentId).toBeTruthy();
    expect(await harness.ctx.mongo.collections.payments.countDocuments({ sourceId: docs[0]!.receivableId! })).toBe(1);
  });

  it('as DUAS datas informadas pelo dono são gravadas exatamente como digitadas (previsão em 09/11, pagamento em 10/11)', async () => {
    const { rentalId } = await newRental({ startDate: '2026-11-02', endDate: '2026-11-30' });
    const res = await add(rentalId, { expectedDate: '2026-11-09', alreadyPaid: true, paidAt: '2026-11-10' });
    expect(res.statusCode).toBe(201);
    expect(res.json().entries[0]).toMatchObject({ expectedDate: '2026-11-09', paidAt: '2026-11-10' });
    const [doc] = await paymentDocs(rentalId);
    expect(doc).toMatchObject({ expectedDate: '2026-11-09', paidAt: '2026-11-10' });
  });

  it('pagamento da locação PENDENTE é só previsão: não muda cartões, extrato nem dashboard', async () => {
    const { rentalId } = await newRental();
    const before = await revenue();
    const res = await add(rentalId, { expectedDate: addDaysIso(today, 4) });
    expect(res.statusCode).toBe(201);
    const v = res.json() as RentalPaymentsView;
    expect(v.entries[0]).toMatchObject({ status: 'PENDING', paidAt: null, method: null });
    expect(v.summary).toMatchObject({ totalCents: 320000, paidCents: 0, pendingCents: 320000 });
    expect(await revenue()).toBe(before);
    expect((await paymentDocs(rentalId))[0]!.paymentId).toBeNull();
  });

  it('pendente com data prevista vencida aparece como Atrasado', async () => {
    const { rentalId } = await newRental();
    const v = (await add(rentalId, { expectedDate: addDaysIso(today, -2) })).json() as RentalPaymentsView;
    expect(v.entries[0]!.status).toBe('OVERDUE');
  });

  it('Marcar como pago: converte o pendente, move o dashboard e repetir não duplica', async () => {
    const { rentalId } = await newRental();
    const created = (await add(rentalId, { expectedDate: addDaysIso(today, 1) })).json() as RentalPaymentsView;
    const entryId = created.entries[0]!.id;
    const before = await revenue();

    const pay = () => call('POST', `/api/v1/rentals/${rentalId}/payments/${entryId}/pay`, { paidAt: today, method: 'BOLETO' });
    const first = await pay();
    expect(first.statusCode).toBe(200);
    expect(first.json().entries[0]).toMatchObject({ status: 'PAID', paidAt: today, method: 'BOLETO' });
    expect(first.json().summary).toMatchObject({ paidCents: 80000, pendingCents: 240000 });
    expect(await revenue()).toBe(before + 80000);

    expect((await pay()).statusCode).toBe(200);
    expect(await revenue()).toBe(before + 80000);
    expect(await harness.ctx.mongo.collections.payments.countDocuments({ sourceId: (await paymentDocs(rentalId))[0]!.receivableId! })).toBe(1);
  });

  it('Marcar como pago com data futura é recusado e o lançamento continua pendente', async () => {
    const { rentalId } = await newRental();
    const entryId = ((await add(rentalId, {})).json() as RentalPaymentsView).entries[0]!.id;
    const res = await call('POST', `/api/v1/rentals/${rentalId}/payments/${entryId}/pay`, { paidAt: addDaysIso(today, 5), method: 'PIX' });
    expect(res.statusCode).toBe(422);
    expect((await view(rentalId)).entries[0]!.status).not.toBe('PAID');
  });

  it('pagamento da locação acima do saldo do contrato é recusado e nenhum lançamento é criado', async () => {
    const { rentalId } = await newRental();
    const res = await add(rentalId, { amountCents: 320001, alreadyPaid: true, paidAt: today });
    expect(res.statusCode).toBe(422);
    expect((await view(rentalId)).entries).toHaveLength(0);
  });

  /* ------------------------------ KM Excedente ------------------------------ */
  it('KM excedente JÁ PAGO R$ 50: soma ao Valor Total e ao Pago, pendente igual (como no vídeo)', async () => {
    const { rentalId, vehicleId } = await newRental();
    const before = await revenue();
    const res = await add(rentalId, { category: 'EXTRA_KM', amountCents: 5000, expectedDate: today, alreadyPaid: true, paidAt: today, method: 'PIX' });
    expect(res.statusCode).toBe(201);
    const v = res.json() as RentalPaymentsView;
    expect(v.summary).toMatchObject({ totalCents: 325000, paidCents: 5000, pendingCents: 320000, depositCents: 150000 });
    expect(v.entries[0]).toMatchObject({ category: 'EXTRA_KM', status: 'PAID' });
    expect(v.entries[0]!.description).toContain('KM Excedente - Contrato LOC-');
    expect(await revenue()).toBe(before + 5000);
    // a receita do KM excedente pertence ao veículo da locação
    const byVehicle = (await call('GET', `/api/v1/reports/by-vehicle?month=${month}&year=${year}`)).json();
    const rows = Object.values(byVehicle).find((x) => Array.isArray(x) && (x[0] as { vehicleId?: string })?.vehicleId) as Array<{
      vehicleId: string;
      revenueCents: number;
    }>;
    expect(rows.find((r) => r.vehicleId === vehicleId)!.revenueCents).toBe(5000);
  });

  it('KM excedente PENDENTE: entra no total e no pendente, mas não na receita; Marcar como pago a realiza', async () => {
    const { rentalId } = await newRental();
    const before = await revenue();
    const v = (await add(rentalId, { category: 'EXTRA_KM', amountCents: 5000, expectedDate: addDaysIso(today, 3) })).json() as RentalPaymentsView;
    expect(v.summary).toMatchObject({ totalCents: 325000, paidCents: 0, pendingCents: 325000 });
    expect(await revenue()).toBe(before);

    const paid = await call('POST', `/api/v1/rentals/${rentalId}/payments/${v.entries[0]!.id}/pay`, { paidAt: today, method: 'PIX' });
    expect(paid.json().summary).toMatchObject({ totalCents: 325000, paidCents: 5000, pendingCents: 320000 });
    expect(await revenue()).toBe(before + 5000);
  });

  /* ------------------------------ Editar ------------------------------ */
  it('Editar pendente: valor, data prevista e observação; KM excedente atualiza o total', async () => {
    const { rentalId } = await newRental();
    const km = ((await add(rentalId, { category: 'EXTRA_KM', amountCents: 5000, expectedDate: addDaysIso(today, 2) })).json() as RentalPaymentsView).entries[0]!;
    const res = await call('PATCH', `/api/v1/rentals/${rentalId}/payments/${km.id}`, {
      amountCents: 7500,
      expectedDate: addDaysIso(today, 6),
      notes: 'corrigido',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries[0]).toMatchObject({ amountCents: 7500, expectedDate: addDaysIso(today, 6), notes: 'corrigido' });
    expect(res.json().summary.totalCents).toBe(327500);
  });

  it('não permite editar pagamento já pago (use Excluir/estornar)', async () => {
    const { rentalId } = await newRental();
    const entry = ((await add(rentalId, { alreadyPaid: true, paidAt: today })).json() as RentalPaymentsView).entries[0]!;
    const res = await call('PATCH', `/api/v1/rentals/${rentalId}/payments/${entry.id}`, { amountCents: 1000 });
    expect(res.statusCode).toBe(409);
  });

  /* ------------------------------ Excluir ------------------------------ */
  it('Excluir pendente: some da lista, totais e dashboard intactos', async () => {
    const { rentalId } = await newRental();
    const before = await revenue();
    const entry = ((await add(rentalId, {})).json() as RentalPaymentsView).entries[0]!;
    const res = await call('DELETE', `/api/v1/rentals/${rentalId}/payments/${entry.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(0);
    expect(res.json().summary.pendingCents).toBe(320000);
    expect(await revenue()).toBe(before);
  });

  it('Excluir PAGO estorna: receita −R$ 800, cartões voltam, histórico preservado, repetir não duplica', async () => {
    const { rentalId } = await newRental();
    const before = await revenue();
    const entry = ((await add(rentalId, { alreadyPaid: true, paidAt: today })).json() as RentalPaymentsView).entries[0]!;
    expect(await revenue()).toBe(before + 80000);

    const del = () => call('DELETE', `/api/v1/rentals/${rentalId}/payments/${entry.id}`);
    const res = await del();
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toHaveLength(0);
    expect(res.json().summary).toMatchObject({ paidCents: 0, pendingCents: 320000 });
    expect(await revenue()).toBe(before);

    // histórico: o lançamento e o pagamento original continuam no banco, marcados
    const [doc] = await paymentDocs(rentalId);
    expect(doc!.deletedAt).toBeTruthy();
    const original = await harness.ctx.mongo.collections.payments.findOne({ _id: doc!.paymentId! });
    expect(original!.reversedAt).toBeTruthy();
    expect(await harness.ctx.mongo.collections.auditLogs.countDocuments({ action: 'rental.payment.reversed', entityId: new ObjectId(rentalId) })).toBe(1);

    expect((await del()).statusCode).toBe(200);
    expect(await revenue()).toBe(before);
  });

  it('Excluir KM excedente pago devolve o total ao valor do contrato', async () => {
    const { rentalId } = await newRental();
    const entry = ((await add(rentalId, { category: 'EXTRA_KM', amountCents: 5000, alreadyPaid: true, paidAt: today })).json() as RentalPaymentsView).entries[0]!;
    const res = await call('DELETE', `/api/v1/rentals/${rentalId}/payments/${entry.id}`);
    expect(res.json().summary).toMatchObject({ totalCents: 320000, paidCents: 0, pendingCents: 320000 });
  });

  /* ------------------------------ recibo, busca, idempotência ------------------------------ */
  it('recibos são sequenciais e únicos (INV-AAAA-NNN)', async () => {
    const { rentalId } = await newRental();
    await add(rentalId, {});
    await add(rentalId, {});
    const numbers = (await view(rentalId)).entries.map((e) => e.receiptNumber);
    expect(new Set(numbers).size).toBe(2);
    const seqs = numbers.map((n) => Number(n.split('-')[2])).sort((a, b) => a - b);
    expect(seqs[1]! - seqs[0]!).toBe(1);
  });

  it('busca filtra por recibo, categoria, situação e valor', async () => {
    const { rentalId } = await newRental();
    await add(rentalId, { alreadyPaid: true, paidAt: today, amountCents: 12345 });
    await add(rentalId, { category: 'EXTRA_KM', amountCents: 5000, expectedDate: addDaysIso(today, 9) });
    const all = await view(rentalId);
    expect(all.entries).toHaveLength(2);
    expect((await view(rentalId, 'KM Excedente')).entries).toHaveLength(1);
    expect((await view(rentalId, 'pago')).entries.map((e) => e.status)).toEqual(['PAID']);
    expect((await view(rentalId, 'pendente')).entries).toHaveLength(1);
    expect((await view(rentalId, '123,45')).entries).toHaveLength(1);
    expect((await view(rentalId, all.entries[0]!.receiptNumber)).entries).toHaveLength(1);
    expect((await view(rentalId, 'nada-disso')).entries).toHaveLength(0);
  });

  it('mesma chave de idempotência (inclusive 5 cliques simultâneos) gera um único lançamento e um único recebimento', async () => {
    const { rentalId } = await newRental();
    const before = await revenue();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => add(rentalId, { alreadyPaid: true, paidAt: today }, 'rp-clique'))
    );
    expect(results.every((r) => [200, 201, 409].includes(r.statusCode))).toBe(true);
    expect((await paymentDocs(rentalId)).filter((d) => !d.deletedAt)).toHaveLength(1);
    expect(await revenue()).toBe(before + 80000);
    expect((await view(rentalId)).summary.paidCents).toBe(80000);
  });

  /* ------------------------------ validações, regras e segurança ------------------------------ */
  it('entradas inválidas → 4xx, nada gravado: valor 0/negativo/decimal, datas inválidas, pago sem data, categoria inválida', async () => {
    const { rentalId } = await newRental();
    const bads: Create[] = [
      { amountCents: 0 },
      { amountCents: -100 },
      { amountCents: 10.5 },
      { expectedDate: '2026-02-30' },
      { expectedDate: '09/11/2026' },
      { expectedDate: '' },
      { alreadyPaid: true },
      { alreadyPaid: true, paidAt: '2026-02-30' },
      { category: 'OUTRA' as never },
    ];
    for (const bad of bads) {
      const res = await add(rentalId, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, JSON.stringify(bad)).toBeLessThan(500);
    }
    expect((await paymentDocs(rentalId)).length).toBe(0);
  });

  it('pago com data futura é recusado e não cria lançamento', async () => {
    const { rentalId } = await newRental();
    const res = await add(rentalId, { alreadyPaid: true, paidAt: addDaysIso(today, 3) });
    expect(res.statusCode).toBe(422);
    expect((await view(rentalId)).entries).toHaveLength(0);
  });

  it('locação encerrada não aceita novos pagamentos', async () => {
    const { rentalId } = await newRental();
    expect((await call('POST', `/api/v1/rentals/${rentalId}/close`, { endDate: today })).statusCode).toBe(200);
    expect((await add(rentalId, {})).statusCode).toBe(409);
  });

  it('isolamento: a empresa B não vê nem altera pagamentos da empresa A', async () => {
    const { rentalId } = await newRental();
    const entry = ((await add(rentalId, {})).json() as RentalPaymentsView).entries[0]!;
    const b = await createOrgB();
    const asB = (m: Method, url: string, p?: unknown) => call(m, url, p, {}, b);
    expect((await asB('GET', `/api/v1/rentals/${rentalId}/payments`)).statusCode).toBe(404);
    expect((await asB('POST', `/api/v1/rentals/${rentalId}/payments`, { category: 'RENT', amountCents: 100, expectedDate: today })).statusCode).toBe(404);
    expect((await asB('PATCH', `/api/v1/rentals/${rentalId}/payments/${entry.id}`, { amountCents: 1 })).statusCode).toBe(404);
    expect((await asB('POST', `/api/v1/rentals/${rentalId}/payments/${entry.id}/pay`, { paidAt: today, method: 'PIX' })).statusCode).toBe(404);
    expect((await asB('DELETE', `/api/v1/rentals/${rentalId}/payments/${entry.id}`)).statusCode).toBe(404);
    expect((await view(rentalId)).entries).toHaveLength(1);
  });

  it('permissões: ler exige finance.read; criar/pagar/editar exige finance.pay; excluir exige finance.delete', async () => {
    const { rentalId } = await newRental();
    const entry = ((await add(rentalId, {})).json() as RentalPaymentsView).entries[0]!;
    const semFinanceiro = await memberCookie('sem-fin@exemplo.test', { vehicles: ['read'] });
    const soLeitura = await memberCookie('leitura-pag@exemplo.test', { finance: ['read'] });
    const pagador = await memberCookie('pagador@exemplo.test', { finance: ['read', 'pay'] });
    const as = (c: string, m: Method, url: string, p?: unknown) => call(m, url, p, {}, c);
    const base = `/api/v1/rentals/${rentalId}/payments`;

    expect((await as(semFinanceiro, 'GET', base)).statusCode).toBe(403);
    expect((await as(soLeitura, 'GET', base)).statusCode).toBe(200);
    expect((await as(soLeitura, 'POST', base, { category: 'RENT', amountCents: 100, expectedDate: today })).statusCode).toBe(403);
    expect((await as(soLeitura, 'POST', `${base}/${entry.id}/pay`, { paidAt: today, method: 'PIX' })).statusCode).toBe(403);
    expect((await as(pagador, 'PATCH', `${base}/${entry.id}`, { notes: 'ok' })).statusCode).toBe(200);
    expect((await as(pagador, 'DELETE', `${base}/${entry.id}`)).statusCode).toBe(403);
    expect((await view(rentalId)).entries).toHaveLength(1);
  });

  it('o extrato bancário concilia: pago entra, estorno sai, pendente não aparece', async () => {
    const { rentalId } = await newRental();
    const acc = (await call('GET', '/api/v1/bank-accounts')).json();
    const accountId = ((acc.data ?? acc) as Array<{ id: string; isDefault: boolean }>).find((a) => a.isDefault)!.id;
    const balance = async () =>
      (((await call('GET', '/api/v1/bank-accounts')).json().data as Array<{ id: string; currentBalanceCents: number }>).find((a) => a.id === accountId)!)
        .currentBalanceCents;
    const start = await balance();
    await add(rentalId, {}); // pendente: não mexe
    expect(await balance()).toBe(start);
    const paid = ((await add(rentalId, { alreadyPaid: true, paidAt: today })).json() as RentalPaymentsView).entries.find((e) => e.status === 'PAID')!;
    expect(await balance()).toBe(start + 80000);
    await call('DELETE', `/api/v1/rentals/${rentalId}/payments/${paid.id}`);
    expect(await balance()).toBe(start);
  });
});
