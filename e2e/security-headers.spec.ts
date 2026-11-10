import { expect, test } from '@playwright/test';

/**
 * A Content-Security-Policy só é aplicada quando o front é servido pela
 * API (produção, ou E2E_BASE_URL apontando para ela). Nesse modo, nenhuma
 * tela pode gerar violação de CSP — script inline, imagem de outra origem,
 * chamada para domínio não listado.
 */
test('telas principais carregam sem violar a Content-Security-Policy', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(msg.text())) violations.push(msg.text());
  });
  for (const path of ['/dashboard', '/dashboard/vehicles', '/dashboard/finance', '/dashboard/inspections', '/dashboard/messages']) {
    await page.goto(path);
    await expect(page.locator('main')).toBeVisible();
    await page.waitForLoadState('networkidle');
  }
  expect(violations).toEqual([]);
});
