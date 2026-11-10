import { expect, test, type Page } from '@playwright/test';

/**
 * AUDITORIA — Contas a Pagar (categorias e parcelamento) pelo NAVEGADOR real (UI → API → banco).
 * A baixa de recebimentos da locação é coberta em zz-baixa-pelo-motorista.spec.ts.
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
