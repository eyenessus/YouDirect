import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Criptografia de campos sensíveis (CPF, RG) em repouso.
 * AES-256-GCM com chave derivada do SESSION_SECRET via SHA-256.
 * Formato: v1:<iv b64>:<tag b64>:<ciphertext b64>
 */
export class PiiCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash('sha256').update(`pii:${secret}`).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  decrypt(payload: string | null | undefined): string | null {
    if (!payload) return null;
    const parts = payload.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(parts[1]!, 'base64'));
      decipher.setAuthTag(Buffer.from(parts[2]!, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64')), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      return null;
    }
  }
}
