import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatCentsBRL } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';
import { extractPlainText, pageCount } from '../pdf/extract.js';

/**
 * T09/T15 — os números exibidos nas capturas de referência precisam ser
 * CALCULADOS a partir dos dados persistidos, nunca embutidos na resposta.
 * Este teste roda o seed e confere cada figura verificável.
 */
describe('figuras verificáveis das capturas de referência', () => {
  let harness: TestHarness;
  let cookie: string;

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness.ctx);
    const login = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    cookie = sessionCookie(login.headers as Record<string, unknown>);
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  });

  const get = (url: string) =>
    harness.app.inject({ method: 'GET', url, headers: { cookie } });

  it('Painel: 6 veículos, 6 motoristas ativos, 6 contratos ativos e receita de R$ 5.603,00', async () => {
    const res = await get('/api/v1/dashboard/summary');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totals.vehicles).toBe(6);
    expect(body.totals.activeDrivers).toBe(6);
    expect(body.totals.activeRentals).toBe(6);
    expect(body.totals.monthlyRevenueCents).toBe(560300);
    expect(formatCentsBRL(body.totals.monthlyRevenueCents).replace(/\u00a0/g, ' ')).toBe('R$ 5.603,00');
  });

  it('Painel: evolução da receita reproduz a curva Jun→Nov', async () => {
    const res = await get('/api/v1/dashboard/summary');
    const series = res.json().revenueSeries as Array<{ month: string; revenueCents: number }>;
    const byMonth = Object.fromEntries(series.map((s) => [s.month, s.revenueCents]));
    expect(byMonth['2026-06']).toBe(0);
    expect(byMonth['2026-07']).toBe(0);
    expect(byMonth['2026-08']).toBe(863700);
    expect(byMonth['2026-09']).toBe(1280000);
    expect(byMonth['2026-10']).toBe(1570300);
    expect(byMonth['2026-11']).toBe(560300);
  });

  it('Dashboard financeiro: 5.603,00 − 1.894,45 = 3.708,55 com margem de 66,2%', async () => {
    const res = await get('/api/v1/finance/dashboard?month=11&year=2026');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revenueCents).toBe(560300);
    expect(body.expensesCents).toBe(189445);
    expect(body.profitCents).toBe(370855);
    expect(body.marginPercent).toBeCloseTo(66.2, 1);
    expect(body.previous.revenueCents).toBe(1570300);
    expect(body.previous.expensesCents).toBe(953898);
    expect(body.previous.profitCents).toBe(616402);
  });

  it('Dashboard financeiro: rótulos do período seguem a referência', async () => {
    const res = await get('/api/v1/finance/dashboard?month=11&year=2026');
    const period = res.json().period;
    expect(period.label).toBe('Novembro 2026');
    // Subtítulo: "comparado com outubro"; rodapé dos cards: "em out".
    expect(period.comparisonLabel).toBe('outubro');
    expect(period.comparisonShortLabel).toBe('out');
  });

  it('Dashboard financeiro: despesas por categoria = Financiamento 1.720,45 + Seguro 174,00', async () => {
    const res = await get('/api/v1/finance/dashboard?month=11&year=2026');
    const categories = res.json().expensesByCategory as Array<{ label: string; amountCents: number }>;
    const map = Object.fromEntries(categories.map((c) => [c.label, c.amountCents]));
    expect(map.Financiamento).toBe(172045);
    expect(map.Seguro).toBe(17400);
    expect(categories.reduce((a, c) => a + c.amountCents, 0)).toBe(189445);
  });

  it('Extrato: 7.802,58 + 5.603,00 − 1.894,45 = 11.511,13', async () => {
    const accounts = await get('/api/v1/bank-accounts');
    const account = accounts.json().data[0];
    expect(account.name).toBe('Conta Principal');
    expect(account.currentBalanceCents).toBe(1151113);

    const res = await get(
      `/api/v1/bank-accounts/${account.id}/statement?from=2026-11-01&to=2026-11-30`,
    );
    const body = res.json();
    expect(body.openingBalanceCents).toBe(780258);
    expect(body.inflowCents).toBe(560300);
    expect(body.outflowCents).toBe(189445);
    expect(body.closingBalanceCents).toBe(1151113);
    expect(body.openingBalanceCents + body.inflowCents - body.outflowCents).toBe(
      body.closingBalanceCents,
    );
  });

  it('Extrato: saldo acumulado da primeira linha é R$ 8.452,58', async () => {
    const accounts = await get('/api/v1/bank-accounts');
    const account = accounts.json().data[0];
    const res = await get(
      `/api/v1/bank-accounts/${account.id}/statement?from=2026-11-01&to=2026-11-30`,
    );
    const rows = res.json().transactions as Array<{ runningBalanceCents: number; description: string }>;
    expect(rows[0]!.runningBalanceCents).toBe(845258);
    expect(rows[rows.length - 1]!.runningBalanceCents).toBe(1151113);
  });

  it('Contas a Receber: valor pendente total de R$ 33.540,00 em 6 contas', async () => {
    const res = await get('/api/v1/receivables?limit=50');
    const body = res.json();
    expect(body.totalPendingCents).toBe(3354000);
    expect(body.page.total).toBe(6);
    const sum = (body.data as Array<{ remainingCents: number }>).reduce(
      (a, r) => a + r.remainingCents,
      0,
    );
    expect(sum).toBe(3354000);
  });

  it('Relatório por cliente: pago + em aberto fecha com o total de cada contrato', async () => {
    const res = await get('/api/v1/reports/by-client');
    const rows = res.json().rows as Array<{ paidCents: number; openCents: number }>;
    expect(rows).toHaveLength(6);
    const open = rows.reduce((a, r) => a + r.openCents, 0);
    const paid = rows.reduce((a, r) => a + r.paidCents, 0);
    expect(open).toBe(3354000);
    expect(paid + open).toBe(1418000 + 1440000 + 1094000 + 1207800 + 1814000 + 1516900);
  });

  it('Relatório por veículo (novembro): receita por veículo bate com a referência', async () => {
    const res = await get('/api/v1/reports/by-vehicle?month=11&year=2026');
    const body = res.json();
    expect(body.revenueCents).toBe(560300);
    expect(body.expensesCents).toBe(189445);
    expect(body.profitCents).toBe(370855);
    const byPlate = Object.fromEntries(
      (body.rows as Array<{ plate: string; revenueCents: number; expensesCents: number }>).map((r) => [
        r.plate,
        r,
      ]),
    );
    expect(byPlate.EBR7G53.revenueCents).toBe(146000);
    expect(byPlate.RVA9F74.revenueCents).toBe(130000);
    expect(byPlate.GCQ0E23.revenueCents).toBe(100000);
    expect(byPlate.RNA8D85.revenueCents).toBe(80000);
    expect(byPlate.RVS9B58.revenueCents).toBe(65000);
    expect(byPlate.SEB9B67.revenueCents).toBe(39300);
    // O VOYAGE arquivado não entra no relatório (nem no total do painel).
    expect(byPlate.FQT3I57).toBeUndefined();
    expect(byPlate.RVS9B58.expensesCents).toBe(172045);
    expect(byPlate.RVA9F74.expensesCents).toBe(17400);
  });

  it('DRE de novembro/2026 reproduz a hierarquia e os valores da tela', async () => {
    const res = await get('/api/v1/reports/dre?month=11&year=2026');
    const body = res.json();
    expect(body.netRevenueCents).toBe(560300);
    expect(body.grossProfitCents).toBe(370855);
    expect(body.netResultCents).toBe(370855);
    const lines = Object.fromEntries(
      (body.lines as Array<{ key: string; amountCents: number }>).map((l) => [l.key, l.amountCents]),
    );
    expect(lines['gross-revenue']).toBe(560300);
    expect(lines.deductions).toBe(0);
    expect(lines['fleet-costs']).toBe(189445);
    expect(lines['before-tax']).toBe(370855);
    expect(lines.taxes).toBe(0);
    expect(body.footnote).toContain('DRE gerencial');
  });

  it('Manutenções do EBR7G53: 2 OS, R$ 831,20 no total e média R$ 415,60', async () => {
    const vehicles = await get('/api/v1/vehicles?limit=50');
    const vehicle = (vehicles.json().data as Array<{ id: string; plate: string }>).find(
      (v) => v.plate === 'EBR7G53',
    )!;
    const res = await get(`/api/v1/vehicles/${vehicle.id}/maintenance`);
    const summary = res.json().summary;
    expect(summary.orderCount).toBe(2);
    expect(summary.completedCount).toBe(2);
    expect(summary.openCount).toBe(0);
    expect(summary.canceledCount).toBe(0);
    expect(summary.laborCents).toBe(25000);
    expect(summary.partsCents).toBe(58120);
    expect(summary.totalCents).toBe(83120);
    expect(summary.averageCents).toBe(41560);
  });

  it('Cartões de manutenção reproduzem os totais por veículo da referência', async () => {
    const res = await get('/api/v1/maintenance/vehicles');
    const cards = res.json().data as Array<{
      vehicle: { plate: string };
      orderCount: number;
      totalCents: number;
      lastPerformedAt: string | null;
    }>;
    const byPlate = Object.fromEntries(cards.map((c) => [c.vehicle.plate, c]));
    expect(byPlate.EBR7G53.orderCount).toBe(2);
    expect(byPlate.EBR7G53.totalCents).toBe(83120);
    expect(byPlate.EBR7G53.lastPerformedAt).toBe('2026-10-12');
    expect(byPlate.GCQ0E23.orderCount).toBe(0);
    expect(byPlate.RNA8D85.orderCount).toBe(1);
    expect(byPlate.RNA8D85.totalCents).toBe(51690);
    expect(byPlate.RVA9F74.orderCount).toBe(0);
    expect(byPlate.RVS9B58.orderCount).toBe(4);
    expect(byPlate.RVS9B58.totalCents).toBe(189116);
    expect(byPlate.SEB9B67.orderCount).toBe(6);
    expect(byPlate.SEB9B67.totalCents).toBe(559571);
    expect(byPlate.SEB9B67.lastPerformedAt).toBe('2026-10-20');
  });

  it('PDF de manutenções do EBR7G53 sai com 2 páginas e os totais do golden master', async () => {
    const vehicles = await get('/api/v1/vehicles?limit=50');
    const vehicle = (vehicles.json().data as Array<{ id: string; plate: string }>).find(
      (v) => v.plate === 'EBR7G53',
    )!;
    const res = await get(`/api/v1/vehicles/${vehicle.id}/maintenance/report.pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');

    const pdf = res.rawPayload;
    expect(pageCount(pdf)).toBe(2);
    const text = extractPlainText(pdf).replace(/\u00a0/g, ' ');
    expect(text).toContain('RELATÓRIO DE MANUTENÇÕES');
    expect(text).toContain('EBR7G53 · VW GOL MPI');
    expect(text).toContain('R$ 250,00 R$ 581,20 R$ 831,20 R$ 415,60');
    expect(text).toContain('WO-2026-0013');
    expect(text).toContain('WO-2026-0006');
    expect(text).toContain('TROCA DE DISCO DE FREIO E PASTILHA');
    expect(text).toContain('TROCA DE ÓLEO E FILTRO DE ÓLEO');
    expect(text).toContain('MERCADO CAR');
    expect(text).toContain('Custos de ordens canceladas ficam fora dos totais.');
    expect(text).toContain('Documento para apresentação ao cliente.');
  }, 60_000);

  it('Alertas de CNH vencida são gerados para os motoristas com validade expirada', async () => {
    const res = await get('/api/v1/notifications?limit=50');
    const body = res.json();
    const cnh = (body.data as Array<{ type: string; title: string; severity: string }>).filter(
      (n) => n.type === 'CNH',
    );
    expect(cnh.length).toBeGreaterThanOrEqual(2);
    expect(cnh.every((n) => n.severity === 'CRITICAL' || n.severity === 'WARNING')).toBe(true);
    expect(body.unread).toBeGreaterThan(0);
  });

  it('Assinatura: plano trimestral 6 a 10 veículos com total de R$ 455,73 no ciclo', async () => {
    const res = await get('/api/v1/subscription');
    const body = res.json();
    expect(body.subscription.planLabel).toBe('6 a 10 veículos');
    expect(body.subscription.productLabel).toBe('Essencial');
    expect(body.subscription.cycleLabel).toBe('Trimestral');
    expect(body.subscription.monthlyPriceCents).toBe(15191);
    expect(body.subscription.cycleTotalCents).toBe(45573);
    expect(body.statement.totalCents).toBe(45573);
    // Sem provedor conectado, nenhum link de pagamento é exposto.
    expect(body.subscription.provider.connected).toBe(false);
    expect(body.invoices.every((i: { paymentUrl: string | null }) => i.paymentUrl === null)).toBe(true);
  });
});
