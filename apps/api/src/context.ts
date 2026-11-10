import { ObjectId } from 'mongodb';
import type { PermissionMatrix, MembershipRole } from '@yudirect/contracts';
import { loadEnv, piiLegacySecret, type Env } from './config/env.js';
import { connectMongo, type MongoContext } from './database/mongo.js';
import { ensureIndexes } from './database/indexes.js';
import { createIntegrations, type Integrations } from './integrations/index.js';
import { createStorageDriver, type StorageDriver } from './storage/index.js';
import { PiiCipher } from './common/crypto-pii.js';

export interface AppContext {
  env: Env;
  mongo: MongoContext;
  storage: StorageDriver;
  integrations: Integrations;
  pii: PiiCipher;
}

export interface AuthContext {
  sessionId: ObjectId;
  userId: ObjectId;
  organizationId: ObjectId;
  role: MembershipRole;
  permissions: PermissionMatrix;
}

export interface BuildContextOptions {
  env?: Env;
  skipIndexes?: boolean;
}

export async function buildContext(options: BuildContextOptions = {}): Promise<AppContext> {
  const env = options.env ?? loadEnv();
  const mongo = await connectMongo(env);
  if (!options.skipIndexes) await ensureIndexes(mongo);
  return {
    env,
    mongo,
    storage: createStorageDriver(env, mongo.db),
    integrations: createIntegrations(env),
    pii: new PiiCipher({
      legacySecret: piiLegacySecret(env),
      current: env.PII_KEY ? { kid: env.PII_KEY_ID, secret: env.PII_KEY } : null,
      previous:
        env.PII_KEY_PREVIOUS && env.PII_KEY_PREVIOUS_ID
          ? [{ kid: env.PII_KEY_PREVIOUS_ID, secret: env.PII_KEY_PREVIOUS }]
          : [],
      // Falha de decifração nunca é silenciosa (dado sumiria da interface).
      onError: ({ kid, reason }) => console.error(`[pii] não foi possível decifrar dados da chave "${kid}": ${reason}`),
    }),
  };
}
