import { ObjectId } from 'mongodb';
import {
  businessDate,
  FISCAL_RECEIVABLE_KINDS,
  paymentMethodLabels,
  type FiscalNote,
  type FiscalNoteCreate,
  type PaymentMethod,
  type PendingFiscalPayment,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import type { FiscalNoteDoc, PaymentDoc, ReceivableDoc } from '../database/types.js';
import type { PaymentReceiptData } from '../pdf/payment-receipt.js';
import { audit, nextNumber } from './common.js';
import { receivableStatementDescription } from './finance.js';

/* ------------------------------------------------------------------ *
 * Controle fiscal: recibo de pagamento e registro das notas de serviço
 * emitidas fora do sistema. O YuDirect não emite NFS-e.
 * ------------------------------------------------------------------ */

interface Actor {
  organizationId: ObjectId;
  userId: ObjectId | null;
}

const isServiceKind = (kind: ReceivableDoc['kind']) => (FISCAL_RECEIVABLE_KINDS as readonly string[]).includes(kind);

async function receivedPayment(ctx: AppContext, organizationId: ObjectId, paymentId: ObjectId): Promise<{ payment: PaymentDoc; receivable: ReceivableDoc }> {
  const payment = await ctx.mongo.collections.payments.findOne({ _id: paymentId, organizationId });
  if (!payment || payment.sourceType !== 'RECEIVABLE') throw notFound('Recebimento não encontrado.');
  if (payment.reversedAt) throw conflict('Este recebimento foi estornado.');
  if (payment.origin === 'DEPOSIT') throw conflict('Compensação com a caução não gera recibo nem nota: o dinheiro já foi recebido na entrada da caução.');
  const receivable = await ctx.mongo.collections.receivables.findOne({ _id: payment.sourceId, organizationId });
  if (!receivable) throw notFound('Conta a receber não encontrada.');
  return { payment, receivable };
}

/** Número do recibo, atribuído na primeira emissão e mantido nas seguintes. */
async function ensureReceiptNumber(ctx: AppContext, organizationId: ObjectId, payment: PaymentDoc): Promise<string> {
  if (payment.receiptDocNumber) return payment.receiptDocNumber;
  const year = Number(payment.paidAt.slice(0, 4));
  const { number } = await nextNumber(ctx, organizationId, 'receipt', 'REC', year);
  const claimed = await ctx.mongo.collections.payments.findOneAndUpdate(
    { _id: payment._id, $or: [{ receiptDocNumber: null }, { receiptDocNumber: { $exists: false } }] },
    { $set: { receiptDocNumber: number } },
    { returnDocument: 'after' },
  );
  // Outra emissão simultânea chegou primeiro: usa o número dela.
  if (claimed) return number;
  return (await ctx.mongo.collections.payments.findOne({ _id: payment._id }))!.receiptDocNumber!;
}

export async function paymentReceiptData(ctx: AppContext, organizationId: ObjectId, paymentId: ObjectId): Promise<PaymentReceiptData> {
  const { payment, receivable } = await receivedPayment(ctx, organizationId, paymentId);
  const [org, driver] = await Promise.all([
    ctx.mongo.collections.organizations.findOne({ _id: organizationId }),
    ctx.mongo.collections.drivers.findOne({ _id: receivable.driverId, organizationId }),
  ]);
  const receiptNumber = await ensureReceiptNumber(ctx, organizationId, payment);
  return {
    receiptNumber,
    organization: { name: org?.name ?? 'Locadora', legalId: org?.legalId ?? null },
    payer: { fullName: driver && !driver.anonymizedAt ? driver.fullName : 'Motorista', cpfMasked: driver?.cpfLast3 ? `final ${driver.cpfLast3}` : null },
    description: receivableStatementDescription(receivable),
    amountCents: payment.amountCents,
    paidAt: payment.paidAt,
    method: payment.method,
    issuedAt: new Date(),
  };
}

/** Recebimentos de serviço no período ainda sem nota emitida. */
export async function pendingFiscalPayments(ctx: AppContext, organizationId: ObjectId, from?: string, to?: string): Promise<PendingFiscalPayment[]> {
  const c = ctx.mongo.collections;
  const range: Record<string, string> = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  const payments = await c.payments
    .find({ organizationId, sourceType: 'RECEIVABLE', reversedAt: null, origin: { $ne: 'DEPOSIT' }, ...(from || to ? { paidAt: range } : {}) })
    .sort({ paidAt: 1, _id: 1 })
    .limit(1000)
    .toArray();
  if (payments.length === 0) return [];
  const [receivables, notes] = await Promise.all([
    c.receivables.find({ organizationId, _id: { $in: payments.map((p) => p.sourceId) } }).toArray(),
    c.fiscalNotes.find({ organizationId, status: 'ISSUED', paymentId: { $in: payments.map((p) => p._id) } }, { projection: { paymentId: 1 } }).toArray(),
  ]);
  const drivers = await c.drivers.find({ organizationId, _id: { $in: receivables.map((r) => r.driverId) } }, { projection: { fullName: 1, anonymizedAt: 1 } }).toArray();
  const rMap = new Map(receivables.map((r) => [r._id.toHexString(), r]));
  const dMap = new Map(drivers.map((d) => [d._id.toHexString(), d]));
  const noted = new Set(notes.map((n) => n.paymentId.toHexString()));
  return payments.flatMap((p) => {
    const r = rMap.get(p.sourceId.toHexString());
    if (!r || !isServiceKind(r.kind) || noted.has(p._id.toHexString())) return [];
    const d = dMap.get(r.driverId.toHexString());
    return [
      {
        paymentId: p._id.toHexString(),
        paidAt: p.paidAt,
        amountCents: p.amountCents,
        description: receivableStatementDescription(r),
        driverName: d && !d.anonymizedAt ? d.fullName : null,
        method: paymentMethodLabels[p.method as PaymentMethod] ?? p.method,
      },
    ];
  });
}

export async function createFiscalNote(ctx: AppContext, actor: Actor, body: FiscalNoteCreate): Promise<FiscalNoteDoc> {
  const { payment, receivable } = await receivedPayment(ctx, actor.organizationId, new ObjectId(body.paymentId));
  if (!isServiceKind(receivable.kind)) throw unprocessable('Só recebimentos de aluguel e km excedente entram no controle de notas de serviço.');
  if (body.issuedOn > businessDate()) throw unprocessable('A data de emissão da nota não pode estar no futuro.');
  const now = new Date();
  const doc: FiscalNoteDoc = {
    _id: new ObjectId(),
    organizationId: actor.organizationId,
    paymentId: payment._id,
    number: body.number,
    issuedOn: body.issuedOn,
    amountCents: payment.amountCents,
    url: body.url ?? null,
    notes: body.notes ?? null,
    status: 'ISSUED',
    canceledReason: null,
    canceledAt: null,
    createdBy: actor.userId,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await ctx.mongo.collections.fiscalNotes.insertOne(doc);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const same = await ctx.mongo.collections.fiscalNotes.findOne({ organizationId: actor.organizationId, paymentId: payment._id, status: 'ISSUED' });
      throw conflict(same ? 'Este recebimento já tem nota registrada.' : `Já existe uma nota registrada com o número ${body.number}.`);
    }
    throw err;
  }
  await audit(ctx, { organizationId: actor.organizationId, actorId: actor.userId, action: 'fiscal.note_registered', entityType: 'fiscalNote', entityId: doc._id, after: { number: doc.number, paymentId: payment._id, amountCents: doc.amountCents } });
  return doc;
}

export async function cancelFiscalNote(ctx: AppContext, actor: Actor, id: ObjectId, reason: string): Promise<FiscalNoteDoc> {
  const note = await ctx.mongo.collections.fiscalNotes.findOne({ _id: id, organizationId: actor.organizationId });
  if (!note) throw notFound('Nota não encontrada.');
  if (note.status === 'CANCELED') throw conflict('Esta nota já está cancelada.');
  const now = new Date();
  const next = await ctx.mongo.collections.fiscalNotes.findOneAndUpdate(
    { _id: id, status: 'ISSUED' },
    { $set: { status: 'CANCELED', canceledReason: reason, canceledAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  );
  if (!next) throw conflict('Esta nota já está cancelada.');
  await audit(ctx, { organizationId: actor.organizationId, actorId: actor.userId, action: 'fiscal.note_canceled', entityType: 'fiscalNote', entityId: id, before: { number: note.number }, after: { reason } });
  return next;
}

export async function listFiscalNotes(ctx: AppContext, organizationId: ObjectId, from?: string, to?: string): Promise<FiscalNote[]> {
  const c = ctx.mongo.collections;
  const range: Record<string, string> = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  const notes = await c.fiscalNotes
    .find({ organizationId, ...(from || to ? { issuedOn: range } : {}) })
    .sort({ issuedOn: -1, _id: -1 })
    .limit(500)
    .toArray();
  const payments = await c.payments.find({ organizationId, _id: { $in: notes.map((n) => n.paymentId) } }).toArray();
  const receivables = await c.receivables.find({ organizationId, _id: { $in: payments.map((p) => p.sourceId) } }).toArray();
  const drivers = await c.drivers.find({ organizationId, _id: { $in: receivables.map((r) => r.driverId) } }, { projection: { fullName: 1, anonymizedAt: 1 } }).toArray();
  const pMap = new Map(payments.map((p) => [p._id.toHexString(), p]));
  const rMap = new Map(receivables.map((r) => [r._id.toHexString(), r]));
  const dMap = new Map(drivers.map((d) => [d._id.toHexString(), d]));
  return notes.map((n) => {
    const p = pMap.get(n.paymentId.toHexString());
    const r = p ? rMap.get(p.sourceId.toHexString()) : undefined;
    const d = r ? dMap.get(r.driverId.toHexString()) : undefined;
    return {
      id: n._id.toHexString(),
      paymentId: n.paymentId.toHexString(),
      number: n.number,
      issuedOn: n.issuedOn,
      amountCents: n.amountCents,
      url: n.url,
      notes: n.notes,
      status: n.status,
      canceledReason: n.canceledReason,
      description: r ? receivableStatementDescription(r) : '—',
      driverName: d && !d.anonymizedAt ? d.fullName : null,
      createdAt: n.createdAt.toISOString(),
    };
  });
}
