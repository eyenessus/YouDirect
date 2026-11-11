import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  billingSettingsSchema,
  defaultBillingSettings,
  portalPixRequestSchema,
  staffPixRequestSchema,
} from '@yudirect/contracts';
import { forbidden, integrationUnavailable, notFound } from '../../common/errors.js';
import { toObjectId } from '../../common/helpers.js';
import { verifyMercadoPagoSignature } from '../../integrations/mercadopago.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { requireDriverContext } from '../../plugins/driver-auth.js';
import { audit } from '../../services/common.js';
import { portalInvoices } from '../../services/driver-portal.js';
import { remainingCents } from '../../services/finance.js';
import { confirmPixPayment, createPixCharge, toPixDTO } from '../../services/pix.js';

export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  /* ----------------------- webhook do Mercado Pago ----------------------- */
  app.post(
    '/webhooks/mercadopago',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const ctx = request.appCtx;
      const secret = ctx.env.MERCADOPAGO_WEBHOOK_SECRET;
      if (!secret) throw integrationUnavailable('Webhook do Mercado Pago sem assinatura configurada (MERCADOPAGO_WEBHOOK_SECRET).');
      const query = request.query as Record<string, string | undefined>;
      const body = (request.body ?? {}) as { type?: string; action?: string; data?: { id?: string | number } };
      const dataId = query['data.id'] ?? (body.data?.id !== undefined ? String(body.data.id) : undefined);
      const valid = verifyMercadoPagoSignature({
        secret,
        signatureHeader: request.headers['x-signature'] as string | undefined,
        requestId: request.headers['x-request-id'] as string | undefined,
        dataId,
      });
      if (!valid) throw forbidden('Assinatura do webhook inválida.');
      const type = query.type ?? body.type;
      if (type && type !== 'payment') return reply.status(200).send({ ok: true, ignored: type });
      if (!dataId) return reply.status(200).send({ ok: true });
      // Erro ao consultar o provedor => 500: o Mercado Pago tenta de novo.
      const result = await confirmPixPayment(ctx, dataId);
      return { ok: true, result: result.result };
    },
  );

  /* -------------------------- equipe: Pix da conta -------------------------- */
  app.post(
    '/receivables/:id/pix',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'pay')], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = staffPixRequestSchema.parse(request.body ?? {});
      const receivable = await ctx.mongo.collections.receivables.findOne({
        _id: toObjectId((request.params as { id: string }).id),
        organizationId: auth.organizationId,
      });
      if (!receivable) throw notFound('Conta a receber não encontrada.');
      const amount = body.amountCents ?? remainingCents(receivable.grossAmountCents, receivable.paidAmountCents);
      const charge = await createPixCharge(ctx, {
        organizationId: auth.organizationId,
        receivable,
        amountCents: amount,
        description: receivable.description,
        scopeKey: `rec:${receivable._id.toHexString()}`,
        actorId: auth.userId,
      });
      reply.status(201);
      return toPixDTO(charge);
    },
  );

  app.get(
    '/receivables/:id/pix',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const docs = await ctx.mongo.collections.pixCharges
        .find({ organizationId: auth.organizationId, receivableId: toObjectId((request.params as { id: string }).id) })
        .sort({ createdAt: -1 })
        .limit(20)
        .toArray();
      return { data: docs.map(toPixDTO) };
    },
  );

  /* ------------------------ motorista: pagar com Pix ------------------------ */
  app.post(
    '/driver/invoices/pix',
    { onRequest: [app.requireDriver], config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireDriverContext(request);
      const { key } = portalPixRequestSchema.parse(request.body);
      const { invoices } = await portalInvoices(ctx, auth);
      const invoice = invoices.find((i) => i.key === key);
      if (!invoice || invoice.status === 'PAID') throw notFound('Fatura não encontrada ou já paga.');
      const receivableId = new ObjectId(key.split(':')[0]!);
      const receivable = await ctx.mongo.collections.receivables.findOne({
        _id: receivableId,
        organizationId: auth.organizationId,
        driverId: auth.driverId,
      });
      if (!receivable) throw notFound('Fatura não encontrada.');
      const charge = await createPixCharge(ctx, {
        organizationId: auth.organizationId,
        receivable,
        amountCents: invoice.remainingCents,
        description: `${invoice.description}${invoice.rentalNumber ? ` (${invoice.rentalNumber})` : ''}`,
        scopeKey: key,
        actorId: null,
      });
      reply.status(201);
      return toPixDTO(charge);
    },
  );

  app.get(
    '/driver/pix/:id',
    { onRequest: [app.requireDriver], config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireDriverContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      let charge = await ctx.mongo.collections.pixCharges.findOne({ _id: id, organizationId: auth.organizationId, driverId: auth.driverId });
      if (!charge) throw notFound('Cobrança não encontrada.');
      // Sem webhook alcançável (ex.: ambiente local), o próprio acompanhamento confirma no provedor.
      if (charge.status === 'PENDING' && Date.now() - charge.createdAt.getTime() > 15_000) {
        await confirmPixPayment(ctx, charge.providerPaymentId).catch(() => undefined);
        charge = (await ctx.mongo.collections.pixCharges.findOne({ _id: id }))!;
      }
      return toPixDTO(charge);
    },
  );

  /* --------------------------- régua de cobrança --------------------------- */
  app.get('/billing/settings', { onRequest: [app.requireAuth] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const org = await request.appCtx.mongo.collections.organizations.findOne({ _id: organizationId });
    return {
      settings: { ...defaultBillingSettings, ...(org?.settings.billing ?? {}) },
      pix: request.appCtx.integrations.pix.status(),
      whatsapp: request.appCtx.integrations.whatsapp.status(),
    };
  });

  /** Últimos lembretes enviados pela régua (para a equipe conferir o que foi mandado). */
  app.get('/billing/reminders', { onRequest: [app.requireAuth] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const rows = await request.appCtx.mongo.collections.billingReminders
      .find({ organizationId })
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray();
    const drivers = await request.appCtx.mongo.collections.drivers
      .find({ organizationId, _id: { $in: rows.map((r) => r.driverId) } }, { projection: { fullName: 1 } })
      .toArray();
    const names = new Map(drivers.map((d) => [d._id.toHexString(), d.fullName]));
    return {
      data: rows.map((r) => ({
        id: r._id.toHexString(),
        driverName: names.get(r.driverId.toHexString()) ?? 'Motorista',
        bucket: r.bucket,
        dueDate: r.dueDate,
        status: r.status,
        error: r.status === 'FAILED' ? r.error : null,
        attempts: r.attempts ?? 1,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.put('/billing/settings', { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const settings = billingSettingsSchema.parse(request.body);
    await ctx.mongo.collections.organizations.updateOne(
      { _id: auth.organizationId },
      { $set: { 'settings.billing': settings, updatedAt: new Date() } },
    );
    await audit(ctx, {
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: 'billing.settings',
      entityType: 'organization',
      entityId: auth.organizationId,
      after: settings,
    });
    return { settings };
  });
}
