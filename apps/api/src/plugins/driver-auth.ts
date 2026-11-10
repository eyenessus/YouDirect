import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { ObjectId } from 'mongodb';
import type { AppContext } from '../context.js';
import { unauthorized } from '../common/errors.js';
import { sha256 } from '../common/helpers.js';

/* ------------------------------------------------------------------ *
 * Sessão da Área do Motorista.
 * Cookie e coleção PRÓPRIOS (`yudirect_driver` / driverSessions): uma
 * sessão de motorista nunca vira `request.auth` e, portanto, nunca passa
 * por `requireAuth`/`requirePermission` das rotas da equipe.
 * ------------------------------------------------------------------ */

export const DRIVER_COOKIE = 'yudirect_driver';
export const DRIVER_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const TOUCH_EVERY_MS = 5 * 60 * 1000;

export interface DriverAuthContext {
  sessionId: ObjectId;
  driverId: ObjectId;
  organizationId: ObjectId;
}

declare module 'fastify' {
  interface FastifyRequest {
    driverAuth: DriverAuthContext | null;
  }
  interface FastifyInstance {
    requireDriver: (request: FastifyRequest) => Promise<void>;
  }
}

async function resolveDriverSession(ctx: AppContext, token: string): Promise<DriverAuthContext | null> {
  const session = await ctx.mongo.collections.driverSessions.findOne({ tokenHash: sha256(token), revokedAt: null });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  const driver = await ctx.mongo.collections.drivers.findOne(
    { _id: session.driverId, organizationId: session.organizationId },
    { projection: { status: 1, archivedAt: 1, anonymizedAt: 1 } },
  );
  if (!driver || driver.status !== 'ACTIVE' || driver.archivedAt || driver.anonymizedAt) return null;
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
    await ctx.mongo.collections.driverSessions.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } });
  }
  return { sessionId: session._id, driverId: session.driverId, organizationId: session.organizationId };
}

export const driverAuthPlugin = fp(async function driverAuthPlugin(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;
  app.decorateRequest('driverAuth', null);

  app.addHook('onRequest', async (request) => {
    request.driverAuth = null;
    const token = request.cookies?.[DRIVER_COOKIE];
    // Só as rotas do portal leem a sessão do motorista.
    if (token && request.url.startsWith('/api/v1/driver/')) {
      request.driverAuth = await resolveDriverSession(ctx, token);
    }
  });

  app.decorate('requireDriver', async (request: FastifyRequest) => {
    if (!request.driverAuth) throw unauthorized('Seu acesso expirou. Peça um novo link à locadora.');
  });
});

export function requireDriverContext(request: FastifyRequest): DriverAuthContext {
  if (!request.driverAuth) throw unauthorized('Seu acesso expirou. Peça um novo link à locadora.');
  return request.driverAuth;
}
