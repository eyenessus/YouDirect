import { expect, test } from '@playwright/test';

/**
 * Análise de crédito (Serasa). No demo não há credencial: as telas precisam
 * dizer isso com honestidade, não oferecer consulta e nada pode ser simulado.
 */
test.describe.configure({ mode: 'serial' });

test('perfil: configuração da Serasa declara a falta de credencial', async ({ page }) => {
  await page.goto('/dashboard/profile');
  const card = page.getByRole('region', { name: 'Análise de crédito' });
  await expect(card).toContainText('Serasa não configurada');
  await expect(card.getByRole('button', { name: 'Testar credencial' })).toBeDisabled();
  await expect(card).toContainText('RELATORIO_BASICO_PF_PME');
});

test('motorista: card explica e não oferece consulta; API recusa com 503', async ({ page }) => {
  const drivers = await (await page.request.get('/api/v1/drivers?limit=1')).json();
  const driver = drivers.data[0];
  await page.goto(`/dashboard/drivers/${driver.id}`);
  const card = page.getByRole('region', { name: 'Análise de crédito' });
  await expect(card).toContainText('Serasa não configurada');
  await expect(card.getByRole('button', { name: 'Consultar Serasa' })).toHaveCount(0);

  // Mesmo ligando nas configurações, sem credencial a consulta é recusada (nada é simulado).
  const origin = new URL(page.url()).origin;
  const put = await page.request.put('/api/v1/credit/settings', {
    headers: { origin },
    data: { enabled: true, costPerQueryCents: null, monthlyLimit: 10, reuseDays: 30, retentionDays: 90 },
  });
  expect(put.status()).toBe(200);
  const res = await page.request.post(`/api/v1/drivers/${driver.id}/credit-checks`, {
    headers: { origin },
    data: { purpose: 'PRE_LOCACAO', justification: 'Teste e2e sem credencial', holderInformed: true, confirmCost: true, idempotencyKey: `e2e-${Date.now()}` },
  });
  expect([422, 503]).toContain(res.status());
  await page.request.put('/api/v1/credit/settings', {
    headers: { origin },
    data: { enabled: false, costPerQueryCents: null, monthlyLimit: 50, reuseDays: 30, retentionDays: 90 },
  });
});

test('menu: histórico e consumo', async ({ page }) => {
  await page.goto('/dashboard');
  await page.getByRole('link', { name: 'Análise de crédito' }).click();
  await expect(page).toHaveURL(/\/dashboard\/credit-checks$/);
  await expect(page.getByRole('heading', { name: 'Análise de crédito' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Consumo' })).toContainText('Consumo por mês');
  await expect(page.getByText('Nenhuma consulta.')).toBeVisible();
});
