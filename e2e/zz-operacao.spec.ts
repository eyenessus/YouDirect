import { expect, test } from '@playwright/test';

/**
 * Operação: contrato em PDF, franquia de km, tabela de avarias, régua de cobrança,
 * fidelidade e Pix na Área do Motorista (no demo o Pix não está configurado:
 * a tela precisa dizer isso com honestidade e oferecer o WhatsApp).
 */
test.describe.configure({ mode: 'serial' });

const RENTAL = 'LOC-2026-005';
let rental: { id: string; driver: { id: string; fullName: string } };

test.beforeAll(async ({ request }) => {
  const res = await request.get(`/api/v1/rentals?q=${RENTAL}`);
  rental = (await res.json()).data.find((r: { rentalNumber: string }) => r.rentalNumber === RENTAL);
});

test('locação: contrato em PDF e franquia de km', async ({ page }) => {
  await page.goto(`/dashboard/rentals/${rental.id}?tab=operations`);
  await expect(page.getByRole('tab', { name: 'Contrato, km e caução' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Contrato e assinatura' })).toContainText('Assinatura digital não configurada');

  const pdf = await page.request.get(`/api/v1/rentals/${rental.id}/contract.pdf`);
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 4).toString()).toBe('%PDF');

  const km = page.getByRole('region', { name: 'Franquia de km' });
  await km.getByLabel(/KM por semana/).fill('1500');
  await km.getByLabel(/Preço do km extra/).fill('80');
  await km.getByLabel(/Hodômetro na entrega/).fill('50000');
  await km.getByRole('button', { name: 'Salvar franquia' }).click();
  await expect(page.getByText('Franquia de km salva')).toBeVisible();
  const summary = await (await page.request.get(`/api/v1/rentals/${rental.id}/km-summary`)).json();
  expect(summary.policy).toMatchObject({ weeklyFranchiseKm: 1500, extraKmPriceCents: 80, startOdometerKm: 50000 });

  const caucao = page.getByRole('region', { name: 'Caução' });
  await expect(caucao).toContainText('Encerre a locação antes de fechar a caução');
});

test('vistorias: tabela de avarias padrão', async ({ page }) => {
  await page.goto('/dashboard/inspections/settings');
  const table = page.getByRole('region', { name: 'Tabela de avarias' });
  await expect(table).toContainText('Retrovisor');
  await expect(table).toContainText('Para-brisa');
});

test('perfil: régua de cobrança e fidelidade', async ({ page }) => {
  await page.goto('/dashboard/profile');
  const card = page.getByRole('region', { name: 'Cobrança e fidelidade' });
  await expect(card).toContainText('Cobrança Pix não configurada');
  await expect(card).toContainText('Fidelidade dos motoristas');
  await expect(card.getByLabel('Nível').first()).toHaveValue('Inicial');
  await card.getByRole('button', { name: 'Salvar régua' }).click();
  await expect(page.getByText('Régua de cobrança salva')).toBeVisible();
});

test('motorista: nível de fidelidade e Pix indisponível com alternativa', async ({ page, browser }) => {
  await page.goto(`/dashboard/drivers/${rental.driver.id}`);
  await expect(page.getByRole('region', { name: 'Fidelidade' })).toContainText('pontos');
  const card = page.getByRole('region', { name: 'Área do Motorista' });
  await card.getByRole('button', { name: /Enviar (novo link|acesso)/ }).click();
  const path = new URL((await card.locator('.font-mono').textContent())!.trim()).pathname;

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: { cookies: [], origins: [] } });
  const phone = await context.newPage();
  await phone.goto(path);
  await expect(phone).toHaveURL(/\/motorista$/);
  await expect(phone.getByRole('region', { name: 'Fidelidade' })).toContainText(/Nível/);

  await phone.getByRole('navigation', { name: 'Área do Motorista' }).getByRole('link', { name: 'Faturas' }).click();
  await phone.getByRole('button', { name: 'Pagar com Pix' }).first().click();
  await expect(phone.getByText('não está disponível agora')).toBeVisible();
  await expect(phone.getByRole('link', { name: 'Pedir a chave Pix pelo WhatsApp' })).toHaveAttribute('href', /wa\.me\//);
  await context.close();
});
