/**
 * Captura as telas da aplicação no mesmo viewport das referências
 * (1917 px de largura) para comparação visual lado a lado.
 *
 *   node e2e/capture-screens.mjs [--out dir] [--theme light|dark]
 *
 * Usa o Chrome instalado na máquina (`channel: 'chrome'`) para não
 * depender do download dos binários do Playwright.
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};

const BASE = getArg('base', 'http://localhost:5173');
const OUT = getArg('out', '.cache/screens');
const THEME = getArg('theme', 'light');
const EMAIL = getArg('email', 'erik@ffveiculos.example.com');
const PASSWORD = getArg('password', 'FrotaOne@2026');

const screens = [
  { name: '01-contas-a-pagar', path: '/dashboard/finance/accounts-payable' },
  { name: '03-nova-conta-a-pagar', path: '/dashboard/finance/accounts-payable/new' },
  { name: '05-relatorio-por-veiculo', path: '/dashboard/finance/reports/by-vehicle' },
  { name: '08-relatorio-por-cliente', path: '/dashboard/finance/reports/by-client' },
  { name: '09-dre-mensal', path: '/dashboard/finance/reports/dre' },
  { name: '11-colaboradores', path: '/dashboard/employees' },
  { name: '14-dashboard', path: '/dashboard' },
  { name: '16-meu-perfil', path: '/dashboard/profile' },
  { name: '18-assinatura', path: '/dashboard/subscription' },
  { name: '24-notificacoes', path: '/dashboard/notifications' },
  { name: '32-disparo-mensagens', path: '/dashboard/dispatch' },
  { name: '34-consulta-veiculos', path: '/dashboard/vehicles' },
  { name: '41-novo-veiculo', path: '/dashboard/vehicles/new' },
  { name: '43-importar-veiculos', path: '/dashboard/vehicles/import' },
  { name: '44-manutencoes', path: '/dashboard/maintenance' },
  { name: '55-vistorias', path: '/dashboard/inspections' },
  { name: '60-config-fotos', path: '/dashboard/inspections/settings' },
  { name: '62-consulta-motoristas', path: '/dashboard/drivers' },
  { name: '64-novo-motorista', path: '/dashboard/drivers/new' },
  { name: '66-consulta-locacoes', path: '/dashboard/rentals' },
  { name: '72-nova-locacao', path: '/dashboard/rentals/new' },
  { name: '80-dashboard-financeiro', path: '/dashboard/finance' },
  { name: '83-contas-bancarias', path: '/dashboard/finance/bank-accounts' },
  { name: '91-contas-a-receber', path: '/dashboard/finance/accounts-receivable' },
];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1917, height: 950 },
    deviceScaleFactor: 1,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    colorScheme: THEME === 'dark' ? 'dark' : 'light',
  });
  await context.addInitScript(
    ([theme]) => {
      try {
        localStorage.setItem('frotaone:theme', theme);
        localStorage.setItem('frotaone:sidebar-collapsed', 'true');
      } catch {
        /* ignore */
      }
    },
    [THEME],
  );

  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [console] ${msg.text().slice(0, 160)}`);
  });
  page.on('pageerror', (err) => console.log(`  [pageerror] ${err.message.slice(0, 160)}`));

  console.log('Autenticando…');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel('E-mail').fill(EMAIL);
  await page.getByPlaceholder('Sua senha').fill(PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL('**/dashboard**', { timeout: 20_000 });
  await page.waitForLoadState('networkidle');

  for (const screen of screens) {
    process.stdout.write(`  ${screen.name} … `);
    try {
      await page.goto(`${BASE}${screen.path}`, { waitUntil: 'networkidle', timeout: 30_000 });
      // O ponteiro fica onde foi o último clique e deixaria uma linha da
      // tabela em estado :hover na captura.
      await page.mouse.move(0, 0);
      await page.waitForTimeout(900); // gráficos ECharts
      await page.screenshot({ path: `${OUT}/${screen.name}.png` });
      console.log('ok');
    } catch (err) {
      console.log(`FALHOU: ${err.message.slice(0, 100)}`);
    }
  }

  // Sidebar expandida (págs. 8, 34, 41, 44, 66 da referência).
  await page.goto(`${BASE}/dashboard/vehicles`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Expandir menu' }).click().catch(() => undefined);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/34b-consulta-veiculos-sidebar-expandida.png` });

  await browser.close();
  console.log(`\nCapturas salvas em ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
