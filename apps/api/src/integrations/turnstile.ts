import type { Env } from '../config/env.js';

/* ------------------------------------------------------------------ *
 * Cloudflare Turnstile (anti-robô do login).
 * developers.cloudflare.com/turnstile/get-started/server-side-validation/
 * - POST https://challenges.cloudflare.com/turnstile/v0/siteverify
 *   (form-urlencoded: secret, response, remoteip).
 * - Token: até 2048 caracteres, vale 300 s e é de uso único.
 * - Falha fechada: se a Cloudflare não responder, o login é recusado
 *   (o desafio não pode ser pulado derrubando a verificação).
 * ------------------------------------------------------------------ */

export const TURNSTILE_ACTION = 'login';
const TIMEOUT_MS = 8000;

export type TurnstileResult =
  | { ok: true }
  | { ok: false; reason: 'MISSING' | 'INVALID' | 'EXPIRED_OR_USED' | 'WRONG_ACTION' | 'UNAVAILABLE'; errorCodes: string[] };

export interface TurnstileVerifier {
  enabled(): boolean;
  siteKey(): string | null;
  verify(token: string | undefined, remoteIp: string | undefined): Promise<TurnstileResult>;
}

export function createTurnstileVerifier(env: Env, fetchImpl: typeof fetch = fetch): TurnstileVerifier {
  const enabled = Boolean(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
  return {
    enabled: () => enabled,
    siteKey: () => (enabled ? env.TURNSTILE_SITE_KEY! : null),
    async verify(token, remoteIp) {
      if (!enabled) return { ok: true };
      if (!token || token.length > 2048) return { ok: false, reason: 'MISSING', errorCodes: [] };
      const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!, response: token });
      if (remoteIp) form.set('remoteip', remoteIp);
      let body: { success?: boolean; 'error-codes'?: string[]; action?: string };
      try {
        const res = await fetchImpl(env.TURNSTILE_VERIFY_URL, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        if (!res.ok) return { ok: false, reason: 'UNAVAILABLE', errorCodes: [`http-${res.status}`] };
        body = (await res.json()) as typeof body;
      } catch {
        return { ok: false, reason: 'UNAVAILABLE', errorCodes: ['network'] };
      }
      const codes = Array.isArray(body['error-codes']) ? body['error-codes'] : [];
      if (body.success !== true) {
        if (codes.includes('internal-error')) return { ok: false, reason: 'UNAVAILABLE', errorCodes: codes };
        return { ok: false, reason: codes.includes('timeout-or-duplicate') ? 'EXPIRED_OR_USED' : 'INVALID', errorCodes: codes };
      }
      // As chaves de teste omitem `action`; quando vem, precisa ser a do login.
      if (body.action && body.action !== TURNSTILE_ACTION) return { ok: false, reason: 'WRONG_ACTION', errorCodes: codes };
      return { ok: true };
    },
  };
}
