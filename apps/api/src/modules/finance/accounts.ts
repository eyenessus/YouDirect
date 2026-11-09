import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  businessDate,
  expenseCategoryCreateSchema,
  payableCreateSchema,
  payableListQuerySchema,
  payableUpdateSchema,
  receivableListQuerySchema,
  registerPaymentSchema,
  type ExpenseCategory,
  type Payable,
  type Receivable,
} from '@yudirect/contracts';
import { conflict, notFound } from '../../common/errors.js';
import {
  decodeCursor,
  encodeCursor,
  escapeRegex,
  foldAccents,
  generateToken,
  slugify,
  toObjectId,
} from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { withTransaction } from '../../database/mongo.js';
import { audit } from '../../services/common.js';
import {
  derivePayableStatus,
  deriveReceivableStatus,
  registerPayablePayment,
  registerReceivablePayment,
  remainingCents,
  reversePaymentsOf,
} from '../../services/finance.js';
import { defaultBankAccountId } from '../../services/ledger.js';
import type { AppContext } from '../../context.js';
import type { PayableDoc, ReceivableDoc } from '../../database/types.js';

/* --------------------------- Categorias ---------------------------- */

const DEFAULT_CATEGORIES = ['Financiamento', 'Seguro', 'Outro'];

export async function ensureDefaultCategories(ctx: AppContext, organizationId: ObjectId) {
  const count = await ctx.mongo.collections.expenseCategories.countDocuments({ organizationId });
  if (count > 0) return;
  const now = new Date();
  await ctx.mongo.collections.expenseCategories.insertMany(
    DEFAULT_CATEGORIES.map((label) => ({
      _id: new ObjectId(),
      organizationId,
      label,
      slug: slugify(label),
      active: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

async function toPayableDTOs(
  ctx: AppContext,
  organizationId: ObjectId,
  docs: PayableDoc[],
): Promise<Payable[]> {
  const categoryIds = docs.map((d) => d.categoryId).filter((v): v is ObjectId => Boolean(v));
  const vehicleIds = docs.map((d) => d.vehicleId).filter((v): v is ObjectId => Boolean(v));
  const [categories, vehicles] = await Promise.all([
    categoryIds.length
      ? ctx.mongo.collections.expenseCategories.find({ organizationId, _id: { $in: categoryIds } }).toArray()
      : Promise.resolve([]),
    vehicleIds.length
      ? ctx.mongo.collections.vehicles.find({ organizationId, _id: { $in: vehicleIds } }).toArray()
      : Promise.resolve([]),
  ]);
  const cMap = new Map(categories.map((c) => [c._id.toHexString(), c]));
  const vMap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));

  return docs.map((doc) => {
    const category = doc.categoryId ? cMap.get(doc.categoryId.toHexString()) : undefined;
    const vehicle = doc.vehicleId ? vMap.get(doc.vehicleId.toHexString()) : undefined;
    return {
      id: doc._id.toHexString(),
      description: doc.description,
      category: category ? { id: category._id.toHexString(), label: category.label } : null,
      vehicle: vehicle ? { id: vehicle._id.toHexString(), plate: vehicle.plate } : null,
      amountCents: doc.amountCents,
      paidAmountCents: doc.paidAmountCents,
      remainingCents: remainingCents(doc.amountCents, doc.paidAmountCents),
      dueDate: doc.dueDate,
      supplierName: doc.supplier?.name ?? null,
      supplierTaxId: doc.supplier?.taxId ?? null,
      documentUrl: doc.documentUrl,
      recurring: Boolean(doc.recurring?.enabled),
      recurringSeriesId: doc.recurring?.seriesId ?? null,
      notes: doc.notes,
      status: doc.status,
      createdAt: doc.createdAt.toISOString(),
    };
  });
}

async function toReceivableDTOs(
  ctx: AppContext,
  organizationId: ObjectId,
  docs: ReceivableDoc[],
): Promise<Receivable[]> {
  const driverIds = [...new Set(docs.map((d) => d.driverId.toHexString()))].map((s) => new ObjectId(s));
  const rentalIds = docs.map((d) => d.rentalId).filter((v): v is ObjectId => Boolean(v));
  const [drivers, rentals] = await Promise.all([
    ctx.mongo.collections.drivers.find({ organizationId, _id: { $in: driverIds } }).toArray(),
    rentalIds.length
      ? ctx.mongo.collections.rentals.find({ organizationId, _id: { $in: rentalIds } }).toArray()
      : Promise.resolve([]),
  ]);
  const dMap = new Map(drivers.map((d) => [d._id.toHexString(), d]));
  const rMap = new Map(rentals.map((r) => [r._id.toHexString(), r]));

  return docs.map((doc) => {
    const driver = dMap.get(doc.driverId.toHexString());
    const rental = doc.rentalId ? rMap.get(doc.rentalId.toHexString()) : undefined;
    return {
      id: doc._id.toHexString(),
      description: doc.description,
      rental: rental ? { id: rental._id.toHexString(), rentalNumber: rental.rentalNumber } : null,
      driver: {
        id: doc.driverId.toHexString(),
        fullName: driver?.fullName ?? '—',
        cpf: driver ? ctx.pii.decrypt(driver.cpfEncrypted) : null,
      },
      grossAmountCents: doc.grossAmountCents,
      paidAmountCents: doc.paidAmountCents,
      remainingCents: remainingCents(doc.grossAmountCents, doc.paidAmountCents),
      dueDate: doc.dueDate,
      paymentMethod: doc.paymentMethod,
      status: doc.status,
      createdAt: doc.createdAt.toISOString(),
    };
  });
}

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------- categorias --------------------------- */
  app.get(
    '/expense-categories',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      await ensureDefaultCategories(ctx, organizationId);
      const docs = await ctx.mongo.collections.expenseCategories
        .find({ organizationId, active: true })
        .sort({ label: 1 })
        .toArray();
      const data: ExpenseCategory[] = docs.map((d) => ({
        id: d._id.toHexString(),
        label: d.label,
        slug: d.slug,
        active: d.active,
        isDefault: d.isDefault,
      }));
      return { data };
    },
  );

  app.post(
    '/expense-categories',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'create')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = expenseCategoryCreateSchema.parse(request.body);
      const now = new Date();
      const doc = {
        _id: new ObjectId(),
        organizationId: auth.organizationId,
        label: body.label,
        slug: slugify(body.label),
        active: true,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.mongo.collections.expenseCategories.insertOne(doc);
      reply.status(201);
      return { id: doc._id.toHexString(), label: doc.label, slug: doc.slug, active: true, isDefault: false };
    },
  );

  /* ------------------------- contas a pagar ------------------------ */
  app.get(
    '/payables',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const query = payableListQuerySchema.parse(request.query);

      const filter: Record<string, unknown> = { organizationId };
      if (query.status) filter.status = query.status;
      if (query.categoryId) filter.categoryId = toObjectId(query.categoryId, 'categoryId');
      if (query.q) {
        const rx = new RegExp(escapeRegex(foldAccents(query.q).toLowerCase()), 'i');
        filter.$or = [{ descriptionFold: rx }, { 'supplier.nameFold': rx }];
      }

      const sortMap: Record<string, Record<string, 1 | -1>> = {
        createdAt: { createdAt: -1, _id: -1 },
        dueDate: { dueDate: 1, _id: 1 },
        amount: { amountCents: -1, _id: -1 },
        description: { descriptionFold: 1, _id: 1 },
      };
      const sort = sortMap[query.sort] ?? sortMap.createdAt!;

      const cursor = decodeCursor<{ skip: number }>(query.cursor);
      const skip = cursor?.skip ?? 0;
      const docs = await ctx.mongo.collections.payables
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(query.limit + 1)
        .toArray();
      const hasMore = docs.length > query.limit;
      const page = hasMore ? docs.slice(0, query.limit) : docs;
      const total = await ctx.mongo.collections.payables.countDocuments(filter);

      return {
        data: await toPayableDTOs(ctx, organizationId, page),
        page: { nextCursor: hasMore ? encodeCursor({ skip: skip + query.limit }) : null, total },
      };
    },
  );

  app.get(
    '/payables/:id',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const doc = await ctx.mongo.collections.payables.findOne({ _id: id, organizationId });
      if (!doc) throw notFound('Conta a pagar não encontrada.');
      const [dto] = await toPayableDTOs(ctx, organizationId, [doc]);
      return dto;
    },
  );

  app.post(
    '/payables',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'create')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = payableCreateSchema.parse(request.body);
      const today = businessDate();

      const category = await ctx.mongo.collections.expenseCategories.findOne({
        _id: toObjectId(body.categoryId, 'categoryId'),
        organizationId: auth.organizationId,
      });
      if (!category) throw notFound('Categoria não encontrada.');

      if (body.vehicleId) {
        const vehicle = await ctx.mongo.collections.vehicles.findOne({
          _id: toObjectId(body.vehicleId, 'vehicleId'),
          organizationId: auth.organizationId,
        });
        if (!vehicle) throw notFound('Veículo não encontrado.');
      }

      const now = new Date();
      const doc: PayableDoc = {
        _id: new ObjectId(),
        organizationId: auth.organizationId,
        description: body.description,
        descriptionFold: foldAccents(body.description).toLowerCase(),
        categoryId: category._id,
        vehicleId: body.vehicleId ? toObjectId(body.vehicleId) : null,
        amountCents: body.amountCents,
        paidAmountCents: 0,
        dueDate: body.dueDate,
        supplier: {
          name: body.supplierName ?? null,
          nameFold: body.supplierName ? foldAccents(body.supplierName).toLowerCase() : null,
          taxId: body.supplierTaxId ?? null,
        },
        documentUrl: body.documentUrl ?? null,
        recurring: body.recurring
          ? { enabled: true, seriesId: generateToken(10), period: body.dueDate.slice(0, 7) }
          : { enabled: false, seriesId: null, period: null },
        notes: body.notes ?? null,
        status: 'PENDING',
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      doc.status = derivePayableStatus(doc, today);
      await ctx.mongo.collections.payables.insertOne(doc);

      if (body.alreadyPaid) {
        const bankAccountId = body.paidBankAccountId
          ? toObjectId(body.paidBankAccountId, 'paidBankAccountId')
          : await defaultBankAccountId(ctx, auth.organizationId);
        if (!bankAccountId) {
          throw conflict('Cadastre uma conta bancária antes de registrar uma conta já paga.');
        }
        await registerPayablePayment(ctx, {
          organizationId: auth.organizationId,
          actorId: auth.userId,
          sourceId: doc._id,
          amountCents: doc.amountCents,
          paidAt: doc.dueDate <= today ? doc.dueDate : today,
          method: 'CASH',
          bankAccountId,
          notes: 'Cadastrada como já paga.',
        });
      }

      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'payable.created',
        entityType: 'payable',
        entityId: doc._id,
        after: { amountCents: doc.amountCents, dueDate: doc.dueDate },
      });

      const fresh = await ctx.mongo.collections.payables.findOne({ _id: doc._id });
      reply.status(201);
      const [dto] = await toPayableDTOs(ctx, auth.organizationId, [fresh!]);
      return dto;
    },
  );

  app.patch(
    '/payables/:id',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = payableUpdateSchema.parse(request.body);
      const current = await ctx.mongo.collections.payables.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!current) throw notFound('Conta a pagar não encontrada.');
      if (current.paidAmountCents > 0 && body.amountCents !== undefined && body.amountCents < current.paidAmountCents) {
        throw conflict('O novo valor não pode ser menor que o total já pago.');
      }

      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (body.description !== undefined) {
        set.description = body.description;
        set.descriptionFold = foldAccents(body.description).toLowerCase();
      }
      if (body.categoryId !== undefined) set.categoryId = toObjectId(body.categoryId, 'categoryId');
      if (body.vehicleId !== undefined) set.vehicleId = body.vehicleId ? toObjectId(body.vehicleId) : null;
      if (body.amountCents !== undefined) set.amountCents = body.amountCents;
      if (body.dueDate !== undefined) set.dueDate = body.dueDate;
      if (body.supplierName !== undefined) {
        set['supplier.name'] = body.supplierName ?? null;
        set['supplier.nameFold'] = body.supplierName ? foldAccents(body.supplierName).toLowerCase() : null;
      }
      if (body.supplierTaxId !== undefined) set['supplier.taxId'] = body.supplierTaxId ?? null;
      if (body.documentUrl !== undefined) set.documentUrl = body.documentUrl ?? null;
      if (body.notes !== undefined) set.notes = body.notes ?? null;

      const next = await ctx.mongo.collections.payables.findOneAndUpdate(
        { _id: id, organizationId: auth.organizationId, version: current.version },
        { $set: set, $inc: { version: 1 } },
        { returnDocument: 'after' },
      );
      if (!next) throw conflict('A conta foi alterada por outro usuário. Recarregue e tente novamente.');
      const status = derivePayableStatus(next, businessDate());
      if (status !== next.status) {
        await ctx.mongo.collections.payables.updateOne({ _id: id }, { $set: { status } });
        next.status = status;
      }
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'payable.updated',
        entityType: 'payable',
        entityId: id,
        before: current,
        after: next,
      });
      const [dto] = await toPayableDTOs(ctx, auth.organizationId, [next]);
      return dto;
    },
  );

  app.post(
    '/payables/:id/payments',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'pay')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = registerPaymentSchema.parse(request.body);
      const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? null;

      const result = await registerPayablePayment(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        sourceId: id,
        amountCents: body.amountCents,
        paidAt: body.paidAt,
        method: body.method,
        bankAccountId: toObjectId(body.bankAccountId, 'bankAccountId'),
        notes: body.notes ?? null,
        idempotencyKey,
      });
      reply.status(result.alreadyProcessed ? 200 : 201);
      const fresh = await ctx.mongo.collections.payables.findOne({ _id: id });
      const [dto] = await toPayableDTOs(ctx, auth.organizationId, [fresh!]);
      return { payment: { id: result.paymentId.toHexString() }, payable: dto };
    },
  );

  app.delete(
    '/payables/:id',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'delete')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const payable = await ctx.mongo.collections.payables.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!payable) throw notFound('Conta a pagar não encontrada.');

      await withTransaction(ctx, async (session) => {
        if (payable.paidAmountCents > 0) {
          // Nunca apaga o extrato: estorna e marca como cancelada.
          await reversePaymentsOf(
            ctx,
            {
              organizationId: auth.organizationId,
              sourceType: 'PAYABLE',
              sourceId: id,
              reason: `Exclusão da conta "${payable.description}"`,
              actorId: auth.userId,
            },
            session,
          );
          await ctx.mongo.collections.payables.updateOne(
            { _id: id },
            { $set: { status: 'CANCELED', updatedAt: new Date() } },
            { session },
          );
        } else {
          await ctx.mongo.collections.payables.deleteOne({ _id: id }, { session });
        }
        await audit(
          ctx,
          {
            organizationId: auth.organizationId,
            actorId: auth.userId,
            action: payable.paidAmountCents > 0 ? 'payable.reversed' : 'payable.deleted',
            entityType: 'payable',
            entityId: id,
            before: payable,
          },
          session,
        );
      });

      return { ok: true, reversed: payable.paidAmountCents > 0 };
    },
  );

  /* ------------------------ contas a receber ----------------------- */
  app.get(
    '/receivables',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const query = receivableListQuerySchema.parse(request.query);

      const filter: Record<string, unknown> = { organizationId };
      if (query.status) filter.status = query.status;
      if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
      if (query.q) {
        const term = query.q.trim();
        const fold = new RegExp(escapeRegex(foldAccents(term).toLowerCase()), 'i');
        const drivers = await ctx.mongo.collections.drivers
          .find({ organizationId, fullNameFold: fold })
          .project<{ _id: ObjectId }>({ _id: 1 })
          .toArray();
        const rentals = await ctx.mongo.collections.rentals
          .find({ organizationId, rentalNumber: new RegExp(escapeRegex(term), 'i') })
          .project<{ _id: ObjectId }>({ _id: 1 })
          .toArray();
        filter.$or = [
          { descriptionFold: fold },
          { driverId: { $in: drivers.map((d) => d._id) } },
          { rentalId: { $in: rentals.map((r) => r._id) } },
        ];
      }

      const sortMap: Record<string, Record<string, 1 | -1>> = {
        createdAt: { createdAt: -1, _id: -1 },
        dueDate: { dueDate: 1, _id: 1 },
        amount: { grossAmountCents: -1, _id: -1 },
        client: { descriptionFold: 1, _id: 1 },
      };
      const sort = sortMap[query.sort] ?? sortMap.createdAt!;

      const cursor = decodeCursor<{ skip: number }>(query.cursor);
      const skip = cursor?.skip ?? 0;
      const docs = await ctx.mongo.collections.receivables
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(query.limit + 1)
        .toArray();
      const hasMore = docs.length > query.limit;
      const page = hasMore ? docs.slice(0, query.limit) : docs;
      const total = await ctx.mongo.collections.receivables.countDocuments(filter);

      const pendingAgg = await ctx.mongo.collections.receivables
        .aggregate<{ pending: number }>([
          { $match: { organizationId, status: { $nin: ['PAID', 'CANCELED'] } } },
          {
            $group: {
              _id: null,
              pending: { $sum: { $subtract: ['$grossAmountCents', '$paidAmountCents'] } },
            },
          },
        ])
        .toArray();

      return {
        data: await toReceivableDTOs(ctx, organizationId, page),
        totalPendingCents: pendingAgg[0]?.pending ?? 0,
        page: { nextCursor: hasMore ? encodeCursor({ skip: skip + query.limit }) : null, total },
      };
    },
  );

  app.get(
    '/receivables/:id',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const doc = await ctx.mongo.collections.receivables.findOne({ _id: id, organizationId });
      if (!doc) throw notFound('Conta a receber não encontrada.');
      const payments = await ctx.mongo.collections.payments
        .find({ organizationId, sourceType: 'RECEIVABLE', sourceId: id })
        .sort({ paidAt: 1 })
        .toArray();
      const [dto] = await toReceivableDTOs(ctx, organizationId, [doc]);
      return {
        ...dto,
        payments: payments.map((p) => ({
          id: p._id.toHexString(),
          amountCents: p.amountCents,
          paidAt: p.paidAt,
          method: p.method,
          bankAccountId: p.bankAccountId?.toHexString() ?? null,
          createdAt: p.createdAt.toISOString(),
        })),
      };
    },
  );

  app.post(
    '/receivables/:id/payments',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'pay')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = registerPaymentSchema.parse(request.body);
      const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? null;

      const result = await registerReceivablePayment(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        sourceId: id,
        amountCents: body.amountCents,
        paidAt: body.paidAt,
        method: body.method,
        bankAccountId: toObjectId(body.bankAccountId, 'bankAccountId'),
        notes: body.notes ?? null,
        idempotencyKey,
      });
      reply.status(result.alreadyProcessed ? 200 : 201);
      const fresh = await ctx.mongo.collections.receivables.findOne({ _id: id });
      const [dto] = await toReceivableDTOs(ctx, auth.organizationId, [fresh!]);
      return { payment: { id: result.paymentId.toHexString() }, receivable: dto };
    },
  );

  /** Recalcula status vencidos sob demanda (usado pela UI ao abrir). */
  app.post(
    '/finance/refresh-statuses',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const today = businessDate();
      const receivables = await ctx.mongo.collections.receivables
        .find({ organizationId, status: { $nin: ['PAID', 'CANCELED'] } })
        .toArray();
      let changed = 0;
      for (const doc of receivables) {
        const status = deriveReceivableStatus(doc, today);
        if (status !== doc.status) {
          await ctx.mongo.collections.receivables.updateOne({ _id: doc._id }, { $set: { status } });
          changed += 1;
        }
      }
      const payables = await ctx.mongo.collections.payables
        .find({ organizationId, status: { $nin: ['PAID', 'CANCELED'] } })
        .toArray();
      for (const doc of payables) {
        const status = derivePayableStatus(doc, today);
        if (status !== doc.status) {
          await ctx.mongo.collections.payables.updateOne({ _id: doc._id }, { $set: { status } });
          changed += 1;
        }
      }
      return { ok: true, changed };
    },
  );
}
