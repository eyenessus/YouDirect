import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ObjectId } from 'mongodb';
import {
  claimChargeSchema,
  claimCreateSchema,
  claimListQuerySchema,
  claimStatusChangeSchema,
  claimUpdateSchema,
} from '@yudirect/contracts';
import { notFound } from '../../common/errors.js';
import { decodeCursor, encodeCursor, escapeRegex, cursorDate, toObjectId } from '../../common/helpers.js';
import { foldAccents } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { changeClaimStatus, chargeClaimDriver, createClaim, toClaimDTOs, updateClaim } from '../../services/claims.js';

const idParam = (request: FastifyRequest): ObjectId => toObjectId((request.params as { id: string }).id);
const actorOf = (request: FastifyRequest) => {
  const auth = requireAuthContext(request);
  return { organizationId: auth.organizationId, userId: auth.userId };
};

export async function registerClaimRoutes(app: FastifyInstance): Promise<void> {
  app.get('/claims', { onRequest: [app.requireAuth, app.requirePermission('claims', 'read')] }, async (request) => {
    const ctx = request.appCtx;
    const { organizationId } = requireAuthContext(request);
    const query = claimListQuerySchema.parse(request.query);
    const filter: Record<string, unknown> = { organizationId };
    if (query.status) filter.status = query.status;
    if (query.vehicleId) filter.vehicleId = toObjectId(query.vehicleId, 'vehicleId');
    if (query.q) filter.searchFold = new RegExp(escapeRegex(foldAccents(query.q).toLowerCase()));
    const cursor = decodeCursor<{ createdAt: string; id: string }>(query.cursor);
    if (cursor) {
      filter.$and = [
        {
          $or: [
            { createdAt: { $lt: cursorDate(cursor.createdAt) } },
            { createdAt: cursorDate(cursor.createdAt), _id: { $lt: toObjectId(String(cursor.id), 'cursor') } },
          ],
        },
      ];
    }
    const docs = await ctx.mongo.collections.claims
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .toArray();
    const hasMore = docs.length > query.limit;
    const page = hasMore ? docs.slice(0, query.limit) : docs;
    return {
      data: await toClaimDTOs(ctx, organizationId, page),
      page: {
        nextCursor: hasMore ? encodeCursor({ createdAt: page[page.length - 1]!.createdAt.toISOString(), id: page[page.length - 1]!._id.toHexString() }) : null,
      },
    };
  });

  app.get('/claims/:id', { onRequest: [app.requireAuth, app.requirePermission('claims', 'read')] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const doc = await request.appCtx.mongo.collections.claims.findOne({ _id: idParam(request), organizationId });
    if (!doc) throw notFound('Sinistro não encontrado.');
    return (await toClaimDTOs(request.appCtx, organizationId, [doc]))[0]!;
  });

  app.post('/claims', { onRequest: [app.requireAuth, app.requirePermission('claims', 'create')] }, async (request, reply) => {
    const actor = actorOf(request);
    const doc = await createClaim(request.appCtx, actor, claimCreateSchema.parse(request.body));
    reply.status(201);
    return (await toClaimDTOs(request.appCtx, actor.organizationId, [doc]))[0]!;
  });

  app.patch('/claims/:id', { onRequest: [app.requireAuth, app.requirePermission('claims', 'update')] }, async (request) => {
    const actor = actorOf(request);
    const doc = await updateClaim(request.appCtx, actor, idParam(request), claimUpdateSchema.parse(request.body));
    return (await toClaimDTOs(request.appCtx, actor.organizationId, [doc]))[0]!;
  });

  app.post('/claims/:id/status', { onRequest: [app.requireAuth, app.requirePermission('claims', 'update')] }, async (request) => {
    const actor = actorOf(request);
    const doc = await changeClaimStatus(request.appCtx, actor, idParam(request), claimStatusChangeSchema.parse(request.body));
    return (await toClaimDTOs(request.appCtx, actor.organizationId, [doc]))[0]!;
  });

  app.post('/claims/:id/charge', { onRequest: [app.requireAuth, app.requirePermission('claims', 'pay')] }, async (request) => {
    const actor = actorOf(request);
    const { claim, alreadyCharged } = await chargeClaimDriver(request.appCtx, actor, idParam(request), claimChargeSchema.parse(request.body));
    return { claim: (await toClaimDTOs(request.appCtx, actor.organizationId, [claim]))[0]!, alreadyCharged };
  });
}


