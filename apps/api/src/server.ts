import { buildApp } from './app.js';
import { buildContext } from './context.js';
import { loadEnv } from './config/env.js';
import { startScheduler } from './jobs/scheduler.js';

async function main() {
  const env = loadEnv();
  const ctx = await buildContext({ env });
  const app = await buildApp(ctx);

  if (!env.MONGODB_URI) {
    app.log.warn(
      'MONGODB_URI não definido — um MongoDB em memória (replica set) foi iniciado. Os dados são descartados ao encerrar.',
    );
  }
  if (!ctx.mongo.supportsTransactions) {
    app.log.warn(
      'MongoDB sem replica set: transações multi-documento indisponíveis. As operações financeiras continuam idempotentes, mas sem atomicidade total.',
    );
  }

  const stopScheduler = startScheduler(ctx, app.log);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'encerrando…');
    stopScheduler();
    await app.close();
    await ctx.mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`YuDirect API em http://${env.HOST}:${env.PORT}/api/v1`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
