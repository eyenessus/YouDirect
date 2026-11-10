import { ObjectId, type ClientSession } from 'mongodb';
import {
  businessDate,
  installmentFrequencyMonths,
  rentalPeriodDays,
  type InstallmentFrequency,
  type PaymentMethod,
  type ReceivableStatus,
  type PayableStatus,
  type RentalPaymentSchedule,
  type RentalPaymentWeek,
  addDaysIso,
  diffDaysIso,
} from '@yudirect/contracts';
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

/**
 * Vencimentos de um parcelamento. Cada parcela é calculada a partir da DATA
 * INICIAL (não da parcela anterior), então 31/01 → 28/02 → 31/03 mantém o dia
 * original sempre que o mês permite.
 */
export function installmentDueDates(
  firstDueDate: IsoDate,
  count: number,
  frequency: InstallmentFrequency,
): IsoDate[] {
  const [y, m, d] = firstDueDate.split('-').map(Number) as [number, number, number];
  const step = installmentFrequencyMonths[frequency];
  return Array.from({ length: count }, (_, i) => {
    const total = m - 1 + i * step;
    const year = y + Math.floor(total / 12);
    const month = (total % 12) + 1;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = Math.min(d, lastDay);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` as IsoDate;
  });
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

/**
 * Cronograma de pagamento do contrato, CALCULADO sobre a conta a receber única
 * (A-FIN-02): nada novo é gravado.
 *  - nº de períodos = ceil(total / valor do período); o último absorve a diferença,
 *    então a soma das semanas sempre bate com o total da conta;
 *  - vencimento do período i = início + i × dias do período (o 1º coincide com o
 *    vencimento da conta);
 *  - o já pago abate do período mais antigo para o mais novo.
 */
export function buildPaymentSchedule(
  rental: Pick<RentalDoc, 'startDate' | 'rentalType' | 'periodicAmountCents'>,
  receivable: Pick<ReceivableDoc, 'grossAmountCents' | 'paidAmountCents'>,
  today: IsoDate,
): { weeks: RentalPaymentWeek[]; totals: RentalPaymentSchedule['totals'] } {
  const periodic = Math.max(rental.periodicAmountCents, 1);
  const gross = Math.max(receivable.grossAmountCents, 0);
  const count = Math.max(1, Math.ceil(gross / periodic));
  const periodDays = rentalPeriodDays[rental.rentalType];

  let unallocated = Math.max(receivable.paidAmountCents, 0);
  const weeks: RentalPaymentWeek[] = [];
  for (let i = 1; i <= count; i += 1) {
    const amountCents = i < count ? periodic : gross - periodic * (count - 1);
    const paidCents = Math.min(amountCents, unallocated);
    unallocated -= paidCents;
    const remaining = amountCents - paidCents;
    const dueDate = addDaysIso(rental.startDate, periodDays * i) as IsoDate;
    const status: RentalPaymentWeek['status'] =
      remaining === 0 ? 'PAID' : dueDate < today ? 'OVERDUE' : paidCents > 0 ? 'PARTIAL' : 'OPEN';
    weeks.push({ number: i, dueDate, amountCents, paidCents, remainingCents: remaining, status });
  }
  const paidTotal = weeks.reduce((a, w) => a + w.paidCents, 0);
  return { weeks, totals: { amountCents: gross, paidCents: paidTotal, remainingCents: gross - paidTotal } };
}

/**
 * Locação sem data de término tem a conta do 1º período apenas. Para o dono poder
 * dar baixa nas semanas seguintes, o total cresce um período a cada período iniciado.
 * Idempotente: só aumenta, nunca reduz.
 */
export async function extendOpenEndedReceivable(
  ctx: AppContext,
  rental: RentalDoc,
  today: IsoDate = businessDate(),
): Promise<boolean> {
  if (rental.endDate || rental.status !== 'ACTIVE') return false;
  const receivable = await ctx.mongo.collections.receivables.findOne({
    organizationId: rental.organizationId,
    rentalId: rental._id,
    expectedPeriod: 'CONTRACT',
  });
  if (!receivable || receivable.status === 'CANCELED') return false;

  const periodDays = rentalPeriodDays[rental.rentalType];
  const started = Math.max(1, Math.floor(diffDaysIso(today, rental.startDate) / periodDays) + 1);
  const target = rental.periodicAmountCents * started;
  if (target <= receivable.grossAmountCents) return false;

  const next = { ...receivable, grossAmountCents: target };
  const res = await ctx.mongo.collections.receivables.updateOne(
    { _id: receivable._id, version: receivable.version },
    {
      $set: {
        grossAmountCents: target,
        status: deriveReceivableStatus(next, today),
        updatedAt: new Date(),
      },
      $inc: { version: 1 },
    },
  );
  return res.modifiedCount > 0;
}

export async function extendOpenEndedReceivables(
  ctx: AppContext,
  organizationId: ObjectId,
  today: IsoDate = businessDate(),
): Promise<number> {
  const rentals = await ctx.mongo.collections.rentals
    .find({ organizationId, status: 'ACTIVE', endDate: null })
    .toArray();
  let extended = 0;
  for (const rental of rentals) {
    if (await extendOpenEndedReceivable(ctx, rental, today)) extended += 1;
  }
  return extended;
}

/**
 * Recalcula a conta a receber do contrato depois de uma edição (valor,
 * datas, tipo) ou do encerramento da locação. O que já foi PAGO nunca é
 * alterado:
 *  - edição que deixaria o total abaixo do já pago → recusada (409);
 *  - encerramento antecipado → o total cai para os períodos até o fim,
 *    mas nunca abaixo do já pago (sobra fica registrada, sem estorno
 *    automático).
 * Locação sem data de fim conta os períodos já iniciados até `today`.
 */
export async function syncContractReceivable(
  ctx: AppContext,
  rental: RentalDoc,
  options: { today?: IsoDate; session?: ClientSession; mode: 'edit' | 'close' },
): Promise<{ changed: boolean; grossAmountCents: number | null }> {
  const today = options.today ?? businessDate();
  const receivable = await ctx.mongo.collections.receivables.findOne(
    { organizationId: rental.organizationId, rentalId: rental._id, expectedPeriod: 'CONTRACT' },
    { session: options.session },
  );
  if (!receivable || receivable.status === 'CANCELED') return { changed: false, grossAmountCents: null };

  const periodDays = rentalPeriodDays[rental.rentalType];
  const periods = rental.endDate
    ? rentalPeriodCount(rental)
    : Math.max(1, Math.floor(diffDaysIso(today, rental.startDate) / periodDays) + 1);
  let gross = rental.periodicAmountCents * periods;
  if (gross < receivable.paidAmountCents) {
    if (options.mode === 'edit') {
      throw conflict(
        'Com esses valores o total do contrato ficaria abaixo do que já foi pago. Ajuste o valor ou registre um estorno antes.',
      );
    }
    gross = receivable.paidAmountCents;
  }
  const dueDate = addDaysIso(rental.startDate, periodDays);
  if (gross === receivable.grossAmountCents && dueDate === receivable.dueDate) {
    return { changed: false, grossAmountCents: gross };
  }
  const next = { ...receivable, grossAmountCents: gross, dueDate };
  const res = await ctx.mongo.collections.receivables.updateOne(
    { _id: receivable._id, version: receivable.version },
    {
      $set: { grossAmountCents: gross, dueDate, status: deriveReceivableStatus(next, today), updatedAt: new Date() },
      $inc: { version: 1 },
    },
    { session: options.session },
  );
  if (res.matchedCount === 0) throw conflict('A conta a receber foi alterada ao mesmo tempo. Tente novamente.');
  return { changed: true, grossAmountCents: gross };
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
    assertPaidAtNotFuture(input.paidAt, today);

    // Chave do cliente: escopo por conta (a mesma chave em contas diferentes
    // não colide). Sem chave: inclui a versão da conta — dois cliques
    // simultâneos viram um pagamento, mas duas parcelas iguais pagas no
    // mesmo dia (legítimas, em momentos diferentes) não se fundem.
    const idempotencyKey = input.idempotencyKey
      ? `receivable:${input.sourceId.toHexString()}:${input.idempotencyKey}`
      : sha256(
          `receivable:${input.sourceId.toHexString()}:v${receivable.version}:${input.amountCents}:${input.paidAt}:${input.bankAccountId.toHexString()}`,
        );

    const duplicated = await ctx.mongo.collections.payments.findOne(
      { organizationId: input.organizationId, idempotencyKey },
      { session },
    );
    if (duplicated) {
      assertSameIdempotentRequest(duplicated, input);
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
    const updated = await ctx.mongo.collections.receivables.updateOne(
      { _id: receivable._id, version: receivable.version },
      {
        $set: { paidAmountCents, status, paymentMethod: input.method, updatedAt: now },
        $inc: { version: 1 },
      },
      { session },
    );
    if (updated.matchedCount === 0) throw conflict('A conta foi alterada ao mesmo tempo. Tente novamente.');

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

/** Pagamento "realizado" não pode estar no futuro (inflaria meses que ainda não aconteceram). */
function assertPaidAtNotFuture(paidAt: IsoDate, today: IsoDate): void {
  if (paidAt > today) {
    throw unprocessable('A data do pagamento não pode ser futura.', { paidAt });
  }
}

/** Reaproveitar a mesma chave com outro valor/conta/data seria um sucesso falso: recusamos. */
function assertSameIdempotentRequest(
  existing: { amountCents: number; paidAt: IsoDate; sourceId: ObjectId },
  input: RegisterPaymentInput,
): void {
  if (
    existing.amountCents !== input.amountCents ||
    existing.paidAt !== input.paidAt ||
    !existing.sourceId.equals(input.sourceId)
  ) {
    throw conflict('Esta chave de idempotência já foi usada em outro pagamento. Gere uma nova tentativa.');
  }
}

/**
 * Estorno de um recebimento: o pagamento original é PRESERVADO (marcado como estornado),
 * o extrato recebe a saída de estorno e a conta volta a ter o saldo em aberto.
 * Repetir o estorno é idempotente (não duplica o efeito).
 */
export async function reverseReceivablePayment(
  ctx: AppContext,
  params: {
    organizationId: ObjectId;
    actorId: ObjectId | null;
    receivableId: ObjectId;
    paymentId: ObjectId;
    reason: string;
  },
): Promise<{ alreadyReversed: boolean; receivableId: ObjectId }> {
  const today = businessDate();
  return withTransaction(ctx, async (session) => {
    const payment = await ctx.mongo.collections.payments.findOne(
      {
        _id: params.paymentId,
        organizationId: params.organizationId,
        sourceType: 'RECEIVABLE',
        sourceId: params.receivableId,
      },
      { session },
    );
    if (!payment) throw notFound('Recebimento não encontrado.');
    const receivable = await ctx.mongo.collections.receivables.findOne(
      { _id: params.receivableId, organizationId: params.organizationId },
      { session },
    );
    if (!receivable) throw notFound('Conta a receber não encontrada.');
    if (payment.reversedAt) return { alreadyReversed: true, receivableId: receivable._id };

    let reversalTransactionId: ObjectId | null = null;
    if (payment.transactionId) {
      reversalTransactionId = await reverseTransaction(
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
    }
    const now = new Date();
    await ctx.mongo.collections.payments.updateOne(
      { _id: payment._id },
      {
        $set: {
          reversedAt: now,
          reversedReason: params.reason,
          reversalTransactionId,
          updatedAt: now,
        },
      },
      { session },
    );

    const paidAmountCents = Math.max(receivable.paidAmountCents - payment.amountCents, 0);
    const status = deriveReceivableStatus({ ...receivable, paidAmountCents }, today);
    const res = await ctx.mongo.collections.receivables.updateOne(
      { _id: receivable._id, version: receivable.version },
      { $set: { paidAmountCents, status, updatedAt: now }, $inc: { version: 1 } },
      { session },
    );
    if (res.matchedCount === 0) throw conflict('A conta foi alterada por outra operação. Tente novamente.');

    await audit(
      ctx,
      {
        organizationId: params.organizationId,
        actorId: params.actorId,
        action: 'receivable.payment.reversed',
        entityType: 'receivable',
        entityId: receivable._id,
        before: { paidAmountCents: receivable.paidAmountCents, status: receivable.status },
        after: { paidAmountCents, status, amountCents: payment.amountCents, reason: params.reason },
      },
      session,
    );
    return { alreadyReversed: false, receivableId: receivable._id };
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
    assertPaidAtNotFuture(input.paidAt, today);

    const idempotencyKey =
      input.idempotencyKey
        ? `payable:${input.sourceId.toHexString()}:${input.idempotencyKey}`
        : sha256(
            `payable:${input.sourceId.toHexString()}:v${payable.version}:${input.amountCents}:${input.paidAt}:${input.bankAccountId.toHexString()}`,
          );

    const duplicated = await ctx.mongo.collections.payments.findOne(
      { organizationId: input.organizationId, idempotencyKey },
      { session },
    );
    if (duplicated) {
      assertSameIdempotentRequest(duplicated, input);
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
    const updated = await ctx.mongo.collections.payables.updateOne(
      { _id: payable._id, version: payable.version },
      { $set: { paidAmountCents, status, updatedAt: now }, $inc: { version: 1 } },
      { session },
    );
    // Outro pagamento mudou a conta no meio: aborta (sem isso o lançamento
    // bancário ficaria registrado e o valor pago, perdido).
    if (updated.matchedCount === 0) throw conflict('A conta foi alterada ao mesmo tempo. Tente novamente.');

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
      {
        organizationId: params.organizationId,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        reversedAt: null,
      },
      { session },
    )
    .toArray();
  const today = businessDate();
  let reversed = 0;
  for (const payment of payments) {
    const id = payment.transactionId
      ? await reverseTransaction(
          ctx,
          {
            organizationId: params.organizationId,
            transactionId: payment.transactionId,
            occurredAt: today,
            reason: params.reason,
            actorId: params.actorId,
          },
          session,
        )
      : null;
    // O pagamento também é marcado: sem isso a DRE e os relatórios
    // continuariam somando um valor que o extrato já estornou.
    await ctx.mongo.collections.payments.updateOne(
      { _id: payment._id, reversedAt: null },
      { $set: { reversedAt: new Date(), reversalTransactionId: id, updatedAt: new Date() } },
      { session },
    );
    if (id) {
      await ctx.mongo.collections.payments.updateOne(
        { _id: payment._id },
        {
          $set: {
            reversedAt: new Date(),
            reversedReason: params.reason,
            reversalTransactionId: id,
            updatedAt: new Date(),
          },
        },
        { session },
      );
      reversed += 1;
    }
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

  // Uma série = todas as ocorrências com o mesmo seriesId. A ocorrência
  // MAIS RECENTE serve de modelo (valor/fornecedor editados valem daqui
  // para frente) e define de onde continuar.
  const latestBySeries = new Map<string, PayableDoc>();
  for (const doc of templates) {
    const seriesId = doc.recurring.seriesId!;
    const prev = latestBySeries.get(seriesId);
    const docPeriod = doc.recurring.period ?? doc.dueDate.slice(0, 7);
    const prevPeriod = prev ? (prev.recurring.period ?? prev.dueDate.slice(0, 7)) : '';
    if (!prev || docPeriod > prevPeriod) latestBySeries.set(seriesId, doc);
  }

  let created = 0;
  for (const [seriesId, template] of latestBySeries) {
    // Recupera meses perdidos (job parado, dyno dormindo): do mês seguinte
    // à última ocorrência até o atual, no máximo 12 por execução.
    const startPeriod = nextMonthKey(template.recurring.period ?? template.dueDate.slice(0, 7));
    const periods: string[] = [];
    for (let p = startPeriod; p <= period && periods.length < 12; p = nextMonthKey(p)) periods.push(p);

    for (const target of periods) {
      const already = await ctx.mongo.collections.payables.findOne({
        organizationId,
        'recurring.seriesId': seriesId,
        'recurring.period': target,
      });
      if (already) continue;

      const day = Number(template.dueDate.slice(8, 10));
      const [y, m] = target.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
      const dueDate = `${target}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;

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
          recurring: { enabled: true, seriesId, period: target },
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
  }
  return created;
}

function nextMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** Encerra a série recorrente inteira (nenhuma nova ocorrência será gerada). */
export async function stopRecurringSeries(
  ctx: AppContext,
  organizationId: ObjectId,
  seriesId: string,
  session?: ClientSession,
): Promise<number> {
  const res = await ctx.mongo.collections.payables.updateMany(
    { organizationId, 'recurring.seriesId': seriesId, 'recurring.enabled': true },
    { $set: { 'recurring.enabled': false, updatedAt: new Date() } },
    { session },
  );
  return res.modifiedCount;
}
