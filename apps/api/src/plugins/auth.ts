import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { ObjectId } from 'mongodb';
import { can, hasModule, type PermissionAction, type PermissionModule } from '@frotaone/contracts';
import type { AppContext, AuthContext } from '../context.js';
import { forbidden, unauthorized } from '../common/errors.js';
import { sha256 } from '../common/helpers.js';

declare module 'fastify' {
  interface FastifyRequest {
    appCtx: AppContext;
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest) => Promise<void>;
    requirePermission: (
      mod: PermissionModule,
      action: PermissionAction,
    ) => (request: FastifyRequest) => Promise<void>;
    requireOwnerOrAdmin: (request: FastifyRequest) => Promise<void>;
  }
}

async function resolveSession(ctx: AppContext, token: string): Promise<AuthContext | null> {
  const tokenHash = sha256(token);
  const session = await ctx.mongo.collections.sessions.findOne({ tokenHash, revokedAt: null });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;

  const membership = await ctx.mongo.collections.memberships.findOne({
    organizationId: session.organizationId,
    userId: session.userId,
    status: 'ACTIVE',
  });
  if (!membership) return null;

  const user = await ctx.mongo.collections.users.findOne({ _id: session.userId, status: 'ACTIVE' });
  if (!user) return null;

  return {
    sessionId: session._id,
    userId: session.userId,
    organizationId: session.organizationId,
    role: membership.role,
    permissions: membership.permissions ?? {},
  };
}

export const authPlugin = fp(async function authPlugin(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;

  app.decorateRequest('appCtx', null as unknown as AppContext);
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (request) => {
    request.appCtx = ctx;
    request.auth = null;
    const token = request.cookies?.[ctx.env.SESSION_COOKIE_NAME];
    if (token) {
      request.auth = await resolveSession(ctx, token);
    }
  });

  app.decorate('requireAuth', async (request: FastifyRequest) => {
    if (!request.auth) throw unauthorized();
  });

  app.decorate(
    'requirePermission',
    (mod: PermissionModule, action: PermissionAction) => async (request: FastifyRequest) => {
      if (!request.auth) throw unauthorized();
      const { role, permissions } = request.auth;
      if (!hasModule(role, permissions, mod)) {
        throw forbidden(`Seu perfil não tem acesso ao módulo "${mod}".`);
      }
      if (!can(role, permissions, mod, action)) {
        throw forbidden('Você não tem permissão para esta ação.');
      }
    },
  );

  app.decorate('requireOwnerOrAdmin', async (request: FastifyRequest) => {
    if (!request.auth) throw unauthorized();
    if (request.auth.role !== 'OWNER' && request.auth.role !== 'ADMIN') {
      throw forbidden('Apenas o proprietário ou administradores podem executar esta ação.');
    }
  });
});

/** Atalho tipado para handlers autenticados. */
export function requireAuthContext(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export function orgFilter(request: FastifyRequest): { organizationId: ObjectId } {
  return { organizationId: requireAuthContext(request).organizationId };
}
