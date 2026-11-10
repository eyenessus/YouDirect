import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/* ------------------------------------------------------------------ *
 * Assinatura HMAC v1 entre YuDirect e Whaply (plano §5.1).
 *
 *   base  = METHOD \n PATH?QUERY \n TIMESTAMP \n NONCE \n SHA256_HEX(body)
 *   X-Yu-Signature: v1=<hex(HMAC_SHA256(secret, base))>
 *
 * Uma chave por direção; cada lado aceita a chave atual e a próxima
 * (rotação sem parada). Timestamp tolerado em ±300 s; o nonce é único
 * dentro dessa janela (armazenado por quem verifica).
 * ------------------------------------------------------------------ */

export const SIGNATURE_HEADERS = {
  keyId: 'x-yu-key-id',
  timestamp: 'x-yu-timestamp',
  nonce: 'x-yu-nonce',
  signature: 'x-yu-signature',
} as const;

export const MAX_CLOCK_SKEW_SECONDS = 300;

export interface SigningKey {
  keyId: string;
  secret: string;
}

export function sha256Hex(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

export function signatureBase(params: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string | Buffer;
}): string {
  return [params.method.toUpperCase(), params.path, params.timestamp, params.nonce, sha256Hex(params.body)].join('\n');
}

export function computeSignature(secret: string, base: string): string {
  return `v1=${createHmac('sha256', secret).update(base).digest('hex')}`;
}

export function signRequest(
  key: SigningKey,
  params: { method: string; path: string; body: string | Buffer; now?: Date; nonce?: string },
): Record<string, string> {
  const timestamp = String(Math.floor((params.now ?? new Date()).getTime() / 1000));
  const nonce = params.nonce ?? randomBytes(16).toString('base64url');
  const base = signatureBase({ method: params.method, path: params.path, timestamp, nonce, body: params.body });
  return {
    [SIGNATURE_HEADERS.keyId]: key.keyId,
    [SIGNATURE_HEADERS.timestamp]: timestamp,
    [SIGNATURE_HEADERS.nonce]: nonce,
    [SIGNATURE_HEADERS.signature]: computeSignature(key.secret, base),
  };
}

export type VerifyFailure = 'SIGNATURE_INVALID' | 'TIMESTAMP_SKEW' | 'MISSING_HEADERS' | 'UNKNOWN_KEY';

export interface VerifyResult {
  ok: boolean;
  reason?: VerifyFailure;
  keyId?: string;
  nonce?: string;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verifica assinatura e relógio. A checagem de nonce (replay) fica a
 * cargo do chamador, que precisa de armazenamento persistente.
 */
export function verifySignature(params: {
  keys: SigningKey[];
  headers: Record<string, string | string[] | undefined>;
  method: string;
  path: string;
  body: string | Buffer;
  now?: Date;
}): VerifyResult {
  const h = (name: string) => {
    const v = params.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const keyId = h(SIGNATURE_HEADERS.keyId);
  const timestamp = h(SIGNATURE_HEADERS.timestamp);
  const nonce = h(SIGNATURE_HEADERS.nonce);
  const signature = h(SIGNATURE_HEADERS.signature);
  if (!keyId || !timestamp || !nonce || !signature) return { ok: false, reason: 'MISSING_HEADERS' };
  if (!/^\d{9,11}$/.test(timestamp) || nonce.length < 16 || nonce.length > 64) {
    return { ok: false, reason: 'SIGNATURE_INVALID' };
  }

  const nowSeconds = Math.floor((params.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'TIMESTAMP_SKEW', keyId };
  }

  const candidates = params.keys.filter((k) => k.keyId === keyId && k.secret);
  if (candidates.length === 0) return { ok: false, reason: 'UNKNOWN_KEY', keyId };

  const base = signatureBase({ method: params.method, path: params.path, timestamp, nonce, body: params.body });
  const valid = candidates.some((k) => safeEqual(computeSignature(k.secret, base), signature));
  return valid ? { ok: true, keyId, nonce } : { ok: false, reason: 'SIGNATURE_INVALID', keyId };
}
