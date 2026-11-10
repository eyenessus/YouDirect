/**
 * Cria a organização inicial e o usuário proprietário (OWNER) em um
 * banco VAZIO — sem dados de demonstração. Recusa rodar se já existir
 * algum usuário, para nunca sobrescrever um ambiente em uso.
 *
 *   BOOTSTRAP_EMAIL=... BOOTSTRAP_PASSWORD=... BOOTSTRAP_NAME=... \
 *   BOOTSTRAP_ORG=... node apps/api/dist/scripts/bootstrap.js
 */
import { ObjectId } from 'mongodb';
import { fullMatrix } from '@yudirect/contracts';
import { loadDotEnv, loadEnv } from '../config/env.js';
import { buildContext } from '../context.js';
import { hashPassword } from '../common/helpers.js';
import { ensureDefaultCategories } from '../modules/finance/accounts.js';
import { ensureDefaultTemplate } from '../modules/notifications/routes.js';

async function main() {
  loadDotEnv();
  const email = process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_PASSWORD;
  const name = process.env.BOOTSTRAP_NAME?.trim() || 'Administrador';
  const orgName = process.env.BOOTSTRAP_ORG?.trim() || 'YuDirect';
  if (!email || !password || password.length < 10) {
    console.error('Defina BOOTSTRAP_EMAIL e BOOTSTRAP_PASSWORD (mín. 10 caracteres).');
    process.exit(1);
  }
  const env = loadEnv();
  if (!env.MONGODB_URI) {
    console.error('Defina MONGODB_URI.');
    process.exit(1);
  }
  const ctx = await buildContext({ env });
  const c = ctx.mongo.collections;
  if ((await c.users.countDocuments()) > 0) {
    console.error('O banco já possui usuários — nada foi alterado.');
    await ctx.mongo.close();
    process.exit(1);
  }

  const now = new Date();
  const organizationId = new ObjectId();
  const userId = new ObjectId();
  await c.organizations.insertOne({
    _id: organizationId,
    name: orgName,
    legalId: null,
    timezone: 'America/Sao_Paulo',
    currency: 'BRL',
    settings: { freeSeats: 3, extraSeatPriceCents: 990 },
    createdAt: now,
    updatedAt: now,
  } as never);
  await c.users.insertOne({
    _id: userId,
    name,
    emailLower: email,
    passwordHash: await hashPassword(password),
    phone: null,
    status: 'ACTIVE',
    browserNotificationsEnabled: false,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  } as never);
  await c.memberships.insertOne({
    _id: new ObjectId(),
    organizationId,
    userId,
    role: 'OWNER',
    permissions: fullMatrix(),
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  });
  await ensureDefaultCategories(ctx, organizationId);
  await ensureDefaultTemplate(ctx, organizationId);

  console.log(`Organização "${orgName}" e usuário ${email} (OWNER) criados.`);
  await ctx.mongo.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
