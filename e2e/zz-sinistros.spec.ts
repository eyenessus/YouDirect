import { expect, test } from '@playwright/test';

/**
 * Sinistros: registrar pela tela (o motorista vem da locação do veículo), andar com a
 * situação e cobrar a franquia, que cai em Contas a Receber.
 * Roda depois dos demais (ordem alfabética) porque cria uma conta a receber no banco do demo.
 */
test.describe.configure({ mode: 'serial' });

const RENTAL = 'LOC-2026-002';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
let rental: { vehicle: { id: string; plate: string }; driver: { fullName: string } };
let claimUrl = '';
let claimNumber = '';

test.beforeAll(async ({ request }) => {
  const res = await request.get(`/api/v1/rentals?q=${RENTAL}`);
  rental = (await res.json()).data.find((r: { rentalNumber: string }) => r.rentalNumber === RENTAL);
});

test('registra o sinistro e identifica o motorista da locação', async ({ page }) => {
  await page.goto('/dashboard/claims/new');
  await expect(page.getByRole('heading', { name: 'Registrar sinistro' })).toBeVisible();
  await page.getByLabel(/^Veículo/).selectOption(rental.vehicle.id);
  await page.getByLabel(/Data do ocorrido/).fill(today);
  await page.getByLabel(/^Descrição/).fill('Colisão na traseira em semáforo, sem feridos');
  await page.getByLabel(/Número do B.O./).fill('BO-E2E-1');
  await page.getByLabel(/^Franquia/).fill('150000');
  await page.getByRole('button', { name: 'Registrar sinistro' }).click();

  await expect(page).toHaveURL(/\/dashboard\/claims\/[0-9a-f]{24}$/);
  claimUrl = new URL(page.url()).pathname;
  claimNumber = (await page.getByRole('heading', { level: 1 }).innerText()).trim();
  expect(claimNumber).toMatch(/^SIN-\d{4}-\d+$/);
  await expect(page.getByText(rental.driver.fullName).first()).toBeVisible();
  await expect(page.getByText('BO-E2E-1')).toBeVisible();
});

test('a lista mostra o sinistro e a busca por placa o encontra', async ({ page }) => {
  await page.goto('/dashboard/claims');
  await page.getByPlaceholder(/Buscar por número/).fill(rental.vehicle.plate);
  await expect(page.locator('tbody tr', { hasText: claimNumber })).toBeVisible();
  await page.getByPlaceholder(/Buscar por número/).fill('placa-que-nao-existe');
  await expect(page.getByText('Nenhum sinistro')).toBeVisible();
});

test('avança a situação e cobra a franquia do motorista', async ({ page }) => {
  await page.goto(claimUrl);
  await page.getByRole('button', { name: /Em análise/ }).click();
  await expect(page.getByText('Situação atualizada')).toBeVisible();
  // Culpa a apurar: registra a do motorista e cobra.
  await page.getByRole('button', { name: 'Registrar culpa do motorista' }).first().click();
  await expect(page.getByText('Culpa registrada como do motorista')).toBeVisible();
  await page.getByRole('button', { name: 'Cobrar motorista' }).click();
  await expect(page.getByText(/Cobrança de .* lançada em Contas a Receber/)).toBeVisible();
  await expect(page.getByText('R$ 1.500,00').first()).toBeVisible();
  // Já cobrado: some o botão.
  await expect(page.getByRole('button', { name: 'Cobrar motorista' })).toHaveCount(0);
  await expect(page.getByText(/Franquia de R\$\s1\.500,00 com vencimento/)).toBeVisible();
});

test('a cobrança aparece em Contas a Receber', async ({ page }) => {
  await page.goto('/dashboard/finance/accounts-receivable');
  await expect(page.getByText(`Franquia do sinistro ${claimNumber}`).first()).toBeVisible();
});
