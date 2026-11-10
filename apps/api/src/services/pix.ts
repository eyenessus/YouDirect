import { ObjectId } from 'mongodb';
import { businessDate, formatCentsBRL, type PixCharge } from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { conflict, integrationUnavailable, notFound, unprocessable } from '../common/errors.js';
import type { PixChargeDoc, ReceivableDoc } from '../database/types.js';
import { audit } from './common.js';
import { registerReceivablePayment, remainingCents } from './finance.js';
import { defaultBankAccountId } from './ledger.js';
import { createNotification } from './notifications.js';
import { nextRentalReceipt } from './rental-payments.js';

/* ------------------------------------------------------------------ *
 * Cobrança Pix com baixa automática.
 * - Uma cobrança PENDENTE por fatura e valor (reaproveitada).
 * - A baixa só acontece depois de consultar o provedor (status
 *   "approved"), com chave de idempotência pelo id do pagamento: webhook
 *   repetido, webhook + conciliação ou dois webhooks juntos dão uma baixa.
 * ------------------------------------------------------------------ */

export function toPixDTO(doc: PixChargeDoc): PixCharge {
  return {
    id: doc._id.toHexString(),
    receivableId: doc.receivableId.toHexString(),
    description: doc.description,
    amountCents: doc.amountCents,
    status: doc.status,
    qrCode: doc.status === 'PENDING' ? doc.qrCode : null,
    qrCodeBase64: doc.status === 'PENDING' ? doc.qrCodeBase64 : null,
    ticketUrl: doc.status === 'PENDING' ? doc.ticketUrl : null,
    expiresAt: doc.expiresAt.toISOString(),
    paidAt: doc.paidAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
  };
}

export interface CreatePixInput {
  organizationId: ObjectId;
  receivable: ReceivableDoc;
  amountCents: number;
  description: string;
  scopeKey: string;
  actorId: ObjectId | null;
}

export async function createPixCharge(ctx: AppContext, input: CreatePixInput): Promise<PixChargeDoc> {
  const provider = ctx.integrations.pix;
  if (!provider.status().connected) throw integrationUnavailable(provider.status().message);
  if (input.receivable.status === 'CANCELED') throw conflict('Conta cancelada.');
  const remaining = remainingCents(input.receivable.grossAmountCents, input.receivable.paidAmountCents);
  if (remaining === 0) throw conflict('Esta fatura já está paga.');
  if (input.amountCents <= 0) throw unprocessable('Valor inválido para cobrança.');
  if (input.amountCents > remaining) throw unprocessable('O valor do Pix não pode ser maior que o saldo da conta.', { remainingCents: remaining });

  const now = new Date();
  // Reaproveita a cobrança pendente da mesma fatura e valor (clique repetido, recarga da página).
  const existing = await ctx.mongo.collections.pixCharges.findOne({
    organizationId: input.organizationId,
    scopeKey: input.scopeKey,
    amountCents: input.amountCents,
    status: 'PENDING',
    expiresAt: { $gt: new Date(now.getTime() + 10 * 60 * 1000) },
  });
  if (existing) return existing;

  const driver = await ctx.mongo.collections.drivers.findOne({ _id: input.receivable.driverId, organizationId: input.organizationId });
  if (!driver) throw notFound('Motorista não encontrado.');
  const org = await ctx.mongo.collections.organizations.findOne({ _id: input.organizationId });
  const names = driver.fullName.trim().split(/\s+/);
  const appHost = new URL(ctx.env.APP_URL).hostname;
  const email = driver.emailLower ?? ctx.env.PIX_PAYER_FALLBACK_EMAIL ?? `cobranca@${appHost.includes('.') ? appHost : 'yudirect.app'}`;
  const chargeId = new ObjectId();
  const expiresAt = new Date(now.getTime() + ctx.env.PIX_EXPIRATION_MINUTES * 60 * 1000);
  const notificationUrl = ctx.env.API_PUBLIC_URL.startsWith('https://')
    ? `${ctx.env.API_PUBLIC_URL.replace(/\/$/, '')}/api/v1/webhooks/mercadopago`
    : null;

  let created;
  try {
    created = await provider.create({
      amountCents: input.amountCents,
      description: `${org?.name ?? 'Locadora'} - ${input.description}`,
      externalReference: chargeId.toHexString(),
      idempotencyKey: `pix:${chargeId.toHexString()}`,
      expiresAt,
      notificationUrl,
      payer: {
        email,
        firstName: names[0] ?? 'Motorista',
        lastName: names.slice(1).join(' ') || '-',
        cpf: ctx.pii.decrypt(driver.cpfEncrypted),
      },
    });
  } catch (err) {
    throw integrationUnavailable((err as Error).message);
  }

  const doc: PixChargeDoc = {
    _id: chargeId,
    organizationId: input.organizationId,
    receivableId: input.receivable._id,
    driverId: input.receivable.driverId,
    rentalId: input.receivable.rentalId,
    scopeKey: input.scopeKey,
    description: input.description,
    amountCents: input.amountCents,
    provider: 'MERCADOPAGO',
    providerPaymentId: created.providerPaymentId,
    qrCode: created.qrCode,
    qrCodeBase64: created.qrCodeBase64,
    ticketUrl: created.ticketUrl,
    status: 'PENDING',
    expiresAt,
    paidAt: null,
    paymentId: null,
    excessCents: 0,
    createdBy: input.actorId,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.mongo.collections.pixCharges.insertOne(doc);
  await audit(ctx, {
    organizationId: input.organizationId,
    actorId: input.actorId,
    action: 'pix.created',
    entityType: 'receivable',
    entityId: input.receivable._id,
    after: { chargeId, amountCents: input.amountCents, scopeKey: input.scopeKey },
  });
  return doc;
}

/** Lançamento PAGO na aba Pagamentos da locação (recibo INV), para aluguel e km excedente. */
async function recordRentalEntry(ctx: AppContext, receivable: ReceivableDoc, paymentId: ObjectId, amountCents: number, paidAt: string) {
  if (!receivable.rentalId || (receivable.kind !== 'RENT' && receivable.kind !== 'OTHER')) return;
  const c = ctx.mongo.collections;
  if (await c.rentalPayments.findOne({ organizationId: receivable.organizationId, paymentId })) return;
  const { number, sequence } = await nextRentalReceipt(ctx, receivable.organizationId, Number(paidAt.slice(0, 4)));
  const now = new Date();
  await c.rentalPayments.insertOne({
    _id: new ObjectId(),
    organizationId: receivable.organizationId,
    rentalId: receivable.rentalId,
    driverId: receivable.driverId,
    receiptNumber: number,
    sequence,
    category: receivable.kind === 'OTHER' ? 'EXTRA_KM' : 'RENT',
    amountCents,
    expectedDate: paidAt,
    notes: 'Pago por Pix (baixa automática)',
    status: 'PAID',
    paidAt,
    method: 'PIX',
    receivableId: receivable._id,
    paymentId,
    deletedAt: null,
    idempotencyKey: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Confirma um pagamento Pix consultando o provedor. Seguro para chamar
 * quantas vezes for preciso (webhook, conciliação, botão "Verificar").
 */
export async function confirmPixPayment(
  ctx: AppContext,
  providerPaymentId: string,
): Promise<{ result: 'PAID' | 'ALREADY_PAID' | 'PENDING' | 'EXPIRED' | 'UNKNOWN' }> {
  const charge = await ctx.mongo.collections.pixCharges.findOne({ provider: 'MERCADOPAGO', providerPaymentId });
  if (!charge) return { result: 'UNKNOWN' };
  if (charge.status === 'PAID') return { result: 'ALREADY_PAID' };

  const info = await ctx.integrations.pix.get(providerPaymentId);
  if (info.externalReference && info.externalReference !== charge._id.toHexString()) return { result: 'UNKNOWN' };

  if (info.status === 'cancelled' || info.status === 'rejected' || info.status === 'expired') {
    await ctx.mongo.collections.pixCharges.updateOne(
      { _id: charge._id, status: 'PENDING' },
      { $set: { status: info.status === 'rejected' ? 'FAILED' : 'EXPIRED', updatedAt: new Date() } },
    );
    return { result: 'EXPIRED' };
  }
  if (info.status !== 'approved') return { result: 'PENDING' };

  const receivable = await ctx.mongo.collections.receivables.findOne({ _id: charge.receivableId, organizationId: charge.organizationId });
  if (!receivable) return { result: 'UNKNOWN' };
  const paidAt = businessDate(info.paidAt ?? new Date());
  const paidCents = Math.min(info.amountCents, charge.amountCents);
  const remaining = receivable.status === 'CANCELED' ? 0 : remainingCents(receivable.grossAmountCents, receivable.paidAmountCents);
  const apply = Math.min(paidCents, remaining);
  let paymentId: ObjectId | null = null;

  if (apply > 0) {
    const bankAccountId = await defaultBankAccountId(ctx, charge.organizationId);
    if (!bankAccountId) throw conflict('Sem conta bancária padrão para registrar o Pix.');
    const res = await registerReceivablePayment(ctx, {
      organizationId: charge.organizationId,
      actorId: null,
      sourceId: receivable._id,
      amountCents: apply,
      paidAt: paidAt > businessDate() ? businessDate() : paidAt,
      method: 'PIX',
      bankAccountId,
      notes: `Pix ${providerPaymentId} (baixa automática)`,
      idempotencyKey: `pix:${providerPaymentId}`,
      origin: 'PIX',
    });
    paymentId = res.paymentId;
    if (!res.alreadyProcessed) await recordRentalEntry(ctx, receivable, res.paymentId, apply, paidAt);
  }

  const excess = paidCents - apply;
  const updated = await ctx.mongo.collections.pixCharges.updateOne(
    { _id: charge._id, status: { $ne: 'PAID' } },
    { $set: { status: 'PAID', paidAt: info.paidAt ?? new Date(), paymentId, excessCents: excess, updatedAt: new Date() } },
  );
  if (updated.modifiedCount === 0) return { result: 'ALREADY_PAID' };

  const driver = await ctx.mongo.collections.drivers.findOne({ _id: charge.driverId }, { projection: { fullName: 1 } });
  await createNotification(ctx, {
    organizationId: charge.organizationId,
    type: 'RENTAL',
    severity: excess > 0 ? 'WARNING' : 'INFO',
    title: excess > 0 ? 'Pix recebido acima do saldo' : 'Pix recebido',
    message:
      excess > 0
        ? `${driver?.fullName ?? 'Motorista'} pagou ${formatCentsBRL(paidCents)} por Pix, mas a fatura já estava quitada em parte: ${formatCentsBRL(excess)} ficou como crédito a devolver ou compensar.`
        : `${driver?.fullName ?? 'Motorista'} pagou ${formatCentsBRL(paidCents)} por Pix (${charge.description}). Baixa automática feita.`,
    subjectLabel: driver?.fullName ?? null,
    entityType: 'receivable',
    entityId: receivable._id,
    targetPath: '/dashboard/finance/accounts-receivable',
    dedupeKey: `pix-paid:${charge._id.toHexString()}`,
  });
  await audit(ctx, {
    organizationId: charge.organizationId,
    actorId: null,
    action: 'pix.paid',
    entityType: 'receivable',
    entityId: receivable._id,
    after: { chargeId: charge._id, providerPaymentId, paidCents, excess },
  });
  return { result: 'PAID' };
}

/** Conciliação (job): consulta pendentes (webhook perdido) e expira as vencidas. */
export async function reconcilePixCharges(ctx: AppContext, organizationId: ObjectId, now = new Date()): Promise<{ paid: number; expired: number }> {
  if (!ctx.integrations.pix.status().connected) return { paid: 0, expired: 0 };
  const pending = await ctx.mongo.collections.pixCharges
    .find({ organizationId, status: 'PENDING', createdAt: { $lt: new Date(now.getTime() - 60 * 1000) } })
    .limit(200)
    .toArray();
  let paid = 0;
  let expired = 0;
  for (const charge of pending) {
    try {
      const r = await confirmPixPayment(ctx, charge.providerPaymentId);
      if (r.result === 'PAID') paid += 1;
      else if (r.result === 'EXPIRED') expired += 1;
      else if (r.result === 'PENDING' && charge.expiresAt.getTime() < now.getTime() - 60 * 60 * 1000) {
        await ctx.mongo.collections.pixCharges.updateOne({ _id: charge._id, status: 'PENDING' }, { $set: { status: 'EXPIRED', updatedAt: now } });
        await ctx.integrations.pix.cancel(charge.providerPaymentId);
        expired += 1;
      }
    } catch {
      /* provedor fora do ar: tenta de novo na próxima rodada */
    }
  }
  return { paid, expired };
}

