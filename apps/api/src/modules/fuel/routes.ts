import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ObjectId } from 'mongodb';
import { fuelLogCreateSchema, fuelLogListQuerySchema, fuelSummaryQuerySchema } from '@yudirect/contracts';
import { toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { createFuelLog, deleteFuelLog, fuelSummaries, toFuelLogDTOs } from '../../services/fuel.js';

const idParam = (request: FastifyRequest): ObjectId => toObjectId((request.params as { id: string }).id);
const actorOf = (request: FastifyRequest) => {
  const auth = requireAuthContext(request);
  return { organizationId: auth.organizationId, userId: auth.userId };
};

/** Abastecimento herda a permissão de Veículos. */
export async function registerFuelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/fuel-logs', { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'read')] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const query = fuelLogListQuerySchema.parse(request.query);
    const filter: Record<string, unknown> = { organizationId };
    if (query.vehicleId) filter.vehicleId = toObjectId(query.vehicleId, 'vehicleId');
    const docs = await request.appCtx.mongo.collections.fuelLogs.find(filter).sort({ date: -1, odometerKm: -1 }).limit(query.limit).toArray();
    return { data: await toFuelLogDTOs(request.appCtx, organizationId, docs) };
  });

  app.get('/fuel-logs/summary', { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'read')] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const { days } = fuelSummaryQuerySchema.parse(request.query);
    return { days, data: await fuelSummaries(request.appCtx, organizationId, days) };
  });

  app.post('/fuel-logs', { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'update')] }, async (request, reply) => {
    const actor = actorOf(request);
    const doc = await createFuelLog(request.appCtx, actor, fuelLogCreateSchema.parse(request.body));
    reply.status(201);
    return (await toFuelLogDTOs(request.appCtx, actor.organizationId, [doc]))[0]!;
  });

  app.delete('/fuel-logs/:id', { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'update')] }, async (request, reply) => {
    await deleteFuelLog(request.appCtx, actorOf(request), idParam(request));
    return reply.status(204).send();
  });
}
