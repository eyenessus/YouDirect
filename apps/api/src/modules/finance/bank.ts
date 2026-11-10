import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  bankAccountCreateSchema,
  bankAccountUpdateSchema,
  businessDate,
  formatCentsPlain,
  formatIsoDateBR,
  manualTransactionSchema,
  statementQuerySchema,
  transactionOriginLabels,
  type BankAccount,
  type Statement,
} from '@yudirect/contracts';
import { conflict, notFound } from '../../common/errors.js';
import { csvCell, toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { withTransaction } from '../../database/mongo.js';
import { audit } from '../../services/common.js';
import { accountBalance, postTransaction, sumAccountMovement } from '../../services/ledger.js';
import type { AppContext } from '../../context.js';
import type { BankAccountDoc } from '../../database/types.js';

async function toAccountDTO(
  ctx: AppContext,
  organizationId: ObjectId,
  doc: BankAccountDoc,
): Promise<BankAccount> {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    institution: doc.institution,
    type: doc.type,
    initialBalanceCents: doc.initialBalanceCents,
    initialBalanceDate: doc.initialBalanceDate,
    currentBalanceCents: await accountBalance(ctx, organizationId, doc),
    isDefault: doc.isDefault,
    active: doc.active,
    createdAt: doc.createdAt.toISOString(),
  };
}

export async function registerBankRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/bank-accounts',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const docs = await ctx.mongo.collections.bankAccounts
        .find({ organizationId })
        .sort({ isDefault: -1, name: 1 })
        .toArray();
      return { data: await Promise.all(docs.map((d) => toAccountDTO(ctx, organizationId, d))) };
    },
  );

  app.post(
    '/bank-accounts',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'create')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = bankAccountCreateSchema.parse(request.body);

      const doc = await withTransaction(ctx, async (session) => {
        const count = await ctx.mongo.collections.bankAccounts.countDocuments(
          { organizationId: auth.organizationId },
          { session },
        );
        const isDefault = body.isDefault || count === 0;
        if (isDefault) {
          await ctx.mongo.collections.bankAccounts.updateMany(
            { organizationId: auth.organizationId, isDefault: true },
            { $set: { isDefault: false, updatedAt: new Date() } },
            { session },
          );
        }
        const now = new Date();
        const created: BankAccountDoc = {
          _id: new ObjectId(),
          organizationId: auth.organizationId,
          name: body.name,
          institution: body.institution ?? null,
          type: body.type,
          initialBalanceCents: body.initialBalanceCents,
          initialBalanceDate: body.initialBalanceDate,
          isDefault,
          active: true,
          archivedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await ctx.mongo.collections.bankAccounts.insertOne(created, { session });
        await audit(
          ctx,
          {
            organizationId: auth.organizationId,
            actorId: auth.userId,
            action: 'bankAccount.created',
            entityType: 'bankAccount',
            entityId: created._id,
            after: created,
          },
          session,
        );
        return created;
      });

      reply.status(201);
      return toAccountDTO(ctx, auth.organizationId, doc);
    },
  );

  app.patch(
    '/bank-accounts/:id',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = bankAccountUpdateSchema.parse(request.body);

      const current = await ctx.mongo.collections.bankAccounts.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!current) throw notFound('Conta bancária não encontrada.');

      const updated = await withTransaction(ctx, async (session) => {
        const now = new Date();
        if (body.isDefault === true) {
          await ctx.mongo.collections.bankAccounts.updateMany(
            { organizationId: auth.organizationId, isDefault: true, _id: { $ne: id } },
            { $set: { isDefault: false, updatedAt: now } },
            { session },
          );
        }
        if (body.active === false && current.isDefault) {
          throw conflict('Defina outra conta como padrão antes de desativar esta.');
        }
        const set: Record<string, unknown> = { updatedAt: now };
        if (body.name !== undefined) set.name = body.name;
        if (body.institution !== undefined) set.institution = body.institution ?? null;
        if (body.type !== undefined) set.type = body.type;
        if (body.initialBalanceCents !== undefined) set.initialBalanceCents = body.initialBalanceCents;
        if (body.initialBalanceDate !== undefined) set.initialBalanceDate = body.initialBalanceDate;
        if (body.isDefault !== undefined) set.isDefault = body.isDefault;
        if (body.active !== undefined) set.active = body.active;

        const next = await ctx.mongo.collections.bankAccounts.findOneAndUpdate(
          { _id: id, organizationId: auth.organizationId },
          { $set: set },
          { returnDocument: 'after', session },
        );
        if (!next) throw notFound('Conta bancária não encontrada.');
        await audit(
          ctx,
          {
            organizationId: auth.organizationId,
            actorId: auth.userId,
            action: 'bankAccount.updated',
            entityType: 'bankAccount',
            entityId: id,
            before: current,
            after: next,
          },
          session,
        );
        return next;
      });

      return toAccountDTO(ctx, auth.organizationId, updated);
    },
  );

  app.delete(
    '/bank-accounts/:id',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'delete')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const account = await ctx.mongo.collections.bankAccounts.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!account) throw notFound('Conta bancária não encontrada.');

      const movements = await ctx.mongo.collections.bankTransactions.countDocuments({
        organizationId: auth.organizationId,
        bankAccountId: id,
      });
      if (movements > 0) {
        // Preserva o extrato: arquiva em vez de excluir.
        await ctx.mongo.collections.bankAccounts.updateOne(
          { _id: id, organizationId: auth.organizationId },
          { $set: { active: false, isDefault: false, archivedAt: new Date(), updatedAt: new Date() } },
        );
        await audit(ctx, {
          organizationId: auth.organizationId,
          actorId: auth.userId,
          action: 'bankAccount.archived',
          entityType: 'bankAccount',
          entityId: id,
        });
        return { ok: true, archived: true, reason: 'A conta possui movimentações e foi arquivada.' };
      }

      await ctx.mongo.collections.bankAccounts.deleteOne({ _id: id, organizationId: auth.organizationId });
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'bankAccount.deleted',
        entityType: 'bankAccount',
        entityId: id,
        before: account,
      });
      return { ok: true, archived: false };
    },
  );

  /* ------------------------ lançamento manual ---------------------- */
  app.post(
    '/bank-accounts/:id/manual-transactions',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'create')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = manualTransactionSchema.parse(request.body);
      const idempotencyKey = (request.headers['idempotency-key'] as string | undefined) ?? null;

      const transactionId = await postTransaction(ctx, {
        organizationId: auth.organizationId,
        bankAccountId: id,
        occurredAt: body.occurredAt,
        description: body.description,
        direction: body.direction,
        amountCents: body.amountCents,
        originType: 'MANUAL',
        originId: null,
        dedupeKey: idempotencyKey ? `manual:${idempotencyKey}` : null,
        actorId: auth.userId,
      });

      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'bankTransaction.manual',
        entityType: 'bankTransaction',
        entityId: transactionId,
        after: { amountCents: body.amountCents, direction: body.direction },
      });

      reply.status(201);
      return { id: transactionId.toHexString() };
    },
  );

  /* ------------------------------ extrato -------------------------- */
  const buildStatement = async (
    ctx: AppContext,
    organizationId: ObjectId,
    accountId: ObjectId,
    from: string,
    to: string,
  ): Promise<Statement> => {
    const account = await ctx.mongo.collections.bankAccounts.findOne({
      _id: accountId,
      organizationId,
    });
    if (!account) throw notFound('Conta bancária não encontrada.');

    const before = await sumAccountMovement(
      ctx,
      organizationId,
      accountId,
      account.initialBalanceDate,
      // dia anterior ao início do período
      from,
    );
    // `sumAccountMovement` inclui `from`; removemos o próprio dia inicial.
    const onFromDay = await sumAccountMovement(ctx, organizationId, accountId, from, from);
    const openingBalanceCents =
      account.initialBalanceCents +
      (before.inflowCents - onFromDay.inflowCents) -
      (before.outflowCents - onFromDay.outflowCents);

    const transactions = await ctx.mongo.collections.bankTransactions
      .find({ organizationId, bankAccountId: accountId, occurredAt: { $gte: from, $lte: to } })
      .sort({ occurredAt: 1, _id: 1 })
      .toArray();

    let running = openingBalanceCents;
    let inflowCents = 0;
    let outflowCents = 0;
    const rows = transactions.map((t) => {
      if (t.direction === 'IN') {
        running += t.amountCents;
        inflowCents += t.amountCents;
      } else {
        running -= t.amountCents;
        outflowCents += t.amountCents;
      }
      return {
        id: t._id.toHexString(),
        occurredAt: t.occurredAt,
        description: t.description,
        origin: t.originType,
        direction: t.direction,
        amountCents: t.amountCents,
        runningBalanceCents: running,
        reversed: Boolean(t.reversedByTransactionId),
      };
    });

    return {
      account: { id: account._id.toHexString(), name: account.name },
      from,
      to,
      openingBalanceCents,
      inflowCents,
      outflowCents,
      closingBalanceCents: openingBalanceCents + inflowCents - outflowCents,
      transactions: rows,
    };
  };

  app.get(
    '/bank-accounts/:id/statement',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const today = businessDate();
      const raw = request.query as Record<string, string>;
      const query = statementQuerySchema.parse({
        from: raw.from ?? `${today.slice(0, 7)}-01`,
        to: raw.to ?? today,
      });
      if (query.from > query.to) throw conflict('A data inicial não pode ser maior que a final.');
      return buildStatement(ctx, organizationId, id, query.from, query.to);
    },
  );

  app.get(
    '/bank-accounts/:id/statement.csv',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'export')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const today = businessDate();
      const raw = request.query as Record<string, string>;
      const query = statementQuerySchema.parse({
        from: raw.from ?? `${today.slice(0, 7)}-01`,
        to: raw.to ?? today,
      });
      const statement = await buildStatement(ctx, organizationId, id, query.from, query.to);

      const esc = csvCell;
      const lines = [
        ['Data', 'Descrição', 'Origem', 'Entrada', 'Saída', 'Saldo'].map(esc).join(';'),
        ...statement.transactions.map((t) =>
          [
            formatIsoDateBR(t.occurredAt),
            t.description,
            transactionOriginLabels[t.origin],
            t.direction === 'IN' ? formatCentsPlain(t.amountCents) : '',
            t.direction === 'OUT' ? formatCentsPlain(t.amountCents) : '',
            formatCentsPlain(t.runningBalanceCents),
          ]
            .map((v) => esc(String(v)))
            .join(';'),
        ),
      ];
      const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="extrato-${statement.account.name
            .toLowerCase()
            .replace(/\s+/g, '-')}-${query.from}-${query.to}.csv"`,
        );
      return reply.send(csv);
    },
  );
}
