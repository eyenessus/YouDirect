import { expect, test } from '@playwright/test';

/**
 * Vencimentos da frota: o veículo recebe as datas, a tela lista os itens do mais urgente
 * ao mais distante e o link leva ao cadastro com as datas preenchidas.
 */
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const shift = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
const plate = `${letter()}${letter()}${letter()}${Math.floor(Math.random() * 10)}${letter()}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`;
let vehicleId = '';

test.beforeAll(async ({ request, baseURL }) => {
  const res = await request.post('/api/v1/vehicles', {
    headers: { origin: baseURL! },
    data: { plate, brand: 'Fiat', model: 'Mobi', mileageKm: 5, ipvaDueDate: shift(-3), licensingDueDate: shift(12), insuranceDueDate: shift(40) },
  });
  expect(res.status()).toBe(201);
  vehicleId = (await res.json()).id;
});

test('a tela lista os vencimentos do veículo, o vencido primeiro', async ({ page }) => {
  await page.goto('/dashboard/vehicles/due');
  await expect(page.getByRole('heading', { name: 'Vencimentos da frota' })).toBeVisible();
  const rows = page.locator('tbody tr', { hasText: plate });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('IPVA');
  await expect(rows.nth(0)).toContainText('Venceu há 3 dia(s)');
  await expect(rows.nth(1)).toContainText('Licenciamento');
  await expect(rows.nth(2)).toContainText('Seguro');
  // O filtro por tipo reduz a lista.
  await page.getByRole('tab', { name: 'Seguro' }).click();
  await expect(page.locator('tbody tr', { hasText: plate })).toHaveCount(1);
});

test('"Atualizar data" abre o cadastro com os vencimentos preenchidos', async ({ page }) => {
  await page.goto('/dashboard/vehicles/due');
  await page.locator('tbody tr', { hasText: plate }).first().getByRole('link', { name: 'Atualizar data' }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/vehicles/${vehicleId}/edit$`));
  await expect(page.getByLabel('Vencimento do IPVA')).toHaveValue(shift(-3));
  await expect(page.getByLabel('Vencimento do Licenciamento')).toHaveValue(shift(12));
});

test('o menu de Veículos leva para os vencimentos', async ({ page }) => {
  await page.goto('/dashboard/vehicles');
  await page.getByRole('link', { name: 'Vencimentos' }).first().click();
  await expect(page).toHaveURL(/\/dashboard\/vehicles\/due$/);
});
