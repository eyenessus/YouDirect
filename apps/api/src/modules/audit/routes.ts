import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { isoDateSchema } from '@yudirect/contracts';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import { cursorDate, decodeCursor, encodeCursor, toObjectId } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';
import { softDeleteFile } from '../../services/files.js';

/* ------------------------------------------------------------------ *
 * Auditoria (OWNER/ADMIN) e direitos do titular (LGPD) — §8.
 * ------------------------------------------------------------------ */

const auditQuerySchema = z.object({
  entityType: z.string().trim().max(60).optional(),
  action: z.string().trim().max(80).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Campos que nunca saem da API, nem na trilha de auditoria. */
const SECRET_KEYS = /^(passwordHash|tokenHash|requestTokenHash|requestTokenEnc|requestPayloadEnc|cpfEncrypted|rgEncrypted|cpfLookupHash|secret.*)$/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 6) return value ?? null;
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k)) continue;
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/audit-logs', { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] }, async (request) => {
    const ctx = request.appCtx;
    const { organizationId } = requireAuthContext(request);
    const query = auditQuerySchema.parse(request.query);
    const filter: Record<string, unknown> = { organizationId };
    if (query.entityType) filter.entityType = query.entityType;
    if (query.action) filter.action = query.action;
    if (query.from || query.to) {
      const range: Record<string, Date> = {};
      if (query.from) range.$gte = new Date(`${query.from}T00:00:00-03:00`);
      if (query.to) range.$lte = new Date(`${query.to}T23:59:59.999-03:00`);
      filter.occurredAt = range;
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (!cursor) throw badRequest('Cursor de paginação inválido.');
      const at = cursorDate(cursor.at);
      const id = toObjectId(String(cursor.id), 'cursor');
      filter.$or = [{ occurredAt: { $lt: at } }, { occurredAt: at, _id: { $lt: id } }];
    }
    const docs = await ctx.mongo.collections.auditLogs
      .find(filter)
      .sort({ occurredAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .toArray();
    const page = docs.slice(0, query.limit);
    const actorIds = [...new Set(page.map((d) => d.actorId?.toHexString()).filter(Boolean))].map((id) => new ObjectId(id));
    const users = actorIds.length
      ? await ctx.mongo.collections.users.find({ _id: { $in: actorIds } }, { projection: { name: 1, emailLower: 1 } }).toArray()
      : [];
    const names = new Map(users.map((u) => [u._id.toHexString(), u.name]));
    const last = page.at(-1);
    return {
      data: page.map((d) => ({
        id: d._id.toHexString(),
        occurredAt: d.occurredAt.toISOString(),
        action: d.action,
        entityType: d.entityType,
        entityId: d.entityId?.toHexString() ?? null,
        actor: d.actorId ? { id: d.actorId.toHexString(), name: names.get(d.actorId.toHexString()) ?? '—' } : null,
        before: sanitize(d.before),
        after: sanitize(d.after),
      })),
      page: {
        nextCursor:
          docs.length > query.limit && last
            ? encodeCursor({ at: last.occurredAt.toISOString(), id: last._id.toHexString() })
            : null,
      },
    };
  });

  /** Portabilidade (LGPD art. 18, V): tudo o que a organização guarda do motorista. */
  app.get(
    '/drivers/:id/data-export',
    { onRequest: [app.requireAuth, app.requirePermission('drivers', 'export')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const driver = await ctx.mongo.collections.drivers.findOne({ _id: id, organizationId: auth.organizationId });
      if (!driver) throw notFound('Motorista não encontrado.');
      const c = ctx.mongo.collections;
      const [rentals, receivables, inspections, files] = await Promise.all([
        c.rentals.find({ organizationId: auth.organizationId, driverId: id }).toArray(),
        c.receivables.find({ organizationId: auth.organizationId, driverId: id }).toArray(),
        c.inspections.find({ organizationId: auth.organizationId, driverId: id }).toArray(),
        c.files
          .find({
            organizationId: auth.organizationId,
            _id: { $in: [driver.idDocumentFileId, driver.addressProofFileId].filter((v): v is ObjectId => Boolean(v)) },
          })
          .toArray(),
      ]);
      const payments = receivables.length
        ? await c.payments
            .find({ organizationId: auth.organizationId, sourceType: 'RECEIVABLE', sourceId: { $in: receivables.map((r) => r._id) } })
            .toArray()
        : [];
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'driver.data_exported',
        entityType: 'driver',
        entityId: id,
      });
      const payload = {
        generatedAt: new Date().toISOString(),
        driver: {
          ...(sanitize(driver) as Record<string, unknown>),
          cpf: driver.cpfEncrypted ? ctx.pii.decrypt(driver.cpfEncrypted) : null,
          rg: driver.rgEncrypted ? ctx.pii.decrypt(driver.rgEncrypted) : null,
        },
        rentals: sanitize(rentals),
        receivables: sanitize(receivables),
        payments: sanitize(payments),
        inspections: sanitize(
          inspections.map((i) => ({
            _id: i._id,
            scheduledAt: i.scheduledAt,
            dueDate: i.dueDate,
            status: i.status,
            submittedAt: (i as { submittedAt?: unknown }).submittedAt ?? null,
            mileageKm: (i as { mileageKm?: unknown }).mileageKm ?? null,
          })),
        ),
        documents: files.map((f) => ({ id: f._id.toHexString(), name: f.originalName, purpose: f.purpose })),
      };
      reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="dados-motorista-${id.toHexString()}.json"`)
        .header('cache-control', 'no-store');
      return JSON.stringify(payload, null, 2);
    },
  );

  /**
   * Anonimização (LGPD art. 18, IV): apaga os dados pessoais de um motorista
   * sem locação ativa (o registro também é arquivado). Locações, recebíveis e pagamentos ficam
   * (obrigação fiscal), ligados a um registro sem identificação.
   */
  app.post(
    '/drivers/:id/anonymize',
    { onRequest: [app.requireAuth, app.requireOwnerOrAdmin] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = z.object({ confirm: z.literal('ANONIMIZAR') }).safeParse(request.body);
      if (!body.success) throw badRequest('Confirme digitando ANONIMIZAR.');
      const driver = await ctx.mongo.collections.drivers.findOne({ _id: id, organizationId: auth.organizationId });
      if (!driver) throw notFound('Motorista não encontrado.');
      if (driver.anonymizedAt) throw conflict('Este motorista já foi anonimizado.');
      const active = await ctx.mongo.collections.rentals.countDocuments({
        organizationId: auth.organizationId,
        driverId: id,
        status: 'ACTIVE',
      });
      if (active > 0) throw conflict('O motorista tem locação ativa.');

      const label = `Motorista anonimizado ${id.toHexString().slice(-6)}`;
      const now = new Date();
      await ctx.mongo.collections.drivers.updateOne(
        { _id: id, organizationId: auth.organizationId },
        {
          $set: {
            fullName: label,
            fullNameFold: label.toLowerCase(),
            cpfEncrypted: null,
            cpfLookupHash: null,
            cpfLast3: null,
            rgEncrypted: null,
            birthDate: null,
            emailLower: null,
            phone: '',
            cnh: { number: null, category: null, expiresAt: null },
            address: { postalCode: null, street: null, number: null, complement: null, district: null, city: null, state: null },
            idDocumentFileId: null,
            addressProofFileId: null,
            whatsappConsent: null,
            anonymizedAt: now,
            archivedAt: driver.archivedAt ?? now,
            status: 'INACTIVE',
            updatedAt: now,
          },
          $inc: { version: 1 },
        },
      );
      for (const fileId of [driver.idDocumentFileId, driver.addressProofFileId]) {
        if (fileId) await softDeleteFile(ctx, auth.organizationId, fileId).catch(() => undefined);
      }
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'driver.anonymized',
        entityType: 'driver',
        entityId: id,
      });
      return { ok: true };
    },
  );
}
