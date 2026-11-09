import { ObjectId, type ClientSession } from 'mongodb';
import type { TransactionDirection, TransactionOrigin } from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../common/errors.js';
import type { IsoDate } from '../database/types.js';

/* ------------------------------------------------------------------ *
 * Razão bancário.
 *
 * Invariantes:
 *  - cada fato financeiro gera EXATAMENTE uma transação (dedupeKey);
 *  - saldo = saldoInicial + Σ entradas − Σ saídas, considerando apenas
 *    lançamentos a partir de `initialBalanceDate` e não estornados;
 *  - exclusão de fato financeiro gera ESTORNO, nunca remoção silenciosa.
 * ------------------------------------------------------------------ */

export interface PostTransactionInput {
  organizationId: ObjectId;
  bankAccountId: ObjectId;
  occurredAt: IsoDate;
  description: string;
  direction: TransactionDirection;
  amountCents: number;
  originType: TransactionOrigin;
  originId: ObjectId | null;
  dedupeKey: string | null;
  actorId: ObjectId | null;
}

export async function postTransaction(
  ctx: AppContext,
  input: PostTransactionInput,
  session?: ClientSession,
): Promise<ObjectId> {
  if (input.amountCents <= 0) throw conflict('Valor de lançamento deve ser maior que zero.');

  if (input.dedupeKey) {
    const existing = await ctx.mongo.collections.bankTransactions.findOne(
      { organizationId: input.organizationId, dedupeKey: input.dedupeKey },
      { session },
    );
    if (existing) return existing._id;
  }

  const account = await ctx.mongo.collections.bankAccounts.findOne(
    { _id: input.bankAccountId, organizationId: input.organizationId },
    { session },
  );
  if (!account) throw notFound('Conta bancária não encontrada.');
  if (!account.active) throw conflict('Conta bancária inativa — selecione outra conta.');

  const now = new Date();
  const _id = new ObjectId();
  await ctx.mongo.collections.bankTransactions.insertOne(
    {
      _id,
      organizationId: input.organizationId,
      bankAccountId: input.bankAccountId,
      occurredAt: input.occurredAt,
      description: input.description,
      direction: input.direction,
      amountCents: input.amountCents,
      originType: input.originType,
      originId: input.originId,
      dedupeKey: input.dedupeKey,
      reversedByTransactionId: null,
      reversalOfTransactionId: null,
      createdBy: input.actorId,
      createdAt: now,
      updatedAt: now,
    },
    { session },
  );
  return _id;
}

/** Estorna um lançamento criando o movimento espelho (auditável). */
export async function reverseTransaction(
  ctx: AppContext,
  params: {
    organizationId: ObjectId;
    transactionId: ObjectId;
    occurredAt: IsoDate;
    reason: string;
    actorId: ObjectId | null;
  },
  session?: ClientSession,
): Promise<ObjectId | null> {
  const original = await ctx.mongo.collections.bankTransactions.findOne(
    { _id: params.transactionId, organizationId: params.organizationId },
    { session },
  );
  if (!original) return null;
  if (original.reversedByTransactionId) return original.reversedByTransactionId;

  const now = new Date();
  const _id = new ObjectId();
  await ctx.mongo.collections.bankTransactions.insertOne(
    {
      _id,
      organizationId: original.organizationId,
      bankAccountId: original.bankAccountId,
      occurredAt: params.occurredAt,
      description: `Estorno — ${params.reason}`,
      direction: original.direction === 'IN' ? 'OUT' : 'IN',
      amountCents: original.amountCents,
      originType: original.originType,
      originId: original.originId,
      dedupeKey: original.dedupeKey ? `reversal:${original.dedupeKey}` : null,
      reversedByTransactionId: null,
      reversalOfTransactionId: original._id,
      createdBy: params.actorId,
      createdAt: now,
      updatedAt: now,
    },
    { session },
  );
  await ctx.mongo.collections.bankTransactions.updateOne(
    { _id: original._id },
    { $set: { reversedByTransactionId: _id, updatedAt: now } },
    { session },
  );
  return _id;
}

/** Soma líquida (entradas − saídas) de uma conta num intervalo. */
export async function sumAccountMovement(
  ctx: AppContext,
  organizationId: ObjectId,
  bankAccountId: ObjectId,
  from: IsoDate | null,
  to: IsoDate | null,
  session?: ClientSession,
): Promise<{ inflowCents: number; outflowCents: number }> {
  const match: Record<string, unknown> = { organizationId, bankAccountId };
  if (from || to) {
    const range: Record<string, string> = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    match.occurredAt = range;
  }
  const rows = await ctx.mongo.collections.bankTransactions
    .aggregate<{ _id: TransactionDirection; total: number }>(
      [{ $match: match }, { $group: { _id: '$direction', total: { $sum: '$amountCents' } } }],
      { session },
    )
    .toArray();
  const inflowCents = rows.find((r) => r._id === 'IN')?.total ?? 0;
  const outflowCents = rows.find((r) => r._id === 'OUT')?.total ?? 0;
  return { inflowCents, outflowCents };
}

/** Saldo atual: inicial + movimentos a partir da data do saldo inicial. */
export async function accountBalance(
  ctx: AppContext,
  organizationId: ObjectId,
  account: { _id: ObjectId; initialBalanceCents: number; initialBalanceDate: IsoDate },
  upTo?: IsoDate,
  session?: ClientSession,
): Promise<number> {
  const { inflowCents, outflowCents } = await sumAccountMovement(
    ctx,
    organizationId,
    account._id,
    account.initialBalanceDate,
    upTo ?? null,
    session,
  );
  return account.initialBalanceCents + inflowCents - outflowCents;
}

export async function organizationCashTotal(
  ctx: AppContext,
  organizationId: ObjectId,
): Promise<{ accounts: Array<{ id: ObjectId; name: string; balanceCents: number }>; totalCents: number }> {
  const accounts = await ctx.mongo.collections.bankAccounts
    .find({ organizationId, active: true })
    .sort({ isDefault: -1, name: 1 })
    .toArray();
  const result: Array<{ id: ObjectId; name: string; balanceCents: number }> = [];
  let totalCents = 0;
  for (const account of accounts) {
    const balanceCents = await accountBalance(ctx, organizationId, account);
    result.push({ id: account._id, name: account.name, balanceCents });
    totalCents += balanceCents;
  }
  return { accounts: result, totalCents };
}

/** Conta padrão da organização (fallback: primeira conta ativa). */
export async function defaultBankAccountId(
  ctx: AppContext,
  organizationId: ObjectId,
  session?: ClientSession,
): Promise<ObjectId | null> {
  const def = await ctx.mongo.collections.bankAccounts.findOne(
    { organizationId, isDefault: true, active: true },
    { session },
  );
  if (def) return def._id;
  const any = await ctx.mongo.collections.bankAccounts.findOne(
    { organizationId, active: true },
    { sort: { createdAt: 1 }, session },
  );
  return any?._id ?? null;
}
