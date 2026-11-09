import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  trafficFinesResponseSchema,
  vehicleInputSchema,
  vehicleListQuerySchema,
  vehicleUpdateSchema,
  type TrafficFinesResponse,
} from '@yudirect/contracts';
import { badRequest, conflict, integrationUnavailable, notFound } from '../../common/errors.js';
import { decodeCursor, encodeCursor, escapeRegex, toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';
import { requireFile } from '../../services/files.js';
import type { VehicleDoc } from '../../database/types.js';
import { toVehicleDTO, toVehicleDTOs } from './mapper.js';
import { registerVehicleImportRoutes } from './import.js';

export async function registerVehicleRoutes(app: FastifyInstance): Promise<void> {
  await registerVehicleImportRoutes(app);

  /* ------------------------------ lista ---------------------------- */
  app.get(
    '/vehicles',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const query = vehicleListQuerySchema.parse(request.query);

      const filter: Record<string, unknown> = { organizationId, archivedAt: null };
      if (query.status) filter.status = query.status;
      if (query.q) {
        const rx = new RegExp(escapeRegex(query.q), 'i');
        filter.$or = [{ plate: rx }, { brand: rx }, { model: rx }, { color: rx }];
      }
      const cursor = decodeCursor<{ createdAt: string; id: string }>(query.cursor);
      if (cursor) {
        filter.$and = [
          {
            $or: [
              { createdAt: { $lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), _id: { $lt: new ObjectId(cursor.id) } },
            ],
          },
        ];
      }

      const docs = await ctx.mongo.collections.vehicles
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(query.limit + 1)
        .toArray();

      const hasMore = docs.length > query.limit;
      const page = hasMore ? docs.slice(0, query.limit) : docs;
      const total = await ctx.mongo.collections.vehicles.countDocuments({
        organizationId,
        archivedAt: null,
      });

      return {
        data: await toVehicleDTOs(ctx, organizationId, page),
        page: {
          nextCursor: hasMore
            ? encodeCursor({
                createdAt: page[page.length - 1]!.createdAt.toISOString(),
                id: page[page.length - 1]!._id.toHexString(),
              })
            : null,
          total,
        },
      };
    },
  );

  /* ----------------------------- detalhe --------------------------- */
  app.get(
    '/vehicles/:id',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const doc = await ctx.mongo.collections.vehicles.findOne({ _id: id, organizationId });
      if (!doc) throw notFound('Veículo não encontrado.');
      return toVehicleDTO(ctx, organizationId, doc);
    },
  );

  /* ------------------------------ criar ---------------------------- */
  app.post(
    '/vehicles',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'create')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = vehicleInputSchema.parse(request.body);

      const photoFileIds: ObjectId[] = [];
      for (const fileId of body.photoFileIds ?? []) {
        const file = await requireFile(ctx, auth.organizationId, toObjectId(fileId), 'VEHICLE_PHOTO');
        photoFileIds.push(file._id);
      }

      const now = new Date();
      const doc: VehicleDoc = {
        _id: new ObjectId(),
        organizationId: auth.organizationId,
        plate: body.plate,
        renavam: body.renavam ?? null,
        vin: body.vin ?? null,
        brand: body.brand,
        model: body.model,
        brandLower: body.brand.toLowerCase(),
        modelLower: body.model.toLowerCase(),
        year: body.year ?? null,
        color: body.color ?? null,
        colorLower: body.color?.toLowerCase() ?? null,
        mileageKm: body.mileageKm,
        registration: { state: body.registrationState ?? null, city: body.registrationCity ?? null },
        purchase: { date: body.purchaseDate ?? null, amountCents: body.purchaseAmountCents ?? null },
        photoFileIds,
        status: 'AVAILABLE',
        archivedAt: null,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await ctx.mongo.collections.vehicles.insertOne(doc);
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'vehicle.created',
        entityType: 'vehicle',
        entityId: doc._id,
        after: doc,
      });
      reply.status(201);
      return toVehicleDTO(ctx, auth.organizationId, doc);
    },
  );

  /* ----------------------------- atualizar ------------------------- */
  app.patch(
    '/vehicles/:id',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = vehicleUpdateSchema.parse(request.body);

      const current = await ctx.mongo.collections.vehicles.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!current) throw notFound('Veículo não encontrado.');

      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (body.plate !== undefined) set.plate = body.plate;
      if (body.renavam !== undefined) set.renavam = body.renavam ?? null;
      if (body.vin !== undefined) set.vin = body.vin ?? null;
      if (body.brand !== undefined) {
        set.brand = body.brand;
        set.brandLower = body.brand.toLowerCase();
      }
      if (body.model !== undefined) {
        set.model = body.model;
        set.modelLower = body.model.toLowerCase();
      }
      if (body.year !== undefined) set.year = body.year ?? null;
      if (body.color !== undefined) {
        set.color = body.color ?? null;
        set.colorLower = body.color?.toLowerCase() ?? null;
      }
      if (body.mileageKm !== undefined) set.mileageKm = body.mileageKm;
      if (body.registrationState !== undefined) set['registration.state'] = body.registrationState ?? null;
      if (body.registrationCity !== undefined) set['registration.city'] = body.registrationCity ?? null;
      if (body.purchaseDate !== undefined) set['purchase.date'] = body.purchaseDate ?? null;
      if (body.purchaseAmountCents !== undefined)
        set['purchase.amountCents'] = body.purchaseAmountCents ?? null;
      if (body.photoFileIds !== undefined) {
        const ids: ObjectId[] = [];
        for (const fileId of body.photoFileIds) {
          const file = await requireFile(ctx, auth.organizationId, toObjectId(fileId), 'VEHICLE_PHOTO');
          ids.push(file._id);
        }
        set.photoFileIds = ids;
      }

      const updated = await ctx.mongo.collections.vehicles.findOneAndUpdate(
        { _id: id, organizationId: auth.organizationId, version: current.version },
        { $set: set, $inc: { version: 1 } },
        { returnDocument: 'after' },
      );
      if (!updated) throw conflict('O veículo foi alterado por outro usuário. Recarregue e tente novamente.');

      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'vehicle.updated',
        entityType: 'vehicle',
        entityId: id,
        before: current,
        after: updated,
      });
      return toVehicleDTO(ctx, auth.organizationId, updated);
    },
  );

  /* ------------------------------ excluir -------------------------- */
  app.delete(
    '/vehicles/:id',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'delete')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);

      const vehicle = await ctx.mongo.collections.vehicles.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!vehicle) throw notFound('Veículo não encontrado.');

      const activeRental = await ctx.mongo.collections.rentals.findOne({
        organizationId: auth.organizationId,
        vehicleId: id,
        status: 'ACTIVE',
      });
      if (activeRental) {
        throw conflict(
          `Não é possível excluir: o veículo possui a locação ativa ${activeRental.rentalNumber}. Encerre a locação antes.`,
        );
      }

      // Exclusão lógica: preserva histórico financeiro, OS e vistorias.
      await ctx.mongo.collections.vehicles.updateOne(
        { _id: id, organizationId: auth.organizationId },
        { $set: { archivedAt: new Date(), status: 'INACTIVE', updatedAt: new Date() } },
      );
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'vehicle.archived',
        entityType: 'vehicle',
        entityId: id,
        before: vehicle,
      });
      return { ok: true, archived: true };
    },
  );

  /* --------------------------- consultar multas -------------------- */
  app.get(
    '/vehicles/:id/traffic-fines',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: id, organizationId });
      if (!vehicle) throw notFound('Veículo não encontrado.');

      const status = ctx.integrations.trafficFines.status();
      if (!status.connected) {
        const payload: TrafficFinesResponse = {
          available: false,
          provider: null,
          message: status.message,
          queriedAt: null,
          fines: [],
        };
        return trafficFinesResponseSchema.parse(payload);
      }
      if (!vehicle.registration.state) {
        throw badRequest(
          'Informe a UF de emplacamento do veículo para consultar multas no DETRAN correspondente.',
        );
      }
      try {
        const fines = await ctx.integrations.trafficFines.query({
          plate: vehicle.plate,
          renavam: vehicle.renavam,
          state: vehicle.registration.state,
        });
        const payload: TrafficFinesResponse = {
          available: true,
          provider: status.name,
          message: 'Consulta realizada no provedor configurado.',
          queriedAt: new Date().toISOString(),
          fines,
        };
        return trafficFinesResponseSchema.parse(payload);
      } catch (err) {
        throw integrationUnavailable(
          `Não foi possível consultar as multas agora: ${(err as Error).message}`,
        );
      }
    },
  );
}
