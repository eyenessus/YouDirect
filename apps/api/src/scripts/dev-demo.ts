#!/usr/bin/env tsx
/**
 * Sobe a API completa com um MongoDB em memória (replica set) já
 * populado pelo seed — útil para demonstração, QA visual e E2E sem
 * depender de Docker. Os dados são descartados ao encerrar o processo.
 *
 *   npm run dev:demo -w @frotaone/api
 */
import { buildApp } from '../app.js';
import { buildContext } from '../context.js';
import { loadEnv, resetEnvCache } from '../config/env.js';
import { seed, TEST_USER_EMAIL, TEST_USER_PASSWORD } from '../database/seed.js';

async function main() {
  resetEnvCache();
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'development',
    MONGODB_URI: '',
    JOBS_ENABLED: 'false',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  } as NodeJS.ProcessEnv);

  console.log('Iniciando MongoDB em memória (replica set)…');
  const ctx = await buildContext({ env });

  console.log('Populando dados de demonstração…');
  await seed(ctx);

  const app = await buildApp(ctx);
  await app.listen({ port: env.PORT, host: env.HOST });

  console.log('');
  console.log('='.repeat(62));
  console.log('  FrotaOne — ambiente de demonstração pronto');
  console.log('='.repeat(62));
  console.log(`  API    : http://localhost:${env.PORT}/api/v1`);
  console.log(`  Web    : ${env.APP_URL}`);
  console.log(`  Login  : ${env.SEED_OWNER_EMAIL}`);
  console.log(`  Senha  : ${env.SEED_OWNER_PASSWORD}`);
  console.log(`  Teste  : ${TEST_USER_EMAIL}  /  ${TEST_USER_PASSWORD}`);
  console.log('='.repeat(62));
  console.log('  Os dados são descartados ao encerrar (Ctrl+C).');
  console.log('');

  const shutdown = async () => {
    await app.close();
    await ctx.mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
