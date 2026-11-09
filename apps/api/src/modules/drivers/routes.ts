import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  businessDate,
  driverInputSchema,
  driverListQuerySchema,
  driverUpdateSchema,
  isValidCpf,
  maskCpf,
  type Driver,
  type PostalCodeLookup,
} from '@frotaone/contracts';
import { badRequest, conflict, notFound } from '../../common/errors.js';
import {
  decodeCursor,
  encodeCursor,
  escapeRegex,
  foldAccents,
  lookupHash,
  toObjectId,
} from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { audit } from '../../services/common.js';
import { describeFiles, requireFile } from '../../services/files.js';
import type { AppContext } from '../../context.js';
import type { DriverDoc } from '../../database/types.js';

async function toDriverDTOs(
  ctx: AppContext,
  organizationId: ObjectId,
  docs: DriverDoc[],
): Promise<Driver[]> {
  const today = businessDate();
  const fileIds = docs.flatMap((d) =>
    [d.idDocumentFileId, d.addressProofFileId].filter((v): v is ObjectId => Boolean(v)),
  );
  const files = await describeFiles(ctx, organizationId, fileIds);
  const rentalCounts = new Map<string, number>();
  if (docs.length > 0) {
    const rows = await ctx.mongo.collections.rentals
      .aggregate<{ _id: ObjectId; count: number }>([
        {
          $match: {
            organizationId,
            status: 'ACTIVE',
            driverId: { $in: docs.map((d) => d._id) },
          },
        },
        { $group: { _id: '$driverId', count: { $sum: 1 } } },
      ])
      .toArray();
    for (const row of rows) rentalCounts.set(row._id.toHexString(), row.count);
  }

  return docs.map((doc) => {
    const cpf = ctx.pii.decrypt(doc.cpfEncrypted);
    const idFile = doc.idDocumentFileId ? files.get(doc.idDocumentFileId.toHexString()) : undefined;
    const addrFile = doc.addressProofFileId ? files.get(doc.addressProofFileId.toHexString()) : undefined;
    return {
      id: doc._id.toHexString(),
      fullName: doc.fullName,
      cpf,
      rg: ctx.pii.decrypt(doc.rgEncrypted),
      birthDate: doc.birthDate,
      email: doc.emailLower,
      phone: doc.phone,
      cnhNumber: doc.cnh?.number ?? null,
      cnhCategory: doc.cnh?.category ?? null,
      cnhExpiresAt: doc.cnh?.expiresAt ?? null,
      cnhExpired: Boolean(doc.cnh?.expiresAt && doc.cnh.expiresAt < today),
      address: {
        postalCode: doc.address?.postalCode ?? null,
        street: doc.address?.street ?? null,
        number: doc.address?.number ?? null,
        complement: doc.address?.complement ?? null,
        district: doc.address?.district ?? null,
        city: doc.address?.city ?? null,
        state: doc.address?.state ?? null,
      },
      idDocument: idFile
        ? {
            fileId: idFile.id.toHexString(),
            url: idFile.url,
            originalName: idFile.originalName,
            contentType: idFile.contentType,
          }
        : null,
      addressProof: addrFile
        ? {
            fileId: addrFile.id.toHexString(),
            url: addrFile.url,
            originalName: addrFile.originalName,
            contentType: addrFile.contentType,
          }
        : null,
      status: doc.status,
      activeRentalsCount: rentalCounts.get(doc._id.toHexString()) ?? 0,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  });
}

export async function registerDriverRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/drivers',
    { onRequest: [app.requireAuth, app.requirePermission('drivers', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const query = driverListQuerySchema.parse(request.query);

      const filter: Record<string, unknown> = { organizationId, archivedAt: null };
      if (query.status) filter.status = query.status;
      if (query.q) {
        const term = query.q.trim();
        const rx = new RegExp(escapeRegex(foldAccents(term).toLowerCase()), 'i');
        const digits = term.replace(/\D+/g, '');
        const or: Record<string, unknown>[] = [
          { fullNameFold: rx },
          { emailLower: new RegExp(escapeRegex(term.toLowerCase()), 'i') },
        ];
        if (digits.length >= 3) or.push({ phone: new RegExp(escapeRegex(digits)) });
        if (digits.length === 11 && isValidCpf(digits)) {
          or.push({ cpfLookupHash: lookupHash(digits, ctx.env.SESSION_SECRET) });
        }
        filter.$or = or;
      }

      const cursor = decodeCursor<{ name: string; id: string }>(query.cursor);
      if (cursor) {
        filter.$and = [
          {
            $or: [
              { fullNameFold: { $gt: cursor.name } },
              { fullNameFold: cursor.name, _id: { $gt: new ObjectId(cursor.id) } },
            ],
          },
        ];
      }

      const docs = await ctx.mongo.collections.drivers
        .find(filter)
        .sort({ fullNameFold: 1, _id: 1 })
        .limit(query.limit + 1)
        .toArray();
      const hasMore = docs.length > query.limit;
      const page = hasMore ? docs.slice(0, query.limit) : docs;
      const total = await ctx.mongo.collections.drivers.countDocuments({ organizationId, archivedAt: null });

      return {
        data: await toDriverDTOs(ctx, organizationId, page),
        page: {
          nextCursor: hasMore
            ? encodeCursor({
                name: page[page.length - 1]!.fullNameFold,
                id: page[page.length - 1]!._id.toHexString(),
              })
            : null,
          total,
        },
      };
    },
  );

  app.get(
    '/drivers/:id',
    { onRequest: [app.requireAuth, app.requirePermission('drivers', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const doc = await ctx.mongo.collections.drivers.findOne({ _id: id, organizationId });
      if (!doc) throw notFound('Motorista não encontrado.');
      const [dto] = await toDriverDTOs(ctx, organizationId, [doc]);
      return dto;
    },
  );

  app.post(
    '/drivers',
    { onRequest: [app.requireAuth, app.requirePermission('drivers', 'create')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const body = driverInputSchema.parse(request.body);

      const idFile = body.idDocumentFileId
        ? await requireFile(ctx, auth.organizationId, toObjectId(body.idDocumentFileId), 'DRIVER_ID')
        : null;
      const proofFile = body.addressProofFileId
        ? await requireFile(
            ctx,
            auth.organizationId,
            toObjectId(body.addressProofFileId),
            'DRIVER_ADDRESS_PROOF',
          )
        : null;

      const now = new Date();
      const doc: DriverDoc = {
        _id: new ObjectId(),
        organizationId: auth.organizationId,
        fullName: body.fullName,
        fullNameFold: foldAccents(body.fullName).toLowerCase(),
        cpfEncrypted: body.cpf ? ctx.pii.encrypt(body.cpf) : null,
        cpfLookupHash: body.cpf ? lookupHash(body.cpf, ctx.env.SESSION_SECRET) : null,
        cpfLast3: body.cpf ? body.cpf.slice(-3) : null,
        rgEncrypted: body.rg ? ctx.pii.encrypt(body.rg) : null,
        birthDate: body.birthDate ?? null,
        emailLower: body.email ?? null,
        phone: body.phone,
        cnh: {
          number: body.cnhNumber ?? null,
          category: body.cnhCategory?.toUpperCase() ?? null,
          expiresAt: body.cnhExpiresAt ?? null,
        },
        address: {
          postalCode: body.address?.postalCode ?? null,
          street: body.address?.street ?? null,
          number: body.address?.number ?? null,
          complement: body.address?.complement ?? null,
          district: body.address?.district ?? null,
          city: body.address?.city ?? null,
          state: body.address?.state ?? null,
        },
        idDocumentFileId: idFile?._id ?? null,
        addressProofFileId: proofFile?._id ?? null,
        status: 'ACTIVE',
        archivedAt: null,
        createdBy: auth.userId,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await ctx.mongo.collections.drivers.insertOne(doc);
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'driver.created',
        entityType: 'driver',
        entityId: doc._id,
        after: { fullName: doc.fullName, cpf: body.cpf ? maskCpf(body.cpf) : null },
      });
      reply.status(201);
      const [dto] = await toDriverDTOs(ctx, auth.organizationId, [doc]);
      return dto;
    },
  );

  app.patch(
    '/drivers/:id',
    { onRequest: [app.requireAuth, app.requirePermission('drivers', 'update')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const body = driverUpdateSchema.parse(request.body);

      const current = await ctx.mongo.collections.drivers.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!current) throw notFound('Motorista não encontrado.');

      const set: Record<string, unknown> = { updatedAt: new Date() };
      if (body.fullName !== undefined) {
        set.fullName = body.fullName;
        set.fullNameFold = foldAccents(body.fullName).toLowerCase();
      }
      if (body.cpf !== undefined) {
        set.cpfEncrypted = body.cpf ? ctx.pii.encrypt(body.cpf) : null;
        set.cpfLookupHash = body.cpf ? lookupHash(body.cpf, ctx.env.SESSION_SECRET) : null;
        set.cpfLast3 = body.cpf ? body.cpf.slice(-3) : null;
      }
      if (body.rg !== undefined) set.rgEncrypted = body.rg ? ctx.pii.encrypt(body.rg) : null;
      if (body.birthDate !== undefined) set.birthDate = body.birthDate ?? null;
      if (body.email !== undefined) set.emailLower = body.email ?? null;
      if (body.phone !== undefined) set.phone = body.phone;
      if (body.cnhNumber !== undefined) set['cnh.number'] = body.cnhNumber ?? null;
      if (body.cnhCategory !== undefined) set['cnh.category'] = body.cnhCategory?.toUpperCase() ?? null;
      if (body.cnhExpiresAt !== undefined) set['cnh.expiresAt'] = body.cnhExpiresAt ?? null;
      if (body.address !== undefined) {
        for (const key of ['postalCode', 'street', 'number', 'complement', 'district', 'city', 'state'] as const) {
          if (body.address[key] !== undefined) set[`address.${key}`] = body.address[key] ?? null;
        }
      }
      if (body.idDocumentFileId !== undefined) {
        const file = await requireFile(
          ctx,
          auth.organizationId,
          toObjectId(body.idDocumentFileId),
          'DRIVER_ID',
        );
        set.idDocumentFileId = file._id;
      }
      if (body.addressProofFileId !== undefined) {
        const file = await requireFile(
          ctx,
          auth.organizationId,
          toObjectId(body.addressProofFileId),
          'DRIVER_ADDRESS_PROOF',
        );
        set.addressProofFileId = file._id;
      }

      const updated = await ctx.mongo.collections.drivers.findOneAndUpdate(
        { _id: id, organizationId: auth.organizationId, version: current.version },
        { $set: set, $inc: { version: 1 } },
        { returnDocument: 'after' },
      );
      if (!updated) throw conflict('O motorista foi alterado por outro usuário. Recarregue e tente novamente.');
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'driver.updated',
        entityType: 'driver',
        entityId: id,
      });
      const [dto] = await toDriverDTOs(ctx, auth.organizationId, [updated]);
      return dto;
    },
  );

  app.delete(
    '/drivers/:id',
    { onRequest: [app.requireAuth, app.requirePermission('drivers', 'delete')] },
    async (request) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const id = toObjectId((request.params as { id: string }).id);
      const driver = await ctx.mongo.collections.drivers.findOne({
        _id: id,
        organizationId: auth.organizationId,
      });
      if (!driver) throw notFound('Motorista não encontrado.');

      const activeRental = await ctx.mongo.collections.rentals.findOne({
        organizationId: auth.organizationId,
        driverId: id,
        status: 'ACTIVE',
      });
      if (activeRental) {
        throw conflict(
          `Não é possível excluir: o motorista possui a locação ativa ${activeRental.rentalNumber}.`,
        );
      }

      await ctx.mongo.collections.drivers.updateOne(
        { _id: id, organizationId: auth.organizationId },
        { $set: { archivedAt: new Date(), status: 'INACTIVE', updatedAt: new Date() } },
      );
      await audit(ctx, {
        organizationId: auth.organizationId,
        actorId: auth.userId,
        action: 'driver.archived',
        entityType: 'driver',
        entityId: id,
      });
      return { ok: true, archived: true };
    },
  );

  /* ----------------------------- CEP ------------------------------- */
  app.get(
    '/postal-codes/:cep',
    { onRequest: [app.requireAuth], config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const ctx = request.appCtx;
      const cep = String((request.params as { cep: string }).cep).replace(/\D+/g, '');
      if (cep.length !== 8) throw badRequest('CEP deve ter 8 dígitos.');
      const status = ctx.integrations.postalCode.status();
      if (!status.connected) {
        const payload: PostalCodeLookup = {
          available: false,
          provider: null,
          message: status.message,
          address: null,
        };
        return payload;
      }
      const address = await ctx.integrations.postalCode.lookup(cep);
      const payload: PostalCodeLookup = {
        available: true,
        provider: status.name,
        message: address ? undefined : 'CEP não encontrado no provedor.',
        address,
      };
      return payload;
    },
  );
}
