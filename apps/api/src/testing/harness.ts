import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { buildContext, type AppContext } from '../context.js';
import { loadEnv, resetEnvCache, type Env } from '../config/env.js';

export interface TestHarness {
  app: FastifyInstance;
  ctx: AppContext;
  env: Env;
  close: () => Promise<void>;
}

let sharedPromise: Promise<TestHarness> | null = null;

/**
 * Sobe a API completa contra um MongoDB em memória com replica set
 * (transações habilitadas) e armazenamento local temporário.
 */
export async function createHarness(): Promise<TestHarness> {
  const storageDir = await mkdtemp(join(tmpdir(), 'yudirect-test-'));
  resetEnvCache();
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: '',
    MONGODB_DB: `yudirect_test_${Math.random().toString(36).slice(2, 8)}`,
    SESSION_SECRET: 'test-session-secret-at-least-16-chars',
    STORAGE_LOCAL_DIR: storageDir,
    JOBS_ENABLED: 'false',
    RATE_LIMIT_MAX: '100000',
    LOGIN_RATE_LIMIT_MAX: '100',
  } as NodeJS.ProcessEnv);

  const ctx = await buildContext({ env });
  const app = await buildApp(ctx);
  await app.ready();

  return {
    app,
    ctx,
    env,
    close: async () => {
      await app.close();
      await ctx.mongo.close();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}

/** Harness compartilhado entre arquivos de teste de um mesmo worker. */
export function sharedHarness(): Promise<TestHarness> {
  if (!sharedPromise) sharedPromise = createHarness();
  return sharedPromise;
}

export async function closeSharedHarness(): Promise<void> {
  if (sharedPromise) {
    const harness = await sharedPromise;
    await harness.close();
    sharedPromise = null;
  }
}

export function sessionCookie(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  const cookie = list.find((c) => typeof c === 'string' && c.startsWith('yudirect_session='));
  if (!cookie) throw new Error('Cookie de sessão não retornado.');
  return String(cookie).split(';')[0]!;
}
