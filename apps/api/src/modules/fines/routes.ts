import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ObjectId } from 'mongodb';
import {
  businessDate,
  fineAppealResultSchema,
  fineChargeSchema,
  fineContestSchema,
  fineGravityLabels,
  fineIdentifySchema,
  fineIndicateSchema,
  fineIndicationStatusLabels,
  fineReasonSchema,
  fineVersionSchema,
  formatCentsPlain,
  formatDateTimeBR,
  formatIsoDateBR,
  trafficFineCreateSchema,
  trafficFineListQuerySchema,
  trafficFineStatusLabels,
  trafficFineUpdateSchema,
} from '@yudirect/contracts';
import { notFound } from '../../common/errors.js';
import { csvCell, decodeCursor, encodeCursor, toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';
import {
  appealResult,
  buildFineFilter,
  cancelFine,
  chargeFine,
  contestFine,
  createFine,
  fineSummary,
  identifyDriver,
  importFromProvider,
  indicateDriver,
  markCompanyLiable,
  notifyDriver,
  rematchFine,
  toFineDTOs,
  updateFine,
  type Actor,
} from '../../services/traffic-fines.js';
import type { AppContext } from '../../context.js';
import type { TrafficFineDoc } from '../../database/types.js';

const BOM = String.fromCharCode(0xfeff);

function actorOf(request: FastifyRequest): Actor {
  const auth = requireAuthContext(request);
  return { organizationId: auth.organizationId, userId: auth.userId };
}

const idParam = (request: FastifyRequest) => toObjectId((request.params as { id: string }).id);

async function one(ctx: AppContext, organizationId: ObjectId, doc: TrafficFineDoc) {
  const [dto] = await toFineDTOs(ctx, organizationId, [doc]);
  return dto;
}

export async function registerFineRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ lista ---------------------------- */
  app.get(
    '/traffic-fines',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const query = trafficFineListQuerySchema.parse(request.query);
      const filter = await buildFineFilter(ctx, organizationId, query);

      const skip = decodeCursor<{ skip: number }>(query.cursor)?.skip ?? 0;
      const docs = await ctx.mongo.collections.trafficFines
        .find(filter)
        .sort({ occurredAt: -1, _id: -1 })
        .skip(skip)
        .limit(query.limit + 1)
        .toArray();
      const hasMore = docs.length > query.limit;
      const page = hasMore ? docs.slice(0, query.limit) : docs;
      const [total, summary, data] = await Promise.all([
        ctx.mongo.collections.trafficFines.countDocuments(filter),
        fineSummary(ctx, organizationId),
        toFineDTOs(ctx, organizationId, page),
      ]);
      return {
        data,
        summary,
        page: { nextCursor: hasMore ? encodeCursor({ skip: skip + query.limit }) : null, total },
      };
    },
  );

  /* ---------------------------- exportação ------------------------- */
  app.get(
    '/traffic-fines/export.csv',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'export')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const query = trafficFineListQuerySchema.omit({ cursor: true, limit: true }).parse(request.query);
      const filter = await buildFineFilter(ctx, auth.organizationId, query);
      const docs = await ctx.mongo.collections.trafficFines.find(filter).sort({ occurredAt: -1 }).limit(20_000).toArray();
      const dtos = await toFineDTOs(ctx, auth.organizationId, docs);

      const header = [
        'Número', 'AIT', 'Órgão', 'Placa', 'Data/hora', 'Infração', 'Gravidade', 'Pontos', 'Valor', 'Valor com desconto',
        'Status', 'Motorista', 'Locação', 'Indicação', 'Prazo de indicação', 'Vencimento',
      ];
      const rows = dtos.map((f) => [
        f.fineNumber,
        f.aitNumber,
        f.authority.name,
        f.vehicle.plate,
        formatDateTimeBR(f.occurredAt),
        f.infractionDescription,
        f.gravity ? fineGravityLabels[f.gravity] : '',
        f.points ?? '',
        formatCentsPlain(f.amountCents),
        f.discountedAmountCents !== null ? formatCentsPlain(f.discountedAmountCents) : '',
        trafficFineStatusLabels[f.status],
        f.match.driver?.fullName ?? '',
        f.match.rental?.rentalNumber ?? '',
        fineIndicationStatusLabels[f.indication.status],
        f.indicationDeadline ? formatIsoDateBR(f.indicationDeadline) : '',
        f.dueDate ? formatIsoDateBR(f.dueDate) : '',
      ]);
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'export.csv',
        entityType: 'trafficFine',
        entityId: null,
        after: { rows: rows.length },
      });
      const lines = [header.map(csvCell).join(';'), ...rows.map((r) => r.map((v) => csvCell(String(v))).join(';'))];
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="multas-${businessDate()}.csv"`)
        .header('cache-control', 'no-store');
      return reply.send(`${BOM}${lines.join('\r\n')}\r\n`);
    },
  );

  /* ------------------------------ detalhe -------------------------- */
  app.get(
    '/traffic-fines/:id',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const doc = await ctx.mongo.collections.trafficFines.findOne({ _id: idParam(request), organizationId });
      if (!doc) throw notFound('Multa não encontrada.');
      return one(ctx, organizationId, doc);
    },
  );

  /* ------------------------------ cadastro ------------------------- */
  app.post(
    '/traffic-fines',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'create')] },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = trafficFineCreateSchema.parse(request.body);
      const doc = await createFine(request.appCtx, actor, body);
      reply.status(201);
      return one(request.appCtx, actor.organizationId, doc);
    },
  );

  app.patch(
    '/traffic-fines/:id',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'update')] },
    async (request) => {
      const actor = actorOf(request);
      const body = trafficFineUpdateSchema.parse(request.body);
      const doc = await updateFine(request.appCtx, actor, idParam(request), body);
      return one(request.appCtx, actor.organizationId, doc);
    },
  );

  /* ------------------------------ ações ---------------------------- */
  app.post(
    '/traffic-fines/:id/rematch',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'update')] },
    async (request) => {
      const actor = actorOf(request);
      const { version } = fineVersionSchema.parse(request.body);
      return one(request.appCtx, actor.organizationId, await rematchFine(request.appCtx, actor, idParam(request), version));
    },
  );

  app.post(
    '/traffic-fines/:id/identify',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'update')] },
    async (request) => {
      const actor = actorOf(request);
      const body = fineIdentifySchema.parse(request.body);
      return one(request.appCtx, actor.organizationId, await identifyDriver(request.appCtx, actor, idParam(request), body));
    },
  );

  app.post(
    '/traffic-fines/:id/indicate',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'update')] },
    async (request) => {
      const actor = actorOf(request);
      const body = fineIndicateSchema.parse(request.body);
      return one(request.appCtx, actor.organizationId, await indicateDriver(request.appCtx, actor, idParam(request), body));
    },
  );

  app.post(
    '/traffic-fines/:id/charge',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'pay')] },
    async (request, reply) => {
      const actor = actorOf(request);
      const body = fineChargeSchema.parse(request.body);
      const result = await chargeFine(request.appCtx, actor, idParam(request), body);
      reply.status(result.alreadyCharged ? 200 : 201);
      return { alreadyCharged: result.alreadyCharged, fine: await one(request.appCtx, actor.organizationId, result.fine) };
    },
  );

  app.post(
    '/traffic-fines/:id/contest',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'update')] },
    async (request) => {
      const actor = actorOf(request);
      const body = fineContestSchema.parse(request.body);
      return one(request.appCtx, actor.organizationId, await contestFine(request.appCtx, actor, idParam(request), body));
    },
  );

  app.post(
    '/traffic-fines/:id/appeal-result',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'update')] },
    async (request) => {
      const actor = actorOf(request);
      const body = fineAppealResultSchema.parse(request.body);
      return one(request.appCtx, actor.organizationId, await appealResult(request.appCtx, actor, idParam(request), body));
    },
  );

  app.post(
    '/traffic-fines/:id/company-liable',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'update')] },
    async (request) => {
      const actor = actorOf(request);
      const body = fineReasonSchema.parse(request.body);
      return one(request.appCtx, actor.organizationId, await markCompanyLiable(request.appCtx, actor, idParam(request), body));
    },
  );

  app.post(
    '/traffic-fines/:id/cancel',
    { onRequest: [app.requireAuth, app.requirePermission('fines', 'delete')] },
    async (request) => {
      const actor = actorOf(request);
      const body = fineReasonSchema.parse(request.body);
      return one(request.appCtx, actor.organizationId, await cancelFine(request.appCtx, actor, idParam(request), body));
    },
  );

  app.post(
    '/traffic-fines/:id/notify-driver',
    {
      onRequest: [app.requireAuth, app.requirePermission('fines', 'update')],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => notifyDriver(request.appCtx, actorOf(request), idParam(request)),
  );

  /* ------------------------- importar do provedor ------------------- */
  app.post(
    '/vehicles/:id/traffic-fines/import',
    {
      onRequest: [app.requireAuth, app.requirePermission('fines', 'create')],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request) => importFromProvider(request.appCtx, actorOf(request), idParam(request)),
  );
}
