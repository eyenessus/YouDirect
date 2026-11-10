import { expect, test, type Page } from '@playwright/test';

/**
 * E2E de interface — vistoria por WhatsApp (YuDirect).
 *
 * Roda contra a aplicação real (`dev:demo`, banco populado pelo seed).
 * No ambiente de demonstração o canal Whaply NÃO está conectado — o que
 * permite verificar o comportamento honesto da interface: nada é
 * apresentado como enviado, a correção cai no link web e o painel
 * avisa que o canal não está conectado.
 *
 * O fluxo com o canal conectado (envio, status, fotos, aprovação) é
 * coberto ponta a ponta, com o código real dos dois sistemas, em
 * `apps/api/src/__tests__/e2e-whaply-cross.test.ts`.
 */

async function apiJson<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(`/api/v1${path}`);
  expect(res.ok(), `${path} → ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

test.describe('consentimento do motorista (opt-in WhatsApp)', () => {
  test('registra e revoga o consentimento com confirmação, deixando o histórico visível', async ({ page }) => {
    const drivers = await apiJson<{ data: Array<{ id: string; fullName: string }> }>(page, '/drivers?limit=5');
    const driver = drivers.data[0]!;
    await page.goto(`/dashboard/drivers/${driver.id}`);

    const card = page.locator('section', { has: page.getByRole('heading', { name: /mensagens de vistoria pelo whatsapp/i }) });
    await expect(card).toBeVisible();
    await expect(card.getByText('Sem consentimento')).toBeVisible();

    await card.getByLabel(/como o cliente autorizou/i).selectOption('IN_PERSON');
    await card.getByRole('button', { name: /registrar consentimento/i }).click();
    await expect(card.getByText('Consentimento ativo')).toBeVisible();
    await expect(card.getByText('Presencial')).toBeVisible();

    // A API reflete o registro (e quem pode ver telefone vê o estado completo).
    const detail = await apiJson<{ whatsappConsent: { status: string; source: string } }>(page, `/drivers/${driver.id}`);
    expect(detail.whatsappConsent).toMatchObject({ status: 'GRANTED', source: 'IN_PERSON' });

    await card.getByRole('button', { name: /revogar consentimento/i }).click();
    const dialog = page.getByRole('dialog', { name: /revogar consentimento/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /^revogar$/i }).click();
    await expect(card.getByText('Consentimento revogado')).toBeVisible();
    await expect(card.getByText(/revogado em/i)).toBeVisible();
    await expect(card.getByText(/pela equipe/i)).toBeVisible();
  });
});

test.describe('configuração da coleta pelo WhatsApp', () => {
  test('mostra o canal desconectado com honestidade e persiste horário e prazos', async ({ page }) => {
    await page.goto('/dashboard/inspections/settings');
    const card = page.locator('section', { has: page.getByRole('heading', { name: /coleta pelo whatsapp/i }) });
    await expect(card).toBeVisible();
    await expect(card.getByText('Canal não conectado')).toBeVisible();
    await expect(card.getByText(/whaply/i).first()).toBeVisible();

    await card.getByLabel(/solicitar fotos automaticamente/i).check();
    await card.getByLabel(/horário do disparo/i).fill('08:30');
    await card.getByLabel(/lembrete após/i).fill('12');
    await card.getByLabel(/prazo da coleta/i).fill('48');
    await card.getByRole('button', { name: /salvar configuração/i }).click();
    await expect(page.getByText('Configuração do WhatsApp salva')).toBeVisible();

    const saved = await apiJson<{ settings: { enabled: boolean; sendTime: string; reminderAfterHours: number; collectionTtlHours: number } }>(
      page,
      '/inspection/whatsapp-settings',
    );
    expect(saved.settings).toMatchObject({ enabled: true, sendTime: '08:30', reminderAfterHours: 12, collectionTtlHours: 48 });

    await page.reload();
    await expect(card.getByLabel(/horário do disparo/i)).toHaveValue('08:30');
    await expect(card.getByLabel(/solicitar fotos automaticamente/i)).toBeChecked();
  });
});

test.describe('painel Mensagens WhatsApp', () => {
  test('é acessível pelo menu de Notificações e avisa que o canal não está conectado', async ({ page }) => {
    await page.goto('/dashboard');
    // Grupo do menu lateral (o sino do topo também se chama Notificações).
    const group = page.locator('button[aria-expanded]').filter({ hasText: 'Notificações' });
    if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click();
    await page.getByRole('link', { name: 'Mensagens WhatsApp' }).click();
    await expect(page).toHaveURL(/\/dashboard\/messages$/);
    await expect(page.getByRole('heading', { name: 'Mensagens WhatsApp' })).toBeVisible();
    await expect(page.getByText(/canal do whatsapp \(whaply\) não conectado/i)).toBeVisible();
  });

  test('visão geral exibe as métricas de envio e de coleta calculadas pela API', async ({ page }) => {
    const summary = await apiJson<{ messages: { total: number }; collections: { awaitingApproval: number } }>(page, '/messaging/summary');
    await page.goto('/dashboard/messages');
    for (const label of [
      'Solicitações de mensagem',
      'Em processamento',
      'Enviadas',
      'Entregues',
      'Lidas',
      'Com falha',
      'Aguardando nova tentativa',
      'Clientes que responderam',
      'Fotos incompletas',
      'Fotos completas',
      'Aguardando aprovação',
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    const awaiting = page.locator('.fo-card', { has: page.getByText('Aguardando aprovação', { exact: true }) });
    await expect(awaiting).toContainText(String(summary.collections.awaitingApproval));
    const total = page.locator('.fo-card', { has: page.getByText('Solicitações de mensagem', { exact: true }) });
    await expect(total).toContainText(String(summary.messages.total));
  });

  test('histórico filtra e mostra estado vazio sem inventar mensagens', async ({ page }) => {
    await page.goto('/dashboard/messages?tab=history');
    await expect(page.getByText('Nenhuma mensagem no período.')).toBeVisible();
    await page.getByLabel('Status do envio').selectOption('FAILED');
    await page.getByLabel(/requer ação manual/i).check();
    await expect(page.getByText('Nenhuma mensagem no período.')).toBeVisible();
  });

  test('custos: registra tarifa de referência e deixa claro que é estimativa, não cobrança', async ({ page }) => {
    await page.goto('/dashboard/messages?tab=costs');
    await expect(page.getByRole('note')).toContainText(/estimativa/i);
    await expect(page.getByRole('note')).toContainText(/fatura da meta/i);

    await page.getByLabel('Categoria').selectOption('UTILITY');
    await page.getByLabel('Moeda').selectOption('BRL');
    await page.getByLabel('Valor por mensagem').fill('0,0368');
    await page.getByLabel('Vigente desde').fill('2026-10-01');
    await page.getByLabel('Fonte').fill('Tabela oficial Meta — Brasil (teste E2E)');
    await page.getByRole('button', { name: /registrar tarifa/i }).click();
    await expect(page.getByText('Tarifa de referência registrada')).toBeVisible();
    await expect(page.getByText(/UTILITY · R\$\s*0,0368 desde 2026-10-01/)).toBeVisible();

    // Tarifa inválida é recusada pela API (sem fonte).
    await page.getByLabel('Valor por mensagem').fill('0,05');
    await page.getByLabel('Fonte').fill('');
    await page.getByRole('button', { name: /registrar tarifa/i }).click();
    await expect(page.getByText('Tarifa inválida')).toBeVisible();
  });

  test('fotos sem vínculo: estado vazio explícito', async ({ page }) => {
    await page.goto('/dashboard/messages?tab=unmatched');
    await expect(page.getByText('Nenhuma foto aguardando atribuição.')).toBeVisible();
  });
});

test.describe('revisão da vistoria: solicitar correção', () => {
  test('exige item e motivo; sem canal conectado a correção volta ao link web e a vistoria fica pendente', async ({ page }) => {
    const vehicles = await apiJson<{ data: Array<{ id: string; plate: string }> }>(page, '/vehicles?q=RVS9B58');
    const vehicle = vehicles.data.find((v) => v.plate === 'RVS9B58')!;
    await page.goto(`/dashboard/inspections/${vehicle.id}`);

    const card = page.locator('article', { hasText: 'Enviada' }).first();
    await card.getByRole('button').first().click(); // expande
    await card.getByRole('button', { name: /solicitar correção/i }).click();

    const dialog = page.getByRole('dialog', { name: /solicitar correção de fotos/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /^solicitar correção$/i }).click();
    await expect(page.getByText(/escolha ao menos um ângulo/i)).toBeVisible();

    await dialog.getByLabel('Quilometragem').check();
    await dialog.getByLabel(/motivo/i).fill('Quilometragem não confere com a foto do painel');
    await dialog.getByRole('button', { name: /^solicitar correção$/i }).click();
    await expect(page.getByText('Correção solicitada')).toBeVisible();
    await expect(page.getByText(/envie o link ao cliente manualmente/i)).toBeVisible();

    // Estado real na API: volta a Pendente, rodada 1, correção registrada.
    const history = await apiJson<{ data: Array<{ status: string; correctionRound: number; corrections: Array<{ reason: string }> }> }>(
      page,
      `/vehicles/${vehicle.id}/inspections`,
    );
    const corrected = history.data.find((i) => i.correctionRound === 1)!;
    expect(corrected.status).toBe('PENDING');
    expect(corrected.corrections[0]?.reason).toContain('Quilometragem');
    await expect(page.locator('article', { hasText: 'Pendente' }).first()).toBeVisible();
  });
});
