import { ObjectId, type ClientSession } from 'mongodb';
import {
  addDaysIso,
  businessDate,
  formatCentsBRL,
  type DamagePrice,
  type DepositSettlementPreview,
  type InspectionDamage,
  type InspectionDamageInput,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { badRequest, conflict, notFound } from '../common/errors.js';
import { foldAccents } from '../common/helpers.js';
import { withTransaction } from '../database/mongo.js';
import type { DamagePriceDoc, InspectionDamageDoc, ReceivableDoc, RentalDoc } from '../database/types.js';
import { audit } from './common.js';
import { deriveReceivableStatus, remainingCents } from './finance.js';
import { syncFineFromReceivable } from './fine-sync.js';
import { defaultBankAccountId, postTransaction } from './ledger.js';
import { createNotification } from './notifications.js';

/* ------------------------------------------------------------------ *
 * Tabela de avarias ("Régua de Avarias" da Localiza) e fechamento da
 * caução no fim do contrato.
 * ------------------------------------------------------------------ */

/** Preços de referência iniciais (editáveis pela locadora). */
export const DEFAULT_DAMAGE_PRICES: Array<{ name: string; category: string; priceCents: number }> = [
  { name: 'Risco leve (até 10 cm)', category: 'Lataria', priceCents: 15000 },
  { name: 'Risco profundo / pintura', category: 'Lataria', priceCents: 45000 },
  { name: 'Amassado pequeno (sem pintura)', category: 'Lataria', priceCents: 25000 },
  { name: 'Amassado com pintura', category: 'Lataria', priceCents: 70000 },
  { name: 'Para-choque (reparo)', category: 'Lataria', priceCents: 55000 },
  { name: 'Retrovisor', category: 'Peças', priceCents: 38000 },
  { name: 'Farol / lanterna', category: 'Peças', priceCents: 45000 },
  { name: 'Calota', category: 'Peças', priceCents: 9000 },
  { name: 'Pneu', category: 'Rodas e pneus', priceCents: 42000 },
  { name: 'Roda (amassada/riscada)', category: 'Rodas e pneus', priceCents: 30000 },
  { name: 'Para-brisa (trinca)', category: 'Vidros', priceCents: 90000 },
  { name: 'Vidro lateral', category: 'Vidros', priceCents: 35000 },
  { name: 'Banco rasgado / queimado', category: 'Interior', priceCents: 40000 },
  { name: 'Limpeza pesada do interior', category: 'Interior', priceCents: 15000 },
  { name: 'Odor de cigarro (higienização)', category: 'Interior', priceCents: 25000 },
  { name: 'Chave / controle perdido', category: 'Acessórios', priceCents: 60000 },
  { name: 'Estepe, macaco ou triângulo ausente', category: 'Acessórios', priceCents: 30000 },
];

export async function ensureDefaultDamagePrices(ctx: AppContext, organizationId: ObjectId): Promise<void> {
  const count = await ctx.mongo.collections.damagePrices.countDocuments({ organizationId });
  if (count > 0) return;
  const now = new Date();
  try {
    await ctx.mongo.collections.damagePrices.insertMany(
      DEFAULT_DAMAGE_PRICES.map((d) => ({ _id: new ObjectId(), organizationId, ...d, active: true, createdAt: now, updatedAt: now })),
      { ordered: false },
    );
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
}

export const toDamagePriceDTO = (d: DamagePriceDoc): DamagePrice => ({
  id: d._id.toHexString(),
  name: d.name,
  category: d.category,
  priceCents: d.priceCents,
  active: d.active,
});

export async function toInspectionDamageDTO(ctx: AppContext, doc: InspectionDamageDoc): Promise<InspectionDamage> {
  const rec = doc.receivableId ? await ctx.mongo.collections.receivables.findOne({ _id: doc.receivableId }) : null;
  return {
    id: doc._id.toHexString(),
    inspectionId: doc.inspectionId.toHexString(),
    items: doc.items.map((i) => ({ name: i.name, category: i.category, quantity: i.quantity, unitPriceCents: i.unitPriceCents, totalCents: i.totalCents, note: i.note })),
    totalCents: doc.totalCents,
    receivable: rec ? { id: rec._id.toHexString(), status: rec.status, paidAmountCents: rec.paidAmountCents } : null,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Cobra as avarias apontadas na vistoria (conta a receber do tipo DAMAGE). Uma cobrança ativa por vistoria. */
export async function chargeInspectionDamages(
  ctx: AppContext,
  params: { organizationId: ObjectId; inspectionId: ObjectId; actorId: ObjectId | null; body: InspectionDamageInput },
): Promise<InspectionDamageDoc> {
  const inspection = await ctx.mongo.collections.inspections.findOne({ _id: params.inspectionId, organizationId: params.organizationId });
  if (!inspection) throw notFound('Vistoria não encontrada.');
  if (!['SUBMITTED', 'APPROVED', 'REJECTED'].includes(inspection.status)) throw conflict('Só é possível cobrar avarias de uma vistoria enviada.');
  if (!inspection.rentalId || !inspection.driverId) throw conflict('A vistoria não está ligada a uma locação e motorista.');
  const already = await ctx.mongo.collections.inspectionDamages.findOne({ organizationId: params.organizationId, inspectionId: inspection._id, status: 'CHARGED' });
  if (already) throw conflict('As avarias desta vistoria já foram cobradas. Cancele a cobrança para refazer.');

  const ids = params.body.items.map((i) => new ObjectId(i.damagePriceId));
  const prices = await ctx.mongo.collections.damagePrices.find({ organizationId: params.organizationId, _id: { $in: ids }, active: true }).toArray();
  const pMap = new Map(prices.map((p) => [p._id.toHexString(), p]));
  const items = params.body.items.map((i) => {
    const p = pMap.get(i.damagePriceId);
    if (!p) throw badRequest('Avaria não encontrada na tabela (ou inativa).');
    return { damagePriceId: p._id, name: p.name, category: p.category, quantity: i.quantity, unitPriceCents: p.priceCents, totalCents: p.priceCents * i.quantity, note: i.note ?? null };
  });
  const total = items.reduce((a, i) => a + i.totalCents, 0);
  const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: inspection.vehicleId }, { projection: { plate: 1 } });
  const today = businessDate();
  const dueDate = params.body.dueDate ?? addDaysIso(today, 7);
  if (dueDate < today) throw badRequest('O vencimento não pode estar no passado.');

  try {
    return await withTransaction(ctx, async (session) => {
      const now = new Date();
      const description = `Avarias ${vehicle?.plate ?? ''} - vistoria ${inspection.scheduledAt}`.trim();
      const receivable: ReceivableDoc = {
        _id: new ObjectId(),
        organizationId: params.organizationId,
        description,
        descriptionFold: foldAccents(description).toLowerCase(),
        rentalId: inspection.rentalId,
        driverId: inspection.driverId!,
        grossAmountCents: total,
        paidAmountCents: 0,
        dueDate,
        paymentMethod: null,
        kind: 'DAMAGE',
        installmentNo: null,
        expectedPeriod: `DAMAGE:${inspection._id.toHexString()}:${now.getTime()}`,
        status: 'OPEN',
        createdBy: params.actorId,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      receivable.status = deriveReceivableStatus(receivable, today);
      await ctx.mongo.collections.receivables.insertOne(receivable, { session });
      const doc: InspectionDamageDoc = {
        _id: new ObjectId(),
        organizationId: params.organizationId,
        inspectionId: inspection._id,
        rentalId: inspection.rentalId!,
        driverId: inspection.driverId!,
        items,
        totalCents: total,
        receivableId: receivable._id,
        status: 'CHARGED',
        createdBy: params.actorId,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.mongo.collections.inspectionDamages.insertOne(doc, { session });
      await audit(ctx, { organizationId: params.organizationId, actorId: params.actorId, action: 'inspection.damages', entityType: 'inspection', entityId: inspection._id, after: { total, items: items.length } }, session);
      return doc;
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('As avarias desta vistoria já foram cobradas.');
    throw err;
  }
}

export async function cancelInspectionDamages(ctx: AppContext, params: { organizationId: ObjectId; inspectionId: ObjectId; actorId: ObjectId | null }): Promise<void> {
  const doc = await ctx.mongo.collections.inspectionDamages.findOne({ organizationId: params.organizationId, inspectionId: params.inspectionId, status: 'CHARGED' });
  if (!doc) throw notFound('Não há cobrança de avarias ativa nesta vistoria.');
  const rec = doc.receivableId ? await ctx.mongo.collections.receivables.findOne({ _id: doc.receivableId }) : null;
  if (rec && rec.paidAmountCents > 0) throw conflict('A cobrança já tem pagamento. Estorne o pagamento em Contas a Receber antes de cancelar.');
  await withTransaction(ctx, async (session) => {
    if (rec) {
      await ctx.mongo.collections.receivables.updateOne({ _id: rec._id }, { $set: { status: 'CANCELED', updatedAt: new Date() }, $inc: { version: 1 } }, { session });
    }
    await ctx.mongo.collections.inspectionDamages.updateOne({ _id: doc._id }, { $set: { status: 'CANCELED', updatedAt: new Date() } }, { session });
    await audit(ctx, { organizationId: params.organizationId, actorId: params.actorId, action: 'inspection.damages.canceled', entityType: 'inspection', entityId: params.inspectionId }, session);
  });
}

/* --------------------------- caução --------------------------- */

async function depositHeld(ctx: AppContext, rental: RentalDoc, session?: ClientSession): Promise<number> {
  if (!rental.depositPrepaid || rental.depositCents <= 0) return 0;
  // A caução só conta se entrou de fato no extrato (lançamento da criação da locação).
  const tx = await ctx.mongo.collections.bankTransactions.findOne(
    { organizationId: rental.organizationId, originType: 'RENTAL_DEPOSIT', originId: rental._id, direction: 'IN', reversedByTransactionId: null },
    { session },
  );
  return tx ? tx.amountCents : 0;
}

export async function previewDepositSettlement(ctx: AppContext, rental: RentalDoc, session?: ClientSession): Promise<DepositSettlementPreview> {
  const settled = await ctx.mongo.collections.depositSettlements.findOne({ organizationId: rental.organizationId, rentalId: rental._id }, { session });
  const held = await depositHeld(ctx, rental, session);
  const open = await ctx.mongo.collections.receivables
    .find({ organizationId: rental.organizationId, rentalId: rental._id, status: { $nin: ['PAID', 'CANCELED'] } }, { session })
    .sort({ dueDate: 1, _id: 1 })
    .toArray();
  let left = settled ? 0 : held;
  const debts = open
    .map((r) => ({ r, remaining: remainingCents(r.grossAmountCents, r.paidAmountCents) }))
    .filter((d) => d.remaining > 0)
    .map(({ r, remaining }) => {
      const applied = Math.min(left, remaining);
      left -= applied;
      return { receivableId: r._id.toHexString(), kind: r.kind, description: r.description, dueDate: r.dueDate, remainingCents: remaining, appliedCents: applied };
    });
  const applied = debts.reduce((a, d) => a + d.appliedCents, 0);
  const totalDebt = debts.reduce((a, d) => a + d.remainingCents, 0);
  const blockedReason = settled
    ? 'A caução desta locação já foi fechada.'
    : rental.status === 'ACTIVE'
      ? 'Encerre a locação antes de fechar a caução.'
      : rental.status === 'CANCELED'
        ? 'Locação cancelada.'
        : held === 0
          ? 'Não há caução registrada no extrato para esta locação.'
          : null;
  return {
    rentalId: rental._id.toHexString(),
    depositHeldCents: held,
    debts,
    appliedCents: settled ? settled.appliedCents : applied,
    refundCents: settled ? settled.refundCents : held - applied,
    uncoveredCents: settled ? 0 : totalDebt - applied,
    settled: settled ? { at: settled.createdAt.toISOString(), appliedCents: settled.appliedCents, refundCents: settled.refundCents, notes: settled.notes } : null,
    canSettle: blockedReason === null,
    blockedReason,
  };
}

/**
 * Fecha a caução: compensa as dívidas da locação com a caução (pagamento
 * sem extrato, o dinheiro já está no caixa) e devolve o restante
 * (saída no extrato). Uma vez por locação (índice único).
 */
export async function settleDeposit(
  ctx: AppContext,
  params: { rental: RentalDoc; actorId: ObjectId | null; refundBankAccountId?: ObjectId; notes?: string | null },
): Promise<DepositSettlementPreview> {
  const today = businessDate();
  const preview = await previewDepositSettlement(ctx, params.rental);
  if (!preview.canSettle) throw conflict(preview.blockedReason ?? 'Não é possível fechar a caução.');
  const refundAccount = params.refundBankAccountId ?? (await defaultBankAccountId(ctx, params.rental.organizationId));
  if (preview.refundCents > 0 && !refundAccount) throw conflict('Cadastre uma conta bancária para registrar a devolução.');

  try {
    await withTransaction(ctx, async (session) => {
      const fresh = await previewDepositSettlement(ctx, params.rental, session);
      if (!fresh.canSettle) throw conflict(fresh.blockedReason ?? 'Não é possível fechar a caução.');
      const now = new Date();
      const applications: Array<{ receivableId: ObjectId; paymentId: ObjectId; amountCents: number }> = [];
      for (const d of fresh.debts.filter((x) => x.appliedCents > 0)) {
        const recId = new ObjectId(d.receivableId);
        const rec = (await ctx.mongo.collections.receivables.findOne({ _id: recId }, { session }))!;
        const paymentId = new ObjectId();
        await ctx.mongo.collections.payments.insertOne(
          {
            _id: paymentId,
            organizationId: rec.organizationId,
            sourceType: 'RECEIVABLE',
            sourceId: rec._id,
            amountCents: d.appliedCents,
            paidAt: today,
            method: 'OTHER',
            bankAccountId: null,
            transactionId: null,
            idempotencyKey: `deposit:${params.rental._id.toHexString()}:${rec._id.toHexString()}`,
            notes: 'Compensado com a caução',
            origin: 'DEPOSIT',
            createdBy: params.actorId,
            createdAt: now,
            updatedAt: now,
          },
          { session },
        );
        const paidAmountCents = rec.paidAmountCents + d.appliedCents;
        const status = deriveReceivableStatus({ ...rec, paidAmountCents }, today);
        const res = await ctx.mongo.collections.receivables.updateOne(
          { _id: rec._id, version: rec.version },
          { $set: { paidAmountCents, status, updatedAt: now }, $inc: { version: 1 } },
          { session },
        );
        if (res.matchedCount === 0) throw conflict('Uma conta foi alterada ao mesmo tempo. Tente novamente.');
        await syncFineFromReceivable(ctx, rec, status, params.actorId, session);
        applications.push({ receivableId: rec._id, paymentId, amountCents: d.appliedCents });
      }
      let refundTransactionId: ObjectId | null = null;
      if (fresh.refundCents > 0) {
        refundTransactionId = await postTransaction(
          ctx,
          {
            organizationId: params.rental.organizationId,
            bankAccountId: refundAccount!,
            occurredAt: today,
            description: `Devolução de caução - Contrato ${params.rental.rentalNumber}`,
            direction: 'OUT',
            amountCents: fresh.refundCents,
            originType: 'RENTAL_DEPOSIT',
            originId: params.rental._id,
            dedupeKey: `deposit-refund:${params.rental._id.toHexString()}`,
            actorId: params.actorId,
          },
          session,
        );
      }
      await ctx.mongo.collections.depositSettlements.insertOne(
        {
          _id: new ObjectId(),
          organizationId: params.rental.organizationId,
          rentalId: params.rental._id,
          driverId: params.rental.driverId,
          depositHeldCents: fresh.depositHeldCents,
          appliedCents: fresh.appliedCents,
          refundCents: fresh.refundCents,
          applications,
          refundTransactionId,
          notes: params.notes ?? null,
          createdBy: params.actorId,
          createdAt: now,
          updatedAt: now,
        },
        { session },
      );
      await audit(
        ctx,
        {
          organizationId: params.rental.organizationId,
          actorId: params.actorId,
          action: 'rental.depositSettled',
          entityType: 'rental',
          entityId: params.rental._id,
          after: { held: fresh.depositHeldCents, applied: fresh.appliedCents, refund: fresh.refundCents },
        },
        session,
      );
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw conflict('A caução desta locação já foi fechada.');
    throw err;
  }
  const after = await previewDepositSettlement(ctx, params.rental);
  await createNotification(ctx, {
    organizationId: params.rental.organizationId,
    type: 'RENTAL',
    severity: 'INFO',
    title: 'Caução fechada',
    message: `${params.rental.rentalNumber}: ${formatCentsBRL(after.appliedCents)} compensados, ${formatCentsBRL(after.refundCents)} a devolver ao motorista.`,
    subjectLabel: params.rental.rentalNumber,
    entityType: 'rental',
    entityId: params.rental._id,
    targetPath: `/dashboard/rentals/${params.rental._id.toHexString()}?tab=deposit`,
    dedupeKey: `deposit-settled:${params.rental._id.toHexString()}`,
  });
  return after;
}
