import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  businessDate,
  dispatchRequestSchema,
  dispatchRetrySchema,
  messageHistoryQuerySchema,
  messageTemplateInputSchema,
  notificationListQuerySchema,
  renderMessage,
  type Dispatch,
  type MessageTemplate,
  type Notification,
} from '@yudirect/contracts';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { decodeCursor, encodeCursor, toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';
import { runNotificationGenerators } from '../../services/notifications.js';
import type { MessageDispatchDoc, MessageTemplateDoc, NotificationDoc } from '../../database/types.js';

function toNotificationDTO(doc: NotificationDoc): Notification {
  return {
    id: doc._id.toHexString(),
    type: doc.type,
    severity: doc.severity,
    title: doc.title,
    message: doc.message,
    subjectLabel: doc.subjectLabel,
    entityType: doc.entityType,
    entityId: doc.entityId?.toHexString() ?? null,
    targetPath: doc.targetPath,
    readAt: doc.readAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
  };
}

function toTemplateDTO(doc: MessageTemplateDoc): MessageTemplate {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    body: doc.body,
    isDefault: doc.isDefault,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toDispatchDTO(doc: MessageDispatchDoc): Dispatch {
  const summary = {
    total: doc.deliveries.length,
    sent: doc.deliveries.filter((d) => d.status === 'SENT').length,
    failed: doc.deliveries.filter((d) => d.status === 'FAILED').length,
    pending: doc.deliveries.filter((d) => d.status === 'PENDING').length,
    unavailable: doc.deliveries.filter((d) => d.status === 'UNAVAILABLE').length,
  };
  return {
    id: doc._id.toHexString(),
    templateId: doc.templateId?.toHexString() ?? null,
    bodySnapshot: doc.bodySnapshot,
    providerAvailable: doc.providerAvailable,
    providerName: doc.providerName,
    summary,
    deliveries: doc.deliveries.map((d) => ({
      driverId: d.driverId.toHexString(),
      driverName: d.driverName,
      phone: d.phone,
      status: d.status,
      providerMessageId: d.providerMessageId,
      error: d.error,
      manualLink: d.manualLink,
      renderedBody: d.renderedBody,
    })),
    createdAt: doc.createdAt.toISOString(),
  };
}

const WELCOME_TEMPLATE_BODY = `Olá, *{{nome_motorista}}*! 👋

Bem-vindo(a)! A partir de agora você irá interagir com a *YuDirect* pela *{{nome_empresa}}*.

Fique atento(a) às mensagens — enviaremos avisos sobre vistorias, documentos e sua locação.

_Equipe {{nome_empresa}}_`;

export async function ensureDefaultTemplate(
  ctx: import('../../context.js').AppContext,
  organizationId: ObjectId,
): Promise<void> {
  const count = await ctx.mongo.collections.messageTemplates.countDocuments({ organizationId });
  if (count > 0) return;
  const now = new Date();
  await ctx.mongo.collections.messageTemplates.insertOne({
    _id: new ObjectId(),
    organizationId,
    name: 'Boas-vindas',
    body: WELCOME_TEMPLATE_BODY,
    isDefault: true,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  /* ---------------------------- listagem --------------------------- */
  app.get(
    '/notifications',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const query = notificationListQuerySchema.parse(request.query);

      const filter: Record<string, unknown> = { organizationId };
      if (query.type) filter.type = query.type;
      if (query.unread === true) filter.readAt = null;

      const cursor = decodeCursor<{ createdAt: string; id: string }>(query.cursor);
      if (cursor) {
        filter.$or = [
          { createdAt: { $lt: new Date(cursor.createdAt) } },
          { createdAt: new Date(cursor.createdAt), _id: { $lt: new ObjectId(cursor.id) } },
        ];
      }

      const docs = await ctx.mongo.collections.notifications
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(query.limit + 1)
        .toArray();
      const hasMore = docs.length > query.limit;
      const page = hasMore ? docs.slice(0, query.limit) : docs;
      const unread = await ctx.mongo.collections.notifications.countDocuments({
        organizationId,
        readAt: null,
      });

      return {
        data: page.map(toNotificationDTO),
        unread,
        page: {
          nextCursor: hasMore
            ? encodeCursor({
                createdAt: page[page.length - 1]!.createdAt.toISOString(),
                id: page[page.length - 1]!._id.toHexString(),
              })
            : null,
        },
      };
    },
  );

  app.get(
    '/notifications/unread-count',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const unread = await ctx.mongo.collections.notifications.countDocuments({
        organizationId,
        readAt: null,
      });
      return { unread };
    },
  );

  app.patch(
    '/notifications/:id/read',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const result = await ctx.mongo.collections.notifications.updateOne(
        { _id: id, organizationId, readAt: null },
        { $set: { readAt: new Date(), updatedAt: new Date() } },
      );
      if (result.matchedCount === 0) {
        const exists = await ctx.mongo.collections.notifications.countDocuments({ _id: id, organizationId });
        if (exists === 0) throw notFound('Notificação não encontrada.');
      }
      return { ok: true };
    },
  );

  app.post(
    '/notifications/mark-all-read',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const result = await ctx.mongo.collections.notifications.updateMany(
        { organizationId, readAt: null },
        { $set: { readAt: new Date(), updatedAt: new Date() } },
      );
      return { ok: true, updated: result.modifiedCount };
    },
  );

  /** Reprocessa os geradores de alerta sob demanda. */
  app.post(
    '/notifications/refresh',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const created = await runNotificationGenerators(ctx, organizationId, businessDate());
      return { ok: true, created };
    },
  );

  /* ---------------------------- templates -------------------------- */
  app.get(
    '/message-templates',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      await ensureDefaultTemplate(ctx, organizationId);
      const docs = await ctx.mongo.collections.messageTemplates
        .find({ organizationId })
        .sort({ isDefault: -1, name: 1 })
        .toArray();
      return { data: docs.map(toTemplateDTO) };
    },
  );

  app.post(
    '/message-templates',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'dispatch')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = messageTemplateInputSchema.parse(request.body);
      const now = new Date();
      const doc: MessageTemplateDoc = {
        _id: new ObjectId(),
        organizationId: auth.organizationId,
        name: body.name,
        body: body.body,
        isDefault: false,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.mongo.collections.messageTemplates.insertOne(doc);
      reply.status(201);
      return toTemplateDTO(doc);
    },
  );

  app.patch(
    '/message-templates/:id',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'dispatch')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = messageTemplateInputSchema.partial().parse(request.body);
      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name !== undefined) set.name = body.name;
      if (body.body !== undefined) set.body = body.body;
      const doc = await ctx.mongo.collections.messageTemplates.findOneAndUpdate(
        { _id: id, organizationId: auth.organizationId },
        { $set: set },
        { returnDocument: 'after' },
      );
      if (!doc) throw notFound('Template não encontrado.');
      return toTemplateDTO(doc);
    },
  );

  app.delete(
    '/message-templates/:id',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'dispatch')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const doc = await ctx.mongo.collections.messageTemplates.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!doc) throw notFound('Template não encontrado.');
      if (doc.isDefault) throw conflict('O template padrão não pode ser excluído.');
      await ctx.mongo.collections.messageTemplates.deleteOne({ _id: id });
      return { ok: true };
    },
  );

  /* ----------------------------- disparo --------------------------- */
  app.post(
    '/message-dispatches',
    {
      onRequest: [app.requireAuth, app.requirePermission('notifications', 'dispatch')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = dispatchRequestSchema.parse(request.body);

      const organization = await ctx.mongo.collections.organizations.findOne({
        _id: auth.organizationId,
      });
      const driverIds = body.driverIds.map((id) => toObjectId(id, 'driverIds'));
      const drivers = await ctx.mongo.collections.drivers
        .find({ organizationId: auth.organizationId, _id: { $in: driverIds }, archivedAt: null })
        .toArray();
      if (drivers.length === 0) throw badRequest('Nenhum motorista válido selecionado.');

      const waStatus = ctx.integrations.whatsapp.status();
      const dispatchId = new ObjectId();
      const now = new Date();

      const deliveries: MessageDispatchDoc['deliveries'] = [];
      for (const driver of drivers) {
        const renderedBody = renderMessage(body.body, {
          driverName: driver.fullName,
          companyName: organization?.name ?? '',
        });
        const idempotencyKey = `${dispatchId.toHexString()}:${driver._id.toHexString()}`;
        const result = await ctx.integrations.whatsapp.send(driver.phone, renderedBody, idempotencyKey);
        deliveries.push({
          driverId: driver._id,
          driverName: driver.fullName,
          phone: driver.phone,
          renderedBody,
          status: result.delivered ? 'SENT' : waStatus.connected ? 'FAILED' : 'UNAVAILABLE',
          providerMessageId: result.providerMessageId,
          error: result.error,
          manualLink: result.manualLink,
          idempotencyKey,
          updatedAt: new Date(),
        });
      }

      const doc: MessageDispatchDoc = {
        _id: dispatchId,
        organizationId: auth.organizationId,
        templateId: body.templateId ? toObjectId(body.templateId, 'templateId') : null,
        bodySnapshot: body.body,
        providerName: waStatus.name,
        providerAvailable: waStatus.connected,
        deliveries,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.mongo.collections.messageDispatches.insertOne(doc);
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'dispatch.created',
        entityType: 'messageDispatch',
        entityId: dispatchId,
        after: { recipients: deliveries.length, providerAvailable: waStatus.connected },
      });

      reply.status(201);
      return toDispatchDTO(doc);
    },
  );

  app.get(
    '/message-dispatches',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const query = messageHistoryQuerySchema.parse(request.query);
      const docs = await ctx.mongo.collections.messageDispatches
        .find({ organizationId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(query.limit)
        .toArray();
      return { data: docs.map(toDispatchDTO) };
    },
  );

  app.get(
    '/message-dispatches/:id',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const doc = await ctx.mongo.collections.messageDispatches.findOne({ _id: id, organizationId });
      if (!doc) throw notFound('Disparo não encontrado.');
      return toDispatchDTO(doc);
    },
  );

  app.post(
    '/message-dispatches/:id/retry',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'dispatch')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = dispatchRetrySchema.parse(request.body ?? {});
      const doc = await ctx.mongo.collections.messageDispatches.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!doc) throw notFound('Disparo não encontrado.');

      const waStatus = ctx.integrations.whatsapp.status();
      if (!waStatus.connected) {
        throw conflict(waStatus.message);
      }

      const only = body.driverIds ? new Set(body.driverIds) : null;
      for (const delivery of doc.deliveries) {
        if (delivery.status === 'SENT') continue;
        if (only && !only.has(delivery.driverId.toHexString())) continue;
        const result = await ctx.integrations.whatsapp.send(
          delivery.phone,
          delivery.renderedBody,
          delivery.idempotencyKey,
        );
        delivery.status = result.delivered ? 'SENT' : 'FAILED';
        delivery.providerMessageId = result.providerMessageId;
        delivery.error = result.error;
        delivery.manualLink = result.manualLink;
        delivery.updatedAt = new Date();
      }
      await ctx.mongo.collections.messageDispatches.updateOne(
        { _id: id },
        { $set: { deliveries: doc.deliveries, updatedAt: new Date() } },
      );
      return toDispatchDTO(doc);
    },
  );

  /** Status das integrações exibido na interface (sem simulações). */
  app.get('/integrations/status', { onRequest: [app.requireAuth] }, async (request) => {
    const ctx = request.appCtx;
    return {
      whatsapp: ctx.integrations.whatsapp.status(),
      email: ctx.integrations.email.status(),
      postalCode: ctx.integrations.postalCode.status(),
      trafficFines: ctx.integrations.trafficFines.status(),
      billing: ctx.integrations.billing.status(),
    };
  });
}
