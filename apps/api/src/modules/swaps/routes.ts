import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ObjectId } from 'mongodb';
import { swapCreateSchema, swapEndSchema, swapStatusSchema } from '@yudirect/contracts';
import { z } from 'zod';
import { toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { createSwap, endSwap, listAvailability, toSwapDTOs } from '../../services/swaps.js';

const idParam = (request: FastifyRequest): ObjectId => toObjectId((request.params as { id: string }).id);
const actorOf = (request: FastifyRequest) => {
  const auth = requireAuthContext(request);
  return { organizationId: auth.organizationId, userId: auth.userId };
};

/** Carro reserva herda a permissão de Locações; o quadro de disponibilidade, a de Veículos. */
export async function registerSwapRoutes(app: FastifyInstance): Promise<void> {
  app.get('/vehicles/availability', { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'read')] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    return { data: await listAvailability(request.appCtx, organizationId) };
  });

  app.get('/vehicle-swaps', { onRequest: [app.requireAuth, app.requirePermission('rentals', 'read')] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const query = z.object({ status: swapStatusSchema.optional(), rentalId: z.string().optional() }).parse(request.query);
    const filter: Record<string, unknown> = { organizationId };
    if (query.status) filter.status = query.status;
    if (query.rentalId) filter.rentalId = toObjectId(query.rentalId, 'rentalId');
    const docs = await request.appCtx.mongo.collections.vehicleSwaps.find(filter).sort({ startedOn: -1, _id: -1 }).limit(100).toArray();
    return { data: await toSwapDTOs(request.appCtx, organizationId, docs) };
  });

  app.post('/rentals/:id/swap', { onRequest: [app.requireAuth, app.requirePermission('rentals', 'update')] }, async (request, reply) => {
    const actor = actorOf(request);
    const doc = await createSwap(request.appCtx, actor, idParam(request), swapCreateSchema.parse(request.body));
    reply.status(201);
    return (await toSwapDTOs(request.appCtx, actor.organizationId, [doc]))[0]!;
  });

  app.post('/vehicle-swaps/:id/end', { onRequest: [app.requireAuth, app.requirePermission('rentals', 'update')] }, async (request) => {
    const actor = actorOf(request);
    const doc = await endSwap(request.appCtx, actor, idParam(request), swapEndSchema.parse(request.body ?? {}));
    return (await toSwapDTOs(request.appCtx, actor.organizationId, [doc]))[0]!;
  });
}
