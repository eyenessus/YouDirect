import { expect, test } from '@playwright/test';

/**
 * Telas de acesso (sem sessão): painel com fotos reais de Ferrari carregando de
 * verdade sob a CSP do servidor, nas quatro telas, e a página de créditos.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const screens = [
  ['/login', 'Entrar'],
  ['/esqueci-a-senha', 'Esqueci a senha'],
  ['/redefinir-senha/token-de-teste', 'Nova senha'],
] as const;

for (const [path, heading] of screens) {
  test(`${path}: painel com fotos carregadas e link de créditos`, async ({ page }) => {
    const violations: string[] = [];
    page.on('console', (m) => /Content Security Policy/i.test(m.text()) && violations.push(m.text()));
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    const photos = page.locator('aside img[src^="/brand/cars/"]');
    await expect(photos.first()).toBeAttached();
    await expect
      .poll(async () => photos.evaluateAll((els) => els.filter((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0).length))
      .toBeGreaterThan(3);
    await expect(page.locator('aside').getByRole('link', { name: 'Créditos das fotos' })).toBeVisible();
    expect(violations).toEqual([]);
  });
}

test('convite inválido também usa o painel', async ({ page }) => {
  await page.goto('/convite/token-inexistente');
  await expect(page.getByText('Convite indisponível')).toBeVisible();
  await expect(page.locator('aside img[src^="/brand/cars/"]').first()).toBeAttached();
});

test('créditos das fotos: cada foto com autor, licença e origem', async ({ page }) => {
  await page.goto('/login');
  await page.locator('aside').getByRole('link', { name: 'Créditos das fotos' }).click();
  await expect(page).toHaveURL(/\/creditos-fotos$/);
  await expect(page.getByRole('heading', { name: 'Créditos das fotos' })).toBeVisible();
  const items = page.locator('ul > li');
  await expect(items).toHaveCount(8);
  await expect(page.getByRole('link', { name: 'Ver no Wikimedia Commons' }).first()).toHaveAttribute('href', /commons\.wikimedia\.org\/wiki\/File:/);
  await expect(page.getByText(/CC BY|CC0/).first()).toBeVisible();
});
