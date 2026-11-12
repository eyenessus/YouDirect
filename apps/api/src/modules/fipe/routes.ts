import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ObjectId } from 'mongodb';
import { fipeLinkSchema } from '@yudirect/contracts';
import { toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { toVehicleDTO } from '../vehicles/mapper.js';
import { cachedList, fipeReport, linkVehicleFipe, refreshVehicleFipe, unlinkVehicleFipe } from '../../services/fipe.js';

const idParam = (request: FastifyRequest): ObjectId => toObjectId((request.params as { id: string }).id);
const actorOf = (request: FastifyRequest) => {
  const auth = requireAuthContext(request);
  return { organizationId: auth.organizationId, userId: auth.userId };
};

/** Valor de mercado (FIPE) herda a permissão de Veículos. */
export async function registerFipeRoutes(app: FastifyInstance): Promise<void> {
  const read = { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'read')] };
  const write = { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'update')] };

  app.get('/fipe/status', read, async (request) => request.appCtx.integrations.fipe.status());

  app.get('/fipe/brands', read, async (request) => {
    const fipe = request.appCtx.integrations.fipe;
    return { data: await cachedList('brands', () => fipe.brands()) };
  });
  app.get('/fipe/brands/:brandId/models', read, async (request) => {
    const { brandId } = request.params as { brandId: string };
    const fipe = request.appCtx.integrations.fipe;
    return { data: await cachedList(`models:${brandId}`, () => fipe.models(brandId)) };
  });
  app.get('/fipe/brands/:brandId/models/:modelId/years', read, async (request) => {
    const { brandId, modelId } = request.params as { brandId: string; modelId: string };
    const fipe = request.appCtx.integrations.fipe;
    return { data: await cachedList(`years:${brandId}:${modelId}`, () => fipe.years(brandId, modelId)) };
  });

  app.get('/vehicles/fipe-report', read, async (request) => {
    const { organizationId } = requireAuthContext(request);
    return { data: await fipeReport(request.appCtx, organizationId) };
  });

  app.post('/vehicles/:id/fipe', write, async (request) => {
    const actor = actorOf(request);
    const doc = await linkVehicleFipe(request.appCtx, actor, idParam(request), fipeLinkSchema.parse(request.body));
    return toVehicleDTO(request.appCtx, actor.organizationId, doc);
  });
  app.post('/vehicles/:id/fipe/refresh', write, async (request) => {
    const actor = actorOf(request);
    const doc = await refreshVehicleFipe(request.appCtx, actor, idParam(request));
    return toVehicleDTO(request.appCtx, actor.organizationId, doc);
  });
  app.delete('/vehicles/:id/fipe', write, async (request, reply) => {
    await unlinkVehicleFipe(request.appCtx, actorOf(request), idParam(request));
    return reply.status(204).send();
  });
}
