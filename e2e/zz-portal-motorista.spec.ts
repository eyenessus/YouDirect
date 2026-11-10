import { expect, test } from '@playwright/test';

/**
 * Área do Motorista: a equipe envia o link → o motorista entra pelo celular (sem a
 * sessão da equipe), vê locação, faturas e multas e pede manutenção → o pedido
 * aparece no painel. Roda no fim (ordem alfabética) porque grava no banco do demo.
 */
test.describe.configure({ mode: 'serial' });

const RENTAL = 'LOC-2026-006';
let rental: { id: string; vehicle: { plate: string }; driver: { id: string; fullName: string } };
let accessPath = '';

test.beforeAll(async ({ request }) => {
  const res = await request.get(`/api/v1/rentals?q=${RENTAL}`);
  rental = (await res.json()).data.find((r: { rentalNumber: string }) => r.rentalNumber === RENTAL);
});

test('equipe gera o link de acesso na página do motorista', async ({ page }) => {
  await page.goto(`/dashboard/drivers/${rental.driver.id}`);
  const card = page.getByRole('region', { name: 'Área do Motorista' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Enviar acesso' }).click();
  const link = card.locator('.font-mono');
  await expect(link).toContainText('/motorista/entrar/');
  accessPath = new URL((await link.textContent())!.trim()).pathname;
  await expect(card.getByRole('link', { name: 'Abrir WhatsApp' })).toBeVisible();
});

test('motorista entra pelo link e usa a Área do Motorista', async ({ browser }) => {
  // Contexto novo: sem o cookie da equipe, tela de celular.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(accessPath);
  await expect(page).toHaveURL(/\/motorista$/);
  await expect(page.getByRole('region', { name: 'Minha locação' })).toContainText(rental.vehicle.plate);
  await expect(page.getByRole('region', { name: 'Minha locação' })).toContainText(RENTAL);
  await expect(page.getByText(/Prazo de indicação|multa\(s\) a pagar|Próxima fatura/).first()).toBeVisible();

  // O link é de uso único.
  const again = await context.newPage();
  await again.goto(accessPath);
  await expect(again.getByText(/já utilizado/)).toBeVisible();
  await again.close();

  // A sessão do motorista não abre o painel da equipe.
  const staffApi = await page.request.get('/api/v1/vehicles');
  expect(staffApi.status()).toBe(401);

  await page.getByRole('navigation', { name: 'Área do Motorista' }).getByRole('link', { name: 'Faturas' }).click();
  await expect(page.getByRole('heading', { name: 'Faturas' })).toBeVisible();
  await expect(page.getByText('Em aberto').first()).toBeVisible();

  await page.getByRole('navigation', { name: 'Área do Motorista' }).getByRole('link', { name: 'Multas' }).click();
  await expect(page.getByRole('heading', { name: 'Multas' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Área do Motorista' }).getByRole('link', { name: 'Manutenção' }).click();
  await page.getByLabel(/O que aconteceu/).selectOption('TIRES');
  await page.getByLabel(/Descrição/).fill('Pneu traseiro murchando todo dia (e2e)');
  await page.getByText('O carro está parado').click();
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(page.getByRole('region', { name: 'Meus pedidos' })).toContainText('Pneu traseiro murchando');
  await expect(page.getByRole('region', { name: 'Meus pedidos' })).toContainText('Recebido');
  await context.close();
});

test('pedido do motorista aparece para a equipe em Manutenções', async ({ page }) => {
  await page.goto('/dashboard/maintenance');
  const panel = page.getByRole('region', { name: 'Pedidos de manutenção dos motoristas' });
  await expect(panel).toContainText('Pneu traseiro murchando');
  await expect(panel).toContainText('carro parado');
  await panel.getByPlaceholder(/Resposta ao motorista/).first().fill('Borracharia amanhã 9h');
  await panel.getByRole('button', { name: 'Agendar' }).first().click();
  await expect(panel.getByText('Agendado').first()).toBeVisible();
});
