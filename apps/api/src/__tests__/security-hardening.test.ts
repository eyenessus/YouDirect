import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import { emptyMatrix, fullMatrix, passwordProblem, type PermissionMatrix } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { csvCell, encodeCursor, hashPassword, redactUrl } from '../common/helpers.js';
import { PiiCipher } from '../common/crypto-pii.js';
import { DEV_SESSION_SECRET, loadEnv, productionProblems, resetEnvCache, type Env } from '../config/env.js';
import { seedRisks } from '../database/seed.js';
import { redactCpf } from '../common/pii-visibility.js';

/* ------------------------------------------------------------------ *
 * SEC — Fase 1 do plano de correções (segurança).
 * ------------------------------------------------------------------ */

describe('configuração de produção (S1)', () => {
  const base = {
    NODE_ENV: 'production',
    MONGODB_URI: 'mongodb+srv://u:p@cluster.mongodb.net/db',
    SESSION_SECRET: 'a'.repeat(64),
    COOKIE_SECURE: 'true',
    APP_URL: 'https://app.exemplo.com.br',
    API_PUBLIC_URL: 'https://app.exemplo.com.br',
    CORS_ORIGINS: 'https://app.exemplo.com.br',
  };

  it('aceita uma configuração de produção segura', () => {
    resetEnvCache();
    expect(() => loadEnv(base as NodeJS.ProcessEnv)).not.toThrow();
    resetEnvCache();
  });

  it('recusa segredo padrão, cookie inseguro e URLs em localhost', () => {
    resetEnvCache();
    expect(() => loadEnv({ ...base, SESSION_SECRET: DEV_SESSION_SECRET } as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET/);
    resetEnvCache();
    const env = { ...base, COOKIE_SECURE: 'false', APP_URL: 'http://localhost:5173', CORS_ORIGINS: 'http://localhost:5173' };
    const problems = productionProblems({
      ...(env as unknown as Env),
      COOKIE_SECURE: false,
      SESSION_SECRET: 'curto-demais-mas-16',
    });
    expect(problems.join('\n')).toMatch(/SESSION_SECRET/);
    expect(problems.join('\n')).toMatch(/COOKIE_SECURE/);
    expect(problems.join('\n')).toMatch(/APP_URL/);
    expect(problems.join('\n')).toMatch(/CORS_ORIGINS/);
    resetEnvCache();
  });

  it('fora de produção não bloqueia o desenvolvimento', () => {
    expect(productionProblems({ NODE_ENV: 'development' } as Env)).toEqual([]);
  });
});

describe('criptografia de PII com chave própria e rotação (S2)', () => {
  it('lê o formato legado e cifra em v2 quando PII_KEY existe', () => {
    const legacy = new PiiCipher('segredo-de-sessao-antigo-123');
    const old = legacy.encrypt('52998224725');
    expect(old.startsWith('v1:')).toBe(true);

    const ring = new PiiCipher({ legacySecret: 'segredo-de-sessao-antigo-123', current: { kid: 'k1', secret: 'k'.repeat(40) } });
    expect(ring.decrypt(old)).toBe('52998224725');
    const fresh = ring.encrypt('52998224725');
    expect(fresh.startsWith('v2:k1:')).toBe(true);
    expect(ring.decrypt(fresh)).toBe('52998224725');
    expect(ring.isCurrent(fresh)).toBe(true);
    expect(ring.isCurrent(old)).toBe(false);
  });

  it('aceita a chave anterior durante a rotação', () => {
    const before = new PiiCipher({ legacySecret: 'x'.repeat(20), current: { kid: 'k1', secret: 'a'.repeat(40) } });
    const enc = before.encrypt('123');
    const after = new PiiCipher({
      legacySecret: 'x'.repeat(20),
      current: { kid: 'k2', secret: 'b'.repeat(40) },
      previous: [{ kid: 'k1', secret: 'a'.repeat(40) }],
    });
    expect(after.decrypt(enc)).toBe('123');
  });

  it('falha de decifração é reportada (uma vez), não engolida', () => {
    const errors: string[] = [];
    const wrong = new PiiCipher({ legacySecret: 'outro-segredo-qualquer', onError: ({ kid }) => errors.push(kid) });
    const enc = new PiiCipher('segredo-original-1234').encrypt('abc');
    expect(wrong.decrypt(enc)).toBeNull();
    expect(wrong.decrypt(enc)).toBeNull();
    expect(errors).toEqual(['v1']);
    expect(wrong.decrypt('v2:kx:a:b:c')).toBeNull();
    expect(errors).toContain('kx');
  });
});

describe('utilitários de segurança (S4, S8, S10, S11)', () => {
  it('senha nova: mínimo 8, sem senhas comuns nem repetição', () => {
    expect(passwordProblem('1234567')).toMatch(/Mínimo/);
    expect(passwordProblem('12345678')).toMatch(/comum/);
    expect(passwordProblem('aaaaaaaaaa')).toMatch(/repetido/);
    expect(passwordProblem('Frota#2026x')).toBeNull();
  });

  it('logs não carregam tokens nem assinaturas', () => {
    expect(redactUrl('/api/v1/inspection-public/abcDEF123/photos')).toBe('/api/v1/inspection-public/[redacted]/photos');
    expect(redactUrl('/api/v1/invitations/tok123')).toBe('/api/v1/invitations/[redacted]');
    expect(redactUrl('/api/v1/files/1/content?org=2&exp=3&sig=SEGREDO')).toBe('/api/v1/files/1/content?org=2&exp=3&sig=[redacted]');
    expect(redactUrl('/api/v1/vehicles?q=abc')).toBe('/api/v1/vehicles?q=abc');
  });

  it('CSV neutraliza fórmulas mas preserva números negativos', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('@SUM(1)')).toBe(`"'@SUM(1)"`);
    expect(csvCell('-150,00')).toBe('"-150,00"');
    expect(csvCell('Aluguel')).toBe('"Aluguel"');
  });

  it('seed recusa produção, Atlas e banco com dados', () => {
    expect(seedRisks({ NODE_ENV: 'development', MONGODB_URI: 'mongodb://localhost/x' }, 0)).toEqual([]);
    expect(seedRisks({ NODE_ENV: 'production', MONGODB_URI: 'mongodb://h/x' }, 0)).toHaveLength(1);
    expect(seedRisks({ NODE_ENV: 'development', MONGODB_URI: 'mongodb+srv://u:p@c.mongodb.net/x' }, 0)).toHaveLength(1);
    expect(seedRisks({ NODE_ENV: 'development', MONGODB_URI: 'mongodb://localhost/x' }, 3)).toHaveLength(1);
  });

  it('CPF mascarado mantém só os dígitos centrais', () => {
    expect(redactCpf('52998224725')).toBe('***.982.247-**');
    expect(redactCpf(null)).toBeNull();
  });
});

describe('API — autenticação, convites e permissões (S3, S5, S6, S7, S9, S12)', () => {
  let harness: TestHarness;
  let ownerCookie: string;
  let organizationId: ObjectId;

  const login = (email: string, password: string, ip = '9.9.9.9', forged = 'x') =>
    harness.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      // O roteador do Heroku acrescenta o IP real ao final do X-Forwarded-For.
      headers: { 'x-forwarded-for': `${forged}, ${ip}` },
      payload: { email, password },
    });

  async function user(email: string, password: string, role: 'OWNER' | 'MEMBER', permissions: PermissionMatrix, org = organizationId) {
    const now = new Date();
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId,
      name: email,
      emailLower: email,
      passwordHash: await hashPassword(password),
      phone: null,
      status: 'ACTIVE',
      browserNotificationsEnabled: false,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await harness.ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(),
      organizationId: org,
      userId,
      role,
      permissions,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    return userId;
  }

  async function org(name: string) {
    const _id = new ObjectId();
    const now = new Date();
    await harness.ctx.mongo.collections.organizations.insertOne({
      _id,
      name,
      legalId: null,
      timezone: 'America/Sao_Paulo',
      currency: 'BRL',
      settings: { freeSeats: 3, extraSeatPriceCents: 990 },
      createdAt: now,
      updatedAt: now,
    });
    return _id;
  }

  beforeAll(async () => {
    harness = await createHarness({ LOGIN_RATE_LIMIT_MAX: '5' });
    organizationId = await org('Org Segura');
    await user('dono@seg.test', 'Dono#Seguro1', 'OWNER', fullMatrix());
    const res = await login('dono@seg.test', 'Dono#Seguro1', '1.1.1.1');
    ownerCookie = sessionCookie(res.headers as Record<string, unknown>);
  });

  afterAll(async () => harness?.close());

  it('S3 — trocar o X-Forwarded-For não renova o limite de tentativas por IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await login(`alvo${i}@seg.test`, 'errada', '7.7.7.7', `10.0.0.${i}`)).statusCode);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('S3 — 10 senhas erradas bloqueiam o e-mail mesmo vindo de IPs diferentes', async () => {
    await user('vitima@seg.test', 'Certa#Senha1', 'MEMBER', fullMatrix());
    for (let i = 0; i < 10; i += 1) {
      const res = await login('vitima@seg.test', 'errada', `20.0.0.${i}`);
      expect(res.statusCode).toBe(401);
    }
    const blocked = await login('vitima@seg.test', 'Certa#Senha1', '30.0.0.1');
    expect(blocked.statusCode).toBe(429);
    // Liberado depois do prazo.
    await harness.ctx.mongo.collections.loginAttempts.updateOne({ _id: 'vitima@seg.test' }, { $set: { lockedUntil: new Date(Date.now() - 1) } });
    expect((await login('vitima@seg.test', 'Certa#Senha1', '30.0.0.2')).statusCode).toBe(200);
  });

  it('S5 — convite para e-mail de conta existente exige a senha DESSA conta', async () => {
    const other = await org('Outra Org');
    await user('existente@seg.test', 'Existente#1', 'OWNER', fullMatrix(), other);
    const invite = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: { cookie: ownerCookie },
      payload: { name: 'Existente', email: 'existente@seg.test', permissions: { vehicles: ['read'] } },
    });
    expect(invite.statusCode).toBe(201);
    const token = (invite.json().acceptUrl as string).split('/').pop()!;

    const info = await harness.app.inject({ method: 'GET', url: `/api/v1/invitations/${token}` });
    expect(info.json().existingAccount).toBe(true);

    // Quem convidou tenta aceitar no lugar do usuário: recusado.
    const hijack = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token, name: 'Intruso', password: 'Qualquer#123', confirmPassword: 'Qualquer#123' },
    });
    expect(hijack.statusCode).toBe(403);

    const ok = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token, name: 'Existente', password: 'Existente#1', confirmPassword: 'Existente#1' },
    });
    expect(ok.statusCode).toBe(200);
    // Link de uso único.
    const again = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token, name: 'Existente', password: 'Existente#1', confirmPassword: 'Existente#1' },
    });
    expect(again.statusCode).toBe(404);
  });

  it('S5/S4 — conta nova pelo convite exige senha forte', async () => {
    const invite = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: { cookie: ownerCookie },
      payload: { name: 'Nova', email: 'nova@seg.test', permissions: { vehicles: ['read'] } },
    });
    const token = (invite.json().acceptUrl as string).split('/').pop()!;
    const weak = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token, name: 'Nova', password: '123456', confirmPassword: '123456' },
    });
    expect(weak.statusCode).toBe(400);
    const strong = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { token, name: 'Nova', password: 'Nova#Senha9', confirmPassword: 'Nova#Senha9' },
    });
    expect(strong.statusCode).toBe(200);
  });

  it('S6/S7 — arquivos e CPF seguem a permissão do módulo', async () => {
    const perms = emptyMatrix();
    perms.rentals = ['read'];
    perms.vehicles = ['read'];
    await user('locacoes@seg.test', 'Locacoes#1', 'MEMBER', perms);
    const member = sessionCookie((await login('locacoes@seg.test', 'Locacoes#1', '5.5.5.5')).headers as Record<string, unknown>);

    // Dono cadastra motorista com CPF e uma locação.
    const vehicle = await harness.app.inject({ method: 'POST', url: '/api/v1/vehicles', headers: { cookie: ownerCookie }, payload: { plate: 'SEG1A23', brand: 'VW', model: 'Gol' } });
    const driver = await harness.app.inject({ method: 'POST', url: '/api/v1/drivers', headers: { cookie: ownerCookie }, payload: { fullName: 'Fulano Seguro', cpf: '529.982.247-25', phone: '11999990000' } });
    const rental = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/rentals',
      headers: { cookie: ownerCookie },
      payload: { vehicleId: vehicle.json().id, driverId: driver.json().id, startDate: '2026-11-01', rentalType: 'MONTHLY', periodicAmountCents: 100000, depositCents: 0 },
    });
    expect(rental.statusCode).toBe(201);

    const asOwner = await harness.app.inject({ method: 'GET', url: `/api/v1/rentals/${rental.json().id}`, headers: { cookie: ownerCookie } });
    expect(asOwner.json().driver.cpf).toBe('52998224725');
    const asMember = await harness.app.inject({ method: 'GET', url: `/api/v1/rentals/${rental.json().id}`, headers: { cookie: member } });
    expect(asMember.statusCode).toBe(200);
    expect(asMember.json().driver.cpf).toBe('***.982.247-**');

    // Upload de documento de motorista sem permissão em motoristas → 403.
    const boundary = '----seg';
    const body =
      `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nDRIVER_ID\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 teste\r\n--${boundary}--\r\n`;
    const upload = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { cookie: member, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(403);
    const ownerUpload = await harness.app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: { cookie: ownerCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(ownerUpload.statusCode).toBe(201);
    const url = await harness.app.inject({ method: 'GET', url: `/api/v1/files/${ownerUpload.json().id}/access-url`, headers: { cookie: member } });
    expect(url.statusCode).toBe(403);
  });

  it('S9 — respostas levam Content-Security-Policy restritiva', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/health' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    // Sem Turnstile configurado, nenhum host externo de script.
    expect(csp).not.toContain('challenges.cloudflare.com');
  });

  it('S12 — cursor de paginação adulterado devolve 400, não 500', async () => {
    const cursor = encodeCursor({ createdAt: 'não-é-data', id: 'nem-objectid' });
    const res = await harness.app.inject({ method: 'GET', url: `/api/v1/vehicles?cursor=${cursor}`, headers: { cookie: ownerCookie } });
    expect(res.statusCode).toBe(400);
  });
});
