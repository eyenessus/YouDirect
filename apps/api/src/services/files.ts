import { ObjectId, type ClientSession } from 'mongodb';
import { extname } from 'node:path';
import type { FilePurpose } from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../common/errors.js';
import {
  buildSignedFileUrl,
  DOCUMENT_MIME,
  IMAGE_MIME,
  sniffContentType,
} from '../storage/index.js';
import { generateToken } from '../common/helpers.js';

const rules: Record<FilePurpose, { mimes: string[]; maxBytes: number; label: string }> = {
  VEHICLE_PHOTO: { mimes: IMAGE_MIME, maxBytes: 5 * 1024 * 1024, label: 'Foto do veículo' },
  DRIVER_ID: { mimes: DOCUMENT_MIME, maxBytes: 10 * 1024 * 1024, label: 'Documento de identificação' },
  DRIVER_ADDRESS_PROOF: { mimes: DOCUMENT_MIME, maxBytes: 10 * 1024 * 1024, label: 'Comprovante de endereço' },
  RENTAL_CONTRACT: { mimes: DOCUMENT_MIME, maxBytes: 10 * 1024 * 1024, label: 'Contrato' },
  MAINTENANCE_INVOICE: { mimes: DOCUMENT_MIME, maxBytes: 10 * 1024 * 1024, label: 'Nota fiscal da OS' },
  INSPECTION_PHOTO: { mimes: IMAGE_MIME, maxBytes: 10 * 1024 * 1024, label: 'Foto de vistoria' },
  TRAFFIC_FINE_NOTICE: { mimes: DOCUMENT_MIME, maxBytes: 10 * 1024 * 1024, label: 'Notificação da multa' },
  TRAFFIC_FINE_PROOF: { mimes: DOCUMENT_MIME, maxBytes: 10 * 1024 * 1024, label: 'Comprovante de indicação' },
  MAINTENANCE_REQUEST_PHOTO: { mimes: IMAGE_MIME, maxBytes: 10 * 1024 * 1024, label: 'Foto do pedido de manutenção' },
};

export function filePurposeRules(purpose: FilePurpose) {
  return rules[purpose];
}

export async function storeFile(
  ctx: AppContext,
  params: {
    organizationId: ObjectId;
    uploadedBy: ObjectId | null;
    purpose: FilePurpose;
    originalName: string;
    declaredContentType: string;
    buffer: Buffer;
  },
): Promise<{ id: ObjectId; url: string; contentType: string; size: number }> {
  const rule = rules[params.purpose];
  if (!rule) throw badRequest('Finalidade de arquivo inválida.');
  if (params.buffer.byteLength === 0) throw badRequest('Arquivo vazio.');
  if (params.buffer.byteLength > rule.maxBytes) {
    throw badRequest(
      `${rule.label}: arquivo acima do limite de ${Math.round(rule.maxBytes / (1024 * 1024))} MB.`,
    );
  }

  const sniffed = sniffContentType(params.buffer, params.declaredContentType);
  if (!sniffed || !rule.mimes.includes(sniffed)) {
    throw badRequest(
      `${rule.label}: formato não permitido. Aceitos: ${rule.mimes
        .map((m) => m.split('/')[1]?.toUpperCase())
        .join(', ')}.`,
    );
  }

  const ext = extname(params.originalName).slice(0, 10) || `.${sniffed.split('/')[1]}`;
  const key = `${params.organizationId.toHexString()}/${params.purpose.toLowerCase()}/${generateToken(16)}${ext}`;
  const stored = await ctx.storage.put(key, params.buffer, sniffed);

  const now = new Date();
  const _id = new ObjectId();
  await ctx.mongo.collections.files.insertOne({
    _id,
    organizationId: params.organizationId,
    originalName: params.originalName.slice(0, 200),
    contentType: sniffed,
    size: stored.size,
    storageKey: stored.storageKey,
    checksum: stored.checksum,
    purpose: params.purpose,
    uploadedBy: params.uploadedBy,
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  });

  return { id: _id, url: fileUrl(ctx, _id, params.organizationId), contentType: sniffed, size: stored.size };
}

export function fileUrl(ctx: AppContext, fileId: ObjectId, organizationId: ObjectId): string {
  return buildSignedFileUrl(
    ctx.env.API_PUBLIC_URL,
    fileId.toHexString(),
    organizationId.toHexString(),
    ctx.env.SESSION_SECRET,
    ctx.env.STORAGE_SIGNED_URL_TTL_SECONDS,
  );
}

export async function requireFile(
  ctx: AppContext,
  organizationId: ObjectId,
  fileId: ObjectId,
  purpose?: FilePurpose,
  session?: ClientSession,
) {
  const file = await ctx.mongo.collections.files.findOne(
    { _id: fileId, organizationId, status: 'ACTIVE' },
    { session },
  );
  if (!file) throw notFound('Arquivo não encontrado.');
  if (purpose && file.purpose !== purpose) throw badRequest('Arquivo enviado para outra finalidade.');
  return file;
}

export async function describeFiles(
  ctx: AppContext,
  organizationId: ObjectId,
  ids: ObjectId[],
): Promise<Map<string, { id: ObjectId; url: string; originalName: string; contentType: string }>> {
  const map = new Map<string, { id: ObjectId; url: string; originalName: string; contentType: string }>();
  if (ids.length === 0) return map;
  const files = await ctx.mongo.collections.files
    .find({ organizationId, _id: { $in: ids }, status: 'ACTIVE' })
    .toArray();
  for (const f of files) {
    map.set(f._id.toHexString(), {
      id: f._id,
      url: fileUrl(ctx, f._id, organizationId),
      originalName: f.originalName,
      contentType: f.contentType,
    });
  }
  return map;
}

export async function softDeleteFile(
  ctx: AppContext,
  organizationId: ObjectId,
  fileId: ObjectId,
): Promise<void> {
  await ctx.mongo.collections.files.updateOne(
    { _id: fileId, organizationId },
    { $set: { status: 'DELETED', updatedAt: new Date() } },
  );
}
