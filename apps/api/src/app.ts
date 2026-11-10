import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { corsOrigins } from './config/env.js';
import type { AppContext } from './context.js';
import { authPlugin } from './plugins/auth.js';
import { errorsPlugin } from './plugins/errors.js';
import { registerAuthRoutes } from './modules/auth/routes.js';
import { registerVehicleRoutes } from './modules/vehicles/routes.js';
import { registerExportRoutes } from './modules/exports/routes.js';
import { registerAuditRoutes } from './modules/audit/routes.js';
import { registerDriverRoutes } from './modules/drivers/routes.js';
import { registerRentalRoutes } from './modules/rentals/routes.js';
import { registerRentalPaymentRoutes } from './modules/rentals/payments.js';
import { registerMaintenanceRoutes } from './modules/maintenance/routes.js';
import { registerFineRoutes } from './modules/fines/routes.js';
import { registerInspectionRoutes } from './modules/inspections/routes.js';
import { registerBankRoutes } from './modules/finance/bank.js';
import { registerAccountRoutes } from './modules/finance/accounts.js';
import { registerReportRoutes } from './modules/reports/routes.js';
import { registerNotificationRoutes } from './modules/notifications/routes.js';
import { registerOrganizationRoutes } from './modules/organization/routes.js';
import { registerFileRoutes } from './modules/files/routes.js';
import { registerWhatsappRoutes } from './modules/whatsapp/routes.js';
import { openApiDocument } from './openapi.js';
import { redactUrl } from './common/helpers.js';

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
      // A URL pode carregar credenciais (token da vistoria pública, do
      // convite, assinatura de arquivo): nunca vai inteira para o log.
      serializers: {
        req(request: { method: string; url: string; ip?: string; id?: string }) {
          return { method: request.method, url: redactUrl(request.url), remoteAddress: request.ip, id: request.id };
        },
      },
      ...(ctx.env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
    },
    genReqId: () => randomUUID(),
    // Exatamente UM proxy confiável (o roteador do Heroku). `true` faria o
    // IP vir do X-Forwarded-For enviado pelo cliente — e o limite de
    // tentativas de login seria contornado trocando o cabeçalho.
    trustProxy: 1,
    bodyLimit: 2 * 1024 * 1024,
  });

  const selfOrigins = [...new Set([ctx.env.APP_URL, ctx.env.API_PUBLIC_URL].map((u) => new URL(u).origin))];
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Vue aplica estilos inline (bindings :style) e o ECharts também.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        // Fotos vêm por URL assinada da própria API (que pode estar em outro domínio).
        imgSrc: ["'self'", 'data:', 'blob:', ...selfOrigins],
        connectSrc: ["'self'", ...selfOrigins],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cors, {
    origin: corsOrigins(ctx.env),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await app.register(cookie, { secret: ctx.env.SESSION_SECRET });

  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 10 },
    attachFieldsToBody: false,
  });

  await app.register(rateLimit, {
    max: ctx.env.RATE_LIMIT_MAX,
    timeWindow: ctx.env.RATE_LIMIT_WINDOW,
    keyGenerator: (request) => `${request.ip}:${request.routeOptions?.url ?? request.url}`,
  });

  // Front compilado (apps/web/dist): servido pela própria API para que
  // um único processo atenda app e API na mesma origem (ex.: Heroku).
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false, index: ['index.html'] });
  }

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
      await registerAuthRoutes(api, { loginRateLimit: ctx.env.LOGIN_RATE_LIMIT_MAX });
      await registerFileRoutes(api);
      await registerVehicleRoutes(api);
      await registerDriverRoutes(api);
      await registerRentalRoutes(api);
      await registerRentalPaymentRoutes(api);
      await registerMaintenanceRoutes(api);
      await registerFineRoutes(api);
      await registerInspectionRoutes(api);
      await registerBankRoutes(api);
      await registerAccountRoutes(api);
      await registerReportRoutes(api);
      await registerNotificationRoutes(api);
      await registerOrganizationRoutes(api);
      await registerWhatsappRoutes(api);
      await registerExportRoutes(api);
      await registerAuditRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
