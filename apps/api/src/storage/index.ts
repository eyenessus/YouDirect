import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Env } from '../config/env.js';
import { badRequest, integrationUnavailable, notFound } from '../common/errors.js';

export interface StoredObject {
  storageKey: string;
  checksum: string;
  size: number;
}

export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private pathFor(key: string): string {
    const safe = key.replace(/\\/g, '/');
    if (safe.includes('..') || safe.startsWith('/')) throw badRequest('Chave de arquivo inválida.');
    const full = join(this.root, safe);
    if (!full.startsWith(this.root)) throw badRequest('Chave de arquivo inválida.');
    return full;
  }

  async put(key: string, body: Buffer): Promise<StoredObject> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
    return {
      storageKey: key,
      checksum: createHash('sha256').update(body).digest('hex'),
      size: body.byteLength,
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch {
      throw notFound('Arquivo não encontrado no armazenamento.');
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

/**
 * Driver S3/MinIO. Só é ativado quando todas as credenciais estão
 * presentes; nunca finge sucesso. A dependência é carregada sob demanda
 * para não exigir o SDK em deployments que usam disco local.
 */
class S3StorageDriver implements StorageDriver {
  readonly name = 's3';
  private client: unknown = null;
  constructor(private readonly env: Env) {}

  private async getClient() {
    if (this.client) return this.client;
    try {
      const mod = (await import('@aws-sdk/client-s3' as string)) as any;
      this.client = new mod.S3Client({
        region: this.env.S3_REGION,
        endpoint: this.env.S3_ENDPOINT,
        forcePathStyle: Boolean(this.env.S3_ENDPOINT),
        credentials: {
          accessKeyId: this.env.S3_ACCESS_KEY_ID!,
          secretAccessKey: this.env.S3_SECRET_ACCESS_KEY!,
        },
      });
      return this.client;
    } catch {
      throw integrationUnavailable(
        'Driver S3 selecionado, mas o pacote @aws-sdk/client-s3 não está instalado neste ambiente.',
      );
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    const mod = (await import('@aws-sdk/client-s3' as string)) as any;
    const client = (await this.getClient()) as any;
    await client.send(
      new mod.PutObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key, Body: body, ContentType: contentType }),
    );
    return {
      storageKey: key,
      checksum: createHash('sha256').update(body).digest('hex'),
      size: body.byteLength,
    };
  }

  async get(key: string): Promise<Buffer> {
    const mod = (await import('@aws-sdk/client-s3' as string)) as any;
    const client = (await this.getClient()) as any;
    const res = await client.send(new mod.GetObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  async remove(key: string): Promise<void> {
    const mod = (await import('@aws-sdk/client-s3' as string)) as any;
    const client = (await this.getClient()) as any;
    await client.send(new mod.DeleteObjectCommand({ Bucket: this.env.S3_BUCKET, Key: key }));
  }
}

export function createStorageDriver(env: Env): StorageDriver {
  if (env.STORAGE_DRIVER === 's3') {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error('STORAGE_DRIVER=s3 exige S3_BUCKET, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY.');
    }
    return new S3StorageDriver(env);
  }
  return new LocalStorageDriver(env.STORAGE_LOCAL_DIR);
}

/* ----------------------- URLs assinadas curtas ---------------------- *
 * Arquivos nunca são servidos por URL pública adivinhável. O acesso é
 * feito por uma URL assinada (HMAC) de curta duração emitida apenas
 * depois da checagem de sessão + tenant + permissão.
 * ------------------------------------------------------------------ */

export interface SignedUrlPayload {
  fileId: string;
  organizationId: string;
  expiresAt: number;
}

export function signFileAccess(payload: SignedUrlPayload, secret: string): string {
  const base = `${payload.fileId}.${payload.organizationId}.${payload.expiresAt}`;
  return createHmac('sha256', secret).update(base).digest('base64url');
}

export function verifyFileAccess(payload: SignedUrlPayload, signature: string, secret: string): boolean {
  const expected = signFileAccess(payload, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildSignedFileUrl(
  baseUrl: string,
  fileId: string,
  organizationId: string,
  secret: string,
  ttlSeconds: number,
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signFileAccess({ fileId, organizationId, expiresAt }, secret);
  const url = new URL(`/api/v1/files/${fileId}/content`, baseUrl);
  url.searchParams.set('org', organizationId);
  url.searchParams.set('exp', String(expiresAt));
  url.searchParams.set('sig', sig);
  return url.toString();
}

/* -------------------------- Tipos aceitos -------------------------- */

export const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'];
export const DOCUMENT_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
export const SHEET_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
  'text/plain',
  'application/octet-stream',
];

/**
 * Validação por "magic number": o Content-Type do browser nunca é
 * confiado isoladamente.
 */
export function sniffContentType(buffer: Buffer, fallback: string): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buffer.length >= 4 && buffer.subarray(0, 2).toString('latin1') === 'PK')
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  // CSV/TXT não têm assinatura: aceitamos apenas se o conteúdo for texto.
  if (fallback.startsWith('text/') || fallback.includes('csv')) {
    const sample = buffer.subarray(0, 512).toString('utf8');
    // eslint-disable-next-line no-control-regex
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(sample)) return 'text/csv';
  }
  return null;
}
