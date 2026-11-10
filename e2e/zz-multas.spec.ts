import { expect, test } from '@playwright/test';

/**
 * Multas: cadastrar pela tela → o sistema identifica sozinho o motorista da locação
 * daquela data → cobrar → a cobrança aparece no motorista e em Contas a Receber.
 * Roda por último (ordem alfabética) porque cria uma conta a receber no banco do demo.
 */
test.describe.configure({ mode: 'serial' });

const RENTAL = 'LOC-2026-002';
const AIT = `E2E-${Date.now().toString().slice(-8)}`;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

let rental: { id: string; vehicle: { id: string; plate: string }; driver: { id: string; fullName: string } };
let fineUrl = '';

test.beforeAll(async ({ request }) => {
  const res = await request.get(`/api/v1/rentals?q=${RENTAL}`);
  rental = (await res.json()).data.find((r: { rentalNumber: string }) => r.rentalNumber === RENTAL);
});

test('lista de multas mostra o resumo e as multas de exemplo', async ({ page }) => {
  await page.goto('/dashboard/fines');
  await expect(page.getByRole('heading', { name: 'Multas de Trânsito' })).toBeVisible();
  await expect(page.getByText('Indicação vencida').first()).toBeVisible();
  await expect(page.locator('tbody tr', { hasText: 'SP-1F2345678' })).toBeVisible();
  // A multa de exemplo com prazo perdido aparece no filtro de indicação vencida.
  await page.getByText('Indicação vencida', { exact: true }).first().click();
  await expect(page.locator('tbody tr', { hasText: 'SP-2A9876543' })).toBeVisible();
  await expect(page.locator('tbody tr', { hasText: 'SP-1F2345678' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Multas' }).first()).toBeVisible();
});

test('cadastrar multa identifica o motorista automaticamente', async ({ page }) => {
  await page.goto('/dashboard/fines/new');
  await page.getByLabel(/^Veículo/).selectOption(rental.vehicle.id);
  await page.getByLabel(/auto de infração/).fill(AIT);
  await page.getByLabel(/Data da infração/).fill(yesterday);
  await page.getByLabel(/^Hora/).fill('10:30');
  await page.getByLabel(/Descrição da infração/).fill('Estacionar em local proibido');
  await page.getByLabel(/Órgão autuador/).fill('CET - São Paulo');
  await page.getByLabel(/Valor da multa/).fill('19523');
  await page.getByRole('button', { name: 'Cadastrar multa' }).click();

  await expect(page).toHaveURL(/\/dashboard\/fines\/[0-9a-f]{24}$/);
  fineUrl = page.url();
  await expect(page.getByText('Identificado automaticamente', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: rental.driver.fullName }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: RENTAL }).first()).toBeVisible();
  await expect(page.getByText('Motorista identificado').first()).toBeVisible();
});

test('cobrar do motorista gera a conta a receber', async ({ page }) => {
  await page.goto(fineUrl);
  await page.getByRole('button', { name: 'Cobrar do motorista' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Cobrar do motorista')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cobrar' }).click();
  await expect(page.getByText('Cobrada do motorista').first()).toBeVisible();
  await expect(page.getByText('R$ 195,23').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cobrar do motorista' })).toHaveCount(0);

  // A multa aparece no cartão "Multas" do motorista.
  await page.goto(`/dashboard/drivers/${rental.driver.id}`);
  await expect(page.getByRole('region', { name: 'Multas' }).getByText(/MUL-\d{4}-\d+/).first()).toBeVisible();

  // E a cobrança está em Contas a Receber.
  const receivables = await (await page.request.get(`/api/v1/receivables?q=${AIT}`)).json();
  expect(receivables.data).toHaveLength(1);
  expect(receivables.data[0].grossAmountCents).toBe(19523);
  expect(receivables.data[0].driver.id).toBe(rental.driver.id);
});
