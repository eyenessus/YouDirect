import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Criptografia de campos sensíveis (CPF, RG, tokens guardados) em repouso.
 * AES-256-GCM. Dois formatos convivem:
 *
 *   v1:<iv>:<tag>:<ct>        legado — chave = sha256("pii:" + segredo legado)
 *   v2:<kid>:<iv>:<tag>:<ct>  atual  — chave de `PII_KEY`, identificada por `kid`
 *
 * Com `PII_KEY` configurada, tudo que é cifrado de novo usa v2; os dados v1
 * continuam legíveis com o segredo legado (`PII_LEGACY_SECRET`, ou o
 * `SESSION_SECRET` enquanto ele não for trocado). Assim o `SESSION_SECRET`
 * pode ser rotacionado sem perder CPF/RG — basta rodar
 * `scripts/rotate-pii.ts` antes, para recifrar em v2.
 *
 * Falha de decifração NÃO é silenciosa: é reportada uma vez por chave
 * (`onError`), porque um `null` mudo apagaria dados da interface sem aviso.
 */
export interface PiiKeyring {
  /** Chave atual (hex/base64/texto ≥ 32 chars) e seu identificador. */
  current?: { kid: string; secret: string } | null;
  /** Chaves anteriores ainda aceitas para leitura (rotação). */
  previous?: Array<{ kid: string; secret: string }>;
  /** Segredo do formato v1 (legado). */
  legacySecret: string;
  onError?: (info: { kid: string; reason: string }) => void;
}

const deriveKey = (secret: string, label: string) => createHash('sha256').update(`${label}:${secret}`).digest();

export class PiiCipher {
  private readonly legacyKey: Buffer;
  private readonly keys = new Map<string, Buffer>();
  private readonly currentKid: string | null;
  private readonly onError: PiiKeyring['onError'];
  private readonly reported = new Set<string>();

  constructor(input: string | PiiKeyring) {
    const ring: PiiKeyring = typeof input === 'string' ? { legacySecret: input } : input;
    this.legacyKey = deriveKey(ring.legacySecret, 'pii');
    this.onError = ring.onError;
    for (const k of ring.previous ?? []) this.keys.set(k.kid, deriveKey(k.secret, 'pii-v2'));
    if (ring.current) {
      this.keys.set(ring.current.kid, deriveKey(ring.current.secret, 'pii-v2'));
      this.currentKid = ring.current.kid;
    } else {
      this.currentKid = null;
    }
  }

  /** Identificador da chave usada para cifrar agora (`v1` = legado). */
  get currentVersion(): string {
    return this.currentKid ? `v2:${this.currentKid}` : 'v1';
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const key = this.currentKid ? this.keys.get(this.currentKid)! : this.legacyKey;
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const body = `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
    return this.currentKid ? `v2:${this.currentKid}:${body}` : `v1:${body}`;
  }

  /** True quando o valor já está cifrado com a chave atual. */
  isCurrent(payload: string | null | undefined): boolean {
    if (!payload) return true;
    return this.currentKid ? payload.startsWith(`v2:${this.currentKid}:`) : payload.startsWith('v1:');
  }

  decrypt(payload: string | null | undefined): string | null {
    if (!payload) return null;
    const parts = payload.split(':');
    let kid: string;
    let key: Buffer | undefined;
    let rest: string[];
    if (parts[0] === 'v1' && parts.length === 4) {
      kid = 'v1';
      key = this.legacyKey;
      rest = parts.slice(1);
    } else if (parts[0] === 'v2' && parts.length === 5) {
      kid = parts[1]!;
      key = this.keys.get(kid);
      rest = parts.slice(2);
    } else {
      this.report('formato', 'formato desconhecido');
      return null;
    }
    if (!key) {
      this.report(kid, 'chave não configurada');
      return null;
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(rest[0]!, 'base64'));
      decipher.setAuthTag(Buffer.from(rest[1]!, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(rest[2]!, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      this.report(kid, 'falha de autenticação (chave errada ou dado corrompido)');
      return null;
    }
  }

  private report(kid: string, reason: string): void {
    if (this.reported.has(kid)) return;
    this.reported.add(kid);
    this.onError?.({ kid, reason });
  }
}
