import type { FastifyInstance } from 'fastify';
import {
  driverPortalLoginSchema,
  maintenanceRequestCreateSchema,
  maintenanceRequestStatusSchema,
  maintenanceRequestUpdateSchema,
  portalDocumentSchema,
  type DriverPortalAccessResult,
} from '@yudirect/contracts';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { DRIVER_COOKIE, requireDriverContext } from '../../plugins/driver-auth.js';
import { audit } from '../../services/common.js';
import { filePurposeRules, storeFile } from '../../services/files.js';
import {
  accessLinkMessage,
  accessStatus,
  attachDocument,
  createAccessLink,
  createMaintenanceRequest,
  loginWithToken,
  portalFines,
  portalInspections,
  portalInvoices,
  portalMe,
  portalRentals,
  revokeDriverAccess,
  toMaintenanceRequestDTOs,
} from '../../services/driver-portal.js';
import { sha256 } from '../../common/helpers.js';

const DRIVER_UPLOAD_PURPOSES = ['MAINTENANCE_REQUEST_PHOTO', 'DRIVER_ID', 'DRIVER_ADDRESS_PROOF'] as const;

export async function registerDriverPortalRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------ equipe: acesso do motorista ------------------------ */
  app.get(
    '/drivers/:id/portal-access',
    { onRequest: [app.requireAuth, app.requirePermission('drivers', 'read')] },
    async (request) => {
      const { organizationId } = requireAuthContext(request);
      return accessStatus(request.appCtx, organizationId, toObjectId((request.params as { id: string }).id));
    },
  );

  app.post(
    '/drivers/:id/portal-access',
    {
      onRequest: [app.requireAuth, app.requirePermission('drivers', 'update')],
      config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
    },
    async (request): Promise<DriverPortalAccessResult> => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const { driver, link, expiresAt } = await createAccessLink(ctx, {
        organizationId: auth.organizationId,
        driverId: toObjectId((request.params as { id: string }).id),
        actorId: auth.userId,
      });
      const org = await ctx.mongo.collections.organizations.findOne({ _id: auth.organizationId });
      const message = accessLinkMessage(driver.fullName, org?.name ?? '', link);
      // Sem consentimento (revogado) não enviamos nada automaticamente: a equipe copia o link.
      if (driver.whatsappConsent?.status === 'REVOKED') {
        return { link, expiresAt: expiresAt.toISOString(), delivered: false, manualLink: null, error: 'O motorista revogou o consentimento para mensagens no WhatsApp.' };
      }
      const sent = await ctx.integrations.whatsapp.send(driver.phone, message, `portal-link:${sha256(link)}`);
      return {
        link,
        expiresAt: expiresAt.toISOString(),
        delivered: sent.delivered,
        manualLink: sent.delivered ? null : sent.manualLink,
        error: sent.delivered ? null : sent.error,
      };
    },
  );

  app.delete(
    '/drivers/:id/portal-access',
    { onRequest: [app.requireAuth, app.requirePermission('drivers', 'update')] },
    async (request) => {
      const auth = requireAuthContext(request);
      const revoked = await revokeDriverAccess(request.appCtx, {
        organizationId: auth.organizationId,
        driverId: toObjectId((request.params as { id: string }).id),
        actorId: auth.userId,
      });
      return { ok: true, revokedSessions: revoked };
    },
  );

  /* ---------------------- equipe: pedidos de manutenção ---------------------- */
  app.get(
    '/maintenance-requests',
    { onRequest: [app.requireAuth, app.requirePermission('maintenance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const { status } = request.query as { status?: string };
      const filter: Record<string, unknown> = { organizationId };
      if (status) filter.status = maintenanceRequestStatusSchema.parse(status);
      const docs = await ctx.mongo.collections.maintenanceRequests.find(filter).sort({ createdAt: -1 }).limit(200).toArray();
      const openCount = await ctx.mongo.collections.maintenanceRequests.countDocuments({ organizationId, status: 'OPEN' });
      return { data: await toMaintenanceRequestDTOs(ctx, organizationId, docs), openCount };
    },
  );

  app.patch(
    '/maintenance-requests/:id',
    { onRequest: [app.requireAuth, app.requirePermission('maintenance', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = maintenanceRequestUpdateSchema.parse(request.body);
      const id = toObjectId((request.params as { id: string }).id);
      const updated = await ctx.mongo.collections.maintenanceRequests.findOneAndUpdate(
        { _id: id, organizationId: auth.organizationId },
        { $set: { status: body.status, responseNote: body.responseNote ?? null, handledBy: auth.userId, updatedAt: new Date() } },
        { returnDocument: 'after' },
      );
      if (!updated) throw notFound('Pedido não encontrado.');
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'maintenanceRequest.updated',
        entityType: 'maintenanceRequest',
        entityId: id,
        after: { status: body.status },
      });
      const [dto] = await toMaintenanceRequestDTOs(ctx, auth.organizationId, [updated]);
      return dto;
    },
  );

  /* ------------------------------ motorista ------------------------------ */
  app.post(
    '/driver/login',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const ctx = request.appCtx;
      const { token } = driverPortalLoginSchema.parse(request.body);
      const { sessionToken, expiresAt } = await loginWithToken(ctx, token, {
        userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
        ip: request.ip ?? null,
      });
      reply.setCookie(DRIVER_COOKIE, sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: ctx.env.COOKIE_SECURE,
        path: '/',
        expires: expiresAt,
      });
      return { ok: true };
    },
  );

  app.post('/driver/logout', async (request, reply) => {
    const ctx = request.appCtx;
    const token = request.cookies?.[DRIVER_COOKIE];
    if (token) {
      await ctx.mongo.collections.driverSessions.updateOne({ tokenHash: sha256(token), revokedAt: null }, { $set: { revokedAt: new Date() } });
    }
    reply.clearCookie(DRIVER_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/driver/me', { onRequest: [app.requireDriver] }, async (request) =>
    portalMe(request.appCtx, requireDriverContext(request)),
  );

  app.get('/driver/rentals', { onRequest: [app.requireDriver] }, async (request) => ({
    data: await portalRentals(request.appCtx, requireDriverContext(request)),
  }));

  app.get('/driver/invoices', { onRequest: [app.requireDriver] }, async (request) =>
    portalInvoices(request.appCtx, requireDriverContext(request)),
  );

  app.get('/driver/fines', { onRequest: [app.requireDriver] }, async (request) => ({
    data: await portalFines(request.appCtx, requireDriverContext(request)),
  }));

  app.get('/driver/inspections', { onRequest: [app.requireDriver] }, async (request) => ({
    data: await portalInspections(request.appCtx, requireDriverContext(request)),
  }));

  app.get('/driver/maintenance-requests', { onRequest: [app.requireDriver] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireDriverContext(request);
    const docs = await ctx.mongo.collections.maintenanceRequests
      .find({ organizationId: auth.organizationId, driverId: auth.driverId })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();
    return { data: await toMaintenanceRequestDTOs(ctx, auth.organizationId, docs) };
  });

  app.post(
    '/driver/maintenance-requests',
    { onRequest: [app.requireDriver], config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireDriverContext(request);
      const body = maintenanceRequestCreateSchema.parse(request.body);
      const open = await ctx.mongo.collections.maintenanceRequests.countDocuments({
        organizationId: auth.organizationId,
        driverId: auth.driverId,
        status: 'OPEN',
      });
      if (open >= 5) throw conflict('Você já tem 5 pedidos aguardando resposta. Fale com a locadora pelo WhatsApp.');
      const doc = await createMaintenanceRequest(ctx, auth, body);
      reply.status(201);
      const [dto] = await toMaintenanceRequestDTOs(ctx, auth.organizationId, [doc]);
      return dto;
    },
  );

  app.post(
    '/driver/files',
    { onRequest: [app.requireDriver], config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireDriverContext(request);
      const file = await request.file({ limits: { fileSize: 10 * 1024 * 1024 } });
      if (!file) throw badRequest('Envie o arquivo no campo "file".');
      const purpose = (file.fields?.purpose as { value?: string } | undefined)?.value;
      if (!purpose || !(DRIVER_UPLOAD_PURPOSES as readonly string[]).includes(purpose)) {
        throw badRequest('Finalidade de arquivo inválida.');
      }
      const typed = purpose as (typeof DRIVER_UPLOAD_PURPOSES)[number];
      const buffer = await file.toBuffer();
      const rules = filePurposeRules(typed);
      if (buffer.byteLength > rules.maxBytes) throw badRequest(`${rules.label}: arquivo acima do limite.`);
      const stored = await storeFile(ctx, {
        organizationId: auth.organizationId,
        uploadedBy: null,
        purpose: typed,
        originalName: file.filename ?? 'arquivo',
        declaredContentType: file.mimetype ?? 'application/octet-stream',
        buffer,
      });
      reply.status(201);
      return {
        id: stored.id.toHexString(),
        url: stored.url,
        contentType: stored.contentType,
        size: stored.size,
        originalName: file.filename ?? 'arquivo',
      };
    },
  );

  app.post('/driver/documents', { onRequest: [app.requireDriver] }, async (request) => {
    const body = portalDocumentSchema.parse(request.body);
    await attachDocument(request.appCtx, requireDriverContext(request), body);
    return { ok: true };
  });
}
