import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { corsOrigins } from './config/env.js';
import type { AppContext } from './context.js';
import { authPlugin } from './plugins/auth.js';
import { errorsPlugin } from './plugins/errors.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerVehicleRoutes } from './modules/vehicles/routes.js';
import { registerDriverRoutes } from './modules/drivers/routes.js';
import { registerRentalRoutes } from './modules/rentals/routes.js';
import { registerMaintenanceRoutes } from './modules/maintenance/routes.js';
import { registerInspectionRoutes } from './modules/inspections/routes.js';
import { registerBankRoutes } from './modules/finance/bank.js';
import { registerAccountRoutes } from './modules/finance/accounts.js';
import { registerReportRoutes } from './modules/reports/routes.js';
import { registerNotificationRoutes } from './modules/notifications/routes.js';
import { registerOrganizationRoutes } from './modules/organization/routes.js';
import { registerFileRoutes } from './modules/files/routes.js';
import { openApiDocument } from './openapi.js';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: ctx.env.LOG_LEVEL,
      // Nunca registrar PII nem segredos nos logs.
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers.authorization',
          'req.body.password',
          'req.body.newPassword',
          'req.body.currentPassword',
          'req.body.cpf',
          'req.body.rg',
        ],
        remove: true,
      },
      ...(ctx.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
    },
    genReqId: () => randomUUID(),
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  await app.register(cors, {
    origin: corsOrigins(ctx.env),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie, { secret: ctx.env.SESSION_SECRET });

  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 10 },
    attachFieldsToBody: false,
  });

  await app.register(rateLimit, {
    max: ctx.env.RATE_LIMIT_MAX,
    timeWindow: ctx.env.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => `${request.ip}:${request.routeOptions?.url ?? request.url}`,
  });

  await app.register(errorsPlugin);
  await app.register(authPlugin, { ctx });

  /* ------------------- proteção CSRF (same-origin) ------------------ */
  const allowedOrigins = new Set(corsOrigins(ctx.env));
  app.addHook('onRequest', async (request) => {
    const method = request.method.toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
    const origin = request.headers.origin;
    if (!origin) return; // clientes não-browser (curl, testes)
    if (!allowedOrigins.has(origin)) {
      request.log.warn({ origin }, 'origem bloqueada');
      const { forbidden } = await import('./common/errors.js');
      throw forbidden('Origem não permitida.');
    }
  });

  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));
  app.get('/ready', async () => {
    await ctx.mongo.db.command({ ping: 1 });
    return {
      status: 'ready',
      transactions: ctx.mongo.supportsTransactions,
      storage: ctx.storage.name,
    };
  });

  await app.register(
    async (api) => {
      api.get('/openapi.json', async () => openApiDocument(ctx.env.API_PUBLIC_URL));
      await registerAuthRoutes(api);
      await registerFileRoutes(api);
      await registerVehicleRoutes(api);
      await registerDriverRoutes(api);
      await registerRentalRoutes(api);
      await registerMaintenanceRoutes(api);
      await registerInspectionRoutes(api);
      await registerBankRoutes(api);
      await registerAccountRoutes(api);
      await registerReportRoutes(api);
      await registerNotificationRoutes(api);
      await registerOrganizationRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
