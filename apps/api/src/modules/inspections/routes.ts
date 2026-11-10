import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  businessDate,
  diffDaysIso,
  inspectionListQuerySchema,
  inspectionRequestSchema,
  inspectionReviewSchema,
  MAX_ACTIVE_PHOTO_SLOTS,
  addPhotoSlotSchema,
  photoSlotsUpdateSchema,
  publicInspectionSubmitSchema,
  type Inspection,
  type InspectionVehicleCard,
  type PhotoSlot,
  type PublicInspection,
  collectionStatusLabels,
} from '@yudirect/contracts';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { sha256, slugify, toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { processKmReading } from '../../services/km-billing.js';
import { audit } from '../../services/common.js';
import { describeFiles, requireFile, storeFile } from '../../services/files.js';
import { buildInspectionDoc, nextOccurrence } from '../../services/inspection-schedule.js';
import {
  cancelCollectionForInspection,
  ensureDefaultSlots,
  formatDateTimeLocal,
} from '../../services/whatsapp-inspection.js';
import { fileUrl } from '../../services/files.js';
import type { AppContext } from '../../context.js';
import type { InspectionDoc, PhotoSlotDoc } from '../../database/types.js';

function toSlotDTO(doc: PhotoSlotDoc): PhotoSlot {
  return {
    id: doc._id.toHexString(),
    code: doc.code,
    label: doc.label,
    order: doc.order,
    active: doc.active,
    isDefault: doc.isDefault,
  };
}

async function toInspectionDTOs(
  ctx: AppContext,
  organizationId: ObjectId,
  docs: InspectionDoc[],
): Promise<Inspection[]> {
  const vehicleIds = [...new Set(docs.map((d) => d.vehicleId.toHexString()))].map((s) => new ObjectId(s));
  const [vehicles, files] = await Promise.all([
    ctx.mongo.collections.vehicles.find({ organizationId, _id: { $in: vehicleIds } }).toArray(),
    describeFiles(
      ctx,
      organizationId,
      docs.flatMap((d) => [...d.photos.map((p) => p.fileId), ...(d.photoEvidence ?? []).map((e) => e.fileId)]),
    ),
  ]);
  const vMap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));

  return docs.map((doc) => {
    const v = vMap.get(doc.vehicleId.toHexString());
    return {
      id: doc._id.toHexString(),
      vehicle: {
        id: doc.vehicleId.toHexString(),
        plate: v?.plate ?? '—',
        brand: v?.brand ?? '—',
        model: v?.model ?? '—',
        year: v?.year ?? null,
      },
      rentalId: doc.rentalId?.toHexString() ?? null,
      driverId: doc.driverId?.toHexString() ?? null,
      responsibleName: doc.responsibleName,
      phone: doc.phone,
      email: doc.email,
      scheduledAt: doc.scheduledAt,
      dueDate: doc.dueDate,
      submittedAt: doc.submittedAt?.toISOString() ?? null,
      reviewedAt: doc.reviewedAt?.toISOString() ?? null,
      status: doc.status,
      odometerKm: doc.odometerKm,
      photos: doc.photos
        .map((p) => {
          const file = files.get(p.fileId.toHexString());
          return file
            ? { slotCode: p.slotCode, slotLabel: p.slotLabel, fileId: p.fileId.toHexString(), url: file.url }
            : null;
        })
        .filter((p): p is NonNullable<typeof p> => Boolean(p)),
      notes: doc.notes,
      requestExpiresAt: doc.requestExpiresAt?.toISOString() ?? null,
      delivery: doc.delivery
        ? {
            channel: doc.delivery.channel,
            status: doc.delivery.status,
            message: doc.delivery.message,
            manualLink: doc.delivery.manualLink,
          }
        : null,
      createdAt: doc.createdAt.toISOString(),
      source: doc.source,
      collection: doc.collection
        ? {
            mode: doc.collection.mode,
            status: doc.collection.status,
            statusLabel: collectionStatusLabels[doc.collection.status],
            round: doc.collection.round,
            requiredSlots: doc.collection.requiredSlots.map((s) => ({ code: s.code, label: s.label })),
            receivedSlots: doc.collection.receivedSlots,
            requireOdometer: doc.collection.requireOdometer,
            scheduledSendAt: doc.scheduledSendAt?.toISOString() ?? null,
            requestedAt: doc.collection.requestedAt?.toISOString() ?? null,
            respondedAt: doc.collection.respondedAt?.toISOString() ?? null,
            completedAt: doc.collection.completedAt?.toISOString() ?? null,
            failureReason: doc.collection.failureReason,
          }
        : null,
      evidence: (doc.photoEvidence ?? [])
        .map((e) => {
          const file = files.get(e.fileId.toHexString());
          return file
            ? {
                slotCode: e.slotCode,
                slotLabel: e.slotLabel,
                url: file.url,
                source: e.source,
                receivedAt: e.receivedAt.toISOString(),
                round: e.round,
                late: e.late,
                superseded: Boolean(e.supersededAt),
              }
            : null;
        })
        .filter((e): e is NonNullable<typeof e> => Boolean(e)),
      correctionRound: doc.correctionRound ?? 0,
      corrections: (doc.correctionRequests ?? []).map((c) => ({ slots: c.slots, reason: c.reason, at: c.at.toISOString() })),
    };
  });
}

export async function registerInspectionRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------ configuração de fotos ------------------ */
  app.get(
    '/inspection/photo-slots',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const slots = await ensureDefaultSlots(ctx, organizationId);
      return {
        data: slots.sort((a, b) => a.order - b.order).map(toSlotDTO),
        maxActive: MAX_ACTIVE_PHOTO_SLOTS,
        activeCount: slots.filter((s) => s.active).length,
      };
    },
  );

  app.put(
    '/inspection/photo-slots',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = photoSlotsUpdateSchema.parse(request.body);
      const current = await ensureDefaultSlots(ctx, auth.organizationId);
      const byId = new Map(current.map((s) => [s._id.toHexString(), s]));

      const now = new Date();
      const keep = new Set<string>();
      let order = 0;
      for (const slot of body.slots) {
        if (slot.id && byId.has(slot.id)) {
          keep.add(slot.id);
          await ctx.mongo.collections.inspectionPhotoSlots.updateOne(
            { _id: new ObjectId(slot.id), organizationId: auth.organizationId },
            { $set: { label: slot.label, active: slot.active, order: order++, updatedAt: now } },
          );
        } else {
          const code = slot.code ?? slugify(slot.label).toUpperCase().replace(/-/g, '_');
          if (!code) throw badRequest('Informe um nome válido para o tipo de foto.');
          const doc: PhotoSlotDoc = {
            _id: new ObjectId(),
            organizationId: auth.organizationId,
            code,
            label: slot.label,
            order: order++,
            active: slot.active,
            isDefault: false,
            createdAt: now,
            updatedAt: now,
          };
          await ctx.mongo.collections.inspectionPhotoSlots.insertOne(doc);
          keep.add(doc._id.toHexString());
        }
      }

      // Remoção lógica: slots excluídos não apagam fotos históricas.
      for (const slot of current) {
        if (!keep.has(slot._id.toHexString())) {
          await ctx.mongo.collections.inspectionPhotoSlots.deleteOne({
            _id: slot._id,
            organizationId: auth.organizationId,
          });
        }
      }

      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'inspection.slots_updated',
        entityType: 'inspectionPhotoSlots',
        entityId: null,
        after: { count: body.slots.length },
      });

      const slots = await ctx.mongo.collections.inspectionPhotoSlots
        .find({ organizationId: auth.organizationId })
        .sort({ order: 1 })
        .toArray();
      return {
        data: slots.map(toSlotDTO),
        maxActive: MAX_ACTIVE_PHOTO_SLOTS,
        activeCount: slots.filter((s) => s.active).length,
      };
    },
  );

  app.post(
    '/inspection/photo-slots',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'update')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = addPhotoSlotSchema.parse(request.body);
      const slots = await ensureDefaultSlots(ctx, auth.organizationId);
      if (slots.filter((s) => s.active).length >= MAX_ACTIVE_PHOTO_SLOTS) {
        throw conflict(`Máximo de ${MAX_ACTIVE_PHOTO_SLOTS} slots ativos atingido.`);
      }
      const base = slugify(body.label).toUpperCase().replace(/-/g, '_') || 'FOTO';
      let code = base;
      let n = 1;
      while (slots.some((s) => s.code === code)) code = `${base}_${++n}`;

      const now = new Date();
      const doc: PhotoSlotDoc = {
        _id: new ObjectId(),
        organizationId: auth.organizationId,
        code,
        label: body.label,
        order: slots.length,
        active: true,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.mongo.collections.inspectionPhotoSlots.insertOne(doc);
      reply.status(201);
      return toSlotDTO(doc);
    },
  );

  /* --------------------- cartões por veículo ----------------------- */
  app.get(
    '/inspections/vehicles',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const { q, status } = request.query as { q?: string; status?: string };
      const today = businessDate();

      const vehicleFilter: Record<string, unknown> = { organizationId, archivedAt: null };
      if (q) {
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        vehicleFilter.$or = [{ plate: rx }, { brand: rx }, { model: rx }];
      }
      const vehicles = await ctx.mongo.collections.vehicles
        .find(vehicleFilter)
        .sort({ plate: 1 })
        .toArray();

      const [rentals, inspections, photoFiles] = await Promise.all([
        ctx.mongo.collections.rentals.find({ organizationId, status: 'ACTIVE' }).toArray(),
        ctx.mongo.collections.inspections.find({ organizationId }).toArray(),
        Promise.resolve(null),
      ]);
      void photoFiles;
      const driverIds = [...new Set(rentals.map((r) => r.driverId.toHexString()))].map(
        (s) => new ObjectId(s),
      );
      const drivers = await ctx.mongo.collections.drivers
        .find({ organizationId, _id: { $in: driverIds } })
        .toArray();
      const driverMap = new Map(drivers.map((d) => [d._id.toHexString(), d]));
      const rentalByVehicle = new Map(rentals.map((r) => [r.vehicleId.toHexString(), r]));

      const cards: InspectionVehicleCard[] = [];
      for (const vehicle of vehicles) {
        const key = vehicle._id.toHexString();
        const vInspections = inspections.filter((i) => i.vehicleId.toHexString() === key);
        const approved = vInspections
          .filter((i) => i.status === 'APPROVED')
          .sort((a, b) => (a.scheduledAt < b.scheduledAt ? 1 : -1));
        const pending = vInspections.filter((i) => i.status === 'PENDING' || i.status === 'SUBMITTED');
        const rental = rentalByVehicle.get(key);
        const lastInspectionAt = approved[0]?.scheduledAt ?? null;
        const nextInspectionAt =
          pending.sort((a, b) => (a.dueDate > b.dueDate ? 1 : -1))[0]?.dueDate ??
          // Mesma regra do gerador automático (services/inspection-schedule.ts).
          (rental?.inspectionRule?.period
            ? nextOccurrence(rental.inspectionRule, rental.startDate, today, rental.endDate)
            : null);
        const onSchedule = !nextInspectionAt || diffDaysIso(nextInspectionAt, today) >= 0;
        if (status === 'late' && onSchedule) continue;
        if (status === 'ok' && !onSchedule) continue;

        const driver = rental ? driverMap.get(rental.driverId.toHexString()) : undefined;
        cards.push({
          vehicle: {
            id: key,
            plate: vehicle.plate,
            brand: vehicle.brand,
            model: vehicle.model,
            year: vehicle.year,
            photoUrl: vehicle.photoFileIds?.[0]
              ? fileUrl(ctx, vehicle.photoFileIds[0]!, organizationId)
              : null,
          },
          driverName: driver?.fullName ?? null,
          lastInspectionAt,
          nextInspectionAt,
          onSchedule,
          pendingCount: pending.length,
        });
      }
      return { data: cards };
    },
  );

  /* -------------------- histórico por veículo ---------------------- */
  app.get(
    '/vehicles/:vehicleId/inspections',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const vehicleId = toObjectId((request.params as { vehicleId: string }).vehicleId, 'vehicleId');
      const query = inspectionListQuerySchema.parse(request.query);

      const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: vehicleId, organizationId });
      if (!vehicle) throw notFound('Veículo não encontrado.');

      const filter: Record<string, unknown> = { organizationId, vehicleId };
      if (query.status) filter.status = query.status;
      if (query.from || query.to) {
        const range: Record<string, string> = {};
        if (query.from) range.$gte = query.from;
        if (query.to) range.$lte = query.to;
        filter.scheduledAt = range;
      }

      const docs = await ctx.mongo.collections.inspections
        .find(filter)
        .sort({ scheduledAt: -1, _id: -1 })
        .limit(query.limit)
        .toArray();

      const today = businessDate();
      const pending = docs.filter((d) => d.status === 'PENDING' || d.status === 'SUBMITTED');
      const nextDue = pending.map((d) => d.dueDate).sort()[0] ?? null;

      return {
        vehicle: {
          id: vehicle._id.toHexString(),
          plate: vehicle.plate,
          brand: vehicle.brand,
          model: vehicle.model,
          year: vehicle.year,
        },
        onSchedule: !nextDue || diffDaysIso(nextDue, today) >= 0,
        data: await toInspectionDTOs(ctx, organizationId, docs),
      };
    },
  );

  /* ------------------------ solicitar vistoria --------------------- */
  app.post(
    '/vehicles/:vehicleId/inspections/request',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'request')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const vehicleId = toObjectId((request.params as { vehicleId: string }).vehicleId, 'vehicleId');
      const body = inspectionRequestSchema.parse(request.body);

      const [vehicle, organization] = await Promise.all([
        ctx.mongo.collections.vehicles.findOne({ _id: vehicleId, organizationId: auth.organizationId }),
        ctx.mongo.collections.organizations.findOne({ _id: auth.organizationId }),
      ]);
      if (!vehicle) throw notFound('Veículo não encontrado.');

      const rental = await ctx.mongo.collections.rentals.findOne({
        organizationId: auth.organizationId,
        vehicleId,
        status: 'ACTIVE',
      });

      const driver = rental
        ? await ctx.mongo.collections.drivers.findOne({ _id: rental.driverId, organizationId: auth.organizationId })
        : null;
      const { doc, link, plan } = await buildInspectionDoc(ctx, {
        organization,
        organizationId: auth.organizationId,
        vehicleId,
        rental,
        driver,
        responsibleName: body.responsibleName,
        phone: body.phone,
        email: body.email ?? null,
        scheduledAt: body.scheduledAt,
        notes: body.notes ?? null,
        source: 'MANUAL',
        createdBy: auth.userId,
      });
      const message =
        `Olá, ${body.responsibleName}! A ${organization?.name ?? 'locadora'} solicitou a vistoria do veículo ` +
        `${vehicle.brand} ${vehicle.model} (${vehicle.plate}). Envie as fotos por aqui: ${link}`;

      if (plan.guided) {
        // Coleta guiada: o disparo acontece no horário configurado, pelo
        // job da integração (idempotente) — nada é enviado agora.
        doc.delivery = {
          channel: 'WHATSAPP',
          status: 'PENDING',
          message: `Solicitação agendada para ${formatDateTimeLocal(plan.scheduledSendAt!)}.`,
          manualLink: link,
          attempts: 0,
        };
        await ctx.mongo.collections.inspections.insertOne(doc);
        await audit(ctx, {
          organizationId: auth.organizationId,
          actorId: auth.userId,
          action: 'inspection.requested',
          entityType: 'inspection',
          entityId: doc._id,
          after: { channel: 'WHATSAPP', scheduledSendAt: plan.scheduledSendAt },
          correlationId: doc.collection?.correlationId ?? null,
        });
        reply.status(201);
        const [dto] = await toInspectionDTOs(ctx, auth.organizationId, [doc]);
        return { inspection: dto, link };
      }

      const waStatus = ctx.integrations.whatsapp.status();
      const result = await ctx.integrations.whatsapp.send(
        body.phone,
        message,
        `inspection:${doc._id.toHexString()}`,
      );

      if (result.delivered) {
        doc.delivery = { channel: 'WHATSAPP', status: 'SENT', message: null, manualLink: null, attempts: 1 };
      } else if (body.email && ctx.integrations.email.status().connected) {
        const mail = await ctx.integrations.email.send(
          body.email,
          'Solicitação de vistoria',
          message,
        );
        doc.delivery = mail.delivered
          ? { channel: 'EMAIL', status: 'SENT', message: null, manualLink: null, attempts: 1 }
          : {
              channel: 'EMAIL',
              status: 'FAILED',
              message: mail.error,
              manualLink: result.manualLink ?? link,
              attempts: 1,
            };
      } else {
        doc.delivery = {
          channel: 'MANUAL',
          status: waStatus.connected ? 'FAILED' : 'UNAVAILABLE',
          message: result.error ?? waStatus.message,
          manualLink: result.manualLink ?? link,
          attempts: 1,
        };
      }

      await ctx.mongo.collections.inspections.insertOne(doc);
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'inspection.requested',
        entityType: 'inspection',
        entityId: doc._id,
        after: { delivery: doc.delivery?.status, channel: doc.delivery?.channel },
      });

      reply.status(201);
      const [dto] = await toInspectionDTOs(ctx, auth.organizationId, [doc]);
      return { inspection: dto, link };
    },
  );

  /* --------------------- aprovar / reprovar ------------------------ */
  app.post(
    '/inspections/:id/review',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'review')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = inspectionReviewSchema.parse(request.body);

      const inspection = await ctx.mongo.collections.inspections.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!inspection) throw notFound('Vistoria não encontrada.');
      if (inspection.status !== 'SUBMITTED') {
        throw conflict('Apenas vistorias enviadas podem ser aprovadas ou reprovadas.');
      }

      const status = body.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      // Atualização condicionada ao estado: duas decisões simultâneas não
      // podem ambas vencer (corrida corrigida — plano §1.1).
      const res = await ctx.mongo.collections.inspections.updateOne(
        { _id: id, organizationId: auth.organizationId, status: 'SUBMITTED' },
        {
          $set: {
            status,
            reviewedAt: new Date(),
            reviewerId: auth.userId,
            notes: body.notes ?? inspection.notes,
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
      );
      if (res.modifiedCount === 0) {
        throw conflict('A vistoria foi decidida ou alterada por outra operação. Recarregue a página.');
      }
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: `inspection.${status.toLowerCase()}`,
        entityType: 'inspection',
        entityId: id,
        before: { status: 'SUBMITTED' },
        after: { status, notes: body.notes ?? null, round: inspection.correctionRound ?? 0 },
        correlationId: inspection.collection?.correlationId ?? null,
      });
      // Vistoria aprovada com hodômetro: cobra o km excedente automaticamente.
      let extraKm: Awaited<ReturnType<typeof processKmReading>> | null = null;
      if (status === 'APPROVED') {
        extraKm = await processKmReading(ctx, { ...inspection, status: 'APPROVED' }, auth.userId).catch((err) => {
          request.log.error({ err, inspectionId: id }, 'falha ao calcular km excedente');
          return null;
        });
      }
      return { ok: true, status, extraKm };
    },
  );

  app.delete(
    '/inspections/:id',
    { onRequest: [app.requireAuth, app.requirePermission('inspections', 'delete')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const inspection = await ctx.mongo.collections.inspections.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!inspection) throw notFound('Vistoria não encontrada.');
      if (inspection.status === 'APPROVED') {
        throw conflict('Vistorias aprovadas não podem ser excluídas — cancele o registro se necessário.');
      }
      const res = await ctx.mongo.collections.inspections.updateOne(
        { _id: id, organizationId: auth.organizationId, status: { $nin: ['APPROVED', 'CANCELED'] } },
        {
          $set: {
            status: 'CANCELED',
            requestTokenHash: null,
            requestTokenEnc: null,
            ...(inspection.collection ? { 'collection.status': 'CANCELED', 'collection.updatedAt': new Date() } : {}),
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
      );
      if (res.modifiedCount === 0) throw conflict('A vistoria já foi aprovada ou cancelada.');
      if (inspection.collection) await cancelCollectionForInspection(ctx, inspection);
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'inspection.canceled',
        entityType: 'inspection',
        entityId: id,
      });
      return { ok: true };
    },
  );

  /* ---------------- formulário público por token ------------------- */
  app.get('/inspection-public/:token', async (request) => {
    const ctx = request.appCtx;
    const { token } = request.params as { token: string };
    const inspection = await ctx.mongo.collections.inspections.findOne({
      requestTokenHash: sha256(token),
    });
    if (!inspection) throw notFound('Link de vistoria inválido.');
    if (inspection.requestExpiresAt && inspection.requestExpiresAt.getTime() <= Date.now()) {
      throw conflict('Este link de vistoria expirou. Solicite um novo à locadora.');
    }
    if (inspection.status !== 'PENDING') {
      throw conflict('Esta vistoria já foi enviada.');
    }

    const [vehicle, organization, slots] = await Promise.all([
      ctx.mongo.collections.vehicles.findOne({ _id: inspection.vehicleId }),
      ctx.mongo.collections.organizations.findOne({ _id: inspection.organizationId }),
      ctx.mongo.collections.inspectionPhotoSlots
        .find({ organizationId: inspection.organizationId, active: true })
        .sort({ order: 1 })
        .toArray(),
    ]);

    const payload: PublicInspection = {
      organizationName: organization?.name ?? 'YuDirect',
      vehicle: {
        plate: vehicle?.plate ?? '—',
        brand: vehicle?.brand ?? '—',
        model: vehicle?.model ?? '—',
        year: vehicle?.year ?? null,
      },
      responsibleName: inspection.responsibleName,
      scheduledAt: inspection.scheduledAt,
      expiresAt: inspection.requestExpiresAt?.toISOString() ?? new Date().toISOString(),
      status: inspection.status,
      slots: slots.map((s) => ({ code: s.code, label: s.label })),
    };
    return payload;
  });

  app.post(
    '/inspection-public/:token/photos',
    { config: { rateLimit: { max: 60, timeWindow: '10 minutes' } } },
    async (request) => {
      const ctx = request.appCtx;
      const { token } = request.params as { token: string };
      const inspection = await ctx.mongo.collections.inspections.findOne({
        requestTokenHash: sha256(token),
      });
      if (!inspection || inspection.status !== 'PENDING') throw notFound('Link de vistoria inválido.');
      if (inspection.requestExpiresAt && inspection.requestExpiresAt.getTime() <= Date.now()) {
        throw conflict('Este link de vistoria expirou.');
      }

      const file = await request.file({ limits: { fileSize: 10 * 1024 * 1024 } });
      if (!file) throw badRequest('Envie a foto no campo "file".');
      const buffer = await file.toBuffer();
      const stored = await storeFile(ctx, {
        organizationId: inspection.organizationId,
        uploadedBy: null,
        purpose: 'INSPECTION_PHOTO',
        originalName: file.filename ?? 'foto.jpg',
        declaredContentType: file.mimetype ?? 'image/jpeg',
        buffer,
      });
      return { fileId: stored.id.toHexString() };
    },
  );

  app.post(
    '/inspection-public/:token/submit',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request) => {
      const ctx = request.appCtx;
      const { token } = request.params as { token: string };
      const body = publicInspectionSubmitSchema.parse(request.body);

      const inspection = await ctx.mongo.collections.inspections.findOne({
        requestTokenHash: sha256(token),
      });
      if (!inspection || inspection.status !== 'PENDING') throw notFound('Link de vistoria inválido.');
      if (inspection.requestExpiresAt && inspection.requestExpiresAt.getTime() <= Date.now()) {
        throw conflict('Este link de vistoria expirou.');
      }

      const slots = await ctx.mongo.collections.inspectionPhotoSlots
        .find({ organizationId: inspection.organizationId, active: true })
        .sort({ order: 1 })
        .toArray();
      const slotMap = new Map(slots.map((s) => [s.code, s]));
      const missing = slots.filter((s) => !body.photos.some((p) => p.slotCode === s.code));
      if (missing.length > 0) {
        throw badRequest(`Envie todas as fotos solicitadas. Faltando: ${missing.map((s) => s.label).join(', ')}.`);
      }

      const unknownSlots = body.photos.filter((p) => !slotMap.has(p.slotCode));
      if (unknownSlots.length > 0) throw badRequest('Foto enviada para um tipo de foto inexistente.');

      // Cada arquivo precisa existir, pertencer à mesma organização e ter
      // sido enviado como foto de vistoria (corrige IDOR — plano §1.1).
      const photos: InspectionDoc['photos'] = [];
      for (const p of body.photos) {
        const file = await requireFile(ctx, inspection.organizationId, toObjectId(p.fileId, 'fileId'), 'INSPECTION_PHOTO');
        photos.push({ slotCode: p.slotCode, slotLabel: slotMap.get(p.slotCode)!.label, fileId: file._id });
      }

      const now = new Date();
      const evidence = [
        ...(inspection.photoEvidence ?? []).map((e) =>
          e.slotCode && photos.some((p) => p.slotCode === e.slotCode) && !e.supersededAt ? { ...e, supersededAt: now } : e,
        ),
        ...photos.map((p) => ({
          slotCode: p.slotCode,
          slotLabel: p.slotLabel,
          fileId: p.fileId,
          source: 'WEB' as const,
          receivedAt: now,
          externalMediaId: null,
          sha256: null,
          wamid: null,
          round: inspection.correctionRound ?? 0,
          late: false,
          supersededAt: null,
        })),
      ];

      const res = await ctx.mongo.collections.inspections.updateOne(
        { _id: inspection._id, status: 'PENDING', requestTokenHash: sha256(token) },
        {
          $set: {
            status: 'SUBMITTED',
            submittedAt: now,
            odometerKm: body.odometerKm,
            photos,
            photoEvidence: evidence,
            notes: body.notes ?? inspection.notes,
            requestTokenHash: null,
            requestTokenEnc: null,
            ...(inspection.collection
              ? {
                  'collection.status': 'COMPLETE',
                  'collection.completedAt': now,
                  'collection.receivedSlots': photos.map((p) => p.slotCode),
                  'collection.updatedAt': now,
                }
              : {}),
            updatedAt: now,
          },
          $inc: { version: 1 },
        },
      );
      if (res.modifiedCount === 0) throw conflict('Esta vistoria já foi enviada.');
      if (inspection.collection?.sessionId) {
        // O cliente concluiu pelo navegador: encerra a coleta no WhatsApp.
        await ctx.integrations.whaply
          .sessionCommand(inspection.collection.sessionId, { type: 'CANCEL', reason: 'submitted_via_web' })
          .catch(() => undefined);
      }
      await audit(ctx, {
        organizationId: inspection.organizationId,
        actorId: null,
        action: 'inspection.submitted',
        entityType: 'inspection',
        entityId: inspection._id,
        after: { odometerKm: body.odometerKm, photos: photos.length, source: 'WEB' },
      });
      return { ok: true };
    },
  );
}
