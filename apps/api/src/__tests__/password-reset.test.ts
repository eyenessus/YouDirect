import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { seed } from '../database/seed.js';

/** Mailgun falso: guarda cada mensagem recebida (form-urlencoded + Basic). */
interface Captured {
  path: string;
  authorization: string | undefined;
  form: URLSearchParams;
}

describe('recuperação de senha por e-mail (Mailgun)', () => {
  let harness: TestHarness;
  let server: Server;
  const inbox: Captured[] = [];

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    harness.app.inject({ method: 'POST', url: `/api/v1${url}`, payload: payload as object, headers });

  const lastLink = () => {
    const text = inbox.at(-1)!.form.get('text')!;
    return /\/redefinir-senha\/([A-Za-z0-9_-]+)/.exec(text)![1]!;
  };

  beforeAll(async () => {
    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();
      inbox.push({ path: req.url ?? '', authorization: req.headers.authorization, form: new URLSearchParams(body) });
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ id: `<msg-${inbox.length}@mg>`, message: 'Queued. Thank you.' }));
    };
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    harness = await createHarness({
      EMAIL_PROVIDER: 'mailgun',
      MAILGUN_API_KEY: 'key-teste',
      MAILGUN_DOMAIN: 'mg.exemplo.com.br',
      MAILGUN_API_URL: `http://127.0.0.1:${port}`,
      EMAIL_FROM: 'YuDirect <nao-responda@mg.exemplo.com.br>',
    });
    await seed(harness.ctx);
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
    await new Promise((r) => server?.close(r));
  });

  it('e-mail inexistente recebe a mesma resposta e nada é enviado', async () => {
    const before = inbox.length;
    const res = await post('/auth/password/forgot', { email: 'ninguem@exemplo.com.br' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(inbox.length).toBe(before);
  });

  it('envia pelo Mailgun, troca a senha, derruba as sessões e o link não serve duas vezes', async () => {
    const email = harness.env.SEED_OWNER_EMAIL;
    const login = await post('/auth/login', { email, password: harness.env.SEED_OWNER_PASSWORD });
    const oldCookie = sessionCookie(login.headers as Record<string, unknown>);

    const res = await post('/auth/password/forgot', { email });
    expect(res.statusCode).toBe(200);
    const mail = inbox.at(-1)!;
    expect(mail.path).toBe('/v3/mg.exemplo.com.br/messages');
    expect(mail.authorization).toBe(`Basic ${Buffer.from('api:key-teste').toString('base64')}`);
    expect(mail.form.get('to')).toBe(email);
    const token = lastLink();

    const weak = await post('/auth/password/reset', { token, password: '12345678', confirmPassword: '12345678' });
    expect(weak.statusCode).toBe(422);

    const ok = await post('/auth/password/reset', {
      token,
      password: 'Nova-senha-forte-2026',
      confirmPassword: 'Nova-senha-forte-2026',
    });
    expect(ok.statusCode, ok.body).toBe(200);

    // Sessão antiga revogada.
    const me = await harness.app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: oldCookie } });
    expect(me.statusCode).toBe(401);
    // Senha nova vale; antiga não.
    expect((await post('/auth/login', { email, password: 'Nova-senha-forte-2026' })).statusCode).toBe(200);
    expect((await post('/auth/login', { email, password: harness.env.SEED_OWNER_PASSWORD })).statusCode).toBe(401);
    // Uso único.
    const again = await post('/auth/password/reset', {
      token,
      password: 'Outra-senha-forte-2026',
      confirmPassword: 'Outra-senha-forte-2026',
    });
    expect(again.statusCode).toBe(400);
  });

  it('no máximo 3 e-mails por conta por hora', async () => {
    const email = harness.env.SEED_OWNER_EMAIL;
    await harness.ctx.mongo.collections.passwordResets.deleteMany({});
    const before = inbox.length;
    for (let i = 0; i < 4; i += 1) {
      const res = await post('/auth/password/forgot', { email }, { 'x-forwarded-for': `10.0.0.${i}` });
      expect([200, 429]).toContain(res.statusCode);
    }
    expect(inbox.length - before).toBeLessThanOrEqual(3);
  });
});
