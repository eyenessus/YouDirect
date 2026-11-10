import { expect, test, type Page } from '@playwright/test';

/**
 * AUDITORIA — baixa de pagamentos e parcelamento pelo NAVEGADOR real (UI → API → banco).
 *
 * O prefixo `zz-` é proposital: o Playwright roda os arquivos em ordem alfabética e estes
 * testes ALTERAM o banco em memória do demo (recebimentos, contas a pagar). Rodando por último,
 * não interferem nos números de referência do yudirect.spec.ts.
 */
test.describe.configure({ mode: 'serial' });

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const [year, month] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];

const finance = async (page: Page) =>
  (await (await page.request.get(`/api/v1/finance/dashboard?month=${month}&year=${year}`)).json()) as {
    revenueCents: number;
    expensesCents: number;
  };

async function rentalByNumber(page: Page, number: string) {
  const res = await page.request.get(`/api/v1/rentals?q=${number}`);
  return (await res.json()).data[0] as { id: string };
}
const scheduleOf = async (page: Page, rentalId: string) =>
  (await (await page.request.get(`/api/v1/rentals/${rentalId}/payment-schedule`)).json()) as {
    receivableId: string;
    weeks: Array<{ number: number; remainingCents: number; status: string }>;
    totals: { paidCents: number; remainingCents: number };
  };

async function openPaymentDialog(page: Page, rentalNumber: string) {
  await page.goto('/dashboard/rentals');
  await page.getByRole('button', { name: `Ações da locação ${rentalNumber}` }).click();
  await page.getByRole('menuitem', { name: 'Lançar pagamento' }).click();
  const table = page.getByRole('table', { name: new RegExp(`Cronograma de Locação ${rentalNumber}`) });
  await expect(table).toBeVisible();
  return table;
}

test.describe('baixa semanal pela interface', () => {
  test('Locações > ⋮ > Lançar pagamento mostra as semanas do contrato', async ({ page }) => {
    const table = await openPaymentDialog(page, 'LOC-2026-007');
    const rows = table.locator('tbody tr');
    expect(await rows.count()).toBeGreaterThan(3);
    await expect(rows.first()).toContainText('Paga');
    await expect(page.getByRole('button', { name: /Dar baixa na semana/ }).first()).toBeVisible();
  });

  test('Dar baixa em uma semana: persiste, atualiza o cronograma e a receita do dashboard (uma vez)', async ({ page }) => {
    const rental = await rentalByNumber(page, 'LOC-2026-007');
    const before = await scheduleOf(page, rental.id);
    const firstOpen = before.weeks.find((w) => w.remainingCents > 0)!;
    const dashBefore = await finance(page);

    await openPaymentDialog(page, 'LOC-2026-007');
    await page.getByRole('button', { name: `Dar baixa na semana ${firstOpen.number}` }).click();
    await expect(page.getByText('Registrar recebimento')).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText('Recebimento registrado')).toBeVisible();

    const after = await scheduleOf(page, rental.id);
    expect(after.totals.paidCents).toBe(before.totals.paidCents + firstOpen.remainingCents);
    expect(after.weeks.find((w) => w.number === firstOpen.number)!.status).toBe('PAID');
    const dashAfter = await finance(page);
    expect(dashAfter.revenueCents).toBe(dashBefore.revenueCents + firstOpen.remainingCents);
    expect(dashAfter.expensesCents).toBe(dashBefore.expensesCents);
  });

  test('clique duplo em Confirmar registra um único recebimento', async ({ page }) => {
    const rental = await rentalByNumber(page, 'LOC-2026-006');
    const before = await scheduleOf(page, rental.id);
    const firstOpen = before.weeks.find((w) => w.remainingCents > 0)!;

    await openPaymentDialog(page, 'LOC-2026-006');
    await page.getByRole('button', { name: `Dar baixa na semana ${firstOpen.number}` }).click();
    await expect(page.getByText('Registrar recebimento')).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar' }).dblclick();
    await expect(page.getByText('Recebimento registrado').first()).toBeVisible();

    const after = await scheduleOf(page, rental.id);
    expect(after.totals.paidCents).toBe(before.totals.paidCents + firstOpen.remainingCents);
  });

  test('valor maior que o saldo é recusado pela interface e nada é gravado', async ({ page }) => {
    const rental = await rentalByNumber(page, 'LOC-2026-005');
    const before = await scheduleOf(page, rental.id);

    await openPaymentDialog(page, 'LOC-2026-005');
    await page.getByRole('button', { name: 'Pagar valor livre' }).click();
    await expect(page.getByText('Registrar recebimento')).toBeVisible();
    const value = page.getByLabel(/Valor recebido/);
    await value.fill(String(before.totals.remainingCents + 100)); // +R$ 1,00 acima do saldo
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText(/não pode ser maior que o saldo/i)).toBeVisible();

    expect((await scheduleOf(page, rental.id)).totals.paidCents).toBe(before.totals.paidCents);
  });
});

test.describe('contas a pagar: categorias e parcelamento', () => {
  test('IPVA, Licenciamento e Outro existem no formulário de nova conta', async ({ page }) => {
    await page.goto('/dashboard/finance/accounts-payable/new');
    // as categorias chegam por requisição: espera a lista aparecer antes de ler
    await expect(page.locator('#payable-category option')).not.toHaveCount(0);
    const options = await page.locator('#payable-category option').allTextContents();
    for (const label of ['Financiamento', 'Seguro', 'IPVA', 'Licenciamento', 'Outro']) {
      expect(options).toContain(label);
    }
  });

  test('financiamento parcelado: 3 parcelas trimestrais aparecem numeradas e sem alterar a receita', async ({ page }) => {
    const dashBefore = await finance(page);
    await page.goto('/dashboard/finance/accounts-payable/new');
    await page.locator('#payable-category').selectOption({ label: 'Financiamento' });
    await page.getByLabel(/Valor/).first().fill('150000');
    await page.getByLabel('Descrição').fill('FINANCIAMENTO E2E AUDITORIA');
    await page.getByLabel(/Parcelado/).check();
    await page.getByLabel('Número de parcelas').fill('3');
    await page.getByLabel('Periodicidade').selectOption({ label: 'Trimestral' });
    await expect(page.getByText(/3 parcelas de/)).toBeVisible();
    await page.getByRole('button', { name: 'Criar Conta a Pagar' }).click();
    await expect(page).toHaveURL(/accounts-payable$/);

    await page.getByPlaceholder(/Buscar por descrição/).fill('FINANCIAMENTO E2E AUDITORIA');
    for (const n of [1, 2, 3]) {
      await expect(page.getByText(`Parcela ${n}/3 · Trimestral`)).toBeVisible();
    }
    // despesa lançada (não paga) não altera receita nem despesa realizada
    const dashAfter = await finance(page);
    expect(dashAfter.revenueCents).toBe(dashBefore.revenueCents);
    expect(dashAfter.expensesCents).toBe(dashBefore.expensesCents);
  });
});
