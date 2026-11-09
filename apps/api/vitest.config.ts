import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 600_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    env: {
      // Mantém o binário do MongoDB em memória dentro do repositório,
      // evitando depender do cache do diretório home.
      MONGOMS_DOWNLOAD_DIR: resolve(here, '../../.cache/mongodb-binaries'),
    },
  },
});
