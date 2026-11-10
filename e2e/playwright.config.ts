import { defineConfig, devices } from '@playwright/test';

/**
 * E2E contra a aplicação real: a API sobe com `dev:demo` (MongoDB em
 * memória com replica set, já populado pelo seed) e o front em modo
 * `preview` sobre o build de produção.
 *
 *   npm run test:e2e
 *
 * Usa o Chrome instalado na máquina (`channel: 'chrome'`) para não
 * exigir o download dos binários do Playwright. Defina
 * `E2E_BASE_URL` para apontar para uma instância já em execução — nesse
 * caso nenhum servidor é iniciado.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:4173';
const external = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { outputFolder: '../.cache/playwright-report', open: 'never' }]],
  outputDir: '../.cache/playwright-artifacts',
  use: {
    baseURL,
    channel: 'chrome',
    viewport: { width: 1600, height: 1000 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Autentica uma única vez; os demais testes reaproveitam o cookie.
    { name: 'setup', testMatch: /auth.setup.ts$/ },
    {
      name: 'desktop',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
        storageState: '.cache/e2e-auth.json',
      },
    },
  ],
  webServer: external
    ? undefined
    : [
        {
          command: 'npm run dev:demo -w @yudirect/api',
          cwd: '..',
          url: 'http://localhost:3333/health',
          // O front de teste roda em `vite preview` (4173): a API precisa aceitar essa origem
          // (proteção CSRF por Origin) e gerar links públicos para ela.
          env: { CORS_ORIGINS: 'http://localhost:5173,http://localhost:4173', APP_URL: 'http://localhost:4173' },
          reuseExistingServer: !process.env.CI,
          timeout: 300_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
        {
          // Executado de dentro de apps/web: usa o Vite local, sem -w.
          command: 'npx vite build && npx vite preview --port 4173 --strictPort',
          cwd: '../apps/web',
          url: 'http://localhost:4173',
          reuseExistingServer: !process.env.CI,
          timeout: 300_000,
          env: { VITE_API_PROXY: 'http://localhost:3333' },
        },
      ],
});
