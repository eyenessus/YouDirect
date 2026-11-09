import { ObjectId, type ClientSession } from 'mongodb';
import {
  businessDate,
  rentalPeriodDays,
  type PaymentMethod,
  type ReceivableStatus,
  type PayableStatus,
  addDaysIso,
  diffDaysIso,
} from '@frotaone/contracts';
import type { AppContext } from '../context.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { withTransaction } from '../database/mongo.js';
import { postTransaction, reverseTransaction } from './ledger.js';
import { foldAccents, sha256 } from '../common/helpers.js';
import type { IsoDate, PayableDoc, ReceivableDoc, RentalDoc } from '../database/types.js';
import { audit } from './common.js';

/* ------------------------------------------------------------------ *
 * Regras de status (prompt §5):
 *   remaining = max(gross - paid, 0)
 *   PAID      quando remaining === 0
 *   OVERDUE   quando remaining > 0 e dueDate < data de negócio
 *   PARTIAL   quando 0 < paid < gross e ainda no prazo
 * O status é derivado e gravado na MESMA transação do pagamento.
 * ------------------------------------------------------------------ */

export function remainingCents(gross: number, paid: number): number {
  return Math.max(gross - paid, 0);
}

export function deriveReceivableStatus(
  doc: Pick<ReceivableDoc, 'grossAmountCents' | 'paidAmountCents' | 'dueDate' | 'status'>,
  today: IsoDate,
): ReceivableStatus {
  if (doc.status === 'CANCELED') return 'CANCELED';
  const remaining = remainingCents(doc.grossAmountCents, doc.paidAmountCents);
  if (remaining === 0) return 'PAID';
  if (doc.dueDate < today) return 'OVERDUE';
  return doc.paidAmountCents > 0 ? 'PARTIAL' : 'OPEN';
}

export function derivePayableStatus(
  doc: Pick<PayableDoc, 'amountCents' | 'paidAmountCents' | 'dueDate' | 'status'>,
  today: IsoDate,
): PayableStatus {
  if (doc.status === 'CANCELED') return 'CANCELED';
  const remaining = remainingCents(doc.amountCents, doc.paidAmountCents);
  if (remaining === 0) return 'PAID';
  if (doc.dueDate < today) return 'OVERDUE';
  return 'PENDING';
}

/** Recalcula status vencidos sem tocar em valores (rotina diária). */
export async function refreshOverdueStatuses(
  ctx: AppContext,
  organizationId: ObjectId,
  today = businessDate(),
): Promise<{ receivables: number; payables: number }> {
  const receivables = await ctx.mongo.collections.receivables.updateMany(
    {
      organizationId,
      status: { $in: ['OPEN', 'PARTIAL'] },
      dueDate: { $lt: today },
      $expr: { $gt: ['$grossAmountCents', '$paidAmountCents'] },
    },
    { $set: { status: 'OVERDUE', updatedAt: new Date() } },
  );
  const payables = await ctx.mongo.collections.payables.updateMany(
    {
      organizationId,
      status: 'PENDING',
      dueDate: { $lt: today },
      $expr: { $gt: ['$amountCents', '$paidAmountCents'] },
    },
    { $set: { status: 'OVERDUE', updatedAt: new Date() } },
  );
  return { receivables: receivables.modifiedCount, payables: payables.modifiedCount };
}

/* ------------------------- Contas a receber ------------------------ */

export function rentalPeriodCount(rental: Pick<RentalDoc, 'startDate' | 'endDate' | 'rentalType'>): number {
  if (!rental.endDate) return 1;
  const days = diffDaysIso(rental.endDate, rental.startDate);
  if (days <= 0) return 1;
  return Math.max(1, Math.ceil(days / rentalPeriodDays[rental.rentalType]));
}

export interface EnsureRentalReceivableOptions {
  grossAmountCents?: number;
  paidAmountCents?: number;
  dueDate?: IsoDate;
  today?: IsoDate;
}

/**
 * Cria (idempotentemente) a conta a receber do contrato.
 *
 * [R] Decisão documentada em ASSUMPTIONS (A-FIN-02): a referência exibe
 * UMA linha por contrato com "Valor Total" e "Valor Pendente", e não uma
 * linha por parcela. Modelamos então um recebível por contrato, cujo
 * valor esperado é `valor do período × número de períodos` e cujo
 * vencimento é o fim do primeiro período. Pagamentos parciais reduzem o
 * pendente. O gatilho exato usado no produto original não é observável.
 */
export async function ensureRentalReceivable(
  ctx: AppContext,
  rental: RentalDoc,
  options: EnsureRentalReceivableOptions = {},
  session?: ClientSession,
): Promise<ObjectId> {
  const existing = await ctx.mongo.collections.receivables.findOne(
    { organizationId: rental.organizationId, rentalId: rental._id, expectedPeriod: 'CONTRACT' },
    { session },
  );
  if (existing) return existing._id;

  const today = options.today ?? businessDate();
  const gross =
    options.grossAmountCents ?? rental.periodicAmountCents * rentalPeriodCount(rental);
  const dueDate =
    options.dueDate ?? addDaysIso(rental.startDate, rentalPeriodDays[rental.rentalType]);
  const paid = options.paidAmountCents ?? 0;
  const description = `Locação ${rental.rentalNumber}`;

  const now = new Date();
  const _id = new ObjectId();
  const doc: ReceivableDoc = {
    _id,
    organizationId: rental.organizationId,
    description,
    descriptionFold: foldAccents(description).toLowerCase(),
    rentalId: rental._id,
    driverId: rental.driverId,
    grossAmountCents: gross,
    paidAmountCents: paid,
    dueDate,
    paymentMethod: null,
    kind: 'RENT',
    installmentNo: null,
    expectedPeriod: 'CONTRACT',
    status: 'OPEN',
    createdBy: rental.createdBy,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  doc.status = deriveReceivableStatus(doc, today);
  await ctx.mongo.collections.receivables.insertOne(doc, { session });
  return _id;
}

export interface RegisterPaymentInput {
  organizationId: ObjectId;
  actorId: ObjectId | null;
  sourceId: ObjectId;
  amountCents: number;
  paidAt: IsoDate;
  method: PaymentMethod;
  bankAccountId: ObjectId;
  notes?: string | null;
  idempotencyKey?: string | null;
}

export async function registerReceivablePayment(
  ctx: AppContext,
  input: RegisterPaymentInput,
): Promise<{ paymentId: ObjectId; receivableId: ObjectId; alreadyProcessed: boolean }> {
  const today = businessDate();
  return withTransaction(ctx, async (session) => {
    const receivable = await ctx.mongo.collections.receivables.findOne(
      { _id: input.sourceId, organizationId: input.organizationId },
      { session },
    );
    if (!receivable) throw notFound('Conta a receber não encontrada.');
    if (receivable.status === 'CANCELED') throw conflict('Conta a receber cancelada.');

    const idempotencyKey =
      input.idempotencyKey ??
      sha256(
        `receivable:${input.sourceId.toHexString()}:${input.amountCents}:${input.paidAt}:${input.bankAccountId.toHexString()}`,
      );

    const duplicated = await ctx.mongo.collections.payments.findOne(
      { organizationId: input.organizationId, idempotencyKey },
      { session },
    );
    if (duplicated) {
      return { paymentId: duplicated._id, receivableId: receivable._id, alreadyProcessed: true };
    }

    const remaining = remainingCents(receivable.grossAmountCents, receivable.paidAmountCents);
    if (remaining === 0) throw conflict('Esta conta já está quitada.');
    if (input.amountCents > remaining) {
      throw unprocessable('O valor recebido não pode ser maior que o saldo pendente.', {
        remainingCents: remaining,
      });
    }

    const transactionId = await postTransaction(
      ctx,
      {
        organizationId: input.organizationId,
        bankAccountId: input.bankAccountId,
        occurredAt: input.paidAt,
        description: `Pagamento da locação - Contrato ${receivable.description.replace(/^Locação\s+/, '')}`,
        direction: 'IN',
        amountCents: input.amountCents,
        originType: 'RECEIVABLE',
        originId: receivable._id,
        dedupeKey: `payment:${idempotencyKey}`,
        actorId: input.actorId,
      },
      session,
    );

    const now = new Date();
    const paymentId = new ObjectId();
    await ctx.mongo.collections.payments.insertOne(
      {
        _id: paymentId,
        organizationId: input.organizationId,
        sourceType: 'RECEIVABLE',
        sourceId: receivable._id,
        amountCents: input.amountCents,
        paidAt: input.paidAt,
        method: input.method,
        bankAccountId: input.bankAccountId,
        transactionId,
        idempotencyKey,
        notes: input.notes ?? null,
        createdBy: input.actorId,
        createdAt: now,
        updatedAt: now,
      },
      { session },
    );

    const paidAmountCents = receivable.paidAmountCents + input.amountCents;
    const status = deriveReceivableStatus(
      { ...receivable, paidAmountCents },
      today,
    );
    await ctx.mongo.collections.receivables.updateOne(
      { _id: receivable._id, version: receivable.version },
      {
        $set: { paidAmountCents, status, paymentMethod: input.method, updatedAt: now },
        $inc: { version: 1 },
      },
      { session },
    );

    await audit(
      ctx,
      {
        organizationId: input.organizationId,
        actorId: input.actorId,
        action: 'receivable.payment',
        entityType: 'receivable',
        entityId: receivable._id,
        before: { paidAmountCents: receivable.paidAmountCents, status: receivable.status },
        after: { paidAmountCents, status, amountCents: input.amountCents },
      },
      session,
    );

    return { paymentId, receivableId: receivable._id, alreadyProcessed: false };
  });
}

export async function registerPayablePayment(
  ctx: AppContext,
  input: RegisterPaymentInput,
): Promise<{ paymentId: ObjectId; payableId: ObjectId; alreadyProcessed: boolean }> {
  const today = businessDate();
  return withTransaction(ctx, async (session) => {
    const payable = await ctx.mongo.collections.payables.findOne(
      { _id: input.sourceId, organizationId: input.organizationId },
      { session },
    );
    if (!payable) throw notFound('Conta a pagar não encontrada.');
    if (payable.status === 'CANCELED') throw conflict('Conta a pagar cancelada.');

    const idempotencyKey =
      input.idempotencyKey ??
      sha256(
        `payable:${input.sourceId.toHexString()}:${input.amountCents}:${input.paidAt}:${input.bankAccountId.toHexString()}`,
      );

    const duplicated = await ctx.mongo.collections.payments.findOne(
      { organizationId: input.organizationId, idempotencyKey },
      { session },
    );
    if (duplicated) {
      return { paymentId: duplicated._id, payableId: payable._id, alreadyProcessed: true };
    }

    const remaining = remainingCents(payable.amountCents, payable.paidAmountCents);
    if (remaining === 0) throw conflict('Esta conta já está paga.');
    if (input.amountCents > remaining) {
      throw unprocessable('O valor pago não pode ser maior que o saldo em aberto.', {
        remainingCents: remaining,
      });
    }

    const transactionId = await postTransaction(
      ctx,
      {
        organizationId: input.organizationId,
        bankAccountId: input.bankAccountId,
        occurredAt: input.paidAt,
        description: `Pagamento de conta a pagar - ${payable.description}`,
        direction: 'OUT',
        amountCents: input.amountCents,
        originType: 'PAYABLE',
        originId: payable._id,
        dedupeKey: `payment:${idempotencyKey}`,
        actorId: input.actorId,
      },
      session,
    );

    const now = new Date();
    const paymentId = new ObjectId();
    await ctx.mongo.collections.payments.insertOne(
      {
        _id: paymentId,
        organizationId: input.organizationId,
        sourceType: 'PAYABLE',
        sourceId: payable._id,
        amountCents: input.amountCents,
        paidAt: input.paidAt,
        method: input.method,
        bankAccountId: input.bankAccountId,
        transactionId,
        idempotencyKey,
        notes: input.notes ?? null,
        createdBy: input.actorId,
        createdAt: now,
        updatedAt: now,
      },
      { session },
    );

    const paidAmountCents = payable.paidAmountCents + input.amountCents;
    const status = derivePayableStatus({ ...payable, paidAmountCents }, today);
    await ctx.mongo.collections.payables.updateOne(
      { _id: payable._id, version: payable.version },
      { $set: { paidAmountCents, status, updatedAt: now }, $inc: { version: 1 } },
      { session },
    );

    await audit(
      ctx,
      {
        organizationId: input.organizationId,
        actorId: input.actorId,
        action: 'payable.payment',
        entityType: 'payable',
        entityId: payable._id,
        before: { paidAmountCents: payable.paidAmountCents, status: payable.status },
        after: { paidAmountCents, status, amountCents: input.amountCents },
      },
      session,
    );

    return { paymentId, payableId: payable._id, alreadyProcessed: false };
  });
}

/**
 * Estorna todos os pagamentos de uma origem (usado no cancelamento de
 * uma conta já paga). Nunca apaga o extrato — cria movimentos espelho.
 */
export async function reversePaymentsOf(
  ctx: AppContext,
  params: {
    organizationId: ObjectId;
    sourceType: 'RECEIVABLE' | 'PAYABLE';
    sourceId: ObjectId;
    reason: string;
    actorId: ObjectId | null;
  },
  session?: ClientSession,
): Promise<number> {
  const payments = await ctx.mongo.collections.payments
    .find(
      { organizationId: params.organizationId, sourceType: params.sourceType, sourceId: params.sourceId },
      { session },
    )
    .toArray();
  const today = businessDate();
  let reversed = 0;
  for (const payment of payments) {
    if (!payment.transactionId) continue;
    const id = await reverseTransaction(
      ctx,
      {
        organizationId: params.organizationId,
        transactionId: payment.transactionId,
        occurredAt: today,
        reason: params.reason,
        actorId: params.actorId,
      },
      session,
    );
    if (id) reversed += 1;
  }
  return reversed;
}

/* ------------------- Recorrência de contas a pagar ----------------- */

/**
 * Gera a ocorrência do período corrente para contas recorrentes.
 * Chave `(seriesId, period)` garante exatamente uma ocorrência por mês,
 * mesmo com execuções concorrentes do job.
 */
export async function generateRecurringPayables(
  ctx: AppContext,
  organizationId: ObjectId,
  today = businessDate(),
): Promise<number> {
  const period = today.slice(0, 7);
  const templates = await ctx.mongo.collections.payables
    .find({
      organizationId,
      'recurring.enabled': true,
      'recurring.seriesId': { $type: 'string' },
      status: { $ne: 'CANCELED' },
    })
    .toArray();

  const seen = new Set<string>();
  let created = 0;
  for (const template of templates) {
    const seriesId = template.recurring.seriesId!;
    if (seen.has(seriesId)) continue;
    seen.add(seriesId);
    if (template.recurring.period === period) continue;

    const already = await ctx.mongo.collections.payables.findOne({
      organizationId,
      'recurring.seriesId': seriesId,
      'recurring.period': period,
    });
    if (already) continue;

    const day = Number(template.dueDate.slice(8, 10));
    const [y, m] = period.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    const dueDate = `${period}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;

    const now = new Date();
    try {
      await ctx.mongo.collections.payables.insertOne({
        _id: new ObjectId(),
        organizationId,
        description: template.description,
        descriptionFold: template.descriptionFold,
        categoryId: template.categoryId,
        vehicleId: template.vehicleId,
        amountCents: template.amountCents,
        paidAmountCents: 0,
        dueDate,
        supplier: template.supplier,
        documentUrl: null,
        recurring: { enabled: true, seriesId, period },
        notes: template.notes,
        status: dueDate < today ? 'OVERDUE' : 'PENDING',
        createdBy: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      });
      created += 1;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return created;
}
