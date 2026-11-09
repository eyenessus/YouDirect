import { expect, test, type Page } from '@playwright/test';

/**
 * E2E sobre a aplicação real (API + banco populado pelo seed).
 * Cada bloco corresponde a um fluxo da matriz de rastreabilidade
 * (docs/TRACEABILITY.md).
 *
 * Nota sobre valores monetários: `formatCentsBRL` usa ESPAÇO NÃO
 * SEPARÁVEL entre "R$" e o número (é o que o Intl do pt-BR produz), por
 * isso as asserções usam expressões regulares com `\s` em vez de texto
 * literal.
 */
const EMAIL = process.env.E2E_EMAIL ?? 'erik@ffveiculos.example.com';
const PASSWORD = process.env.E2E_PASSWORD ?? 'FrotaOne@2026';

const brl = (value: string) => new RegExp(`R\\$\\s*${value.replace(/[.$]/g, '\\$&')}`);

test.describe('acesso', () => {
  // Estes casos precisam de navegador ANÔNIMO — os demais reaproveitam
  // a sessão gravada pelo projeto `setup` (e2e/auth.setup.ts).
  test.use({ storageState: { cookies: [], origins: [] } });

  test('rota protegida redireciona para o login', async ({ page }) => {
    await page.goto('/dashboard/finance');
    await expect(page).toHaveURL(/\/login/);
  });

  test('credenciais inválidas não revelam se o e-mail existe', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-mail').fill(EMAIL);
    await page.getByPlaceholder('Sua senha').fill('senha-errada');
    await page.getByRole('button', { name: /entrar/i }).click();
    await expect(page.getByText(/e-mail ou senha inválidos/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('login leva ao painel autenticado', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('E-mail').fill(EMAIL);
    await page.getByPlaceholder('Sua senha').fill(PASSWORD);
    await page.getByRole('button', { name: /entrar/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText('Total de Veículos')).toBeVisible();
  });
});

test.describe('painel e relatórios', () => {
  test('painel mostra os indicadores calculados', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByText('Total de Veículos')).toBeVisible();
    await expect(page.getByText('Receita Mensal')).toBeVisible();
    await expect(page.getByText(brl('5.603,00')).first()).toBeVisible();
    await expect(page.getByText('Evolução da Receita')).toBeVisible();
  });

  test('dashboard financeiro fecha receita menos despesa igual a lucro', async ({ page }) => {
    await page.goto('/dashboard/finance');
    await expect(page.getByText(brl('5.603,00')).first()).toBeVisible();
    await expect(page.getByText(brl('1.894,45')).first()).toBeVisible();
    await expect(page.getByText(brl('3.708,55')).first()).toBeVisible();
    await expect(page.getByText('66,2%').first()).toBeVisible();
  });

  test('DRE mensal lista a hierarquia e permite baixar o PDF', async ({ page }) => {
    await page.goto('/dashboard/finance/reports/dre');
    await expect(page.getByText('Receita bruta').first()).toBeVisible();
    await expect(page.getByText('Custos da frota')).toBeVisible();
    await expect(page.getByText('Resultado do exercício').first()).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Baixar PDF' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^dre-2026-\d{2}\.pdf$/);
  });

  test('relatório por cliente soma pago e em aberto', async ({ page }) => {
    await page.goto('/dashboard/finance/reports/by-client');
    await expect(page.getByText('Total Pago').first()).toBeVisible();
    await expect(page.getByText('Em Aberto').first()).toBeVisible();
    // Maior pendência do conjunto da referência: R$ 9.750,00.
    await expect(page.getByText(brl('9.750,00')).first()).toBeVisible();
  });
});

test.describe('veículos', () => {
  test('busca filtra a lista pela placa', async ({ page }) => {
    await page.goto('/dashboard/vehicles');
    await expect(page.getByText('EBR7G53')).toBeVisible();
    await page.getByPlaceholder(/filtrar por placa/i).fill('RNA8D85');
    await expect(page.getByText('RNA8D85')).toBeVisible();
    await expect(page.getByText('EBR7G53')).toHaveCount(0);
  });

  test('o veículo arquivado não aparece na consulta', async ({ page }) => {
    await page.goto('/dashboard/vehicles');
    await expect(page.getByText('EBR7G53')).toBeVisible();
    await expect(page.getByText('FQT3I57')).toHaveCount(0);
  });

  test('cadastro rejeita placa inválida antes de enviar', async ({ page }) => {
    await page.goto('/dashboard/vehicles/new');
    await page.getByRole('textbox', { name: /^placa/i }).fill('AAA');
    await page.getByRole('button', { name: /salvar|cadastrar/i }).first().click();
    await expect(page).toHaveURL(/vehicles\/new/);
  });

  test('importação baixa a planilha modelo', async ({ page }) => {
    await page.goto('/dashboard/vehicles/import');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /baixar planilha modelo/i }).click();
    const file = await download;
    expect(file.suggestedFilename()).toContain('.xlsx');
  });
});

test.describe('manutenções', () => {
  async function openEbrHistory(page: Page) {
    await page.goto('/dashboard/maintenance');
    const card = page.locator('article, section, div.fo-card').filter({ hasText: 'EBR7G53' }).last();
    await card.getByRole('button', { name: /ver histórico/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/maintenance\/[0-9a-f]{24}$/);
  }

  test('histórico do EBR7G53 mostra as duas OS e o total do período', async ({ page }) => {
    await openEbrHistory(page);
    await expect(page.getByText('WO-2026-0013')).toBeVisible();
    await expect(page.getByText('WO-2026-0006')).toBeVisible();
    await expect(page.getByText(brl('831,20')).first()).toBeVisible();
  });

  test('exporta o relatório de manutenções em PDF', async ({ page }) => {
    await openEbrHistory(page);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /baixar relatório/i }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^manutencoes-ebr7g53-\d{4}-\d{2}-\d{2}\.pdf$/);
  });
});

test.describe('financeiro', () => {
  test('extrato bancário fecha o saldo do período', async ({ page }) => {
    await page.goto('/dashboard/finance/bank-accounts');
    await expect(page.getByText('Conta Principal')).toBeVisible();
    await page.getByRole('button', { name: /^extrato$/i }).first().click();
    await expect(page).toHaveURL(/bank-accounts\/[0-9a-f]{24}$/);
    await expect(page.getByText(brl('7.802,58')).first()).toBeVisible();
    await expect(page.getByText(brl('11.511,13')).first()).toBeVisible();
  });

  test('contas a receber exibem o pendente total e o badge de vencida', async ({ page }) => {
    await page.goto('/dashboard/finance/accounts-receivable');
    await expect(page.getByText('Valor Pendente Total')).toBeVisible();
    await expect(page.getByText(brl('33.540,00')).first()).toBeVisible();
    // "Vencida" também é uma opção do filtro de status; aqui queremos o badge.
    await expect(page.getByRole('cell').getByText('Vencida').first()).toBeVisible();
  });
});

test.describe('integrações sem credenciais', () => {
  test('disparo de mensagens avisa que o provedor não está configurado', async ({ page }) => {
    await page.goto('/dashboard/dispatch');
    await expect(page.getByText(/provedor de whatsapp não conectado/i).first()).toBeVisible();
  });

  test('assinatura não oferece link de pagamento sem provedor conectado', async ({ page }) => {
    await page.goto('/dashboard/subscription');
    await expect(page.getByText(/provedor de cobrança/i).first()).toBeVisible();
  });
});
