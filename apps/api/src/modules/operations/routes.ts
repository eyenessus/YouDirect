import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import {
  damagePriceInputSchema,
  depositSettlementInputSchema,
  inspectionDamageInputSchema,
  loyaltySettingsSchema,
  rentalKmPolicySchema,
} from '@yudirect/contracts';
import { conflict, forbidden, integrationUnavailable, notFound } from '../../common/errors.js';
import { toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { requireDriverContext } from '../../plugins/driver-auth.js';
import { audit } from '../../services/common.js';
import {
  cancelSignature,
  contractData,
  requestSignature,
  syncSignature,
  toSignatureDTO,
} from '../../services/contract-signature.js';
import {
  cancelInspectionDamages,
  chargeInspectionDamages,
  ensureDefaultDamagePrices,
  previewDepositSettlement,
  settleDeposit,
  toDamagePriceDTO,
  toInspectionDamageDTO,
} from '../../services/damages.js';
import { kmSummary } from '../../services/km-billing.js';
import { driverRanking, loyaltySettingsOf, loyaltyStatus } from '../../services/loyalty.js';
import { renderRentalContract } from '../../pdf/rental-contract.js';
import type { AppContext } from '../../context.js';
import { ObjectId as ObjectIdCtor, type ObjectId } from 'mongodb';

async function rentalOf(ctx: AppContext, organizationId: ObjectId, request: FastifyRequest) {
  const rental = await ctx.mongo.collections.rentals.findOne({ _id: toObjectId((request.params as { id: string }).id), organizationId });
  if (!rental) throw notFound('Locação não encontrada.');
  return rental;
}

export async function registerOperationsRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ KM ------------------------------ */
  app.put('/rentals/:id/km-policy', { onRequest: [app.requireAuth, app.requirePermission('rentals', 'update')] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const rental = await rentalOf(ctx, auth.organizationId, request);
    const policy = rentalKmPolicySchema.parse(request.body);
    await ctx.mongo.collections.rentals.updateOne({ _id: rental._id }, { $set: { kmPolicy: policy, updatedAt: new Date() }, $inc: { version: 1 } });
    await audit(ctx, { organizationId: auth.organizationId, actorId: auth.userId, action: 'rental.kmPolicy', entityType: 'rental', entityId: rental._id, after: policy });
    return kmSummary({ ...rental, kmPolicy: policy });
  });

  app.get('/rentals/:id/km-summary', { onRequest: [app.requireAuth, app.requirePermission('rentals', 'read')] }, async (request) => {
    const auth = requireAuthContext(request);
    return kmSummary(await rentalOf(request.appCtx, auth.organizationId, request));
  });

  /* ---------------------------- Avarias ---------------------------- */
  app.get('/damage-prices', { onRequest: [app.requireAuth, app.requirePermission('inspections', 'read')] }, async (request) => {
    const ctx = request.appCtx;
    const { organizationId } = requireAuthContext(request);
    await ensureDefaultDamagePrices(ctx, organizationId);
    const docs = await ctx.mongo.collections.damagePrices.find({ organizationId }).sort({ category: 1, name: 1 }).toArray();
    return { data: docs.map(toDamagePriceDTO) };
  });

  app.post('/damage-prices', { onRequest: [app.requireAuth, app.requirePermission('inspections', 'update')] }, async (request, reply) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const body = damagePriceInputSchema.parse(request.body);
    const now = new Date();
    try {
      const doc = { _id: new ObjectIdCtor(), organizationId: auth.organizationId, ...body, createdAt: now, updatedAt: now };
      await ctx.mongo.collections.damagePrices.insertOne(doc);
      reply.status(201);
      return toDamagePriceDTO(doc);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw conflict('Já existe uma avaria com este nome nesta categoria.');
      throw err;
    }
  });

  app.patch('/damage-prices/:id', { onRequest: [app.requireAuth, app.requirePermission('inspections', 'update')] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const body = damagePriceInputSchema.partial().parse(request.body);
    const updated = await ctx.mongo.collections.damagePrices.findOneAndUpdate(
      { _id: toObjectId((request.params as { id: string }).id), organizationId: auth.organizationId },
      { $set: { ...body, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    if (!updated) throw notFound('Avaria não encontrada.');
    return toDamagePriceDTO(updated);
  });

  app.get('/inspections/:id/damages', { onRequest: [app.requireAuth, app.requirePermission('inspections', 'read')] }, async (request) => {
    const ctx = request.appCtx;
    const { organizationId } = requireAuthContext(request);
    const docs = await ctx.mongo.collections.inspectionDamages
      .find({ organizationId, inspectionId: toObjectId((request.params as { id: string }).id) })
      .sort({ createdAt: -1 })
      .toArray();
    return { data: await Promise.all(docs.map((d) => toInspectionDamageDTO(ctx, d))) };
  });

  app.post('/inspections/:id/damages', { onRequest: [app.requireAuth, app.requirePermission('inspections', 'review')] }, async (request, reply) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const body = inspectionDamageInputSchema.parse(request.body);
    const doc = await chargeInspectionDamages(ctx, {
      organizationId: auth.organizationId,
      inspectionId: toObjectId((request.params as { id: string }).id),
      actorId: auth.userId,
      body,
    });
    reply.status(201);
    return toInspectionDamageDTO(ctx, doc);
  });

  app.delete('/inspections/:id/damages', { onRequest: [app.requireAuth, app.requirePermission('inspections', 'review')] }, async (request) => {
    const auth = requireAuthContext(request);
    await cancelInspectionDamages(request.appCtx, {
      organizationId: auth.organizationId,
      inspectionId: toObjectId((request.params as { id: string }).id),
      actorId: auth.userId,
    });
    return { ok: true };
  });

  /* ----------------------------- Caução ----------------------------- */
  app.get('/rentals/:id/deposit-settlement', { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] }, async (request) => {
    const auth = requireAuthContext(request);
    return previewDepositSettlement(request.appCtx, await rentalOf(request.appCtx, auth.organizationId, request));
  });

  app.post('/rentals/:id/deposit-settlement', { onRequest: [app.requireAuth, app.requirePermission('finance', 'pay')] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const body = depositSettlementInputSchema.parse(request.body ?? {});
    const rental = await rentalOf(ctx, auth.organizationId, request);
    let refundBankAccountId: ObjectId | undefined;
    if (body.refundBankAccountId) {
      const acc = await ctx.mongo.collections.bankAccounts.findOne({ _id: toObjectId(body.refundBankAccountId), organizationId: auth.organizationId });
      if (!acc) throw notFound('Conta bancária não encontrada.');
      refundBankAccountId = acc._id;
    }
    return settleDeposit(ctx, { rental, actorId: auth.userId, refundBankAccountId, notes: body.notes ?? null });
  });

  /* --------------------------- Fidelidade --------------------------- */
  app.get('/loyalty/settings', { onRequest: [app.requireAuth] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const org = await request.appCtx.mongo.collections.organizations.findOne({ _id: organizationId });
    return loyaltySettingsOf(org?.settings);
  });

  app.put('/loyalty/settings', { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const settings = loyaltySettingsSchema.parse(request.body);
    const codes = new Set(settings.levels.map((l) => l.code));
    if (codes.size !== settings.levels.length) throw conflict('Os códigos dos níveis precisam ser únicos.');
    await ctx.mongo.collections.organizations.updateOne({ _id: auth.organizationId }, { $set: { 'settings.loyalty': settings, updatedAt: new Date() } });
    await audit(ctx, { organizationId: auth.organizationId, actorId: auth.userId, action: 'loyalty.settings', entityType: 'organization', entityId: auth.organizationId, after: settings });
    return settings;
  });

  app.get('/drivers/ranking', { onRequest: [app.requireAuth, app.requirePermission('drivers', 'read')] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    return { data: await driverRanking(request.appCtx, organizationId) };
  });

  app.get('/drivers/:id/loyalty', { onRequest: [app.requireAuth, app.requirePermission('drivers', 'read')] }, async (request) => {
    const ctx = request.appCtx;
    const { organizationId } = requireAuthContext(request);
    const driverId = toObjectId((request.params as { id: string }).id);
    const driver = await ctx.mongo.collections.drivers.findOne({ _id: driverId, organizationId });
    if (!driver) throw notFound('Motorista não encontrado.');
    return loyaltyStatus(ctx, organizationId, driverId);
  });

  /* ---------------------- Contrato e assinatura ---------------------- */
  app.get('/rentals/:id/contract.pdf', { onRequest: [app.requireAuth, app.requirePermission('rentals', 'read')] }, async (request, reply) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const rental = await rentalOf(ctx, auth.organizationId, request);
    const pdf = await renderRentalContract(await contractData(ctx, rental));
    reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="contrato-${rental.rentalNumber.toLowerCase()}.pdf"`)
      .header('cache-control', 'no-store');
    return reply.send(pdf);
  });

  app.get('/rentals/:id/signature', { onRequest: [app.requireAuth, app.requirePermission('rentals', 'read')] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const rental = await rentalOf(ctx, auth.organizationId, request);
    const doc = await ctx.mongo.collections.contractSignatures.findOne({ organizationId: auth.organizationId, rentalId: rental._id }, { sort: { createdAt: -1 } });
    return { signature: doc ? await toSignatureDTO(ctx, doc) : null, provider: ctx.integrations.signature.status() };
  });

  app.post(
    '/rentals/:id/signature',
    { onRequest: [app.requireAuth, app.requirePermission('rentals', 'update')], config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const rental = await rentalOf(ctx, auth.organizationId, request);
      const doc = await requestSignature(ctx, rental, auth.userId);
      reply.status(201);
      return toSignatureDTO(ctx, doc);
    },
  );

  app.post('/rentals/:id/signature/sync', { onRequest: [app.requireAuth, app.requirePermission('rentals', 'read')] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const rental = await rentalOf(ctx, auth.organizationId, request);
    const doc = await ctx.mongo.collections.contractSignatures.findOne({ organizationId: auth.organizationId, rentalId: rental._id, status: 'SENT' });
    if (!doc) throw notFound('Não há assinatura pendente.');
    if (!ctx.integrations.signature.status().connected) throw integrationUnavailable(ctx.integrations.signature.status().message);
    return toSignatureDTO(ctx, await syncSignature(ctx, doc));
  });

  app.delete('/rentals/:id/signature', { onRequest: [app.requireAuth, app.requirePermission('rentals', 'update')] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    await cancelSignature(ctx, await rentalOf(ctx, auth.organizationId, request), auth.userId);
    return { ok: true };
  });

  /** Webhook da ZapSign: autenticado por cabeçalho; o estado é sempre reconsultado na API. */
  app.post('/webhooks/zapsign', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const ctx = request.appCtx;
    const secret = ctx.env.ZAPSIGN_WEBHOOK_SECRET;
    if (!secret) throw integrationUnavailable('Webhook da ZapSign sem segredo configurado (ZAPSIGN_WEBHOOK_SECRET).');
    const got = String(request.headers.authorization ?? '');
    const expected = `Bearer ${secret}`;
    const ok = got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    if (!ok) throw forbidden('Webhook não autorizado.');
    const body = (request.body ?? {}) as { token?: string };
    if (!body.token) return { ok: true };
    const doc = await ctx.mongo.collections.contractSignatures.findOne({ provider: 'ZAPSIGN', providerDocToken: body.token });
    if (!doc) return { ok: true, unknown: true };
    const next = await syncSignature(ctx, doc);
    return { ok: true, status: next.status };
  });

  /* ------------------------ Área do Motorista ------------------------ */
  app.get('/driver/loyalty', { onRequest: [app.requireDriver] }, async (request) => {
    const auth = requireDriverContext(request);
    return loyaltyStatus(request.appCtx, auth.organizationId, auth.driverId);
  });

  app.get('/driver/km', { onRequest: [app.requireDriver] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireDriverContext(request);
    const rental = await ctx.mongo.collections.rentals.findOne({ organizationId: auth.organizationId, driverId: auth.driverId, status: 'ACTIVE' }, { sort: { startDate: -1 } });
    return { rentalId: rental?._id.toHexString() ?? null, summary: rental ? kmSummary(rental) : null };
  });

  app.get('/driver/contracts', { onRequest: [app.requireDriver] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireDriverContext(request);
    const docs = await ctx.mongo.collections.contractSignatures
      .find({ organizationId: auth.organizationId, driverId: auth.driverId, status: { $in: ['SENT', 'SIGNED'] } })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();
    return { data: await Promise.all(docs.map((d) => toSignatureDTO(ctx, d))) };
  });
}
