import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  publicSiteSettingsUpdateSchema,
  rentalLeadCreateSchema,
  rentalLeadStatusSchema,
  rentalLeadUpdateSchema,
  vehicleOfferSchema,
  type PublicCatalog,
  type PublicCatalogGroup,
  type PublicSiteSettings,
  type RentalLead,
} from '@yudirect/contracts';
import { conflict, notFound } from '../../common/errors.js';
import { toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';
import { describeFiles } from '../../services/files.js';
import { createNotification } from '../../services/notifications.js';
import type { AppContext } from '../../context.js';
import type { OrganizationDoc, RentalLeadDoc } from '../../database/types.js';

/* ------------------------------------------------------------------ *
 * Site da locadora (`/l/:slug`), inspirado na home da Localiza:
 * vitrine de grupos "ou similar" com preço semanal e pedido de reserva.
 * Os pedidos caem numa fila no painel (Pedidos de reserva).
 * ------------------------------------------------------------------ */

const DEFAULT_REQUIREMENTS = [
  'CNH definitiva com EAR (exerce atividade remunerada)',
  'Cadastro ativo na Uber ou 99',
  'Comprovante de residência',
];

function siteSettings(org: OrganizationDoc): PublicSiteSettings {
  const s = org.settings.publicSite;
  return {
    publicSlug: org.publicSlug ?? null,
    enabled: s?.enabled ?? false,
    headline: s?.headline ?? null,
    about: s?.about ?? null,
    city: s?.city ?? null,
    whatsappPhone: s?.whatsappPhone ?? null,
    emergencyPhone: s?.emergencyPhone ?? null,
    requirements: s?.requirements ?? DEFAULT_REQUIREMENTS,
  };
}

async function orgBySlug(ctx: AppContext, slug: string): Promise<OrganizationDoc> {
  const org = await ctx.mongo.collections.organizations.findOne({ publicSlug: slug.toLowerCase() });
  if (!org || !org.settings.publicSite?.enabled) throw notFound('Página não encontrada.');
  return org;
}

function toLeadDTO(d: RentalLeadDoc): RentalLead {
  return {
    id: d._id.toHexString(),
    fullName: d.fullName,
    phone: d.phone,
    email: d.email,
    groupName: d.groupName,
    desiredStartDate: d.desiredStartDate,
    appPlatforms: d.appPlatforms,
    hasEarCnh: d.hasEarCnh,
    message: d.message,
    status: d.status,
    notes: d.notes,
    createdAt: d.createdAt.toISOString(),
  };
}

export async function buildCatalog(ctx: AppContext, org: OrganizationDoc): Promise<PublicCatalog> {
  const vehicles = await ctx.mongo.collections.vehicles
    .find({ organizationId: org._id, archivedAt: null, status: { $ne: 'INACTIVE' }, 'offer.showOnSite': true })
    .toArray();
  const byGroup = new Map<string, typeof vehicles>();
  for (const v of vehicles) {
    const key = v.offer!.groupName.trim();
    byGroup.set(key, [...(byGroup.get(key) ?? []), v]);
  }
  const photoIds = [...byGroup.values()]
    .map((list) => list.find((v) => v.photoFileIds.length > 0)?.photoFileIds[0])
    .filter((v): v is ObjectId => Boolean(v));
  const photos = await describeFiles(ctx, org._id, photoIds);

  const groups: PublicCatalogGroup[] = [...byGroup.entries()].map(([groupName, list]) => {
    const cheapest = [...list].sort((a, b) => a.offer!.weeklyPriceCents - b.offer!.weeklyPriceCents)[0]!;
    const photoId = list.find((v) => v.photoFileIds.length > 0)?.photoFileIds[0];
    const available = list.filter((v) => v.status === 'AVAILABLE').length;
    return {
      groupName,
      fromWeeklyPriceCents: cheapest.offer!.weeklyPriceCents,
      depositCents: cheapest.offer!.depositCents,
      kmPolicy: cheapest.offer!.kmPolicy,
      weeklyKmFranchise: cheapest.offer!.weeklyKmFranchise,
      models: [...new Set(list.map((v) => `${v.brand} ${v.model}`))].slice(0, 4),
      highlights: [...new Set(list.flatMap((v) => v.offer!.highlights))].slice(0, 6),
      photoUrl: photoId ? (photos.get(photoId.toHexString())?.url ?? null) : null,
      available: available > 0,
      availableCount: available,
    };
  });
  groups.sort((a, b) => (a.available === b.available ? a.fromWeeklyPriceCents - b.fromWeeklyPriceCents : a.available ? -1 : 1));

  const s = siteSettings(org);
  return {
    organization: {
      name: org.name,
      headline: s.headline,
      about: s.about,
      city: s.city,
      whatsappPhone: s.whatsappPhone,
      requirements: s.requirements,
    },
    groups,
  };
}

export async function registerPublicSiteRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------- equipe: configurações ------------------------- */
  app.get('/public-site/settings', { onRequest: [app.requireAuth] }, async (request) => {
    const { organizationId } = requireAuthContext(request);
    const org = await request.appCtx.mongo.collections.organizations.findOne({ _id: organizationId });
    if (!org) throw notFound('Organização não encontrada.');
    return siteSettings(org);
  });

  app.patch('/public-site/settings', { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const body = publicSiteSettingsUpdateSchema.parse(request.body);
    const org = await ctx.mongo.collections.organizations.findOne({ _id: auth.organizationId });
    if (!org) throw notFound('Organização não encontrada.');
    const current = siteSettings(org);
    const next = {
      enabled: body.enabled ?? current.enabled,
      headline: body.headline !== undefined ? (body.headline ?? null) : current.headline,
      about: body.about !== undefined ? (body.about ?? null) : current.about,
      city: body.city !== undefined ? (body.city ?? null) : current.city,
      whatsappPhone: body.whatsappPhone !== undefined ? body.whatsappPhone || null : current.whatsappPhone,
      emergencyPhone: body.emergencyPhone !== undefined ? body.emergencyPhone || null : current.emergencyPhone,
      requirements: body.requirements ?? current.requirements,
    };
    const slug = body.publicSlug !== undefined ? body.publicSlug : current.publicSlug;
    if (next.enabled && !slug) throw conflict('Defina o endereço do site antes de publicá-lo.');
    try {
      await ctx.mongo.collections.organizations.updateOne(
        { _id: auth.organizationId },
        { $set: { publicSlug: slug, 'settings.publicSite': next, updatedAt: new Date() } },
      );
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw conflict('Este endereço já está em uso por outra empresa.');
      throw err;
    }
    await audit(ctx, {
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: 'publicSite.updated',
      entityType: 'organization',
      entityId: auth.organizationId,
      after: { slug, enabled: next.enabled },
    });
    const fresh = await ctx.mongo.collections.organizations.findOne({ _id: auth.organizationId });
    return siteSettings(fresh!);
  });

  /* --------------------------- equipe: oferta do veículo --------------------------- */
  app.put(
    '/vehicles/:id/offer',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = vehicleOfferSchema.parse(request.body);
      const offer = {
        showOnSite: body.showOnSite,
        groupName: body.groupName.trim(),
        weeklyPriceCents: body.weeklyPriceCents,
        depositCents: body.depositCents,
        kmPolicy: body.kmPolicy,
        weeklyKmFranchise: body.kmPolicy === 'FRANCHISE' ? (body.weeklyKmFranchise ?? null) : null,
        highlights: body.highlights,
      };
      const res = await ctx.mongo.collections.vehicles.updateOne(
        { _id: id, organizationId: auth.organizationId, archivedAt: null },
        { $set: { offer, updatedAt: new Date() } },
      );
      if (res.matchedCount === 0) throw notFound('Veículo não encontrado.');
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'vehicle.offerUpdated',
        entityType: 'vehicle',
        entityId: id,
        after: offer,
      });
      return { offer };
    },
  );

  app.delete(
    '/vehicles/:id/offer',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'update')] },
    async (request) => {
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const res = await request.appCtx.mongo.collections.vehicles.updateOne(
        { _id: id, organizationId: auth.organizationId },
        { $set: { offer: null, updatedAt: new Date() } },
      );
      if (res.matchedCount === 0) throw notFound('Veículo não encontrado.');
      return { ok: true };
    },
  );

  /* ------------------------------- público ------------------------------- */
  app.get(
    '/public/:slug/catalog',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const org = await orgBySlug(request.appCtx, (request.params as { slug: string }).slug);
      reply.header('cache-control', 'no-store');
      return buildCatalog(request.appCtx, org);
    },
  );

  app.post(
    '/public/:slug/leads',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const ctx = request.appCtx;
      const org = await orgBySlug(ctx, (request.params as { slug: string }).slug);
      const body = rentalLeadCreateSchema.parse(request.body);
      reply.status(201);
      // Honeypot preenchido = robô: responde como sucesso, sem gravar.
      if (body.website) return { ok: true };

      // O mesmo telefone pedindo de novo em 24h não duplica a fila.
      const recent = await ctx.mongo.collections.rentalLeads.findOne({
        organizationId: org._id,
        phone: body.phone,
        createdAt: { $gt: new Date(Date.now() - 24 * 3600 * 1000) },
      });
      if (recent) return { ok: true };

      const now = new Date();
      const doc: RentalLeadDoc = {
        _id: new ObjectId(),
        organizationId: org._id,
        fullName: body.fullName,
        phone: body.phone,
        email: body.email ?? null,
        groupName: body.groupName ?? null,
        desiredStartDate: body.desiredStartDate ?? null,
        appPlatforms: body.appPlatforms,
        hasEarCnh: body.hasEarCnh,
        message: body.message ?? null,
        status: 'NEW',
        notes: null,
        ip: request.ip ?? null,
        handledBy: null,
        createdAt: now,
        updatedAt: now,
      };
      await ctx.mongo.collections.rentalLeads.insertOne(doc);
      await createNotification(ctx, {
        organizationId: org._id,
        type: 'RENTAL',
        severity: 'INFO',
        title: 'Novo pedido de reserva pelo site',
        message: `${body.fullName}${body.groupName ? ` quer um ${body.groupName}` : ' pediu uma reserva'}.`,
        subjectLabel: body.fullName,
        entityType: 'rentalLead',
        entityId: doc._id,
        targetPath: '/dashboard/leads',
        dedupeKey: `rental-lead:${doc._id.toHexString()}`,
      });
      return { ok: true };
    },
  );

  /* --------------------------- equipe: pedidos --------------------------- */
  app.get(
    '/rental-leads',
    { onRequest: [app.requireAuth, app.requirePermission('rentals', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const { status } = request.query as { status?: string };
      const filter: Record<string, unknown> = { organizationId };
      if (status) filter.status = rentalLeadStatusSchema.parse(status);
      const docs = await ctx.mongo.collections.rentalLeads.find(filter).sort({ createdAt: -1 }).limit(200).toArray();
      const newCount = await ctx.mongo.collections.rentalLeads.countDocuments({ organizationId, status: 'NEW' });
      return { data: docs.map(toLeadDTO), newCount };
    },
  );

  app.patch(
    '/rental-leads/:id',
    { onRequest: [app.requireAuth, app.requirePermission('rentals', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = rentalLeadUpdateSchema.parse(request.body);
      const set: Record<string, unknown> = { updatedAt: new Date(), handledBy: auth.userId };
      if (body.status) set.status = body.status;
      if (body.notes !== undefined) set.notes = body.notes ?? null;
      const updated = await ctx.mongo.collections.rentalLeads.findOneAndUpdate(
        { _id: toObjectId((request.params as { id: string }).id), organizationId: auth.organizationId },
        { $set: set },
        { returnDocument: 'after' },
      );
      if (!updated) throw notFound('Pedido não encontrado.');
      return toLeadDTO(updated);
    },
  );
}
