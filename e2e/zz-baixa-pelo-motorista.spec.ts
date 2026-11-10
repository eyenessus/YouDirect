import { expect, test } from '@playwright/test';

/**
 * Caminho do operador: Locações > Consultar > clicar no NOME do motorista na linha >
 * detalhe do motorista > "Lançar pagamento" (somente as contas DAQUELE motorista).
 * Roda depois de zz-auditoria-baixa (ordem alfabética) porque altera o banco em memória do demo.
 */
test('da lista de locações ao motorista: o botão Lançar pagamento mostra só as contas dele e dá baixa', async ({ page }) => {
  const rentals = (await (await page.request.get('/api/v1/rentals?q=LOC-2026-004')).json()).data as Array<{
    id: string;
    rentalNumber: string;
    driver: { id: string; fullName: string };
  }>;
  const rental = rentals.find((r) => r.rentalNumber === 'LOC-2026-004')!;
  const other = (await (await page.request.get('/api/v1/rentals?q=LOC-2026-005')).json()).data[0] as {
    rentalNumber: string;
    driver: { id: string };
  };
  expect(other.driver.id).not.toBe(rental.driver.id); // outro motorista, para provar o filtro

  const scheduleOf = async () =>
    (await (await page.request.get(`/api/v1/rentals/${rental.id}/payment-schedule`)).json()) as {
      weeks: Array<{ number: number; remainingCents: number }>;
      totals: { paidCents: number };
    };
  const before = await scheduleOf();
  const firstOpen = before.weeks.find((w) => w.remainingCents > 0)!;

  // 1) na lista, clicar no nome do motorista da linha leva ao detalhe DELE
  await page.goto('/dashboard/rentals');
  const row = page.locator('tbody tr', { hasText: 'LOC-2026-004' });
  await row.getByRole('link', { name: rental.driver.fullName }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/drivers/${rental.driver.id}$`));
  await expect(page.getByRole('heading', { name: rental.driver.fullName, level: 1 })).toBeVisible();

  // 2) "Lançar pagamento" abre o cronograma só das locações desse motorista
  await page.getByRole('button', { name: 'Lançar pagamento' }).click();
  await expect(page.getByText(`Lançar pagamento — ${rental.driver.fullName}`)).toBeVisible();
  await expect(page.getByRole('table', { name: /Cronograma de Locação LOC-2026-004/ })).toBeVisible();
  await expect(page.getByRole('table', { name: new RegExp(`Cronograma de Locação ${other.rentalNumber}`) })).toHaveCount(0);

  // 3) dar baixa na primeira semana em aberto persiste e atualiza o cronograma
  await page.getByRole('button', { name: `Dar baixa na semana ${firstOpen.number}` }).click();
  await expect(page.getByText('Registrar recebimento')).toBeVisible();
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Recebimento registrado')).toBeVisible();

  const after = await scheduleOf();
  expect(after.totals.paidCents).toBe(before.totals.paidCents + firstOpen.remainingCents);
});
