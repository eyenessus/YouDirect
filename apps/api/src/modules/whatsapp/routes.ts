import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  addDaysIso,
  can,
  collectionStatusLabels,
  correctionRequestSchema,
  DEFAULT_INSPECTION_WHATSAPP_SETTINGS,
  driverConsentUpdateSchema,
  inspectionWhatsappSettingsSchema,
  maskPhone,
  messageKindLabels,
  messageStatusLabels,
  messagingListQuerySchema,
  messagingRateSchema,
  whaplyEventEnvelopeSchema,
  type MessageStatus,
} from '@yudirect/contracts';
import { AppError, badRequest, conflict, notFound } from '../../common/errors.js';
import { toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';
import { fileUrl } from '../../services/files.js';
import {
  assignUnmatchedMedia,
  getWhatsappSettings,
  ingestWhaplyEvent,
  localDateTimeToUtc,
  requestCorrection,
  resendMessage,
  retryFailedMessage,
} from '../../services/whatsapp-inspection.js';
import { verifySignature, type SigningKey } from '../../integrations/whaply/signing.js';
import type { AppContext } from '../../context.js';
import type { WhatsappMessageDoc } from '../../database/types.js';

/* ------------------------------------------------------------------ *
 * Rotas da coleta de vistoria pelo WhatsApp (Whaply).
 * Plano: docs/architecture/yudirect-whaply-vistoria-plan.md §5 e §10.
 * ------------------------------------------------------------------ */

const PROCESSING: MessageStatus[] = ['INTENT_CREATED', 'SUBMITTED_TO_WHAPLY', 'ACCEPTED_BY_WHAPLY', 'DEFERRED', 'ACCEPTED_BY_META'];
const SENT_OR_BETTER: MessageStatus[] = ['SENT', 'DELIVERED', 'READ'];

function inboundKeys(ctx: AppContext): SigningKey[] {
  const keys: SigningKey[] = [];
  if (ctx.env.WHAPLY_INBOUND_KEY_ID && ctx.env.WHAPLY_INBOUND_SECRET) {
    keys.push({ keyId: ctx.env.WHAPLY_INBOUND_KEY_ID, secret: ctx.env.WHAPLY_INBOUND_SECRET });
  }
  if (ctx.env.WHAPLY_INBOUND_KEY_ID_NEXT && ctx.env.WHAPLY_INBOUND_SECRET_NEXT) {
    keys.push({ keyId: ctx.env.WHAPLY_INBOUND_KEY_ID_NEXT, secret: ctx.env.WHAPLY_INBOUND_SECRET_NEXT });
  }
  return keys;
}

class IntegrationAuthError extends AppError {
  constructor(public readonly reason: string) {
    super('UNAUTHORIZED', 'Assinatura de integração inválida.');
  }
}

/** Autenticação dos eventos: HMAC + relógio + nonce persistido (replay). */
async function authenticateWhaply(request: FastifyRequest, rawBody: string): Promise<void> {
  const ctx = request.appCtx;
  if (!ctx.integrations.whaply.status().connected) {
    throw new AppError('INTEGRATION_UNAVAILABLE', 'Integração com o Whaply desligada.');
  }
  const result = verifySignature({
    keys: inboundKeys(ctx),
    headers: request.headers as Record<string, string | string[] | undefined>,
    method: request.method,
    path: request.url,
    body: rawBody,
  });
  if (!result.ok) {
    request.log.warn({ reason: result.reason, keyId: result.keyId }, 'evento do Whaply rejeitado');
    throw new IntegrationAuthError(result.reason ?? 'SIGNATURE_INVALID');
  }
  try {
    await ctx.mongo.collections.integrationNonces.insertOne({
      _id: `${result.keyId}:${result.nonce}`,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      request.log.warn({ keyId: result.keyId }, 'nonce repetido (replay) rejeitado');
      throw new IntegrationAuthError('NONCE_REPLAY');
    }
    throw err;
  }
}

function canSeePhone(request: FastifyRequest): boolean {
  const auth = requireAuthContext(request);
  return can(auth.role, auth.permissions, 'drivers', 'read');
}

function messageNeedsAction(m: WhatsappMessageDoc): boolean {
  return m.status === 'FAILED' || (m.status === 'RETRY_SCHEDULED' && m.attempts >= 3);
}

async function toMessageDTOs(ctx: AppContext, docs: WhatsappMessageDoc[], showPhone: boolean) {
  const inspectionIds = [...new Set(docs.map((d) => d.inspectionId?.toHexString()).filter(Boolean))].map(
    (s) => new ObjectId(s!),
  );
  const inspections = await ctx.mongo.collections.inspections
    .find({ _id: { $in: inspectionIds } }, { projection: { vehicleId: 1, status: 1, collection: 1, photos: 1 } })
    .toArray();
  const vehicleIds = [...new Set(inspections.map((i) => i.vehicleId.toHexString()))].map((s) => new ObjectId(s));
  const vehicles = await ctx.mongo.collections.vehicles
    .find({ _id: { $in: vehicleIds } }, { projection: { plate: 1, brand: 1, model: 1 } })
    .toArray();
  const iMap = new Map(inspections.map((i) => [i._id.toHexString(), i]));
  const vMap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));

  return docs.map((d) => {
    const inspection = d.inspectionId ? iMap.get(d.inspectionId.toHexString()) : undefined;
    const vehicle = inspection ? vMap.get(inspection.vehicleId.toHexString()) : undefined;
    const lastEvent = d.events.at(-1);
    return {
      id: d._id.toHexString(),
      kind: d.kind,
      kindLabel: messageKindLabels[d.kind],
      status: d.status,
      statusLabel: messageStatusLabels[d.status],
      templateName: d.templateName,
      category: d.pricing?.category ?? d.category,
      recipientName: d.recipientName,
      phone: showPhone ? maskPhone(d.recipientPhone) : maskPhone(d.recipientPhone).replace(/\d(?=\d{0,3}$)/g, '•'),
      inspection: inspection
        ? {
            id: inspection._id.toHexString(),
            vehicleId: inspection.vehicleId.toHexString(),
            status: inspection.status,
            collectionStatus: inspection.collection?.status ?? null,
            collectionStatusLabel: inspection.collection ? collectionStatusLabels[inspection.collection.status] : null,
            photosReceived: inspection.collection?.receivedSlots.filter((s) => s !== 'ODOMETER').length ?? inspection.photos.length,
            photosRequired: inspection.collection?.requiredSlots.length ?? null,
          }
        : null,
      vehicle: vehicle ? { plate: vehicle.plate, label: `${vehicle.brand} ${vehicle.model}` } : null,
      attempts: d.attempts,
      wamid: d.wamid,
      pricing: d.pricing,
      lastError: d.lastError ? { ...d.lastError, at: d.lastError.at.toISOString() } : null,
      needsAction: messageNeedsAction(d),
      manual: Boolean(d.manualOf),
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      lastEventAt: lastEvent?.at.toISOString() ?? null,
      timestamps: Object.fromEntries(
        Object.entries(d.timestamps).map(([k, v]) => [k, v ? (v as Date).toISOString() : null]),
      ),
    };
  });
}

function periodFilter(from?: string, to?: string): Record<string, Date> | null {
  if (!from && !to) return null;
  const range: Record<string, Date> = {};
  if (from) range.$gte = new Date(`${from}T03:00:00.000Z`);
  if (to) range.$lt = new Date(new Date(`${to}T03:00:00.000Z`).getTime() + 24 * 3600 * 1000);
  return range;
}

export async function registerWhatsappRoutes(app: FastifyInstance): Promise<void> {
  /* -------------- eventos do Whaply (servidor → servidor) ---------- */
  await app.register(async (scope) => {
    // Corpo cru: a assinatura cobre os bytes exatamente como enviados.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      ['application/json', 'text/plain'],
      { parseAs: 'string', bodyLimit: 64 * 1024 },
      (_req, body, done) => done(null, body),
    );
    scope.post(
      '/integrations/whaply/events',
      { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const raw = typeof request.body === 'string' ? request.body : '';
        await authenticateWhaply(request, raw);
        let envelope;
        try {
          envelope = whaplyEventEnvelopeSchema.parse(JSON.parse(raw));
        } catch {
          throw badRequest('Envelope de evento inválido.');
        }
        const outcome = await ingestWhaplyEvent(request.appCtx, envelope);
        reply.header('x-yu-outcome', outcome);
        return reply.status(204).send();
      },
    );
  });

  /* ------------------------- configurações ------------------------- */
  app.get(
    '/inspection/whatsapp-settings',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const org = await ctx.mongo.collections.organizations.findOne({ _id: organizationId });
      return {
        settings: getWhatsappSettings(org),
        channel: ctx.integrations.whaply.status(),
        templates: {
          request: ctx.env.WHAPLY_TEMPLATE_REQUEST,
          reminder: ctx.env.WHAPLY_TEMPLATE_REMINDER,
          correction: ctx.env.WHAPLY_TEMPLATE_CORRECTION,
          language: ctx.env.WHAPLY_TEMPLATE_LANGUAGE,
        },
      };
    },
  );

  app.put(
    '/inspection/whatsapp-settings',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = inspectionWhatsappSettingsSchema.parse({ ...DEFAULT_INSPECTION_WHATSAPP_SETTINGS, ...(request.body as object) });
      const org = await ctx.mongo.collections.organizations.findOne({ _id: auth.organizationId });
      await ctx.mongo.collections.organizations.updateOne(
        { _id: auth.organizationId },
        { $set: { 'settings.inspectionWhatsapp': body, updatedAt: new Date() } },
      );
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'inspection.whatsapp_settings_updated',
        entityType: 'organization',
        entityId: auth.organizationId,
        before: getWhatsappSettings(org),
        after: body,
      });
      return { settings: body };
    },
  );

  /* ------------------------- consentimento ------------------------- */
  app.put(
    '/drivers/:id/whatsapp-consent',
    { onRequest: [app.requireAuth, app.requirePermission('drivers', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = driverConsentUpdateSchema.parse(request.body);
      const driver = await ctx.mongo.collections.drivers.findOne({ _id: id, organizationId: auth.organizationId });
      if (!driver) throw notFound('Motorista não encontrado.');
      const now = new Date();
      const consent =
        body.action === 'GRANT'
          ? {
              status: 'GRANTED' as const,
              grantedAt: body.grantedAt ? new Date(body.grantedAt) : now,
              source: body.source,
              recordedBy: auth.userId,
              revokedAt: null,
              revokedSource: null,
            }
          : {
              status: 'REVOKED' as const,
              grantedAt: driver.whatsappConsent?.grantedAt ?? null,
              source: driver.whatsappConsent?.source ?? null,
              recordedBy: auth.userId,
              revokedAt: now,
              revokedSource: 'OPERATOR' as const,
            };
      await ctx.mongo.collections.drivers.updateOne(
        { _id: id, organizationId: auth.organizationId },
        { $set: { whatsappConsent: consent, updatedAt: now }, $inc: { version: 1 } },
      );
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: body.action === 'GRANT' ? 'driver.consent_granted' : 'driver.consent_revoked',
        entityType: 'driver',
        entityId: id,
        before: driver.whatsappConsent ?? null,
        after: { ...consent, reason: body.action === 'REVOKE' ? body.reason ?? null : undefined },
      });
      return {
        consent: {
          status: consent.status,
          grantedAt: consent.grantedAt?.toISOString() ?? null,
          source: consent.source,
          revokedAt: consent.revokedAt?.toISOString() ?? null,
          revokedSource: consent.revokedSource,
        },
      };
    },
  );

  /* ---------------------- correção de fotos ------------------------ */
  app.post(
    '/inspections/:id/request-correction',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'review')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = correctionRequestSchema.parse(request.body);
      return requestCorrection(ctx, {
        organizationId: auth.organizationId,
        inspectionId: id,
        actorId: auth.userId,
        slots: [...new Set(body.slots)],
        reason: body.reason,
      });
    },
  );

  /* ---------------------- reagendamento --------------------------- */
  app.patch(
    '/inspections/:id/schedule',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'request')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = z.object({ scheduledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(request.body);
      const inspection = await ctx.mongo.collections.inspections.findOne({ _id: id, organizationId: auth.organizationId });
      if (!inspection) throw notFound('Vistoria não encontrada.');
      if (inspection.status !== 'PENDING') throw conflict('Só vistorias pendentes podem ser reagendadas.');
      const status = inspection.collection?.status;
      if (status && !['SCHEDULED', 'BLOCKED_NO_CONSENT', 'NOT_SCHEDULED'].includes(status)) {
        throw conflict('A solicitação já foi enviada ao cliente; cancele e crie uma nova vistoria para outra data.');
      }
      const org = await ctx.mongo.collections.organizations.findOne({ _id: auth.organizationId });
      const settings = getWhatsappSettings(org);
      const at = localDateTimeToUtc(body.scheduledAt, settings.sendTime);
      const sendAt = inspection.collection?.mode === 'WHATSAPP' ? (at < new Date() ? new Date() : at) : null;
      const res = await ctx.mongo.collections.inspections.updateOne(
        { _id: id, status: 'PENDING', 'collection.status': status ?? { $exists: false } },
        {
          $set: {
            scheduledAt: body.scheduledAt,
            dueDate: addDaysIso(body.scheduledAt, 2),
            scheduledSendAt: sendAt,
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
      );
      if (res.modifiedCount === 0) throw conflict('A vistoria foi alterada por outra operação. Recarregue a página.');
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'inspection.rescheduled',
        entityType: 'inspection',
        entityId: id,
        before: { scheduledAt: inspection.scheduledAt },
        after: { scheduledAt: body.scheduledAt, scheduledSendAt: sendAt },
      });
      return { ok: true, scheduledAt: body.scheduledAt, scheduledSendAt: sendAt?.toISOString() ?? null };
    },
  );

  /* ---------------------- painel de mensagens ---------------------- */
  app.get(
    '/messaging/summary',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const q = z
        .object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
        .parse(request.query);
      const created = periodFilter(q.from, q.to);
      const msgFilter: Record<string, unknown> = { organizationId, kind: { $ne: 'SESSION_PROMPT' } };
      if (created) msgFilter.createdAt = created;

      const grouped = await ctx.mongo.collections.whatsappMessages
        .aggregate<{ _id: MessageStatus; n: number }>([{ $match: msgFilter }, { $group: { _id: '$status', n: { $sum: 1 } } }])
        .toArray();
      const by = (statuses: MessageStatus[]) => grouped.filter((g) => statuses.includes(g._id)).reduce((a, g) => a + g.n, 0);

      const inspFilter: Record<string, unknown> = { organizationId, 'collection.mode': 'WHATSAPP' };
      if (created) inspFilter.createdAt = created;
      const collections = await ctx.mongo.collections.inspections
        .aggregate<{ _id: string; n: number }>([
          { $match: inspFilter },
          { $group: { _id: '$collection.status', n: { $sum: 1 } } },
        ])
        .toArray();
      const col = (statuses: string[]) => collections.filter((g) => statuses.includes(g._id)).reduce((a, g) => a + g.n, 0);
      const responded = await ctx.mongo.collections.inspections.countDocuments({
        ...inspFilter,
        'collection.respondedAt': { $ne: null },
      });
      const awaitingApproval = await ctx.mongo.collections.inspections.countDocuments({ organizationId, status: 'SUBMITTED' });
      const unmatched = await ctx.mongo.collections.unmatchedMedia.countDocuments({ organizationId, status: 'PENDING' });

      return {
        channel: ctx.integrations.whaply.status(),
        messages: {
          total: grouped.reduce((a, g) => a + g.n, 0),
          processing: by(PROCESSING),
          sent: by(SENT_OR_BETTER),
          delivered: by(['DELIVERED', 'READ']),
          read: by(['READ']),
          failed: by(['FAILED']),
          retrying: by(['RETRY_SCHEDULED']),
          canceled: by(['CANCELED']),
        },
        collections: {
          responded,
          incomplete: col(['REQUESTED', 'IN_PROGRESS', 'PARTIAL']),
          complete: col(['COMPLETE']),
          blocked: col(['BLOCKED_NO_CONSENT']),
          expired: col(['EXPIRED']),
          failed: col(['FAILED']),
          awaitingApproval,
          unmatchedPhotos: unmatched,
        },
      };
    },
  );

  app.get(
    '/messaging/messages',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const q = messagingListQuerySchema.parse(request.query);
      const filter: Record<string, unknown> = { organizationId };
      const created = periodFilter(q.from, q.to);
      if (created) filter.createdAt = created;
      if (q.status) filter.status = q.status;
      if (q.kind) filter.kind = q.kind;
      if (q.inspectionId) filter.inspectionId = new ObjectId(q.inspectionId);
      if (q.needsAction) {
        filter.$or = [{ status: 'FAILED' }, { status: 'RETRY_SCHEDULED', attempts: { $gte: 3 } }];
      }
      if (q.q) {
        const rx = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const vehicles = await ctx.mongo.collections.vehicles.find({ organizationId, plate: rx }, { projection: { _id: 1 } }).toArray();
        const inspections = vehicles.length
          ? await ctx.mongo.collections.inspections
              .find({ organizationId, vehicleId: { $in: vehicles.map((v) => v._id) } }, { projection: { _id: 1 } })
              .toArray()
          : [];
        const or: Record<string, unknown>[] = [{ recipientName: rx }];
        if (inspections.length) or.push({ inspectionId: { $in: inspections.map((i) => i._id) } });
        filter.$and = [{ $or: or }];
      }
      const docs = await ctx.mongo.collections.whatsappMessages
        .find(filter, { projection: { requestPayloadEnc: 0 } })
        .sort({ createdAt: -1, _id: -1 })
        .limit(q.limit)
        .toArray();
      return { data: await toMessageDTOs(ctx, docs, canSeePhone(request)) };
    },
  );

  app.get(
    '/messaging/messages/:id',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const doc = await ctx.mongo.collections.whatsappMessages.findOne(
        { _id: id, organizationId },
        { projection: { requestPayloadEnc: 0 } },
      );
      if (!doc) throw notFound('Mensagem não encontrada.');
      const [dto] = await toMessageDTOs(ctx, [doc], canSeePhone(request));
      const related = doc.inspectionId
        ? await ctx.mongo.collections.whatsappMessages
            .find({ inspectionId: doc.inspectionId, organizationId }, { projection: { requestPayloadEnc: 0 } })
            .sort({ createdAt: 1 })
            .toArray()
        : [];
      return {
        ...dto,
        idempotencyKey: doc.idempotencyKey,
        correlationId: doc.correlationId,
        whaplyRequestId: doc.whaplyRequestId,
        sessionId: doc.sessionId,
        events: doc.events.map((e) => ({ ...e, at: e.at.toISOString() })),
        related: await toMessageDTOs(ctx, related, canSeePhone(request)),
      };
    },
  );

  app.post(
    '/messaging/messages/:id/resend',
    {
      onRequest: [app.requireAuth, app.requirePermission('notifications', 'dispatch')],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = z.object({ confirm: z.literal(true) }).parse(request.body);
      void body;
      const id = toObjectId((request.params as { id: string }).id);
      const message = await resendMessage(ctx, { organizationId: auth.organizationId, messageId: id, actorId: auth.userId });
      reply.status(201);
      return { id: message._id.toHexString(), status: message.status };
    },
  );

  app.post(
    '/messaging/messages/:id/retry',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'dispatch')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      await retryFailedMessage(ctx, { organizationId: auth.organizationId, messageId: id, actorId: auth.userId });
      return { ok: true };
    },
  );

  /* ------------------------------ custos --------------------------- */
  app.get(
    '/messaging/costs',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const q = z.object({ months: z.coerce.number().int().min(1).max(24).default(6) }).parse(request.query);
      const since = new Date();
      since.setUTCMonth(since.getUTCMonth() - (q.months - 1), 1);
      since.setUTCHours(3, 0, 0, 0);

      const rows = await ctx.mongo.collections.whatsappMessages
        .aggregate<{ _id: { month: string; category: string; billable: boolean | null }; n: number }>([
          {
            $match: {
              organizationId,
              createdAt: { $gte: since },
              status: { $in: ['DELIVERED', 'READ'] },
            },
          },
          {
            $group: {
              _id: {
                month: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'America/Sao_Paulo' } },
                category: { $toUpper: { $ifNull: ['$pricing.category', '$category'] } },
                billable: { $ifNull: ['$pricing.billable', null] },
              },
              n: { $sum: 1 },
            },
          },
          { $sort: { '_id.month': 1 } },
        ])
        .toArray();
      const rates = await ctx.mongo.collections.messagingRates.find({ organizationId }).sort({ effectiveFrom: -1 }).toArray();
      const rateFor = (category: string, month: string) =>
        rates.find((r) => r.category === category && r.effectiveFrom <= `${month}-31`) ?? null;

      const data = rows.map((r) => {
        const rate = rateFor(r._id.category, r._id.month);
        const billable = r._id.billable === true;
        return {
          month: r._id.month,
          category: r._id.category,
          billable: r._id.billable,
          delivered: r.n,
          rate: rate ? { amount: rate.amountMicros / 1_000_000, currency: rate.currency, source: rate.source, effectiveFrom: rate.effectiveFrom } : null,
          estimated: billable && rate ? Math.round(r.n * rate.amountMicros) / 1_000_000 : null,
        };
      });
      return {
        disclaimer:
          'Estimativa calculada com tarifas de referência cadastradas manualmente. A cobrança oficial é a fatura da Meta (Facebook Brasil) — este painel não mostra valores efetivamente cobrados.',
        confirmedBillingAvailable: false,
        data,
        rates: rates.map((r) => ({
          id: r._id.toHexString(),
          category: r.category,
          currency: r.currency,
          amount: r.amountMicros / 1_000_000,
          effectiveFrom: r.effectiveFrom,
          source: r.source,
        })),
      };
    },
  );

  app.post(
    '/messaging/rates',
    { onRequest: [app.requireAuth, app.requirePermission('notifications', 'update')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = messagingRateSchema.parse(request.body);
      const now = new Date();
      const doc = {
        _id: new ObjectId(),
        organizationId: auth.organizationId,
        category: body.category,
        currency: body.currency,
        amountMicros: Math.round(body.amount * 1_000_000),
        effectiveFrom: body.effectiveFrom,
        source: body.source,
        recordedBy: auth.userId,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.mongo.collections.messagingRates.insertOne(doc);
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'messaging.rate_recorded',
        entityType: 'messagingRate',
        entityId: doc._id,
        after: body,
      });
      reply.status(201);
      return { id: doc._id.toHexString() };
    },
  );

  /* ------------------------ fotos sem vínculo ---------------------- */
  app.get(
    '/messaging/unmatched-media',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const docs = await ctx.mongo.collections.unmatchedMedia
        .find({ organizationId, status: 'PENDING' })
        .sort({ receivedAt: -1 })
        .limit(100)
        .toArray();
      return {
        data: docs.map((d) => ({
          id: d._id.toHexString(),
          url: fileUrl(ctx, d.fileId, organizationId),
          reason: d.reason,
          receivedAt: d.receivedAt.toISOString(),
        })),
      };
    },
  );

  app.get(
    '/messaging/assignable-inspections',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const docs = await ctx.mongo.collections.inspections
        .find({ organizationId, status: { $in: ['PENDING', 'SUBMITTED'] } })
        .sort({ scheduledAt: -1 })
        .limit(100)
        .toArray();
      const vehicles = await ctx.mongo.collections.vehicles
        .find({ _id: { $in: docs.map((d) => d.vehicleId) } }, { projection: { plate: 1 } })
        .toArray();
      const plates = new Map(vehicles.map((v) => [v._id.toHexString(), v.plate]));
      const slots = await ctx.mongo.collections.inspectionPhotoSlots.find({ organizationId, active: true }).sort({ order: 1 }).toArray();
      return {
        data: docs.map((d) => ({
          id: d._id.toHexString(),
          label: `${plates.get(d.vehicleId.toHexString()) ?? '—'} · ${d.responsibleName} · ${d.scheduledAt.split('-').reverse().join('/')}`,
        })),
        slots: slots.map((s) => ({ code: s.code, label: s.label })),
      };
    },
  );

  app.post(
    '/messaging/unmatched-media/:id/assign',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'review')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = z.object({ inspectionId: z.string(), slotCode: z.string().min(1).max(32) }).parse(request.body);
      await assignUnmatchedMedia(ctx, {
        organizationId: auth.organizationId,
        id,
        actorId: auth.userId,
        inspectionId: toObjectId(body.inspectionId, 'inspectionId'),
        slotCode: body.slotCode,
      });
      return { ok: true };
    },
  );

  app.post(
    '/messaging/unmatched-media/:id/discard',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'review')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const res = await ctx.mongo.collections.unmatchedMedia.updateOne(
        { _id: id, organizationId: auth.organizationId, status: 'PENDING' },
        { $set: { status: 'DISCARDED', resolvedBy: auth.userId, resolvedAt: new Date(), updatedAt: new Date() } },
      );
      if (res.modifiedCount === 0) throw notFound('Foto pendente não encontrada.');
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'inspection.unmatched_photo_discarded',
        entityType: 'unmatchedMedia',
        entityId: id,
      });
      return { ok: true };
    },
  );
}
