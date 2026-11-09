import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  businessDate,
  computeMaintenanceTotalCents,
  computePartsCostCents,
  maintenanceCreateSchema,
  maintenanceListQuerySchema,
  maintenanceUpdateSchema,
  paymentMethodLabels,
  type MaintenanceOrder,
  type MaintenanceSummary,
  type MaintenanceVehicleCard,
} from '@frotaone/contracts';
import { conflict, notFound } from '../../common/errors.js';
import { escapeRegex, toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { withTransaction } from '../../database/mongo.js';
import { audit, nextNumber } from '../../services/common.js';
import { describeFiles, requireFile } from '../../services/files.js';
import { defaultBankAccountId, postTransaction, reverseTransaction } from '../../services/ledger.js';
import { renderMaintenanceReport } from '../../pdf/maintenance-report.js';
import type { AppContext } from '../../context.js';
import type { MaintenanceOrderDoc } from '../../database/types.js';

async function toOrderDTOs(
  ctx: AppContext,
  organizationId: ObjectId,
  docs: MaintenanceOrderDoc[],
): Promise<MaintenanceOrder[]> {
  const vehicleIds = [...new Set(docs.map((d) => d.vehicleId.toHexString()))].map((s) => new ObjectId(s));
  const bankIds = docs.map((d) => d.bankAccountId).filter((v): v is ObjectId => Boolean(v));
  const [vehicles, accounts, files] = await Promise.all([
    ctx.mongo.collections.vehicles.find({ organizationId, _id: { $in: vehicleIds } }).toArray(),
    bankIds.length
      ? ctx.mongo.collections.bankAccounts.find({ organizationId, _id: { $in: bankIds } }).toArray()
      : Promise.resolve([]),
    describeFiles(
      ctx,
      organizationId,
      docs.map((d) => d.invoiceFileId).filter((v): v is ObjectId => Boolean(v)),
    ),
  ]);
  const vMap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));
  const aMap = new Map(accounts.map((a) => [a._id.toHexString(), a]));

  return docs.map((doc) => {
    const v = vMap.get(doc.vehicleId.toHexString());
    const invoice = doc.invoiceFileId ? files.get(doc.invoiceFileId.toHexString()) : undefined;
    const account = doc.bankAccountId ? aMap.get(doc.bankAccountId.toHexString()) : undefined;
    return {
      id: doc._id.toHexString(),
      orderNumber: doc.orderNumber,
      vehicle: {
        id: doc.vehicleId.toHexString(),
        plate: v?.plate ?? '—',
        brand: v?.brand ?? '—',
        model: v?.model ?? '—',
        year: v?.year ?? null,
      },
      type: doc.type,
      status: doc.status,
      description: doc.description,
      openedAt: doc.openedAt,
      scheduledAt: doc.scheduledAt,
      performedAt: doc.performedAt,
      completedAt: doc.completedAt,
      canceledAt: doc.canceledAt,
      mileageKm: doc.mileageKm,
      laborCostCents: doc.laborCostCents,
      partsCostCents: doc.partsCostCents,
      totalCents: doc.totalCents,
      items: doc.items,
      paymentMethod: doc.paymentMethod,
      bankAccount: account ? { id: account._id.toHexString(), name: account.name } : null,
      invoice: invoice
        ? {
            fileId: invoice.id.toHexString(),
            url: invoice.url,
            originalName: invoice.originalName,
            contentType: invoice.contentType,
            label: 'Nota Fiscal da OS',
          }
        : null,
      notes: doc.notes,
      ledgerPosted: Boolean(doc.ledgerTransactionId),
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  });
}

function summarize(docs: MaintenanceOrderDoc[]): MaintenanceSummary {
  const eligible = docs.filter((d) => d.status !== 'CANCELED');
  const totalCents = eligible.reduce((a, d) => a + d.totalCents, 0);
  return {
    orderCount: docs.length,
    totalCents,
    completedCount: docs.filter((d) => d.status === 'COMPLETED').length,
    openCount: docs.filter((d) => d.status === 'OPEN').length,
    canceledCount: docs.filter((d) => d.status === 'CANCELED').length,
    laborCents: eligible.reduce((a, d) => a + d.laborCostCents, 0),
    partsCents: eligible.reduce((a, d) => a + d.partsCostCents, 0),
    averageCents: eligible.length > 0 ? Math.round(totalCents / eligible.length) : 0,
  };
}

/** Lança (ou estorna) a saída bancária da OS. Exatamente uma vez. */
async function syncLedgerForOrder(
  ctx: AppContext,
  organizationId: ObjectId,
  actorId: ObjectId | null,
  order: MaintenanceOrderDoc,
  session?: Parameters<typeof postTransaction>[2],
): Promise<ObjectId | null> {
  const shouldPost = order.status === 'COMPLETED' && order.totalCents > 0 && Boolean(order.bankAccountId);

  if (shouldPost && !order.ledgerTransactionId) {
    return postTransaction(
      ctx,
      {
        organizationId,
        bankAccountId: order.bankAccountId!,
        occurredAt: order.completedAt ?? order.performedAt ?? businessDate(),
        description: `Manutenção ${order.orderNumber} - ${order.description}`.slice(0, 180),
        direction: 'OUT',
        amountCents: order.totalCents,
        originType: 'MAINTENANCE',
        originId: order._id,
        dedupeKey: `maintenance:${order._id.toHexString()}`,
        actorId,
      },
      session,
    );
  }

  if (!shouldPost && order.ledgerTransactionId) {
    await reverseTransaction(
      ctx,
      {
        organizationId,
        transactionId: order.ledgerTransactionId,
        occurredAt: businessDate(),
        reason: `OS ${order.orderNumber}`,
        actorId,
      },
      session,
    );
    return null;
  }

  return order.ledgerTransactionId;
}

export async function registerMaintenanceRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------- grade de veículos (cards) ------------------ */
  app.get(
    '/maintenance/vehicles',
    { onRequest: [app.requireAuth, app.requirePermission('maintenance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const { q } = request.query as { q?: string };

      const filter: Record<string, unknown> = { organizationId, archivedAt: null };
      if (q) {
        const rx = new RegExp(escapeRegex(q), 'i');
        filter.$or = [{ plate: rx }, { brand: rx }, { model: rx }];
      }
      const vehicles = await ctx.mongo.collections.vehicles.find(filter).sort({ plate: 1 }).toArray();
      const stats = await ctx.mongo.collections.maintenanceOrders
        .aggregate<{ _id: ObjectId; orderCount: number; totalCents: number; lastPerformedAt: string | null }>([
          { $match: { organizationId, status: { $ne: 'CANCELED' } } },
          {
            $group: {
              _id: '$vehicleId',
              orderCount: { $sum: 1 },
              totalCents: { $sum: '$totalCents' },
              lastPerformedAt: { $max: '$performedAt' },
            },
          },
        ])
        .toArray();
      const statMap = new Map(stats.map((s) => [s._id.toHexString(), s]));

      const cards: MaintenanceVehicleCard[] = vehicles.map((v) => {
        const s = statMap.get(v._id.toHexString());
        return {
          vehicle: {
            id: v._id.toHexString(),
            plate: v.plate,
            brand: v.brand,
            model: v.model,
            year: v.year,
            status: v.status,
          },
          orderCount: s?.orderCount ?? 0,
          totalCents: s?.totalCents ?? 0,
          lastPerformedAt: s?.lastPerformedAt ?? null,
        };
      });
      return { data: cards };
    },
  );

  /* ------------------ histórico de OS por veículo ------------------ */
  app.get(
    '/vehicles/:vehicleId/maintenance',
    { onRequest: [app.requireAuth, app.requirePermission('maintenance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const vehicleId = toObjectId((request.params as { vehicleId: string }).vehicleId, 'vehicleId');
      const query = maintenanceListQuerySchema.parse(request.query);

      const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: vehicleId, organizationId });
      if (!vehicle) throw notFound('Veículo não encontrado.');

      const filter: Record<string, unknown> = { organizationId, vehicleId };
      if (query.status) filter.status = query.status;
      if (query.type) filter.type = query.type;

      const docs = await ctx.mongo.collections.maintenanceOrders
        .find(filter)
        .sort({ performedAt: -1, _id: -1 })
        .limit(query.limit)
        .toArray();
      const all = await ctx.mongo.collections.maintenanceOrders
        .find({ organizationId, vehicleId })
        .toArray();

      return {
        vehicle: {
          id: vehicle._id.toHexString(),
          plate: vehicle.plate,
          brand: vehicle.brand,
          model: vehicle.model,
          year: vehicle.year,
          mileageKm: vehicle.mileageKm,
          status: vehicle.status,
        },
        summary: summarize(all),
        data: await toOrderDTOs(ctx, organizationId, docs),
      };
    },
  );

  /* --------------------------- detalhe OS -------------------------- */
  app.get(
    '/maintenance/:id',
    { onRequest: [app.requireAuth, app.requirePermission('maintenance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const doc = await ctx.mongo.collections.maintenanceOrders.findOne({ _id: id, organizationId });
      if (!doc) throw notFound('Ordem de serviço não encontrada.');
      const [dto] = await toOrderDTOs(ctx, organizationId, [doc]);
      return dto;
    },
  );

  /* ---------------------------- criar OS --------------------------- */
  app.post(
    '/vehicles/:vehicleId/maintenance',
    { onRequest: [app.requireAuth, app.requirePermission('maintenance', 'create')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const vehicleId = toObjectId((request.params as { vehicleId: string }).vehicleId, 'vehicleId');
      const body = maintenanceCreateSchema.parse(request.body);

      const vehicle = await ctx.mongo.collections.vehicles.findOne({
        _id: vehicleId,
        organizationId: auth.organizationId,
      });
      if (!vehicle) throw notFound('Veículo não encontrado.');

      const invoice = body.invoiceFileId
        ? await requireFile(
            ctx,
            auth.organizationId,
            toObjectId(body.invoiceFileId),
            'MAINTENANCE_INVOICE',
          )
        : null;

      const bankAccountId = body.bankAccountId
        ? toObjectId(body.bankAccountId, 'bankAccountId')
        : await defaultBankAccountId(ctx, auth.organizationId);

      const today = businessDate();
      const performedAt = body.performedAt ?? today;
      const items = body.items.map((item) => ({
        name: item.name,
        code: item.code ?? null,
        quantity: item.quantity,
        unitCostCents: item.unitCostCents,
        subtotalCents: item.quantity * item.unitCostCents,
        supplier: item.supplier ?? null,
        warrantyUntil: item.warrantyUntil ?? null,
        nextDueDate: item.nextDueDate ?? null,
      }));
      const partsCostCents = computePartsCostCents(items);
      const totalCents = computeMaintenanceTotalCents(body.laborCostCents, items);

      const created = await withTransaction(ctx, async (session) => {
        const year = Number(performedAt.slice(0, 4));
        const { number, sequence } = await nextNumber(
          ctx,
          auth.organizationId,
          'maintenance',
          'WO',
          year,
          session,
        );
        const now = new Date();
        const doc: MaintenanceOrderDoc = {
          _id: new ObjectId(),
          organizationId: auth.organizationId,
          orderNumber: number,
          sequence,
          vehicleId,
          type: body.type,
          status: body.status,
          description: body.description,
          openedAt: today,
          scheduledAt: null,
          performedAt,
          completedAt: body.status === 'COMPLETED' ? performedAt : null,
          canceledAt: null,
          mileageKm: body.mileageKm ?? null,
          laborCostCents: body.laborCostCents,
          partsCostCents,
          totalCents,
          items,
          paymentMethod: body.paymentMethod,
          bankAccountId: bankAccountId ?? null,
          invoiceFileId: invoice?._id ?? null,
          notes: body.notes ?? null,
          ledgerTransactionId: null,
          createdBy: auth.userId,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        await ctx.mongo.collections.maintenanceOrders.insertOne(doc, { session });

        const ledgerTransactionId = await syncLedgerForOrder(
          ctx,
          auth.organizationId,
          auth.userId,
          doc,
          session,
        );
        if (ledgerTransactionId) {
          await ctx.mongo.collections.maintenanceOrders.updateOne(
            { _id: doc._id },
            { $set: { ledgerTransactionId, updatedAt: now } },
            { session },
          );
          doc.ledgerTransactionId = ledgerTransactionId;
        }

        // Hodômetro: valores maiores atualizam o veículo (texto da tela).
        if (body.mileageKm !== undefined && body.mileageKm > vehicle.mileageKm) {
          await ctx.mongo.collections.vehicles.updateOne(
            { _id: vehicleId, organizationId: auth.organizationId },
            { $set: { mileageKm: body.mileageKm, updatedAt: now } },
            { session },
          );
        }

        await audit(
          ctx,
          {
            organizationId: auth.organizationId,
            actorId: auth.userId,
            action: 'maintenance.created',
            entityType: 'maintenanceOrder',
            entityId: doc._id,
            after: { orderNumber: number, totalCents, status: doc.status },
          },
          session,
        );
        return doc;
      });

      reply.status(201);
      const [dto] = await toOrderDTOs(ctx, auth.organizationId, [created]);
      return dto;
    },
  );

  /* --------------------------- atualizar OS ------------------------ */
  app.patch(
    '/maintenance/:id',
    { onRequest: [app.requireAuth, app.requirePermission('maintenance', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = maintenanceUpdateSchema.parse(request.body);

      const current = await ctx.mongo.collections.maintenanceOrders.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!current) throw notFound('Ordem de serviço não encontrada.');
      if (current.status === 'CANCELED') throw conflict('Ordem cancelada não pode ser editada.');

      const items =
        body.items !== undefined
          ? body.items.map((item) => ({
              name: item.name,
              code: item.code ?? null,
              quantity: item.quantity,
              unitCostCents: item.unitCostCents,
              subtotalCents: item.quantity * item.unitCostCents,
              supplier: item.supplier ?? null,
              warrantyUntil: item.warrantyUntil ?? null,
              nextDueDate: item.nextDueDate ?? null,
            }))
          : current.items;
      const laborCostCents = body.laborCostCents ?? current.laborCostCents;
      const partsCostCents = computePartsCostCents(items);
      const totalCents = laborCostCents + partsCostCents;

      const updated = await withTransaction(ctx, async (session) => {
        const now = new Date();
        const set: Record<string, unknown> = { updatedAt: now, items, partsCostCents, totalCents, laborCostCents };
        if (body.type !== undefined) set.type = body.type;
        if (body.description !== undefined) set.description = body.description;
        if (body.performedAt !== undefined) set.performedAt = body.performedAt ?? null;
        if (body.mileageKm !== undefined) set.mileageKm = body.mileageKm ?? null;
        if (body.notes !== undefined) set.notes = body.notes ?? null;
        if (body.paymentMethod !== undefined) set.paymentMethod = body.paymentMethod;
        if (body.bankAccountId !== undefined) set.bankAccountId = toObjectId(body.bankAccountId);
        if (body.invoiceFileId !== undefined) {
          const file = await requireFile(
            ctx,
            auth.organizationId,
            toObjectId(body.invoiceFileId),
            'MAINTENANCE_INVOICE',
          );
          set.invoiceFileId = file._id;
        }

        const next = await ctx.mongo.collections.maintenanceOrders.findOneAndUpdate(
          { _id: id, organizationId: auth.organizationId, version: current.version },
          { $set: set, $inc: { version: 1 } },
          { returnDocument: 'after', session },
        );
        if (!next) throw conflict('A OS foi alterada por outro usuário. Recarregue e tente novamente.');

        // Valor mudou com lançamento já efetuado: estorna e relança.
        if (next.ledgerTransactionId && next.totalCents !== current.totalCents) {
          await reverseTransaction(
            ctx,
            {
              organizationId: auth.organizationId,
              transactionId: next.ledgerTransactionId,
              occurredAt: businessDate(),
              reason: `Ajuste da OS ${next.orderNumber}`,
              actorId: auth.userId,
            },
            session,
          );
          const newTx = await postTransaction(
            ctx,
            {
              organizationId: auth.organizationId,
              bankAccountId: next.bankAccountId!,
              occurredAt: next.completedAt ?? next.performedAt ?? businessDate(),
              description: `Manutenção ${next.orderNumber} - ${next.description}`.slice(0, 180),
              direction: 'OUT',
              amountCents: next.totalCents,
              originType: 'MAINTENANCE',
              originId: next._id,
              dedupeKey: `maintenance:${next._id.toHexString()}:v${next.version}`,
              actorId: auth.userId,
            },
            session,
          );
          await ctx.mongo.collections.maintenanceOrders.updateOne(
            { _id: id },
            { $set: { ledgerTransactionId: newTx } },
            { session },
          );
          next.ledgerTransactionId = newTx;
        }

        await audit(
          ctx,
          {
            organizationId: auth.organizationId,
            actorId: auth.userId,
            action: 'maintenance.updated',
            entityType: 'maintenanceOrder',
            entityId: id,
            before: { totalCents: current.totalCents },
            after: { totalCents: next.totalCents },
          },
          session,
        );
        return next;
      });

      const [dto] = await toOrderDTOs(ctx, auth.organizationId, [updated]);
      return dto;
    },
  );

  /* ---------------------- concluir / cancelar ---------------------- */
  app.post(
    '/maintenance/:id/complete',
    { onRequest: [app.requireAuth, app.requirePermission('maintenance', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const order = await ctx.mongo.collections.maintenanceOrders.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!order) throw notFound('Ordem de serviço não encontrada.');
      if (order.status === 'COMPLETED') return { ok: true, alreadyCompleted: true };
      if (order.status === 'CANCELED') throw conflict('Ordem cancelada não pode ser concluída.');

      await withTransaction(ctx, async (session) => {
        const now = new Date();
        const completedAt = businessDate();
        const next: MaintenanceOrderDoc = { ...order, status: 'COMPLETED', completedAt };
        const ledgerTransactionId = await syncLedgerForOrder(
          ctx,
          auth.organizationId,
          auth.userId,
          next,
          session,
        );
        await ctx.mongo.collections.maintenanceOrders.updateOne(
          { _id: id, organizationId: auth.organizationId },
          { $set: { status: 'COMPLETED', completedAt, ledgerTransactionId, updatedAt: now } },
          { session },
        );
        await audit(
          ctx,
          {
            organizationId: auth.organizationId,
            actorId: auth.userId,
            action: 'maintenance.completed',
            entityType: 'maintenanceOrder',
            entityId: id,
          },
          session,
        );
      });
      return { ok: true };
    },
  );

  app.post(
    '/maintenance/:id/cancel',
    { onRequest: [app.requireAuth, app.requirePermission('maintenance', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const order = await ctx.mongo.collections.maintenanceOrders.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!order) throw notFound('Ordem de serviço não encontrada.');
      if (order.status === 'CANCELED') return { ok: true, alreadyCanceled: true };

      await withTransaction(ctx, async (session) => {
        const now = new Date();
        if (order.ledgerTransactionId) {
          await reverseTransaction(
            ctx,
            {
              organizationId: auth.organizationId,
              transactionId: order.ledgerTransactionId,
              occurredAt: businessDate(),
              reason: `Cancelamento da OS ${order.orderNumber}`,
              actorId: auth.userId,
            },
            session,
          );
        }
        await ctx.mongo.collections.maintenanceOrders.updateOne(
          { _id: id, organizationId: auth.organizationId },
          {
            $set: {
              status: 'CANCELED',
              canceledAt: businessDate(),
              ledgerTransactionId: null,
              updatedAt: now,
            },
          },
          { session },
        );
        await audit(
          ctx,
          {
            organizationId: auth.organizationId,
            actorId: auth.userId,
            action: 'maintenance.canceled',
            entityType: 'maintenanceOrder',
            entityId: id,
          },
          session,
        );
      });
      return { ok: true };
    },
  );

  app.delete(
    '/maintenance/:id',
    { onRequest: [app.requireAuth, app.requirePermission('maintenance', 'delete')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const order = await ctx.mongo.collections.maintenanceOrders.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!order) throw notFound('Ordem de serviço não encontrada.');

      await withTransaction(ctx, async (session) => {
        if (order.ledgerTransactionId) {
          await reverseTransaction(
            ctx,
            {
              organizationId: auth.organizationId,
              transactionId: order.ledgerTransactionId,
              occurredAt: businessDate(),
              reason: `Exclusão da OS ${order.orderNumber}`,
              actorId: auth.userId,
            },
            session,
          );
        }
        await ctx.mongo.collections.maintenanceOrders.deleteOne(
          { _id: id, organizationId: auth.organizationId },
          { session },
        );
        await audit(
          ctx,
          {
            organizationId: auth.organizationId,
            actorId: auth.userId,
            action: 'maintenance.deleted',
            entityType: 'maintenanceOrder',
            entityId: id,
            before: order,
          },
          session,
        );
      });
      return { ok: true };
    },
  );

  /* ---------------------------- PDF do veículo --------------------- */
  app.get(
    '/vehicles/:vehicleId/maintenance/report.pdf',
    { onRequest: [app.requireAuth, app.requirePermission('maintenance', 'export')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const vehicleId = toObjectId((request.params as { vehicleId: string }).vehicleId, 'vehicleId');

      const [vehicle, organization, orders] = await Promise.all([
        ctx.mongo.collections.vehicles.findOne({ _id: vehicleId, organizationId }),
        ctx.mongo.collections.organizations.findOne({ _id: organizationId }),
        ctx.mongo.collections.maintenanceOrders
          .find({ organizationId, vehicleId })
          .sort({ performedAt: -1, _id: -1 })
          .toArray(),
      ]);
      if (!vehicle) throw notFound('Veículo não encontrado.');

      const pdf = await renderMaintenanceReport({
        organizationName: organization?.name ?? 'FrotaOne',
        issuedAt: new Date(),
        vehicle: {
          plate: vehicle.plate,
          brand: vehicle.brand,
          model: vehicle.model,
          year: vehicle.year,
          color: vehicle.color,
          renavam: vehicle.renavam,
          vin: vehicle.vin,
          mileageKm: vehicle.mileageKm,
          status: vehicle.status,
          purchaseDate: vehicle.purchase?.date ?? null,
        },
        orders: orders.map((order) => ({
          orderNumber: order.orderNumber,
          type: order.type,
          status: order.status,
          description: order.description,
          openedAt: order.openedAt,
          scheduledAt: order.scheduledAt,
          performedAt: order.performedAt,
          completedAt: order.completedAt,
          mileageKm: order.mileageKm,
          laborCostCents: order.laborCostCents,
          partsCostCents: order.partsCostCents,
          totalCents: order.totalCents,
          paymentMethodLabel: paymentMethodLabels[order.paymentMethod],
          items: order.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unitCostCents: item.unitCostCents,
            subtotalCents: item.subtotalCents,
            supplier: item.supplier,
            warrantyUntil: item.warrantyUntil,
            nextDueDate: item.nextDueDate,
          })),
        })),
      });

      const fileName = `manutencoes-${vehicle.plate.toLowerCase()}-${businessDate()}.pdf`;
      reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${fileName}"`);
      return reply.send(pdf);
    },
  );
}
