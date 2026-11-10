import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  businessDate,
  rentalCloseSchema,
  rentalCreateSchema,
  rentalListQuerySchema,
  rentalUpdateSchema,
  type Rental,
  type RentalPaymentSchedule,
} from '@yudirect/contracts';
import { conflict, notFound } from '../../common/errors.js';
import { cursorDate,
  decodeCursor, encodeCursor, escapeRegex, foldAccents, toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { withTransaction } from '../../database/mongo.js';
import { audit, nextNumber } from '../../services/common.js';
import { describeFiles, requireFile } from '../../services/files.js';
import {
  buildPaymentSchedule,
  deriveReceivableStatus,
  ensureRentalReceivable,
  extendOpenEndedReceivable,
  syncContractReceivable,
} from '../../services/finance.js';
import { postTransaction, defaultBankAccountId } from '../../services/ledger.js';
import type { AppContext, AuthContext } from '../../context.js';
import { cpfForViewer } from '../../common/pii-visibility.js';
import type { RentalDoc } from '../../database/types.js';
import type { ClientSession } from 'mongodb';

/** Locação ativa do mesmo veículo cujo período cruza com [startDate, endDate]. */
async function findOverlappingRental(
  ctx: AppContext,
  p: {
    organizationId: ObjectId;
    vehicleId: ObjectId;
    startDate: string;
    endDate: string | null;
    excludeId?: ObjectId;
    session?: ClientSession;
  },
): Promise<RentalDoc | null> {
  return ctx.mongo.collections.rentals.findOne(
    {
      organizationId: p.organizationId,
      vehicleId: p.vehicleId,
      status: 'ACTIVE',
      ...(p.excludeId ? { _id: { $ne: p.excludeId } } : {}),
      $or: [{ endDate: null }, { endDate: { $gte: p.startDate } }],
      ...(p.endDate ? { startDate: { $lte: p.endDate } } : {}),
    },
    { session: p.session },
  );
}

async function toRentalDTOs(
  ctx: AppContext,
  organizationId: ObjectId,
  viewer: AuthContext | null,
  docs: RentalDoc[],
): Promise<Rental[]> {
  const vehicleIds = [...new Set(docs.map((d) => d.vehicleId.toHexString()))].map((s) => new ObjectId(s));
  const driverIds = [...new Set(docs.map((d) => d.driverId.toHexString()))].map((s) => new ObjectId(s));
  const [vehicles, drivers, files] = await Promise.all([
    ctx.mongo.collections.vehicles.find({ organizationId, _id: { $in: vehicleIds } }).toArray(),
    ctx.mongo.collections.drivers.find({ organizationId, _id: { $in: driverIds } }).toArray(),
    describeFiles(
      ctx,
      organizationId,
      docs.map((d) => d.contractFileId).filter((v): v is ObjectId => Boolean(v)),
    ),
  ]);
  const vMap = new Map(vehicles.map((v) => [v._id.toHexString(), v]));
  const dMap = new Map(drivers.map((d) => [d._id.toHexString(), d]));

  return docs.map((doc) => {
    const v = vMap.get(doc.vehicleId.toHexString());
    const d = dMap.get(doc.driverId.toHexString());
    const contract = doc.contractFileId ? files.get(doc.contractFileId.toHexString()) : undefined;
    return {
      id: doc._id.toHexString(),
      rentalNumber: doc.rentalNumber,
      vehicle: {
        id: doc.vehicleId.toHexString(),
        plate: v?.plate ?? '—',
        brand: v?.brand ?? '—',
        model: v?.model ?? '—',
        year: v?.year ?? null,
      },
      driver: {
        id: doc.driverId.toHexString(),
        fullName: d?.fullName ?? '—',
        cpf: d ? cpfForViewer(viewer, ctx.pii.decrypt(d.cpfEncrypted)) : null,
        phone: d?.phone ?? '',
      },
      startDate: doc.startDate,
      endDate: doc.endDate,
      rentalType: doc.rentalType,
      inspectionPeriod: doc.inspectionRule?.period ?? null,
      inspectionWeekday: doc.inspectionRule?.weekday ?? 'ANY',
      periodicAmountCents: doc.periodicAmountCents,
      depositCents: doc.depositCents,
      firstPeriodPrepaid: doc.firstPeriodPrepaid,
      depositPrepaid: doc.depositPrepaid,
      allowedKm: doc.allowedKm,
      monthlyFranchiseKm: doc.monthlyFranchiseKm,
      contractFile: contract
        ? {
            fileId: contract.id.toHexString(),
            url: contract.url,
            originalName: contract.originalName,
          }
        : null,
      notes: doc.notes,
      status: doc.status,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  });
}

export async function registerRentalRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/rentals',
    { onRequest: [app.requireAuth, app.requirePermission('rentals', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const query = rentalListQuerySchema.parse(request.query);

      const filter: Record<string, unknown> = { organizationId };
      if (query.status) filter.status = query.status;
      if (query.vehicleId) filter.vehicleId = toObjectId(query.vehicleId, 'vehicleId');
      if (query.driverId) filter.driverId = toObjectId(query.driverId, 'driverId');

      if (query.q) {
        const term = query.q.trim();
        const rx = new RegExp(escapeRegex(term), 'i');
        const nameRx = new RegExp(escapeRegex(foldAccents(term).toLowerCase()), 'i');
        const [vehicles, drivers] = await Promise.all([
          ctx.mongo.collections.vehicles
            .find({ organizationId, plate: rx })
            .project<{ _id: ObjectId }>({ _id: 1 })
            .toArray(),
          ctx.mongo.collections.drivers
            .find({ organizationId, fullNameFold: nameRx })
            .project<{ _id: ObjectId }>({ _id: 1 })
            .toArray(),
        ]);
        filter.$or = [
          { rentalNumber: rx },
          { vehicleId: { $in: vehicles.map((v) => v._id) } },
          { driverId: { $in: drivers.map((d) => d._id) } },
        ];
      }

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

      const docs = await ctx.mongo.collections.rentals
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(query.limit + 1)
        .toArray();
      const hasMore = docs.length > query.limit;
      const page = hasMore ? docs.slice(0, query.limit) : docs;
      const total = await ctx.mongo.collections.rentals.countDocuments({ organizationId });

      return {
        data: await toRentalDTOs(ctx, organizationId, request.auth, page),
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

  app.get(
    '/rentals/:id',
    { onRequest: [app.requireAuth, app.requirePermission('rentals', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const doc = await ctx.mongo.collections.rentals.findOne({ _id: id, organizationId });
      if (!doc) throw notFound('Locação não encontrada.');
      const [dto] = await toRentalDTOs(ctx, organizationId, request.auth, [doc]);
      return dto;
    },
  );

  /** Semanas do contrato (vencimento, pago, pendente, atraso) para dar baixa por semana. */
  app.get(
    '/rentals/:id/payment-schedule',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request): Promise<RentalPaymentSchedule> => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const rental = await ctx.mongo.collections.rentals.findOne({ _id: id, organizationId });
      if (!rental) throw notFound('Locação não encontrada.');

      const today = businessDate();
      await extendOpenEndedReceivable(ctx, rental, today);
      const receivable = await ctx.mongo.collections.receivables.findOne({
        organizationId,
        rentalId: rental._id,
        expectedPeriod: 'CONTRACT',
      });

      // Locação legada sem conta a receber: nada é criado aqui, só devolvemos vazio.
      if (!receivable || receivable.status === 'CANCELED') {
        return {
          rentalId: rental._id.toHexString(),
          rentalNumber: rental.rentalNumber,
          receivableId: null,
          rentalType: rental.rentalType,
          weeks: [],
          totals: { amountCents: 0, paidCents: 0, remainingCents: 0 },
        };
      }
      const { weeks, totals } = buildPaymentSchedule(rental, receivable, today);
      return {
        rentalId: rental._id.toHexString(),
        rentalNumber: rental.rentalNumber,
        receivableId: receivable._id.toHexString(),
        rentalType: rental.rentalType,
        weeks,
        totals,
      };
    },
  );

  app.post(
    '/rentals',
    { onRequest: [app.requireAuth, app.requirePermission('rentals', 'create')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = rentalCreateSchema.parse(request.body);
      const vehicleId = toObjectId(body.vehicleId, 'vehicleId');
      const driverId = toObjectId(body.driverId, 'driverId');

      const [vehicle, driver] = await Promise.all([
        ctx.mongo.collections.vehicles.findOne({
          _id: vehicleId,
          organizationId: auth.organizationId,
          archivedAt: null,
        }),
        ctx.mongo.collections.drivers.findOne({
          _id: driverId,
          organizationId: auth.organizationId,
          archivedAt: null,
        }),
      ]);
      if (!vehicle) throw notFound('Veículo não encontrado.');
      if (!driver) throw notFound('Motorista não encontrado.');

      // Impede sobreposição de locação ativa para o mesmo veículo (checagem
      // rápida aqui; a definitiva é refeita dentro da transação).
      const overlapping = await findOverlappingRental(ctx, {
        organizationId: auth.organizationId,
        vehicleId,
        startDate: body.startDate,
        endDate: body.endDate ?? null,
      });
      if (overlapping) {
        throw conflict(
          `O veículo ${vehicle.plate} já possui a locação ativa ${overlapping.rentalNumber} no período informado.`,
        );
      }

      const contractFile = body.contractFileId
        ? await requireFile(ctx, auth.organizationId, toObjectId(body.contractFileId), 'RENTAL_CONTRACT')
        : null;

      const today = businessDate();
      const result = await withTransaction(ctx, async (session) => {
        // Serializa por veículo: a escrita no documento do veículo faz duas
        // criações simultâneas conflitarem (uma é refeita pelo retry da
        // transação e então enxerga a outra na checagem abaixo).
        await ctx.mongo.collections.vehicles.updateOne(
          { _id: vehicleId, organizationId: auth.organizationId },
          { $set: { updatedAt: new Date() } },
          { session },
        );
        const overlappingInTx = await findOverlappingRental(ctx, {
          organizationId: auth.organizationId,
          vehicleId,
          startDate: body.startDate,
          endDate: body.endDate ?? null,
          session,
        });
        if (overlappingInTx) {
          throw conflict(
            `O veículo ${vehicle.plate} já possui a locação ativa ${overlappingInTx.rentalNumber} no período informado.`,
          );
        }
        const year = Number(body.startDate.slice(0, 4));
        const { number, sequence } = await nextNumber(
          ctx,
          auth.organizationId,
          'rental',
          'LOC',
          year,
          session,
        );
        const now = new Date();
        const doc: RentalDoc = {
          _id: new ObjectId(),
          organizationId: auth.organizationId,
          rentalNumber: number,
          sequence,
          vehicleId,
          driverId,
          startDate: body.startDate,
          endDate: body.endDate ?? null,
          rentalType: body.rentalType,
          inspectionRule: { period: body.inspectionPeriod ?? null, weekday: body.inspectionWeekday },
          periodicAmountCents: body.periodicAmountCents,
          depositCents: body.depositCents,
          firstPeriodPrepaid: body.firstPeriodPrepaid,
          depositPrepaid: body.depositPrepaid,
          allowedKm: body.allowedKm ?? null,
          monthlyFranchiseKm: body.monthlyFranchiseKm ?? null,
          contractFileId: contractFile?._id ?? null,
          notes: body.notes ?? null,
          status: 'ACTIVE',
          closedAt: null,
          history: [{ at: now, actorId: auth.userId, action: 'created' }],
          createdBy: auth.userId,
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        await ctx.mongo.collections.rentals.insertOne(doc, { session });

        await ctx.mongo.collections.vehicles.updateOne(
          { _id: vehicleId, organizationId: auth.organizationId },
          { $set: { status: 'RENTED', updatedAt: now } },
          { session },
        );

        const receivableId = await ensureRentalReceivable(ctx, doc, { today }, session);

        // Valores já recebidos: entram como adiantamento/caução no caixa,
        // nunca como "aluguel reconhecido" automático sem lançamento.
        const accountId = await defaultBankAccountId(ctx, auth.organizationId, session);
        if (accountId && body.firstPeriodPrepaid && body.periodicAmountCents > 0) {
          const txId = await postTransaction(
            ctx,
            {
              organizationId: auth.organizationId,
              bankAccountId: accountId,
              occurredAt: body.startDate,
              description: `Adiantamento do contrato ${number}`,
              direction: 'IN',
              amountCents: body.periodicAmountCents,
              originType: 'RENTAL_PREPAYMENT',
              originId: doc._id,
              dedupeKey: `rental-prepay:${doc._id.toHexString()}`,
              actorId: auth.userId,
            },
            session,
          );
          await ctx.mongo.collections.payments.insertOne(
            {
              _id: new ObjectId(),
              organizationId: auth.organizationId,
              sourceType: 'RECEIVABLE',
              sourceId: receivableId,
              amountCents: body.periodicAmountCents,
              paidAt: body.startDate,
              method: 'CASH',
              bankAccountId: accountId,
              transactionId: txId,
              idempotencyKey: `rental-prepay:${doc._id.toHexString()}`,
              notes: 'Primeiro período informado como já pago no cadastro da locação.',
              createdBy: auth.userId,
              createdAt: now,
              updatedAt: now,
            },
            { session },
          );
          const prepaidReceivable = await ctx.mongo.collections.receivables.findOne(
            { _id: receivableId },
            { session },
          );
          const prepaidPaid = (prepaidReceivable?.paidAmountCents ?? 0) + body.periodicAmountCents;
          await ctx.mongo.collections.receivables.updateOne(
            { _id: receivableId },
            {
              $inc: { paidAmountCents: body.periodicAmountCents, version: 1 },
              $set: {
                updatedAt: now,
                ...(prepaidReceivable
                  ? {
                      status: deriveReceivableStatus(
                        { ...prepaidReceivable, paidAmountCents: prepaidPaid },
                        today,
                      ),
                    }
                  : {}),
              },
            },
            { session },
          );
        }
        if (accountId && body.depositPrepaid && body.depositCents > 0) {
          await postTransaction(
            ctx,
            {
              organizationId: auth.organizationId,
              bankAccountId: accountId,
              occurredAt: body.startDate,
              description: `Caução do contrato ${number}`,
              direction: 'IN',
              amountCents: body.depositCents,
              originType: 'RENTAL_DEPOSIT',
              originId: doc._id,
              dedupeKey: `rental-deposit:${doc._id.toHexString()}`,
              actorId: auth.userId,
            },
            session,
          );
        }

        await audit(
          ctx,
          {
            organizationId: auth.organizationId,
            actorId: auth.userId,
            action: 'rental.created',
            entityType: 'rental',
            entityId: doc._id,
            after: { rentalNumber: number, vehicleId, driverId },
          },
          session,
        );

        return doc;
      });

      reply.status(201);
      const [dto] = await toRentalDTOs(ctx, auth.organizationId, request.auth, [result]);
      return dto;
    },
  );

  app.patch(
    '/rentals/:id',
    { onRequest: [app.requireAuth, app.requirePermission('rentals', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = rentalUpdateSchema.parse(request.body);

      const current = await ctx.mongo.collections.rentals.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!current) throw notFound('Locação não encontrada.');
      if (current.status !== 'ACTIVE') {
        throw conflict('Locação encerrada ou cancelada não pode ser editada.');
      }

      const startDate = body.startDate ?? current.startDate;
      const endDate = body.endDate === undefined ? current.endDate : body.endDate ?? null;
      if (endDate && endDate < startDate) {
        throw conflict('A data de término deve ser igual ou posterior à data de início.');
      }
      // "Já pago na assinatura" gera lançamento bancário na criação: mudar
      // depois deixaria banco e conta a receber divergentes.
      if (
        (body.firstPeriodPrepaid !== undefined && body.firstPeriodPrepaid !== current.firstPeriodPrepaid) ||
        (body.depositPrepaid !== undefined && body.depositPrepaid !== current.depositPrepaid)
      ) {
        throw conflict('Pagamento antecipado não pode ser alterado depois do cadastro. Registre o pagamento na conta a receber.');
      }
      const datesChanged = body.startDate !== undefined || body.endDate !== undefined;
      const moneyChanged =
        datesChanged || body.periodicAmountCents !== undefined || body.rentalType !== undefined;

      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (body.startDate !== undefined) set.startDate = body.startDate;
      if (body.endDate !== undefined) set.endDate = body.endDate ?? null;
      if (body.rentalType !== undefined) set.rentalType = body.rentalType;
      if (body.inspectionPeriod !== undefined) set['inspectionRule.period'] = body.inspectionPeriod ?? null;
      if (body.inspectionWeekday !== undefined) set['inspectionRule.weekday'] = body.inspectionWeekday;
      if (body.periodicAmountCents !== undefined) set.periodicAmountCents = body.periodicAmountCents;
      if (body.depositCents !== undefined) set.depositCents = body.depositCents;
      if (body.firstPeriodPrepaid !== undefined) set.firstPeriodPrepaid = body.firstPeriodPrepaid;
      if (body.depositPrepaid !== undefined) set.depositPrepaid = body.depositPrepaid;
      if (body.allowedKm !== undefined) set.allowedKm = body.allowedKm ?? null;
      if (body.monthlyFranchiseKm !== undefined) set.monthlyFranchiseKm = body.monthlyFranchiseKm ?? null;
      if (body.notes !== undefined) set.notes = body.notes ?? null;
      if (body.contractFileId !== undefined) {
        const file = await requireFile(
          ctx,
          auth.organizationId,
          toObjectId(body.contractFileId),
          'RENTAL_CONTRACT',
        );
        set.contractFileId = file._id;
      }

      const updated = await withTransaction(ctx, async (session) => {
        if (datesChanged) {
          await ctx.mongo.collections.vehicles.updateOne(
            { _id: current.vehicleId, organizationId: auth.organizationId },
            { $set: { updatedAt: new Date() } },
            { session },
          );
          const overlap = await findOverlappingRental(ctx, {
            organizationId: auth.organizationId,
            vehicleId: current.vehicleId,
            startDate,
            endDate,
            excludeId: id,
            session,
          });
          if (overlap) {
            throw conflict(`O período informado cruza com a locação ativa ${overlap.rentalNumber} do mesmo veículo.`);
          }
        }
        const doc = await ctx.mongo.collections.rentals.findOneAndUpdate(
          { _id: id, organizationId: auth.organizationId, version: current.version, status: 'ACTIVE' },
          {
            $set: set,
            $inc: { version: 1 },
            $push: {
              history: { at: new Date(), actorId: auth.userId, action: 'updated' },
            },
          },
          { returnDocument: 'after', session },
        );
        if (!doc) throw conflict('A locação foi alterada por outro usuário. Recarregue e tente novamente.');
        // Valor, datas ou tipo mudaram: a conta a receber acompanha (o pago não muda).
        if (moneyChanged) await syncContractReceivable(ctx, doc, { mode: 'edit', session });
        return doc;
      });
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'rental.updated',
        entityType: 'rental',
        entityId: id,
        before: current,
        after: updated,
      });
      const [dto] = await toRentalDTOs(ctx, auth.organizationId, request.auth, [updated]);
      return dto;
    },
  );

  app.post(
    '/rentals/:id/close',
    { onRequest: [app.requireAuth, app.requirePermission('rentals', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = rentalCloseSchema.parse(request.body);

      const rental = await ctx.mongo.collections.rentals.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!rental) throw notFound('Locação não encontrada.');
      if (rental.status !== 'ACTIVE') throw conflict('A locação não está ativa.');
      if (body.endDate < rental.startDate) {
        throw conflict('A data de encerramento não pode ser anterior ao início.');
      }

      await withTransaction(ctx, async (session) => {
        const now = new Date();
        // Condicionado a ACTIVE: dois encerramentos simultâneos → um vence.
        const closed = await ctx.mongo.collections.rentals.findOneAndUpdate(
          { _id: id, organizationId: auth.organizationId, status: 'ACTIVE' },
          {
            $set: { status: 'FINISHED', endDate: body.endDate, closedAt: now, updatedAt: now },
            $inc: { version: 1 },
            $push: {
              history: { at: now, actorId: auth.userId, action: 'closed', detail: body.notes ?? undefined },
            },
          },
          { returnDocument: 'after', session },
        );
        if (!closed) throw conflict('A locação não está mais ativa.');
        // Encerramento antecipado: o contrato passa a cobrar só até o fim real.
        await syncContractReceivable(ctx, closed, { mode: 'close', session, today: body.endDate });
        const stillRented = await ctx.mongo.collections.rentals.countDocuments(
          { organizationId: auth.organizationId, vehicleId: rental.vehicleId, status: 'ACTIVE' },
          { session },
        );
        if (stillRented === 0) {
          await ctx.mongo.collections.vehicles.updateOne(
            { _id: rental.vehicleId, organizationId: auth.organizationId },
            { $set: { status: 'AVAILABLE', updatedAt: now } },
            { session },
          );
        }
        await audit(
          ctx,
          {
            organizationId: auth.organizationId,
            actorId: auth.userId,
            action: 'rental.closed',
            entityType: 'rental',
            entityId: id,
            after: { endDate: body.endDate },
          },
          session,
        );
      });
      return { ok: true };
    },
  );

  app.delete(
    '/rentals/:id',
    { onRequest: [app.requireAuth, app.requirePermission('rentals', 'delete')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const rental = await ctx.mongo.collections.rentals.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!rental) throw notFound('Locação não encontrada.');

      const paid = await ctx.mongo.collections.payments.countDocuments({
        organizationId: auth.organizationId,
        sourceType: 'RECEIVABLE',
        sourceId: {
          $in: (
            await ctx.mongo.collections.receivables
              .find({ organizationId: auth.organizationId, rentalId: id })
              .project<{ _id: ObjectId }>({ _id: 1 })
              .toArray()
          ).map((r) => r._id),
        },
      });
      if (paid > 0) {
        throw conflict(
          'Esta locação possui recebimentos registrados. Encerre o contrato em vez de excluí-lo para preservar o histórico financeiro.',
        );
      }

      await withTransaction(ctx, async (session) => {
        const now = new Date();
        await ctx.mongo.collections.rentals.updateOne(
          { _id: id, organizationId: auth.organizationId },
          {
            $set: { status: 'CANCELED', closedAt: now, updatedAt: now },
            $push: { history: { at: now, actorId: auth.userId, action: 'canceled' } },
          },
          { session },
        );
        await ctx.mongo.collections.receivables.updateMany(
          { organizationId: auth.organizationId, rentalId: id, paidAmountCents: 0 },
          { $set: { status: 'CANCELED', updatedAt: now } },
          { session },
        );
        const stillRented = await ctx.mongo.collections.rentals.countDocuments(
          { organizationId: auth.organizationId, vehicleId: rental.vehicleId, status: 'ACTIVE' },
          { session },
        );
        if (stillRented === 0) {
          await ctx.mongo.collections.vehicles.updateOne(
            { _id: rental.vehicleId, organizationId: auth.organizationId },
            { $set: { status: 'AVAILABLE', updatedAt: now } },
            { session },
          );
        }
        await audit(
          ctx,
          {
            organizationId: auth.organizationId,
            actorId: auth.userId,
            action: 'rental.canceled',
            entityType: 'rental',
            entityId: id,
            before: rental,
          },
          session,
        );
      });
      return { ok: true, canceled: true };
    },
  );
}
