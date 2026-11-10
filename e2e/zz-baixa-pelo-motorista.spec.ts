import { expect, test, type Page } from '@playwright/test';

/**
 * Fluxo do operador (igual ao Frota One): Locações > Consultar > nome do motorista >
 * "Lançar pagamento" > página da locação (aba Pagamentos) > Adicionar Pagamento.
 * Roda depois dos demais (ordem alfabética) porque altera o banco em memória do demo.
 */
test.describe.configure({ mode: 'serial' });

const RENTAL = 'LOC-2026-004';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];

type View = {
  summary: { totalCents: number; paidCents: number; pendingCents: number; depositCents: number };
  entries: Array<{ id: string; receiptNumber: string; category: string; status: string; amountCents: number }>;
};

let rental: { id: string; driver: { id: string; fullName: string } };

const viewOf = async (page: Page) =>
  (await (await page.request.get(`/api/v1/rentals/${rental.id}/payments`)).json()) as View;
const revenue = async (page: Page) =>
  ((await (await page.request.get(`/api/v1/finance/dashboard?month=${month}&year=${year}`)).json()) as { revenueCents: number })
    .revenueCents;

async function openPaymentsTab(page: Page) {
  await page.goto(`/dashboard/rentals/${rental.id}?tab=payments`);
  await expect(page.getByRole('heading', { name: `Locação #${RENTAL}` })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lista de Pagamentos' })).toBeVisible();
}

async function fillForm(
  page: Page,
  v: { category?: string; cents: string; expected: string; paid?: string; notes?: string },
) {
  await page.getByRole('button', { name: /Adicionar Pagamento/ }).click();
  await expect(page.getByRole('heading', { name: 'Adicionar Pagamento' })).toBeVisible();
  if (v.category) await page.getByLabel(/Categoria/).selectOption({ label: v.category });
  await page.getByLabel(/^Valor/).fill(v.cents);
  await page.getByLabel(/Data Prevista/).fill(v.expected);
  if (v.paid) {
    await page.getByLabel('Já foi pago?').check();
    await page.getByLabel(/Data do Pagamento/).fill(v.paid);
  }
  if (v.notes) await page.getByLabel(/Observação/).fill(v.notes);
}

test.beforeAll(async ({ request }) => {
  const res = await request.get(`/api/v1/rentals?q=${RENTAL}`);
  rental = (await res.json()).data.find((r: { rentalNumber: string }) => r.rentalNumber === RENTAL);
});

test('lista de locações > nome do motorista > Lançar pagamento abre a página da locação (aba Pagamentos)', async ({ page }) => {
  await page.goto('/dashboard/rentals');
  const row = page.locator('tbody tr', { hasText: RENTAL });
  await row.getByRole('link', { name: rental.driver.fullName }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/drivers/${rental.driver.id}$`));

  await page.getByRole('button', { name: 'Lançar pagamento' }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/rentals/${rental.id}\\?tab=payments$`));
  await expect(page.getByRole('heading', { name: `Locação #${RENTAL}` })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Pagamentos' })).toHaveAttribute('aria-selected', 'true');

  for (const text of ['Valor Total', 'Valor Pago', 'Valor Pendente', 'Caução', 'Valor total da locação (sem caução)', 'Valor separado']) {
    await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /Adicionar Pagamento/ })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Nº Recibo' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Dt. Prevista' })).toBeVisible();
});

test('os recebimentos que já existiam aparecem na lista com recibo INV', async ({ page }) => {
  await openPaymentsTab(page);
  const v = await viewOf(page);
  expect(v.entries.length).toBeGreaterThan(0);
  // (no seed de demonstração há pagamentos históricos extras só para o gráfico de receita; a conciliação
  //  lista × cartão é verificada na API sobre uma locação consistente: rental-payments.test.ts)
  expect(v.entries.every((e) => /^INV-\d{4}-\d{3,}$/.test(e.receiptNumber))).toBe(true);
  await expect(page.getByRole('cell', { name: /^INV-\d{4}-\d{3}$/ }).first()).toBeVisible();
});

test('formulário: as datas começam vazias e "Já foi pago?" revela Data do Pagamento e Forma', async ({ page }) => {
  await openPaymentsTab(page);
  await page.getByRole('button', { name: /Adicionar Pagamento/ }).click();
  await expect(page.getByLabel(/Data Prevista/)).toHaveValue('');
  await expect(page.getByLabel(/Data do Pagamento/)).toHaveCount(0);
  await page.getByLabel('Já foi pago?').check();
  await expect(page.getByLabel(/Data do Pagamento/)).toHaveValue('');
  await expect(page.getByLabel(/Forma de Pagamento/)).toBeVisible();
  await expect(page.getByLabel(/Categoria/).locator('option')).toHaveText(['Pagamento da Locação', 'KM Excedente']);
});

test('Salvar vazio não grava nada e mostra o que falta', async ({ page }) => {
  await openPaymentsTab(page);
  const before = await viewOf(page);
  await page.getByRole('button', { name: /Adicionar Pagamento/ }).click();
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Informe um valor maior que zero')).toBeVisible();
  await expect(page.getByText('Informe a data prevista')).toBeVisible();
  expect((await viewOf(page)).entries).toHaveLength(before.entries.length);
});

test('KM Excedente já pago (R$ 50): soma ao total e ao pago, pendente igual, receita +R$ 50', async ({ page }) => {
  await openPaymentsTab(page);
  const before = await viewOf(page);
  const revBefore = await revenue(page);

  await fillForm(page, { category: 'KM Excedente', cents: '5000', expected: today, paid: today, notes: 'KM extra' });
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Pagamento adicionado')).toBeVisible();

  const after = await viewOf(page);
  expect(after.summary.totalCents).toBe(before.summary.totalCents + 5000);
  expect(after.summary.paidCents).toBe(before.summary.paidCents + 5000);
  expect(after.summary.pendingCents).toBe(before.summary.pendingCents);
  expect(await revenue(page)).toBe(revBefore + 5000);

  const row = page.locator('tbody tr', { hasText: `KM Excedente - Contrato ${RENTAL}` }).first();
  await expect(row).toContainText('Pago');
  await expect(row).toContainText(/INV-\d{4}-\d{3}/);
  await expect(row).toContainText('R$ 50,00');
});

test('pagamento da locação PENDENTE: aparece na lista sem mexer nos cartões nem no dashboard', async ({ page }) => {
  await openPaymentsTab(page);
  const before = await viewOf(page);
  const revBefore = await revenue(page);

  await fillForm(page, { cents: '10000', expected: today });
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Pagamento adicionado')).toBeVisible();

  const after = await viewOf(page);
  expect(after.summary).toEqual(before.summary);
  expect(await revenue(page)).toBe(revBefore);
  expect(after.entries.filter((e) => e.status !== 'PAID')).toHaveLength(1);
});

test('⋮ > Marcar como pago: pede a data do pagamento, atualiza os cartões e o dashboard', async ({ page }) => {
  await openPaymentsTab(page);
  const before = await viewOf(page);
  const revBefore = await revenue(page);
  const pending = before.entries.find((e) => e.status !== 'PAID' && e.category === 'RENT')!;

  await page.getByRole('button', { name: `Ações do pagamento ${pending.receiptNumber}` }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Marcar como pago', 'Editar', 'Excluir']);
  await page.getByRole('menuitem', { name: 'Marcar como pago' }).click();
  await expect(page.getByRole('heading', { name: 'Marcar como pago' })).toBeVisible();
  await expect(page.getByLabel(/Data do Pagamento/)).toHaveValue('');
  await page.getByLabel(/Data do Pagamento/).fill(today);
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Pagamento registrado como pago')).toBeVisible();

  const after = await viewOf(page);
  expect(after.summary.paidCents).toBe(before.summary.paidCents + pending.amountCents);
  expect(after.summary.pendingCents).toBe(before.summary.pendingCents - pending.amountCents);
  expect(await revenue(page)).toBe(revBefore + pending.amountCents);
  await expect(page.locator('tbody tr', { hasText: pending.receiptNumber })).toContainText('Pago');
});

test('clique duplo em Salvar registra um único pagamento', async ({ page }) => {
  await openPaymentsTab(page);
  const before = await viewOf(page);
  await fillForm(page, { category: 'KM Excedente', cents: '2000', expected: today, paid: today });
  await page.getByRole('button', { name: 'Salvar' }).dblclick();
  await expect(page.getByText('Pagamento adicionado').first()).toBeVisible();
  const after = await viewOf(page);
  expect(after.entries).toHaveLength(before.entries.length + 1);
  expect(after.summary.paidCents).toBe(before.summary.paidCents + 2000);
});

test('busca filtra a lista por categoria', async ({ page }) => {
  await openPaymentsTab(page);
  await page.getByPlaceholder(/Filtrar por recibo/).fill('KM Excedente');
  // a busca tem debounce: espera o filtro aplicar (nenhuma linha sem "KM Excedente" e ao menos uma com)
  await expect(page.locator('tbody tr', { hasNotText: 'KM Excedente' })).toHaveCount(0);
  await expect(page.locator('tbody tr', { hasText: 'KM Excedente' }).first()).toBeVisible();
  await page.getByPlaceholder(/Filtrar por recibo/).fill('nada-disso');
  await expect(page.getByText('Nenhum pagamento registrado')).toBeVisible();
});

test('Excluir um pagamento PAGO o estorna: cartões e dashboard voltam, o histórico fica', async ({ page }) => {
  await openPaymentsTab(page);
  const before = await viewOf(page);
  const revBefore = await revenue(page);
  const paid = before.entries.find((e) => e.status === 'PAID' && e.category === 'EXTRA_KM' && e.amountCents === 2000)!;

  await page.getByRole('button', { name: `Ações do pagamento ${paid.receiptNumber}` }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Excluir']);
  await page.getByRole('menuitem', { name: 'Excluir' }).click();
  await expect(page.getByText(/será estornado|é estornado|estornado/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Excluir', exact: true }).last().click();
  await expect(page.getByText('Pagamento estornado')).toBeVisible();

  const after = await viewOf(page);
  expect(after.entries.find((e) => e.id === paid.id)).toBeUndefined();
  expect(after.summary.paidCents).toBe(before.summary.paidCents - 2000);
  expect(after.summary.totalCents).toBe(before.summary.totalCents - 2000);
  expect(await revenue(page)).toBe(revBefore - 2000);
});

test('Excluir um pagamento PENDENTE o remove sem mexer em valores', async ({ page }) => {
  await openPaymentsTab(page);
  await fillForm(page, { cents: '3000', expected: today });
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Pagamento adicionado').first()).toBeVisible();
  const before = await viewOf(page);
  const pending = before.entries.find((e) => e.status !== 'PAID' && e.amountCents === 3000)!;
  const revBefore = await revenue(page);

  await page.getByRole('button', { name: `Ações do pagamento ${pending.receiptNumber}` }).click();
  await page.getByRole('menuitem', { name: 'Excluir' }).click();
  await page.getByRole('button', { name: 'Excluir', exact: true }).last().click();
  await expect(page.getByText('Pagamento excluído')).toBeVisible();

  const after = await viewOf(page);
  expect(after.entries.find((e) => e.id === pending.id)).toBeUndefined();
  expect(after.summary).toEqual(before.summary);
  expect(await revenue(page)).toBe(revBefore);
});
