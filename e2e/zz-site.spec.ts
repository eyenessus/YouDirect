import { expect, test } from '@playwright/test';

/**
 * Site da locadora (estilo home da Localiza): vitrine de grupos com preço semanal,
 * pedido de reserva sem login, e o pedido na fila "Pedidos de Reserva" do painel.
 */
test.describe.configure({ mode: 'serial' });

const NAME = `Visitante E2E ${Date.now().toString().slice(-5)}`;

test('visitante vê os grupos e pede uma reserva', async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/l/ff-veiculos');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  for (const group of ['Compacto', 'Hatch', 'Sedã']) {
    await expect(page.getByRole('article', { name: `Grupo ${group}` })).toBeVisible();
  }
  await expect(page.getByRole('article', { name: 'Grupo Hatch' })).toContainText('R$ 650,00');
  await expect(page.getByRole('link', { name: 'WhatsApp' })).toHaveAttribute('href', /wa\.me\/5511999990000/);

  await page.getByRole('article', { name: 'Grupo Hatch' }).getByRole('button').click();
  await expect(page).toHaveURL(/\/l\/ff-veiculos\/reservar\?grupo=Hatch/);
  await expect(page.getByLabel('Grupo')).toHaveValue('Hatch');
  await page.getByLabel(/Nome completo/).fill(NAME);
  await page.locator('#r-phone').fill('(11) 97777-1234');
  await page.getByLabel('Uber').check();
  await page.getByLabel(/EAR/).check();
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(page.getByText(/Aceitar o contato|É preciso aceitar/i)).toBeVisible();
  await page.getByLabel(/Aceito ser contatado/).check();
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(page.getByRole('heading', { name: 'Pedido enviado!' })).toBeVisible();
  await context.close();
});

test('o pedido aparece em Locações > Pedidos do site', async ({ page }) => {
  await page.goto('/dashboard/leads');
  await expect(page.getByRole('heading', { name: 'Pedidos de Reserva' })).toBeVisible();
  const row = page.locator('li', { hasText: NAME });
  await expect(row).toContainText('Hatch');
  await expect(row).toContainText('Novo');
  await row.getByRole('button', { name: 'Aprovar' }).click();
  await expect(page).toHaveURL(/\/dashboard\/drivers\/new/);
  await expect(page.getByLabel(/Nome completo/)).toHaveValue(NAME);
});
