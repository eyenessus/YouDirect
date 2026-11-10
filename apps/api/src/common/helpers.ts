import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { badRequest, notFound } from './errors.js';

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

/* ------------------------------ IDs -------------------------------- */

export function toObjectId(value: string, field = 'id'): ObjectId {
  if (!ObjectId.isValid(value)) throw badRequest(`Identificador inválido em "${field}".`);
  return new ObjectId(value);
}

export function optionalObjectId(value: string | undefined | null, field = 'id'): ObjectId | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return toObjectId(value, field);
}

export function requireFound<T>(value: T | null | undefined, message?: string): T {
  if (value === null || value === undefined) throw notFound(message);
  return value;
}

/* --------------------------- Senhas (hash) ------------------------- *
 * Argon2id é a preferência declarada. O binding nativo nem sempre está
 * disponível no ambiente alvo, então usamos scrypt (RFC 7914, nativo do
 * Node, memory-hard) com parâmetros fortes e formato versionado que
 * permite migrar para argon2id sem invalidar hashes existentes.
 * Ver docs/ASSUMPTIONS.md (A-SEC-01).
 * ------------------------------------------------------------------ */

const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 2;
const SCRYPT_KEYLEN = 64;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(plain.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, n, r, p, salt, hash] = parts;
  try {
    const derived = await scrypt(plain.normalize('NFKC'), Buffer.from(salt, 'base64'), SCRYPT_KEYLEN, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });
    const expected = Buffer.from(hash, 'base64');
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/* --------------------------- Tokens opacos ------------------------- */

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/* ------------------------- PII (CPF / RG) -------------------------- *
 * CPF é guardado cifrado (AES-256-GCM com chave derivada do
 * SESSION_SECRET) e acompanhado de um hash determinístico usado apenas
 * para checagem de duplicidade e busca exata.
 * ------------------------------------------------------------------ */

export function lookupHash(value: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${value}`).digest('hex');
}

/* ----------------------------- Paginação --------------------------- */

export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor<T = Record<string, unknown>>(cursor: string | undefined): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    throw badRequest('Cursor de paginação inválido.');
  }
}

/* ----------------------------- Textos ------------------------------ */

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove acentos para busca tolerante. */
export function foldAccents(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function slugify(value: string): string {
  return foldAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60);
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
}

/* ------------------------- Números sequenciais --------------------- */

export function formatSequence(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

/* ------------------------------ Logs ------------------------------- */

/**
 * Remove credenciais de URLs antes de logar: tokens de vistoria pública e
 * de convite (no caminho) e assinatura/token de query string.
 */
export function redactUrl(url: string): string {
  return url
    .replace(/(\/(?:inspection-public|invitations|vistoria|convite|redefinir-senha)\/)[^/?#]+/g, '$1[redacted]')
    .replace(/([?&](?:sig|token|signature)=)[^&#]+/gi, '$1[redacted]');
}

/* ------------------------------- CSV ------------------------------- */

/**
 * Célula CSV segura: aspas escapadas e neutralização de "fórmula" — texto
 * digitado pelo usuário começando com = + - @ (ou tab/CR) viraria fórmula
 * ao abrir no Excel/Sheets (CSV injection).
 */
export function csvCell(value: string): string {
  // Números (inclusive negativos, ex.: saldo "-150,00") não são fórmula.
  const numeric = /^-?[\d.,]+$/.test(value);
  const neutral = !numeric && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${neutral.replace(/"/g, '""')}"`;
}

/** Data vinda de cursor de paginação (cliente): inválida → 400, não 500. */
export function cursorDate(value: unknown): Date {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw badRequest('Cursor de paginação inválido.');
  return date;
}
