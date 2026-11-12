import { expect, test } from '@playwright/test';

/**
 * Telas novas da frota e do financeiro abrem de verdade sob a CSP do servidor,
 * sem erro de console, e os menus levam até elas.
 */
const pages = [
  ['/dashboard/vehicles/fuel', 'Abastecimento'],
  ['/dashboard/vehicles/availability', 'Disponibilidade e carro reserva'],
  ['/dashboard/vehicles/fipe', 'Valor de mercado (FIPE)'],
  ['/dashboard/vehicles/tracking', 'Rastreamento'],
  ['/dashboard/drivers/ranking', 'Ranking de motoristas'],
  ['/dashboard/finance/fiscal', 'Notas fiscais e recibos'],
] as const;

for (const [path, heading] of pages) {
  test(`${path} abre com o título "${heading}"`, async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (m) => m.type() === 'error' && /Content Security Policy|Uncaught|TypeError/i.test(m.text()) && problems.push(m.text()));
    page.on('pageerror', (e) => problems.push(e.message));
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
    expect(problems).toEqual([]);
  });
}

test('abastecimento: registra um abastecimento pela tela e ele aparece na lista', async ({ page, request, baseURL }) => {
  const vehicles = (await (await request.get('/api/v1/vehicles?limit=1')).json()).data as Array<{ id: string; plate: string; mileageKm: number }>;
  const vehicle = vehicles[0]!;
  await page.goto('/dashboard/vehicles/fuel');
  await page.getByLabel(/^Veículo/).selectOption(vehicle.id);
  await page.getByLabel(/^Litros/).fill('30,5');
  await page.getByLabel(/^Valor pago/).fill('19500');
  await page.getByLabel(/^Hodômetro/).fill(String(vehicle.mileageKm + 10));
  await page.getByRole('button', { name: 'Registrar', exact: true }).click();
  await expect(page.getByText('Abastecimento registrado')).toBeVisible();
  await expect(page.locator('section', { hasText: 'Últimos abastecimentos' }).locator('tbody tr', { hasText: vehicle.plate }).first()).toBeVisible();
  void baseURL;
});

test('vincular o veículo à FIPE falha com mensagem clara quando a tabela não responde, sem gravar valor', async ({ page, request }) => {
  const vehicles = (await (await request.get('/api/v1/vehicles?limit=1')).json()).data as Array<{ id: string }>;
  await page.route('**/api/v1/fipe/brands', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTEGRATION_UNAVAILABLE', message: 'Não foi possível falar com a tabela FIPE agora. Tente novamente em instantes.' } }) }));
  await page.goto(`/dashboard/vehicles/${vehicles[0]!.id}`);
  await page.getByRole('button', { name: /Vincular à FIPE|Trocar vínculo/ }).click();
  await expect(page.getByText('Não foi possível falar com a tabela FIPE')).toBeVisible();
});
