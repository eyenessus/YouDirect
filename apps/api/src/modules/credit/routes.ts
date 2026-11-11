import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  creditCheckRequestSchema,
  creditCheckStatusSchema,
  creditPurposeSchema,
  creditReviewSchema,
  creditSettingsSchema,
  isoDateSchema,
  objectIdSchema,
} from '@yudirect/contracts';
import type { Filter } from 'mongodb';
import { notFound } from '../../common/errors.js';
import { toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';
import {
  creditIntegrationStatus,
  creditSettingsOf,
  creditUsage,
  requestCreditCheck,
  reviewCreditCheck,
  toCreditCheckDTOs,
} from '../../services/credit.js';
import type { CreditCheckDoc } from '../../database/types.js';

const historyQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  status: creditCheckStatusSchema.optional(),
  purpose: creditPurposeSchema.optional(),
  requestedBy: objectIdSchema.optional(),
  driverId: objectIdSchema.optional(),
  cursor: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/**
 * Análise de crédito (Serasa). Permissões no módulo `credit`:
 * read = ver relatórios/histórico, request = consulta paga, review = decisão.
 * Configuração e teste de credencial: só dono/administrador.
 * Nada disto é exposto à Área do Motorista, ao site público ou a automações.
 */
export async function registerCreditRoutes(app: FastifyInstance, options: { requestRateLimit?: number } = {}): Promise<void> {
  app.get('/credit/status', { onRequest: [app.requireAuth, app.requirePermission('credit', 'read')] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    return creditIntegrationStatus(request.appCtx, organizationId);
  });

  app.get('/credit/settings', { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const org = await request.appCtx.mongo.collections.organizations.findOne({ _id: organizationId }, { projection: { settings: 1 } });
    return creditSettingsOf(org?.settings);
  });

  app.put('/credit/settings', { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const settings = creditSettingsSchema.parse(request.body);
    const org = await ctx.mongo.collections.organizations.findOne({ _id: auth.organizationId }, { projection: { settings: 1 } });
    await ctx.mongo.collections.organizations.updateOne({ _id: auth.organizationId }, { $set: { 'settings.credit': settings, updatedAt: new Date() } });
    await audit(ctx, {
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: 'credit.settings',
      entityType: 'organization',
      entityId: auth.organizationId,
      before: creditSettingsOf(org?.settings),
      after: settings,
    });
    return settings;
  });

  /** Valida a credencial sem consultar CPF (não gera cobrança). */
  app.post(
    '/credit/test-auth',
    { onRequest: [app.requireAuth, app.requireOwnerOrAdmin], config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const result = await ctx.integrations.credit.testAuth();
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'credit.auth_tested',
        entityType: 'organization',
        entityId: auth.organizationId,
        after: { ok: result.ok, environment: ctx.integrations.credit.environment() },
      });
      return result;
    },
  );

  app.post(
    '/drivers/:id/credit-checks',
    { onRequest: [app.requireAuth, app.requirePermission('credit', 'request')], config: { rateLimit: { max: options.requestRateLimit ?? 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const auth = requireAuthContext(request);
      const body = creditCheckRequestSchema.parse(request.body);
      const result = await requestCreditCheck(request.appCtx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        driverId: toObjectId((request.params as { id: string }).id),
        body,
      });
      reply.status(result.reused ? 200 : 201);
      return result;
    },
  );

  /** Consultas do motorista com o relatório (enquanto não expirou). Leitura auditada. */
  app.get('/drivers/:id/credit-checks', { onRequest: [app.requireAuth, app.requirePermission('credit', 'read')] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const driverId = toObjectId((request.params as { id: string }).id);
    const driver = await ctx.mongo.collections.drivers.findOne({ _id: driverId, organizationId: auth.organizationId }, { projection: { _id: 1 } });
    if (!driver) throw notFound('Motorista não encontrado.');
    const docs = await ctx.mongo.collections.creditChecks
      .find({ organizationId: auth.organizationId, driverId })
      .sort({ requestedAt: -1 })
      .limit(20)
      .toArray();
    // O relatório só vai junto na consulta mais recente com conteúdo; as demais mostram o registro.
    const latestWithReport = docs.find((d) => d.reportEncrypted);
    const data = await Promise.all(
      docs.map(async (d) => (await toCreditCheckDTOs(ctx, [d], { includeReport: d === latestWithReport }))[0]!),
    );
    if (latestWithReport) {
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'credit.report_viewed',
        entityType: 'creditCheck',
        entityId: latestWithReport._id,
      });
    }
    return { data };
  });

  app.get('/credit-checks/:id', { onRequest: [app.requireAuth, app.requirePermission('credit', 'read')] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const doc = await ctx.mongo.collections.creditChecks.findOne({
      _id: toObjectId((request.params as { id: string }).id),
      organizationId: auth.organizationId,
    });
    if (!doc) throw notFound('Consulta não encontrada.');
    if (doc.reportEncrypted) {
      await audit(ctx, { organizationId: auth.organizationId, actorId: auth.userId, action: 'credit.report_viewed', entityType: 'creditCheck', entityId: doc._id });
    }
    return (await toCreditCheckDTOs(ctx, [doc], { includeReport: true }))[0];
  });

  app.post('/credit-checks/:id/review', { onRequest: [app.requireAuth, app.requirePermission('credit', 'review')] }, async (request) => {
    const auth = requireAuthContext(request);
    return reviewCreditCheck(request.appCtx, {
      organizationId: auth.organizationId,
      actorId: auth.userId,
      checkId: toObjectId((request.params as { id: string }).id),
      body: creditReviewSchema.parse(request.body),
    });
  });

  /** Histórico (sem o conteúdo dos relatórios). */
  app.get('/credit-checks', { onRequest: [app.requireAuth, app.requirePermission('credit', 'read')] }, async (request) => {
    const ctx = request.appCtx;
    const { organizationId } = requireAuthContext(request);
    const q = historyQuerySchema.parse(request.query);
    const filter: Filter<CreditCheckDoc> = { organizationId };
    if (q.status) filter.status = q.status;
    if (q.purpose) filter.purpose = q.purpose;
    if (q.requestedBy) filter.requestedBy = toObjectId(q.requestedBy);
    if (q.driverId) filter.driverId = toObjectId(q.driverId);
    if (q.from || q.to) {
      filter.requestedAt = {
        ...(q.from ? { $gte: new Date(`${q.from}T00:00:00-03:00`) } : {}),
        ...(q.to ? { $lt: new Date(new Date(`${q.to}T00:00:00-03:00`).getTime() + 86_400_000) } : {}),
      };
    }
    if (q.cursor) filter._id = { $lt: toObjectId(q.cursor) };
    const docs = await ctx.mongo.collections.creditChecks.find(filter).sort({ _id: -1 }).limit(q.limit + 1).toArray();
    const page = docs.slice(0, q.limit);
    return {
      data: await toCreditCheckDTOs(ctx, page, { includeReport: false }),
      page: { nextCursor: docs.length > q.limit ? page[page.length - 1]!._id.toHexString() : null },
    };
  });

  app.get('/credit/usage', { onRequest: [app.requireAuth, app.requirePermission('credit', 'read')] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const { months } = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }).parse(request.query);
    return creditUsage(request.appCtx, organizationId, months);
  });
}
