import { ObjectId, type ClientSession } from 'mongodb';
import {
  businessDate,
  rentalPaymentCategoryLabels,
  rentalPaymentStatusLabels,
  type PaymentMethod,
  type RentalPaymentCategory,
  type RentalPaymentEntry,
  type RentalPaymentsView,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { conflict, notFound } from '../common/errors.js';
import { withTransaction } from '../database/mongo.js';
import type { IsoDate, ReceivableDoc, RentalDoc, RentalPaymentDoc } from '../database/types.js';
import { audit, nextSequence } from './common.js';
import {
  deriveReceivableStatus,
  ensureRentalReceivable,
  extendOpenEndedReceivable,
  registerReceivablePayment,
  reverseReceivablePayment,
} from './finance.js';
import { defaultBankAccountId } from './ledger.js';
import { foldAccents } from '../common/helpers.js';

/* ------------------------------------------------------------------ *
 * Aba "Pagamentos" da locação (fluxo do Frota One).
 *
 * Cada lançamento é uma linha da lista, com recibo `INV-AAAA-NNN`:
 *   - RENT      "Pagamento da Locação": abate a conta do contrato quando pago;
 *               pendente é só previsão (não muda totais).
 *   - EXTRA_KM  "KM Excedente": cobrança extra; cria conta a receber própria
 *               (soma ao Valor Total e ao Pendente).
 * O DINHEIRO nunca é gravado aqui: pagar = registerReceivablePayment (transação,
 * extrato, idempotência, auditoria, dashboards); excluir pago = reverseReceivablePayment.
 * Datas (prevista e do pagamento) são sempre informadas pelo dono.
 * ------------------------------------------------------------------ */

export async function nextRentalReceipt(
  ctx: AppContext,
  organizationId: ObjectId,
  year: number,
  session?: ClientSession,
): Promise<{ number: string; sequence: number }> {
  const sequence = await nextSequence(ctx, organizationId, 'receipt', year, session);
  return { number: `INV-${year}-${String(sequence).padStart(3, '0')}`, sequence };
}

export async function loadRental(ctx: AppContext, organizationId: ObjectId, rentalId: ObjectId): Promise<RentalDoc> {
  const rental = await ctx.mongo.collections.rentals.findOne({ _id: rentalId, organizationId });
  if (!rental) throw notFound('Locação não encontrada.');
  return rental;
}

const describe = (category: RentalPaymentCategory, rentalNumber: string) =>
  `${rentalPaymentCategoryLabels[category]} - Contrato ${rentalNumber}`;

/** Cartões: contrato + KM excedente (sem caução). Contas canceladas não contam. */
async function summarize(ctx: AppContext, rental: RentalDoc) {
  const receivables = await ctx.mongo.collections.receivables
    .find({
      organizationId: rental.organizationId,
      rentalId: rental._id,
      kind: { $in: ['RENT', 'OTHER'] },
      status: { $ne: 'CANCELED' },
    })
    .toArray();
  const totalCents = receivables.reduce((a, r) => a + r.grossAmountCents, 0);
  const paidCents = receivables.reduce((a, r) => a + Math.min(r.paidAmountCents, r.grossAmountCents), 0);
  return {
    totalCents,
    paidCents,
    pendingCents: Math.max(totalCents - paidCents, 0),
    depositCents: rental.depositCents,
  };
}

function toEntry(doc: RentalPaymentDoc, rentalNumber: string, today: IsoDate): RentalPaymentEntry {
  return {
    id: doc._id.toHexString(),
    receiptNumber: doc.receiptNumber,
    category: doc.category,
    description: describe(doc.category, rentalNumber),
    amountCents: doc.amountCents,
    expectedDate: doc.expectedDate,
    method: doc.method,
    status: doc.status === 'PAID' ? 'PAID' : doc.expectedDate < today ? 'OVERDUE' : 'PENDING',
    paidAt: doc.paidAt,
    notes: doc.notes,
  };
}

/** Busca livre: recibo, categoria, descrição, situação ou valor (35000, 350,00 ou 350.00). */
function matches(entry: RentalPaymentEntry, term: string): boolean {
  const t = foldAccents(term).toLowerCase().trim();
  if (!t) return true;
  const cents = String(entry.amountCents);
  const reais = (entry.amountCents / 100).toFixed(2);
  const haystack = [
    entry.receiptNumber,
    rentalPaymentCategoryLabels[entry.category],
    entry.description,
    rentalPaymentStatusLabels[entry.status],
    cents,
    reais,
    reais.replace('.', ','),
  ]
    .map((v) => foldAccents(v).toLowerCase())
    .join(' | ');
  return haystack.includes(t);
}

export async function buildView(
  ctx: AppContext,
  rental: RentalDoc,
  q?: string,
  today: IsoDate = businessDate(),
): Promise<RentalPaymentsView> {
  await extendOpenEndedReceivable(ctx, rental, today);
  const docs = await ctx.mongo.collections.rentalPayments
    .find({ organizationId: rental.organizationId, rentalId: rental._id, deletedAt: null })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();
  const entries = docs.map((d) => toEntry(d, rental.rentalNumber, today)).filter((e) => (q ? matches(e, q) : true));
  return {
    rentalId: rental._id.toHexString(),
    rentalNumber: rental.rentalNumber,
    rentalStatus: rental.status,
    summary: await summarize(ctx, rental),
    entries,
  };
}

function assertWritable(rental: RentalDoc) {
  if (rental.status === 'CANCELED') throw conflict('A locação está cancelada.');
}

/** Conta a receber do lançamento: contrato (RENT) ou conta própria já criada (EXTRA_KM). */
async function receivableFor(ctx: AppContext, rental: RentalDoc, entry: RentalPaymentDoc): Promise<ReceivableDoc> {
  const id =
    entry.category === 'RENT'
      ? await ensureRentalReceivable(ctx, rental, {})
      : entry.receivableId;
  const doc = id ? await ctx.mongo.collections.receivables.findOne({ _id: id, organizationId: rental.organizationId }) : null;
  if (!doc) throw notFound('Conta a receber do lançamento não encontrada.');
  return doc;
}

/** EXTRA_KM: conta a receber própria; `expectedPeriod` único por lançamento torna a criação idempotente. */
async function ensureExtraReceivable(
  ctx: AppContext,
  rental: RentalDoc,
  params: { entryKey: string; amountCents: number; expectedDate: IsoDate; actorId: ObjectId | null },
  session?: ClientSession,
): Promise<ObjectId> {
  const marker = `KM:${params.entryKey}`;
  const existing = await ctx.mongo.collections.receivables.findOne(
    { organizationId: rental.organizationId, rentalId: rental._id, expectedPeriod: marker },
    { session },
  );
  if (existing) return existing._id;
  const description = describe('EXTRA_KM', rental.rentalNumber);
  const now = new Date();
  const doc: ReceivableDoc = {
    _id: new ObjectId(),
    organizationId: rental.organizationId,
    description,
    descriptionFold: foldAccents(description).toLowerCase(),
    rentalId: rental._id,
    driverId: rental.driverId,
    grossAmountCents: params.amountCents,
    paidAmountCents: 0,
    dueDate: params.expectedDate,
    paymentMethod: null,
    kind: 'OTHER',
    installmentNo: null,
    expectedPeriod: marker,
    status: 'OPEN',
    createdBy: params.actorId,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  doc.status = deriveReceivableStatus(doc, businessDate());
  await ctx.mongo.collections.receivables.insertOne(doc, { session });
  return doc._id;
}

export interface CreateEntryInput {
  organizationId: ObjectId;
  actorId: ObjectId | null;
  rentalId: ObjectId;
  category: RentalPaymentCategory;
  amountCents: number;
  expectedDate: IsoDate;
  alreadyPaid: boolean;
  paidAt?: IsoDate;
  method?: PaymentMethod;
  notes?: string | null;
  idempotencyKey?: string | null;
}

export async function createEntry(
  ctx: AppContext,
  input: CreateEntryInput,
): Promise<{ view: RentalPaymentsView; alreadyProcessed: boolean }> {
  const rental = await loadRental(ctx, input.organizationId, input.rentalId);
  assertWritable(rental);
  if (rental.status !== 'ACTIVE') throw conflict('A locação não está ativa: não aceita novos pagamentos.');

  const c = ctx.mongo.collections;
  if (input.idempotencyKey) {
    const existing = await c.rentalPayments.findOne({
      organizationId: input.organizationId,
      rentalId: rental._id,
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) return { view: await buildView(ctx, rental), alreadyProcessed: true };
  }

  const entryKey = input.idempotencyKey ?? new ObjectId().toHexString();
  const today = businessDate();
  await extendOpenEndedReceivable(ctx, rental, today);

  // Conta a receber do lançamento (contrato ou conta própria do KM excedente).
  let receivableId: ObjectId | null = null;
  if (input.category === 'RENT') {
    receivableId = await ensureRentalReceivable(ctx, rental, { today });
  } else {
    receivableId = await ensureExtraReceivable(ctx, rental, {
      entryKey,
      amountCents: input.amountCents,
      expectedDate: input.expectedDate,
      actorId: input.actorId,
    });
  }

  // Pago: o dinheiro passa pelo fluxo oficial (transação + extrato + dashboards).
  let paymentId: ObjectId | null = null;
  if (input.alreadyPaid) {
    const bankAccountId = await defaultBankAccountId(ctx, input.organizationId);
    if (!bankAccountId) throw conflict('Cadastre uma conta bancária antes de registrar um pagamento.');
    const paid = await registerReceivablePayment(ctx, {
      organizationId: input.organizationId,
      actorId: input.actorId,
      sourceId: receivableId,
      amountCents: input.amountCents,
      paidAt: input.paidAt!,
      method: input.method ?? 'PIX',
      bankAccountId,
      notes: input.notes ?? null,
      idempotencyKey: `rpe:${entryKey}`,
    });
    paymentId = paid.paymentId;
  }

  const year = Number((input.alreadyPaid ? input.paidAt! : input.expectedDate).slice(0, 4));
  await withTransaction(ctx, async (session) => {
    const { number, sequence } = await nextRentalReceipt(ctx, input.organizationId, year, session);
    const now = new Date();
    const doc: RentalPaymentDoc = {
      _id: new ObjectId(),
      organizationId: input.organizationId,
      rentalId: rental._id,
      driverId: rental.driverId,
      receiptNumber: number,
      sequence,
      category: input.category,
      amountCents: input.amountCents,
      expectedDate: input.expectedDate,
      notes: input.notes ?? null,
      status: input.alreadyPaid ? 'PAID' : 'PENDING',
      paidAt: input.alreadyPaid ? input.paidAt! : null,
      method: input.alreadyPaid ? (input.method ?? 'PIX') : null,
      receivableId,
      paymentId,
      deletedAt: null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.actorId,
      createdAt: now,
      updatedAt: now,
    };
    await c.rentalPayments.insertOne(doc, { session });
    await audit(
      ctx,
      {
        organizationId: input.organizationId,
        actorId: input.actorId,
        action: 'rental.payment.created',
        entityType: 'rental',
        entityId: rental._id,
        after: {
          receiptNumber: number,
          category: input.category,
          amountCents: input.amountCents,
          expectedDate: input.expectedDate,
          status: doc.status,
        },
      },
      session,
    );
  });
  return { view: await buildView(ctx, rental), alreadyProcessed: false };
}

async function loadEntry(
  ctx: AppContext,
  rental: RentalDoc,
  entryId: ObjectId,
): Promise<RentalPaymentDoc> {
  const entry = await ctx.mongo.collections.rentalPayments.findOne({
    _id: entryId,
    organizationId: rental.organizationId,
    rentalId: rental._id,
    deletedAt: null,
  });
  if (!entry) throw notFound('Pagamento não encontrado.');
  return entry;
}

export async function updateEntry(
  ctx: AppContext,
  params: {
    organizationId: ObjectId;
    actorId: ObjectId | null;
    rentalId: ObjectId;
    entryId: ObjectId;
    amountCents?: number;
    expectedDate?: IsoDate;
    notes?: string | null;
  },
): Promise<RentalPaymentsView> {
  const rental = await loadRental(ctx, params.organizationId, params.rentalId);
  assertWritable(rental);
  const entry = await loadEntry(ctx, rental, params.entryId);
  if (entry.status !== 'PENDING') {
    throw conflict('Só é possível editar pagamentos pendentes. Exclua (estorne) o pagamento para corrigi-lo.');
  }

  const amountCents = params.amountCents ?? entry.amountCents;
  const expectedDate = params.expectedDate ?? entry.expectedDate;
  const notes = params.notes !== undefined ? params.notes : entry.notes;

  if (entry.category === 'EXTRA_KM' && entry.receivableId) {
    const receivable = await ctx.mongo.collections.receivables.findOne({
      _id: entry.receivableId,
      organizationId: params.organizationId,
    });
    if (receivable) {
      const next = { ...receivable, grossAmountCents: amountCents, dueDate: expectedDate };
      const res = await ctx.mongo.collections.receivables.updateOne(
        { _id: receivable._id, version: receivable.version },
        {
          $set: {
            grossAmountCents: amountCents,
            dueDate: expectedDate,
            status: deriveReceivableStatus(next, businessDate()),
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
      );
      if (res.matchedCount === 0) throw conflict('O pagamento foi alterado ao mesmo tempo. Tente novamente.');
    }
  }
  await ctx.mongo.collections.rentalPayments.updateOne(
    { _id: entry._id, status: 'PENDING' },
    { $set: { amountCents, expectedDate, notes, updatedAt: new Date() } },
  );
  await audit(ctx, {
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: 'rental.payment.updated',
    entityType: 'rental',
    entityId: rental._id,
    before: { receiptNumber: entry.receiptNumber, amountCents: entry.amountCents, expectedDate: entry.expectedDate },
    after: { receiptNumber: entry.receiptNumber, amountCents, expectedDate },
  });
  return buildView(ctx, rental);
}

export async function markEntryPaid(
  ctx: AppContext,
  params: {
    organizationId: ObjectId;
    actorId: ObjectId | null;
    rentalId: ObjectId;
    entryId: ObjectId;
    paidAt: IsoDate;
    method: PaymentMethod;
  },
): Promise<RentalPaymentsView> {
  const rental = await loadRental(ctx, params.organizationId, params.rentalId);
  assertWritable(rental);
  const entry = await loadEntry(ctx, rental, params.entryId);
  if (entry.status === 'PAID') return buildView(ctx, rental); // repetir não duplica

  const receivable = await receivableFor(ctx, rental, entry);
  const bankAccountId = await defaultBankAccountId(ctx, params.organizationId);
  if (!bankAccountId) throw conflict('Cadastre uma conta bancária antes de registrar um pagamento.');
  const paid = await registerReceivablePayment(ctx, {
    organizationId: params.organizationId,
    actorId: params.actorId,
    sourceId: receivable._id,
    amountCents: entry.amountCents,
    paidAt: params.paidAt,
    method: params.method,
    bankAccountId,
    notes: entry.notes,
    idempotencyKey: `rpe-pay:${entry._id.toHexString()}`,
  });
  await ctx.mongo.collections.rentalPayments.updateOne(
    { _id: entry._id, status: 'PENDING' },
    {
      $set: {
        status: 'PAID',
        paidAt: params.paidAt,
        method: params.method,
        receivableId: receivable._id,
        paymentId: paid.paymentId,
        updatedAt: new Date(),
      },
    },
  );
  await audit(ctx, {
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: 'rental.payment.paid',
    entityType: 'rental',
    entityId: rental._id,
    after: { receiptNumber: entry.receiptNumber, amountCents: entry.amountCents, paidAt: params.paidAt },
  });
  return buildView(ctx, rental);
}

export async function deleteEntry(
  ctx: AppContext,
  params: { organizationId: ObjectId; actorId: ObjectId | null; rentalId: ObjectId; entryId: ObjectId },
): Promise<RentalPaymentsView> {
  const rental = await loadRental(ctx, params.organizationId, params.rentalId);
  assertWritable(rental);
  const c = ctx.mongo.collections;
  const entry = await c.rentalPayments.findOne({
    _id: params.entryId,
    organizationId: params.organizationId,
    rentalId: rental._id,
  });
  if (!entry) throw notFound('Pagamento não encontrado.');
  if (entry.deletedAt) return buildView(ctx, rental); // repetir não duplica o efeito

  // Pago: estorna o recebimento (histórico preservado). Pendente: não há dinheiro a desfazer.
  if (entry.status === 'PAID' && entry.paymentId && entry.receivableId) {
    await reverseReceivablePayment(ctx, {
      organizationId: params.organizationId,
      actorId: params.actorId,
      receivableId: entry.receivableId,
      paymentId: entry.paymentId,
      reason: `Pagamento ${entry.receiptNumber} excluído`,
    });
  }
  // KM excedente: a conta própria deixa de existir (sai do Valor Total).
  if (entry.category === 'EXTRA_KM' && entry.receivableId) {
    await c.receivables.updateOne(
      { _id: entry.receivableId, organizationId: params.organizationId },
      { $set: { status: 'CANCELED', updatedAt: new Date() }, $inc: { version: 1 } },
    );
  }
  await c.rentalPayments.updateOne(
    { _id: entry._id },
    { $set: { deletedAt: new Date(), updatedAt: new Date() } },
  );
  await audit(ctx, {
    organizationId: params.organizationId,
    actorId: params.actorId,
    action: entry.status === 'PAID' ? 'rental.payment.reversed' : 'rental.payment.deleted',
    entityType: 'rental',
    entityId: rental._id,
    before: { receiptNumber: entry.receiptNumber, amountCents: entry.amountCents, status: entry.status },
  });
  return buildView(ctx, rental);
}

/**
 * Cria lançamentos PAGOS para recebimentos de locação anteriores a esta funcionalidade,
 * para a lista não ficar vazia onde "Valor Pago" já tem valor. Idempotente.
 */
export async function backfillRentalPaymentEntries(ctx: AppContext): Promise<{ created: number }> {
  const c = ctx.mongo.collections;
  let created = 0;
  const cursor = c.payments
    .find({ sourceType: 'RECEIVABLE', reversedAt: null })
    .sort({ organizationId: 1, paidAt: 1, createdAt: 1 });
  for await (const payment of cursor) {
    const already = await c.rentalPayments.findOne({ organizationId: payment.organizationId, paymentId: payment._id });
    if (already) continue;
    const receivable = await c.receivables.findOne({ _id: payment.sourceId, organizationId: payment.organizationId });
    if (!receivable?.rentalId) continue;
    // Multa repassada não é lançamento da aba Pagamentos da locação.
    if (receivable.kind === 'FINE' || receivable.kind === 'DAMAGE') continue;
    const { number, sequence } = await nextRentalReceipt(ctx, payment.organizationId, Number(payment.paidAt.slice(0, 4)));
    const now = new Date();
    await c.rentalPayments.insertOne({
      _id: new ObjectId(),
      organizationId: payment.organizationId,
      rentalId: receivable.rentalId,
      driverId: receivable.driverId,
      receiptNumber: number,
      sequence,
      category: receivable.kind === 'OTHER' ? 'EXTRA_KM' : 'RENT',
      amountCents: payment.amountCents,
      // a data prevista original não foi guardada: usa a data do pagamento
      expectedDate: payment.paidAt,
      notes: payment.notes ?? null,
      status: 'PAID',
      paidAt: payment.paidAt,
      method: payment.method,
      receivableId: receivable._id,
      paymentId: payment._id,
      deletedAt: null,
      idempotencyKey: null,
      createdBy: payment.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    });
    created += 1;
  }
  return { created };
}

