import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  formatShortDateBR,
  invitationCreateSchema,
  membershipPermissionsUpdateSchema,
  type EmployeesOverview,
  type Invitation,
  type Membership,
  type SubscriptionOverview,
} from '@yudirect/contracts';
import { conflict, integrationUnavailable, notFound } from '../../common/errors.js';
import { generateToken, sha256, toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';
import type { AppContext } from '../../context.js';
import type { InvitationDoc, MembershipDoc } from '../../database/types.js';

const INVITE_TTL_DAYS = 7;

async function toMembershipDTOs(
  ctx: AppContext,
  docs: MembershipDoc[],
): Promise<Membership[]> {
  const users = await ctx.mongo.collections.users
    .find({ _id: { $in: docs.map((d) => d.userId) } })
    .toArray();
  const uMap = new Map(users.map((u) => [u._id.toHexString(), u]));
  return docs.map((doc) => {
    const user = uMap.get(doc.userId.toHexString());
    return {
      id: doc._id.toHexString(),
      user: {
        id: doc.userId.toHexString(),
        name: user?.name ?? '—',
        email: user?.emailLower ?? '—',
        phone: user?.phone ?? null,
      },
      role: doc.role,
      permissions: doc.permissions ?? {},
      status: doc.status,
      createdAt: doc.createdAt.toISOString(),
    };
  });
}

function toInvitationDTO(doc: InvitationDoc, appUrl: string, token?: string): Invitation {
  return {
    id: doc._id.toHexString(),
    name: doc.name,
    email: doc.emailLower,
    phone: doc.phone,
    permissions: doc.permissions ?? {},
    status: doc.status,
    expiresAt: doc.expiresAt.toISOString(),
    createdAt: doc.createdAt.toISOString(),
    acceptUrl: token ? `${appUrl.replace(/\/$/, '')}/convite/${token}` : null,
    delivery: doc.delivery,
  };
}

export async function registerOrganizationRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------- colaboradores ------------------------ */
  app.get('/employees', { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] }, async (request) => {
    const ctx = request.appCtx;
    const { organizationId } = requireAuthContext(request);
    const [organization, memberships, invitations] = await Promise.all([
      ctx.mongo.collections.organizations.findOne({ _id: organizationId }),
      ctx.mongo.collections.memberships.find({ organizationId }).sort({ createdAt: 1 }).toArray(),
      ctx.mongo.collections.invitations
        .find({ organizationId, status: { $in: ['PENDING', 'EXPIRED'] } })
        .sort({ createdAt: -1 })
        .toArray(),
    ]);

    const payload: EmployeesOverview = {
      freeSeats: organization?.settings?.freeSeats ?? 3,
      extraSeatPriceCents: organization?.settings?.extraSeatPriceCents ?? 990,
      usedSeats: memberships.filter((m) => m.role === 'MEMBER' && m.status === 'ACTIVE').length,
      memberships: await toMembershipDTOs(ctx, memberships.filter((m) => m.role !== 'OWNER')),
      invitations: invitations.map((i) => toInvitationDTO(i, ctx.env.APP_URL)),
    };
    return payload;
  });

  app.post(
    '/invitations',
    {
      onRequest: [app.requireAuth, app.requireOwnerOrAdmin],
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = invitationCreateSchema.parse(request.body);

      const existingUser = await ctx.mongo.collections.users.findOne({ emailLower: body.email });
      if (existingUser) {
        const membership = await ctx.mongo.collections.memberships.findOne({
          organizationId: auth.organizationId,
          userId: existingUser._id,
        });
        if (membership) throw conflict('Este e-mail já é colaborador desta organização.');
      }

      const token = generateToken(24);
      const now = new Date();
      const doc: InvitationDoc = {
        _id: new ObjectId(),
        organizationId: auth.organizationId,
        name: body.name,
        emailLower: body.email,
        phone: body.phone ?? null,
        permissions: body.permissions,
        tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 3600 * 1000),
        status: 'PENDING',
        invitedBy: auth.userId,
        acceptedAt: null,
        delivery: null,
        createdAt: now,
        updatedAt: now,
      };

      const organization = await ctx.mongo.collections.organizations.findOne({
        _id: auth.organizationId,
      });
      const acceptUrl = `${ctx.env.APP_URL.replace(/\/$/, '')}/convite/${token}`;
      const mailStatus = ctx.integrations.email.status();
      if (mailStatus.connected) {
        const result = await ctx.integrations.email.send(
          body.email,
          `Convite para ${organization?.name ?? 'YuDirect'}`,
          `Olá, ${body.name}! Você foi convidado(a) para acessar o YuDirect da ${
            organization?.name ?? ''
          }. Acesse: ${acceptUrl} (válido por ${INVITE_TTL_DAYS} dias).`,
        );
        doc.delivery = {
          channel: 'EMAIL',
          status: result.delivered ? 'SENT' : 'FAILED',
          message: result.error,
        };
      } else {
        doc.delivery = { channel: 'MANUAL', status: 'UNAVAILABLE', message: mailStatus.message };
      }

      await ctx.mongo.collections.invitations.insertOne(doc);
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'invitation.created',
        entityType: 'invitation',
        entityId: doc._id,
        after: { email: body.email, delivery: doc.delivery?.status },
      });

      reply.status(201);
      // O link só é devolvido na criação, para entrega manual quando não
      // há provedor de e-mail configurado. O token não é armazenado.
      // Só quando o e-mail NÃO foi entregue (entrega manual pelo administrador).
      return toInvitationDTO(doc, ctx.env.APP_URL, doc.delivery?.status === 'SENT' ? undefined : token);
    },
  );

  app.delete(
    '/invitations/:id',
    { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const result = await ctx.mongo.collections.invitations.updateOne(
        { _id: id, organizationId: auth.organizationId, status: 'PENDING' },
        { $set: { status: 'REVOKED', tokenHash: `revoked:${id.toHexString()}`, updatedAt: new Date() } },
      );
      if (result.matchedCount === 0) throw notFound('Convite não encontrado ou já utilizado.');
      return { ok: true };
    },
  );

  app.patch(
    '/memberships/:id/permissions',
    { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = membershipPermissionsUpdateSchema.parse(request.body);
      const membership = await ctx.mongo.collections.memberships.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!membership) throw notFound('Colaborador não encontrado.');
      if (membership.role === 'OWNER') throw conflict('As permissões do proprietário não podem ser alteradas.');

      await ctx.mongo.collections.memberships.updateOne(
        { _id: id },
        { $set: { permissions: body.permissions, updatedAt: new Date() } },
      );
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'membership.permissions_updated',
        entityType: 'membership',
        entityId: id,
        before: membership.permissions,
        after: body.permissions,
      });
      return { ok: true };
    },
  );

  app.delete(
    '/memberships/:id',
    { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const membership = await ctx.mongo.collections.memberships.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!membership) throw notFound('Colaborador não encontrado.');
      if (membership.role === 'OWNER') throw conflict('O proprietário não pode ser removido.');
      if (membership.userId.equals(auth.userId)) throw conflict('Você não pode remover o próprio acesso.');

      await ctx.mongo.collections.memberships.deleteOne({ _id: id });
      await ctx.mongo.collections.sessions.updateMany(
        { userId: membership.userId, organizationId: auth.organizationId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
      );
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'membership.removed',
        entityType: 'membership',
        entityId: id,
      });
      return { ok: true };
    },
  );

  /* ---------------------------- assinatura ------------------------- */
  app.get('/subscription', { onRequest: [app.requireAuth] }, async (request) => {
    const ctx = request.appCtx;
    const { organizationId } = requireAuthContext(request);
    const [subscription, invoices, organization, vehicleCount] = await Promise.all([
      ctx.mongo.collections.subscriptions.findOne({ organizationId }),
      ctx.mongo.collections.billingInvoices.find({ organizationId }).sort({ dueDate: -1 }).toArray(),
      ctx.mongo.collections.organizations.findOne({ _id: organizationId }),
      ctx.mongo.collections.vehicles.countDocuments({ organizationId, archivedAt: null }),
    ]);
    if (!subscription) throw notFound('Nenhuma assinatura cadastrada para esta organização.');

    const billing = ctx.integrations.billing.status();
    const cycleTotalCents = Math.round(
      subscription.monthlyPriceCents * subscription.cycleMonths,
    );

    const statusLabels = {
      ACTIVE: 'Ativa',
      PAST_DUE: 'Em atraso',
      CANCELED: 'Cancelada',
      TRIAL: 'Teste',
    } as const;
    const cycleLabels = { MONTHLY: 'Mensal', QUARTERLY: 'Trimestral', YEARLY: 'Anual' } as const;

    const payload: SubscriptionOverview = {
      subscription: {
        status: subscription.status,
        statusLabel: statusLabels[subscription.status],
        planCode: subscription.planCode,
        planLabel: subscription.planLabel,
        productLabel: subscription.productLabel,
        cycle: subscription.cycle,
        cycleLabel: cycleLabels[subscription.cycle],
        cycleMonths: subscription.cycleMonths,
        nextDueAt: subscription.nextDueAt,
        monthlyPriceCents: subscription.monthlyPriceCents,
        discountPercent: subscription.discountPercent,
        cycleTotalCents,
        periodStart: subscription.periodStart,
        periodEnd: subscription.periodEnd,
        vehicleRange: subscription.vehicleRange,
        provider: {
          name: billing.name,
          connected: billing.connected,
          message: billing.connected ? null : billing.message,
        },
      },
      invoices: invoices.map((inv) => ({
        id: inv._id.toHexString(),
        description: inv.description,
        amountCents: inv.amountCents,
        status: inv.status,
        dueDate: inv.dueDate,
        paidAt: inv.paidAt,
        hasDetail: Boolean(inv.composition && inv.composition.length > 0),
        // Links só existem se vieram do provedor real.
        paymentUrl: billing.connected ? inv.paymentUrl : null,
        invoiceUrl: billing.connected ? inv.invoiceUrl : null,
        composition: inv.composition,
      })),
      statement: {
        periodLabel: `${formatShortDateBR(subscription.periodStart)} – ${formatShortDateBR(
          subscription.periodEnd,
        )}`,
        planRangeLabel: subscription.planLabel.toUpperCase(),
        lines: [
          {
            label: 'Plano',
            hint: subscription.discountPercent > 0 ? `(${subscription.discountPercent}% off)` : null,
            amountCents: subscription.monthlyPriceCents,
          },
          {
            label: `Plano faturado no ciclo (${subscription.cycleMonths} meses)`,
            hint: null,
            amountCents: cycleTotalCents,
          },
        ],
        totalCents: cycleTotalCents,
      },
    };
    void organization;
    void vehicleCount;
    return payload;
  });

  app.get(
    '/subscription/invoices/:id/link',
    { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const invoice = await ctx.mongo.collections.billingInvoices.findOne({ _id: id, organizationId });
      if (!invoice) throw notFound('Fatura não encontrada.');

      const billing = ctx.integrations.billing.status();
      if (!billing.connected || !invoice.providerInvoiceId) {
        throw conflict(
          'Provedor de cobrança não conectado — não é possível gerar o link de pagamento ou a 2ª via.',
        );
      }
      const url = await ctx.integrations.billing.paymentLink(invoice.providerInvoiceId).catch(() => {
        throw integrationUnavailable('O provedor de cobrança não respondeu. Tente novamente em instantes.');
      });
      if (!url) throw conflict('O provedor não retornou um link para esta fatura.');
      await ctx.mongo.collections.billingInvoices.updateOne(
        { _id: id },
        { $set: { paymentUrl: url, updatedAt: new Date() } },
      );
      return { url };
    },
  );

  app.post(
    '/subscription/refresh',
    { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] },
    async (request) => {
      const ctx = request.appCtx;
      const billing = ctx.integrations.billing.status();
      void request;
      if (!billing.connected) {
        throw conflict(billing.message);
      }
      // A sincronização real depende do provedor configurado.
      return { ok: true, synced: false, message: 'Sincronização solicitada ao provedor.' };
    },
  );
}
