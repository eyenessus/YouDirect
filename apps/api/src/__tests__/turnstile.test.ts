import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { productionProblems, type Env } from '../config/env.js';
import { createTurnstileVerifier } from '../integrations/turnstile.js';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';

/**
 * Anti-robô do login (Cloudflare Turnstile) contra um siteverify falso no
 * formato documentado: { success, "error-codes", action }.
 */
const SECRET = 'segredo-turnstile-de-teste';

interface FakeSiteverify {
  url: string;
  calls: Array<Record<string, string>>;
  down: boolean;
  close(): Promise<void>;
}

async function startFakeSiteverify(): Promise<FakeSiteverify> {
  const state = { calls: [] as Array<Record<string, string>>, down: false };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    state.calls.push(form);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (state.down) return json(503, {});
    if (form.secret !== SECRET) return json(200, { success: false, 'error-codes': ['invalid-input-secret'] });
    switch (form.response) {
      case 'token-ok':
        return json(200, { success: true, action: 'login', hostname: 'yudirect.test', 'error-codes': [] });
      case 'token-sem-action':
        return json(200, { success: true, hostname: 'example.com', 'error-codes': [] });
      case 'token-outra-acao':
        return json(200, { success: true, action: 'signup', 'error-codes': [] });
      case 'token-usado':
        return json(200, { success: false, 'error-codes': ['timeout-or-duplicate'] });
      case 'token-erro-interno':
        return json(200, { success: false, 'error-codes': ['internal-error'] });
      default:
        return json(200, { success: false, 'error-codes': ['invalid-input-response'] });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}/turnstile/v0/siteverify`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  });
}

const envFor = (url: string, extra: Partial<Env> = {}) =>
  ({ TURNSTILE_SITE_KEY: '0x4AAAAAAA-site', TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_VERIFY_URL: url, ...extra }) as Env;

describe('verificador do Turnstile', () => {
  let fake: FakeSiteverify;
  beforeAll(async () => {
    fake = await startFakeSiteverify();
  });
  afterAll(async () => {
    await fake.close();
  });

  it('desligado sem as chaves: não exige nada e não chama a Cloudflare', async () => {
    const v = createTurnstileVerifier({ TURNSTILE_VERIFY_URL: fake.url } as Env);
    expect(v.enabled()).toBe(false);
    expect(v.siteKey()).toBeNull();
    expect(await v.verify(undefined, '1.2.3.4')).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(0);
  });

  it('aceita token válido e envia secret, response e remoteip', async () => {
    const v = createTurnstileVerifier(envFor(fake.url));
    expect(await v.verify('token-ok', '203.0.113.9')).toEqual({ ok: true });
    expect(fake.calls.at(-1)).toEqual({ secret: SECRET, response: 'token-ok', remoteip: '203.0.113.9' });
    // As chaves de teste da Cloudflare não devolvem action: aceito.
    expect(await v.verify('token-sem-action', undefined)).toEqual({ ok: true });
  });

  it('recusa token ausente, longo demais, inválido, usado e de outra ação', async () => {
    const v = createTurnstileVerifier(envFor(fake.url));
    const before = fake.calls.length;
    expect(await v.verify(undefined, undefined)).toMatchObject({ ok: false, reason: 'MISSING' });
    expect(await v.verify('x'.repeat(2049), undefined)).toMatchObject({ ok: false, reason: 'MISSING' });
    expect(fake.calls.length).toBe(before); // nem chega à Cloudflare
    expect(await v.verify('qualquer', undefined)).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await v.verify('token-usado', undefined)).toMatchObject({ ok: false, reason: 'EXPIRED_OR_USED' });
    expect(await v.verify('token-outra-acao', undefined)).toMatchObject({ ok: false, reason: 'WRONG_ACTION' });
  });

  it('Cloudflare fora do ar: falha fechada (UNAVAILABLE)', async () => {
    const v = createTurnstileVerifier(envFor(fake.url));
    fake.down = true;
    expect(await v.verify('token-ok', undefined)).toMatchObject({ ok: false, reason: 'UNAVAILABLE' });
    fake.down = false;
    expect(await v.verify('token-erro-interno', undefined)).toMatchObject({ ok: false, reason: 'UNAVAILABLE' });
    const offline = createTurnstileVerifier(envFor('http://127.0.0.1:9/siteverify'));
    expect(await offline.verify('token-ok', undefined)).toMatchObject({ ok: false, reason: 'UNAVAILABLE' });
  });

  it('produção: chaves juntas e nunca as chaves de teste', () => {
    const base = { NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), COOKIE_SECURE: true, MONGODB_URI: 'mongodb://x', APP_URL: 'https://a.com', API_PUBLIC_URL: 'https://a.com', CORS_ORIGINS: 'https://a.com' } as unknown as Env;
    expect(productionProblems({ ...base, TURNSTILE_SITE_KEY: '0x4AAA' }).join()).toMatch(/TURNSTILE/);
    expect(productionProblems({ ...base, TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }).join()).toMatch(/TESTE/);
    expect(productionProblems({ ...base, TURNSTILE_SITE_KEY: '0x4AAA', TURNSTILE_SECRET_KEY: '0x4AAA-secret' })).toEqual([]);
  });
});

describe('login com Turnstile ligado', () => {
  let fake: FakeSiteverify;
  let harness: TestHarness;
  const login = (payload: Record<string, unknown>) => harness.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload });
  let credentials: { email: string; password: string };

  beforeAll(async () => {
    fake = await startFakeSiteverify();
    harness = await createHarness({
      TURNSTILE_SITE_KEY: '0x4AAAAAAA-site',
      TURNSTILE_SECRET_KEY: SECRET,
      TURNSTILE_VERIFY_URL: fake.url,
      LOGIN_RATE_LIMIT_MAX: '100',
    });
    await seed(harness.ctx);
    credentials = { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD };
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
    await fake?.close();
  });

  it('a tela recebe só a chave pública', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/api/v1/auth/login-config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ captcha: { provider: 'turnstile', siteKey: '0x4AAAAAAA-site', action: 'login' } });
    expect(res.body).not.toContain(SECRET);
  });

  it('sem token ou com token inválido/usado: 400 e a senha nem é testada', async () => {
    const before = await harness.ctx.mongo.collections.loginAttempts.countDocuments();
    for (const captchaToken of [undefined, 'qualquer', 'token-usado', 'token-outra-acao']) {
      const res = await login({ ...credentials, ...(captchaToken ? { captchaToken } : {}) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toMatch(/anti-robô/);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    // Não conta como senha errada (não bloqueia o usuário por falha do desafio).
    expect(await harness.ctx.mongo.collections.loginAttempts.countDocuments()).toBe(before);
  });

  it('com token válido entra normalmente; senha errada continua 401', async () => {
    const ok = await login({ ...credentials, captchaToken: 'token-ok' });
    expect(ok.statusCode).toBe(200);
    expect(sessionCookie(ok.headers as Record<string, unknown>)).toContain('yudirect_session=');
    expect(fake.calls.at(-1)?.remoteip).toBeTruthy();
    const wrong = await login({ ...credentials, password: 'Errada@123', captchaToken: 'token-ok' });
    expect(wrong.statusCode).toBe(401);
  });

  it('Cloudflare fora do ar: 503 honesto, sem entrar', async () => {
    fake.down = true;
    const res = await login({ ...credentials, captchaToken: 'token-ok' });
    fake.down = false;
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/indisponível/);
  });

  it('CSP libera só o script e o iframe da Cloudflare', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/health' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(csp).not.toContain("'unsafe-inline' https://challenges");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
