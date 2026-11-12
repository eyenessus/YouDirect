import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { geofenceCreateSchema, trackerDeviceCreateSchema, trackerIngestSchema } from '@yudirect/contracts';
import { conflict, notFound, unauthorized } from '../../common/errors.js';
import { toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';
import { ingestPositions, organizationByTrackerToken, rotateTrackerToken, toGeofenceDTO, trackingOverview } from '../../services/tracking.js';

const idParam = (request: FastifyRequest): ObjectId => toObjectId((request.params as { id: string }).id);

/** Token vindo de `Authorization: Bearer` ou do cabeçalho `x-tracker-token`. */
function tokenOf(request: FastifyRequest): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1];
  const header = request.headers['x-tracker-token'];
  return bearer ?? (typeof header === 'string' ? header : undefined);
}

/** Rastreamento herda a permissão de Veículos; o token do webhook é só do dono ou administrador. */
export async function registerTrackingRoutes(app: FastifyInstance): Promise<void> {
  const read = { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'read')] };
  const write = { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'update')] };

  /* ------------------------- webhook (sem sessão) ------------------------- */
  app.post('/webhooks/tracker', { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (request) => {
    const org = await organizationByTrackerToken(request.appCtx, tokenOf(request));
    if (!org) throw unauthorized('Token do rastreador inválido.');
    const { positions } = trackerIngestSchema.parse(request.body);
    return ingestPositions(request.appCtx, org._id, positions);
  });

  /* ------------------------------ painel ------------------------------ */
  app.get('/tracking/overview', read, async (request) => {
    const { organizationId } = requireAuthContext(request);
    return { data: await trackingOverview(request.appCtx, organizationId) };
  });

  app.get('/tracking/token', read, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const org = await request.appCtx.mongo.collections.organizations.findOne({ _id: organizationId });
    const t = org?.settings.tracker;
    return { configured: Boolean(t?.tokenHash), rotatedAt: t?.rotatedAt?.toISOString() ?? null, webhookUrl: `${request.appCtx.env.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/webhooks/tracker` };
  });
  app.post('/tracking/token', { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] }, async (request) => {
    const auth = requireAuthContext(request);
    return { token: await rotateTrackerToken(request.appCtx, { organizationId: auth.organizationId, userId: auth.userId }) };
  });

  app.get('/tracking/devices', read, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const devices = await request.appCtx.mongo.collections.trackerDevices.find({ organizationId }).sort({ createdAt: -1 }).toArray();
    return { data: devices.map((d) => ({ id: d._id.toHexString(), vehicleId: d.vehicleId.toHexString(), deviceId: d.deviceId, label: d.label })) };
  });
  app.post('/tracking/devices', write, async (request, reply) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const body = trackerDeviceCreateSchema.parse(request.body);
    const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: new ObjectId(body.vehicleId), organizationId: auth.organizationId });
    if (!vehicle || vehicle.archivedAt) throw notFound('Veículo não encontrado.');
    const now = new Date();
    try {
      const doc = { _id: new ObjectId(), organizationId: auth.organizationId, vehicleId: vehicle._id, deviceId: body.deviceId, label: body.label ?? null, createdBy: auth.userId, createdAt: now, updatedAt: now };
      await ctx.mongo.collections.trackerDevices.insertOne(doc);
      await audit(ctx, { organizationId: auth.organizationId, actorId: auth.userId, action: 'tracker.device_added', entityType: 'vehicle', entityId: vehicle._id, after: { deviceId: body.deviceId } });
      reply.status(201);
      return { id: doc._id.toHexString(), vehicleId: body.vehicleId, deviceId: body.deviceId, label: doc.label };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw conflict('Este rastreador já está cadastrado, ou o veículo já tem um rastreador.');
      throw err;
    }
  });
  app.delete('/tracking/devices/:id', write, async (request, reply) => {
    const auth = requireAuthContext(request);
    const res = await request.appCtx.mongo.collections.trackerDevices.findOneAndDelete({ _id: idParam(request), organizationId: auth.organizationId });
    if (!res) throw notFound('Rastreador não encontrado.');
    await audit(request.appCtx, { organizationId: auth.organizationId, actorId: auth.userId, action: 'tracker.device_removed', entityType: 'vehicle', entityId: res.vehicleId, before: { deviceId: res.deviceId } });
    return reply.status(204).send();
  });

  app.get('/tracking/geofences', read, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const zones = await request.appCtx.mongo.collections.geofences.find({ organizationId }).sort({ name: 1 }).toArray();
    return { data: zones.map(toGeofenceDTO) };
  });
  app.post('/tracking/geofences', write, async (request, reply) => {
    const auth = requireAuthContext(request);
    const body = geofenceCreateSchema.parse(request.body);
    const now = new Date();
    try {
      const doc = { _id: new ObjectId(), organizationId: auth.organizationId, ...body, createdBy: auth.userId, createdAt: now, updatedAt: now };
      await request.appCtx.mongo.collections.geofences.insertOne(doc);
      reply.status(201);
      return toGeofenceDTO(doc);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw conflict('Já existe uma área com esse nome.');
      throw err;
    }
  });
  app.delete('/tracking/geofences/:id', write, async (request, reply) => {
    const auth = requireAuthContext(request);
    const res = await request.appCtx.mongo.collections.geofences.deleteOne({ _id: idParam(request), organizationId: auth.organizationId });
    if (res.deletedCount !== 1) throw notFound('Área não encontrada.');
    return reply.status(204).send();
  });

  /** Histórico de posições de um veículo nas últimas horas (máx. 500 pontos, do mais recente). */
  app.get('/vehicles/:id/positions', read, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const { hours } = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }).parse(request.query);
    const rows = await request.appCtx.mongo.collections.vehiclePositions
      .find({ organizationId, vehicleId: idParam(request), at: { $gte: new Date(Date.now() - hours * 3600 * 1000) } })
      .sort({ at: -1 })
      .limit(500)
      .toArray();
    return { data: rows.map((p) => ({ lat: p.lat, lng: p.lng, at: p.at.toISOString(), speedKmh: p.speedKmh, ignition: p.ignition, odometerKm: p.odometerKm })) };
  });
}
