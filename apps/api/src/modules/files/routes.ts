import type { FastifyInstance } from 'fastify';
import { filePurposeSchema } from '@yudirect/contracts';
import { badRequest, forbidden, notFound } from '../../common/errors.js';
import { toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { filePurposeRules, softDeleteFile, storeFile } from '../../services/files.js';
import { verifyFileAccess } from '../../storage/index.js';

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------ upload --------------------------- */
  app.post('/files', { onRequest: [app.requireAuth] }, async (request, reply) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);

    const file = await request.file({ limits: { fileSize: 10 * 1024 * 1024 } });
    if (!file) throw badRequest('Envie o arquivo no campo "file".');

    const purposeRaw = (file.fields?.purpose as { value?: string } | undefined)?.value;
    const parsed = filePurposeSchema.safeParse(purposeRaw);
    if (!parsed.success) {
      throw badRequest(
        'Informe o campo "purpose" com uma finalidade válida (VEHICLE_PHOTO, DRIVER_ID, DRIVER_ADDRESS_PROOF, RENTAL_CONTRACT, MAINTENANCE_INVOICE, INSPECTION_PHOTO).',
      );
    }
    const rules = filePurposeRules(parsed.data);

    const buffer = await file.toBuffer();
    if (buffer.byteLength > rules.maxBytes) {
      throw badRequest(
        `${rules.label}: arquivo acima do limite de ${Math.round(rules.maxBytes / (1024 * 1024))} MB.`,
      );
    }

    const stored = await storeFile(ctx, {
      organizationId: auth.organizationId,
      uploadedBy: auth.userId,
      purpose: parsed.data,
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
      purpose: parsed.data,
      createdAt: new Date().toISOString(),
    };
  });

  /* ----------------------- download assinado ----------------------- */
  app.get('/files/:id/content', async (request, reply) => {
    const ctx = request.appCtx;
    const { id } = request.params as { id: string };
    const { org, exp, sig } = request.query as { org?: string; exp?: string; sig?: string };

    if (!org || !exp || !sig) throw forbidden('Link de arquivo inválido.');
    const expiresAt = Number(exp);
    if (!Number.isFinite(expiresAt)) throw forbidden('Link de arquivo inválido.');
    if (expiresAt * 1000 < Date.now()) throw forbidden('Link de arquivo expirado. Recarregue a página.');
    if (!verifyFileAccess({ fileId: id, organizationId: org, expiresAt }, sig, ctx.env.SESSION_SECRET)) {
      throw forbidden('Assinatura de arquivo inválida.');
    }

    const file = await ctx.mongo.collections.files.findOne({
      _id: toObjectId(id),
      organizationId: toObjectId(org, 'org'),
      status: 'ACTIVE',
    });
    if (!file) throw notFound('Arquivo não encontrado.');

    const body = await ctx.storage.get(file.storageKey);
    reply
      .header('content-type', file.contentType)
      .header('cache-control', 'private, max-age=60')
      .header(
        'content-disposition',
        `inline; filename="${file.originalName.replace(/["\\]/g, '')}"`,
      )
      .header('x-content-type-options', 'nosniff');
    return reply.send(body);
  });

  app.get('/files/:id/access-url', { onRequest: [app.requireAuth] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const id = toObjectId((request.params as { id: string }).id);
    const file = await ctx.mongo.collections.files.findOne({
      _id: id,
      organizationId: auth.organizationId,
      status: 'ACTIVE',
    });
    if (!file) throw notFound('Arquivo não encontrado.');
    const { fileUrl } = await import('../../services/files.js');
    return { url: fileUrl(ctx, id, auth.organizationId), contentType: file.contentType };
  });

  app.delete('/files/:id', { onRequest: [app.requireAuth] }, async (request) => {
    const ctx = request.appCtx;
    const auth = requireAuthContext(request);
    const id = toObjectId((request.params as { id: string }).id);
    const file = await ctx.mongo.collections.files.findOne({
      _id: id,
      organizationId: auth.organizationId,
    });
    if (!file) throw notFound('Arquivo não encontrado.');
    await softDeleteFile(ctx, auth.organizationId, id);
    return { ok: true };
  });
}
