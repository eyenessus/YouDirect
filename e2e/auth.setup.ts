import { expect, test as setup } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Autentica UMA vez e guarda o cookie de sessão para os demais testes.
 *
 * Sem isso, cada teste faria um `POST /auth/login` e a suíte esbarraria
 * no rate limit da rota (10 tentativas por minuto) — que é um
 * comportamento desejado da API, não um defeito a contornar afrouxando
 * o limite.
 */
export const STORAGE_STATE = '.cache/e2e-auth.json';

const EMAIL = process.env.E2E_EMAIL ?? 'erik@ffveiculos.example.com';
const PASSWORD = process.env.E2E_PASSWORD ?? 'FrotaOne@2026';

setup('autentica e guarda a sessão', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('E-mail').fill(EMAIL);
  await page.getByPlaceholder('Sua senha').fill(PASSWORD);
  await page.getByRole('button', { name: /entrar/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByText('Total de Veículos')).toBeVisible();

  await mkdir(dirname(STORAGE_STATE), { recursive: true });
  await page.context().storageState({ path: STORAGE_STATE });
});
