import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import type { CreditCheck, CreditCheckResult, CreditIntegrationStatus, CreditUsageReport, DriverPortalAccessResult } from '@yudirect/contracts';
import { createHarness, sessionCookie, type TestHarness } from '../testing/harness.js';
import { sampleReport, startFakeSerasa, type FakeSerasa } from '../testing/fake-serasa.js';
import { seed } from '../database/seed.js';
import { hashPassword } from '../common/helpers.js';
import { expireStaleCreditChecks, purgeExpiredCreditReports } from '../services/credit.js';

/**
 * Análise de crédito pela Serasa (servidor falso): finalidade, custo,
 * duplicidade, limite, permissões, isolamento, retenção e LGPD.
 */
/** CPF válido gerado a partir de uma semente (dígitos verificadores corretos). */
function cpfFrom(seed: number): string {
  const base = String(100000000 + ((seed * 7919) % 899999999)).slice(0, 9).split("").map(Number);
  const dv = (digits: number[]) => {
    const sum = digits.reduce((acc, d, i) => acc + d * (digits.length + 1 - i), 0);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  return [...base, d1, d2].join("");
}

describe('análise de crédito (Serasa)', () => {
  let harness: TestHarness;
  let fake: FakeSerasa;
  let owner: string;
  let orgId: ObjectId;
  let cpfIndex = 0;

  type Method = 'GET' | 'POST' | 'PUT';
  const call = (method: Method, url: string, payload?: unknown, cookie?: string) =>
    harness.app.inject({ method, url, headers: cookie ? { cookie } : {}, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

  let keySeq = 0;
  const request = (driverId: string, cookie: string, extra: Record<string, unknown> = {}) =>
    call(
      'POST',
      `/api/v1/drivers/${driverId}/credit-checks`,
      {
        purpose: 'PRE_LOCACAO',
        justification: 'Análise antes de entregar o carro',
        holderInformed: true,
        confirmCost: true,
        idempotencyKey: `key-${Date.now()}-${++keySeq}`,
        ...extra,
      },
      cookie,
    );

  /** Motorista com CPF ainda não usado (o seed já tem alguns CPFs). */
  const newDriver = async (withCpf = true) => {
    let res;
    do {
      const cpf = cpfFrom(++cpfIndex + 4242);
      res = await call('POST', '/api/v1/drivers', { fullName: `Motorista Crédito ${cpfIndex}`, phone: `1197${String(1000000 + cpfIndex)}`, ...(withCpf ? { cpf } : {}) }, owner);
      if (!withCpf) break;
    } while (res.statusCode === 409 && cpfIndex < 40);
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const doc = await harness.ctx.mongo.collections.drivers.findOne({ _id: new ObjectId(id) });
    return { id, cpf: harness.ctx.pii.decrypt(doc!.cpfEncrypted) };
  };

  const settings = (patch: Record<string, unknown> = {}) =>
    call('PUT', '/api/v1/credit/settings', { enabled: true, costPerQueryCents: 1290, monthlyLimit: 100, reuseDays: 30, retentionDays: 90, ...patch }, owner);

  const memberCookie = async (email: string, permissions: Record<string, string[]>, organizationId = orgId) => {
    const now = new Date();
    const userId = new ObjectId();
    await harness.ctx.mongo.collections.users.insertOne({
      _id: userId, name: email, emailLower: email, passwordHash: await hashPassword('Senha@12345'),
      phone: null, status: 'ACTIVE', browserNotificationsEnabled: false, lastLoginAt: null, createdAt: now, updatedAt: now,
    });
    await harness.ctx.mongo.collections.memberships.insertOne({
      _id: new ObjectId(), organizationId, userId, role: 'MEMBER', permissions: permissions as never, status: 'ACTIVE', createdAt: now, updatedAt: now,
    });
    return sessionCookie((await call('POST', '/api/v1/auth/login', { email, password: 'Senha@12345' })).headers as Record<string, unknown>);
  };

  beforeAll(async () => {
    fake = await startFakeSerasa();
    harness = await createHarness({
      SERASA_CLIENT_ID: fake.clientId,
      SERASA_CLIENT_SECRET: fake.clientSecret,
      SERASA_API_URL: fake.url,
      SERASA_TIMEOUT_MS: '2000',
      LOGIN_RATE_LIMIT_MAX: '100',
      SERASA_RATE_LIMIT_PER_MINUTE: '1000',
    });
    await seed(harness.ctx);
    const login = await call('POST', '/api/v1/auth/login', { email: harness.env.SEED_OWNER_EMAIL, password: harness.env.SEED_OWNER_PASSWORD });
    owner = sessionCookie(login.headers as Record<string, unknown>);
    orgId = (await harness.ctx.mongo.collections.memberships.findOne({ role: 'OWNER' }))!.organizationId;
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
    await fake?.close();
  });

  beforeEach(() => {
    fake.behaviors.clear();
    fake.delayMs = 0;
  });

  it('desligada por padrão: nada é consultado até o administrador ligar', async () => {
    const d = await newDriver();
    const status = (await call('GET', '/api/v1/credit/status', undefined, owner)).json() as CreditIntegrationStatus;
    expect(status).toMatchObject({ connected: true, environment: 'homologacao', reportName: 'RELATORIO_BASICO_PF_PME' });
    expect(status.settings.enabled).toBe(false);
    const res = await request(d.id, owner);
    expect(res.statusCode).toBe(422);
    expect(fake.reportCalls).toHaveLength(0);
  });

  it('teste de autenticação não consulta CPF', async () => {
    const before = fake.reportCalls.length;
    const res = await call('POST', '/api/v1/credit/test-auth', {}, owner);
    expect(res.json()).toMatchObject({ ok: true });
    expect(fake.reportCalls.length).toBe(before);
  });

  it('consulta concluída: relatório cifrado, sem CPF em claro, com auditoria', async () => {
    expect((await settings()).statusCode).toBe(200);
    const d = await newDriver();
    const before = fake.reportCalls.length;
    const res = await request(d.id, owner);
    expect(res.statusCode).toBe(201);
    const { check, reused } = res.json() as CreditCheckResult;
    expect(reused).toBe(false);
    expect(check).toMatchObject({ status: 'COMPLETED', billable: 'YES', estimatedCostCents: 1290, purpose: 'PRE_LOCACAO', environment: 'homologacao' });
    expect(check.report!.score!.score).toBe(612);
    expect(check.report!.hasNegative).toBe(true);
    expect(fake.reportCalls.length).toBe(before + 1);
    expect(fake.reportCalls.at(-1)!.cpf).toBe(d.cpf);

    const raw = await harness.ctx.mongo.collections.creditChecks.findOne({ _id: new ObjectId(check.id) });
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(d.cpf!);
    expect(serialized).not.toContain('FULANO DE TESTE');
    expect(raw!.documentHash).toMatch(/^[a-f0-9]{32,}$/);
    expect(raw!.legalBasis).toBe('PROTECAO_CREDITO');

    const logs = await harness.ctx.mongo.collections.auditLogs.find({ entityId: raw!._id }).toArray();
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(['credit.check_requested', 'credit.check_completed']));
    expect(JSON.stringify(logs)).not.toContain(d.cpf!);
  });

  it('clique repetido (mesma chave) devolve a mesma consulta sem nova chamada', async () => {
    const d = await newDriver();
    const key = `dup-${Date.now()}`;
    const a = await request(d.id, owner, { idempotencyKey: key });
    const calls = fake.reportCalls.length;
    const b = await request(d.id, owner, { idempotencyKey: key });
    expect(b.json().check.id).toBe(a.json().check.id);
    expect(fake.reportCalls.length).toBe(calls);
  });

  it('reaproveita a consulta recente; "nova consulta" chama de novo', async () => {
    const d = await newDriver();
    await request(d.id, owner);
    const calls = fake.reportCalls.length;
    const again = await request(d.id, owner);
    expect(again.statusCode).toBe(200);
    expect(again.json().reused).toBe(true);
    expect(fake.reportCalls.length).toBe(calls);
    const forced = await request(d.id, owner, { forceNew: true });
    expect(forced.statusCode).toBe(201);
    expect(fake.reportCalls.length).toBe(calls + 1);
  });

  it('duas consultas simultâneas do mesmo motorista: só uma chega à Serasa', async () => {
    const d = await newDriver();
    fake.delayMs = 400;
    const [a, b] = await Promise.all([request(d.id, owner, { forceNew: true }), request(d.id, owner, { forceNew: true })]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    expect(fake.reportCalls.filter((c) => c.cpf === d.cpf)).toHaveLength(1);
  });

  it('exige finalidade, ciência do motorista e confirmação de custo', async () => {
    const d = await newDriver();
    for (const bad of [{ justification: 'curto' }, { holderInformed: false }, { confirmCost: false }, { purpose: 'CURIOSIDADE' }]) {
      expect((await request(d.id, owner, bad)).statusCode).toBe(422);
    }
  });

  it('motorista sem CPF ou com CPF inválido não é consultado', async () => {
    const semCpf = await newDriver(false);
    expect((await request(semCpf.id, owner)).statusCode).toBe(422);
    const d = await newDriver();
    await harness.ctx.mongo.collections.drivers.updateOne({ _id: new ObjectId(d.id) }, { $set: { cpfEncrypted: harness.ctx.pii.encrypt('11111111111') } });
    const calls = fake.reportCalls.length;
    expect((await request(d.id, owner)).statusCode).toBe(422);
    expect(fake.reportCalls.length).toBe(calls);
  });

  it('sem informação (403/30) não vira "sem risco"; recusa (401/10) não conta como cobrada', async () => {
    const a = await newDriver();
    fake.behaviors.set(a.cpf!, { kind: 'error', status: 403, code: '30', message: 'Information not available for the document consulted.' });
    const na = (await request(a.id, owner)).json() as CreditCheckResult;
    expect(na.check).toMatchObject({ status: 'NOT_AVAILABLE', billable: 'UNKNOWN', report: null });
    expect(na.check.message).toContain('não indica ausência de risco');

    const b = await newDriver();
    fake.behaviors.set(b.cpf!, { kind: 'error', status: 401, code: '10', message: "You don't have access to this product yet." });
    const pe = (await request(b.id, owner)).json() as CreditCheckResult;
    expect(pe.check).toMatchObject({ status: 'FAILED', outcome: 'PRODUCT_NOT_ENABLED', billable: 'NO', estimatedCostCents: 0 });
  });

  it('erro 500 vira incerto e não é repetido automaticamente', async () => {
    const d = await newDriver();
    fake.behaviors.set(d.cpf!, { kind: 'error', status: 500, code: '20', message: 'An internal error has occurred' });
    const res = (await request(d.id, owner)).json() as CreditCheckResult;
    expect(res.check).toMatchObject({ status: 'UNCERTAIN', outcome: 'SERVER_ERROR', billable: 'UNKNOWN' });
    expect(fake.reportCalls.filter((c) => c.cpf === d.cpf)).toHaveLength(1);
  });

  it('limite mensal bloqueia novas consultas cobráveis', async () => {
    const used = (await call('GET', '/api/v1/credit/status', undefined, owner)).json().usage.billable as number;
    await settings({ monthlyLimit: used });
    const d = await newDriver();
    const res = await request(d.id, owner);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('Limite mensal');
    await settings();
  });

  it('decisão é humana, justificada e auditada', async () => {
    const d = await newDriver();
    const { check } = (await request(d.id, owner)).json() as CreditCheckResult;
    expect((await call('POST', `/api/v1/credit-checks/${check.id}/review`, { decision: 'APROVADO' }, owner)).statusCode).toBe(422);
    const ok = await call('POST', `/api/v1/credit-checks/${check.id}/review`, { decision: 'APROVADO_COM_CAUCAO', notes: 'Pefin antigo; caução de 2 semanas.' }, owner);
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as CreditCheck).review).toMatchObject({ decision: 'APROVADO_COM_CAUCAO' });
    const log = await harness.ctx.mongo.collections.auditLogs.findOne({ action: 'credit.check_reviewed', entityId: new ObjectId(check.id) });
    expect(log).not.toBeNull();

    // Consulta que falhou não recebe decisão.
    const e = await newDriver();
    fake.behaviors.set(e.cpf!, { kind: 'error', status: 412, code: '70', message: 'The document number entered is incorrect.' });
    const failed = (await request(e.id, owner)).json() as CreditCheckResult;
    expect((await call('POST', `/api/v1/credit-checks/${failed.check.id}/review`, { decision: 'RECUSADO', notes: 'teste de recusa' }, owner)).statusCode).toBe(409);
  });

  it('permissões: sem módulo nada; leitura não consulta; consulta não decide; config só admin', async () => {
    const d = await newDriver();
    const { check } = (await request(d.id, owner)).json() as CreditCheckResult;
    const none = await memberCookie('sem-credito@teste.com', { drivers: ['read'] });
    const reader = await memberCookie('leitor-credito@teste.com', { credit: ['read'] });
    const requester = await memberCookie('analista-credito@teste.com', { credit: ['read', 'request'] });

    expect((await call('GET', '/api/v1/credit/status', undefined, none)).statusCode).toBe(403);
    expect((await call('GET', `/api/v1/credit-checks/${check.id}`, undefined, none)).statusCode).toBe(403);
    expect((await request(d.id, none)).statusCode).toBe(403);

    expect((await call('GET', `/api/v1/credit-checks/${check.id}`, undefined, reader)).statusCode).toBe(200);
    expect((await request(d.id, reader)).statusCode).toBe(403);

    expect((await request(d.id, requester)).statusCode).toBe(200); // reaproveitada
    expect((await call('POST', `/api/v1/credit-checks/${check.id}/review`, { decision: 'APROVADO', notes: 'sem permissão' }, requester)).statusCode).toBe(403);

    for (const cookie of [reader, requester]) {
      expect((await call('PUT', '/api/v1/credit/settings', { enabled: false, costPerQueryCents: null, monthlyLimit: null, reuseDays: 0, retentionDays: 30 }, cookie)).statusCode).toBe(403);
      expect((await call('POST', '/api/v1/credit/test-auth', {}, cookie)).statusCode).toBe(403);
    }
    expect((await call('GET', '/api/v1/credit/status')).statusCode).toBe(401);
  });

  it('isolamento: outra organização não vê nem consulta', async () => {
    const d = await newDriver();
    const { check } = (await request(d.id, owner)).json() as CreditCheckResult;
    const now = new Date();
    const otherOrg = new ObjectId();
    await harness.ctx.mongo.collections.organizations.insertOne({
      _id: otherOrg, name: 'Outra Locadora', legalId: null, timezone: 'America/Sao_Paulo', currency: 'BRL',
      settings: { freeSeats: 3, extraSeatPriceCents: 990, credit: { enabled: true, costPerQueryCents: null, monthlyLimit: null, reuseDays: 30, retentionDays: 90 } },
      createdAt: now, updatedAt: now,
    });
    const stranger = await memberCookie('outra-org@teste.com', { credit: ['read', 'request', 'review'], drivers: ['read'] }, otherOrg);
    expect((await call('GET', `/api/v1/credit-checks/${check.id}`, undefined, stranger)).statusCode).toBe(404);
    expect((await call('GET', `/api/v1/drivers/${d.id}/credit-checks`, undefined, stranger)).statusCode).toBe(404);
    expect((await request(d.id, stranger)).statusCode).toBe(404);
    expect((await call('POST', `/api/v1/credit-checks/${check.id}/review`, { decision: 'RECUSADO', notes: 'invasão' }, stranger)).statusCode).toBe(404);
    const list = (await call('GET', '/api/v1/credit-checks', undefined, stranger)).json();
    expect(list.data).toHaveLength(0);
  });

  it('Área do Motorista não acessa nada da Serasa', async () => {
    const d = await newDriver();
    const access = (await call('POST', `/api/v1/drivers/${d.id}/portal-access`, undefined, owner)).json() as DriverPortalAccessResult;
    const login = await call('POST', '/api/v1/driver/login', { token: access.link.split('/motorista/entrar/')[1] });
    const driverCookie = sessionCookie(login.headers as Record<string, unknown>, 'yudirect_driver');
    expect((await call('GET', '/api/v1/credit/status', undefined, driverCookie)).statusCode).toBe(401);
    expect((await call('GET', `/api/v1/drivers/${d.id}/credit-checks`, undefined, driverCookie)).statusCode).toBe(401);
  });

  it('histórico com filtros (sem conteúdo do relatório) e consumo do mês', async () => {
    const list = (await call('GET', '/api/v1/credit-checks?status=COMPLETED&limit=2', undefined, owner)).json();
    expect(list.data.length).toBeGreaterThan(0);
    expect(list.data.every((c: CreditCheck) => c.status === 'COMPLETED' && c.report === null)).toBe(true);
    expect(list.page.nextCursor).not.toBeNull();
    const next = (await call('GET', `/api/v1/credit-checks?status=COMPLETED&limit=2&cursor=${list.page.nextCursor}`, undefined, owner)).json();
    expect(next.data[0].id).not.toBe(list.data[0].id);

    const usage = (await call('GET', '/api/v1/credit/usage?months=3', undefined, owner)).json() as CreditUsageReport;
    expect(usage.months).toHaveLength(3);
    const current = usage.months[0]!;
    expect(current.total).toBeGreaterThan(0);
    expect(current.notBilled).toBeGreaterThan(0); // recusas (401/10, 412/70)
    expect(current.reused).toBeGreaterThan(0);
    expect(current.estimatedCostCents).toBe(current.billable * 1290);
    expect(usage.byUser[0]!.total).toBeGreaterThan(0);
  });

  it('retenção: relatório vencido é apagado e o registro fica', async () => {
    const d = await newDriver();
    const { check } = (await request(d.id, owner)).json() as CreditCheckResult;
    await harness.ctx.mongo.collections.creditChecks.updateOne({ _id: new ObjectId(check.id) }, { $set: { reportExpiresAt: new Date(Date.now() - 1000) } });
    expect(await purgeExpiredCreditReports(harness.ctx)).toBeGreaterThan(0);
    const after = (await call('GET', `/api/v1/credit-checks/${check.id}`, undefined, owner)).json() as CreditCheck;
    expect(after).toMatchObject({ status: 'COMPLETED', report: null, reportPurged: true });
    // Sem relatório guardado, a próxima consulta não é "reaproveitada".
    const again = await request(d.id, owner);
    expect(again.statusCode).toBe(201);
  });

  it('consulta presa em andamento vira incerta (sem nova chamada)', async () => {
    const d = await newDriver();
    const now = new Date();
    const _id = new ObjectId();
    await harness.ctx.mongo.collections.creditChecks.insertOne({
      _id, organizationId: orgId, driverId: new ObjectId(d.id), rentalId: null, requestedBy: new ObjectId(), purpose: 'PRE_LOCACAO',
      justification: 'processo caiu no meio', legalBasis: 'PROTECAO_CREDITO', holderInformedAt: now, idempotencyKey: `stale-${_id}`,
      documentHash: 'x', environment: 'homologacao', reportName: 'RELATORIO_BASICO_PF_PME', optionalFeatures: [], status: 'PENDING',
      outcome: null, message: null, httpStatus: null, providerCode: null, billable: 'UNKNOWN', estimatedCostCents: null,
      requestedAt: new Date(now.getTime() - 11 * 60_000), completedAt: null, reportEncrypted: null, reportExpiresAt: null,
      reportPurgedAt: null, review: null, createdAt: now, updatedAt: now, version: 1,
    });
    expect(await expireStaleCreditChecks(harness.ctx)).toBe(1);
    const doc = await harness.ctx.mongo.collections.creditChecks.findOne({ _id });
    expect(doc).toMatchObject({ status: 'UNCERTAIN', outcome: 'INTERRUPTED' });
  });

  it('LGPD: exportação inclui as consultas; anonimizar apaga os relatórios', async () => {
    const d = await newDriver();
    await request(d.id, owner, { forceNew: true });
    const exported = await call('GET', `/api/v1/drivers/${d.id}/data-export`, undefined, owner);
    const payload = JSON.parse(exported.body);
    expect(payload.creditChecks[0]).toMatchObject({ purpose: 'PRE_LOCACAO', source: 'Serasa Experian' });
    expect(payload.creditChecks[0].report.score.score).toBe(612);

    expect((await call('POST', `/api/v1/drivers/${d.id}/anonymize`, { confirm: 'ANONIMIZAR' }, owner)).statusCode).toBe(200);
    const left = await harness.ctx.mongo.collections.creditChecks.find({ driverId: new ObjectId(d.id) }).toArray();
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((c) => c.reportEncrypted === null && c.reportPurgedAt)).toBe(true);
    expect((await request(d.id, owner)).statusCode).toBe(404);
  });

  it('relatório com dados reais da Serasa aparece por inteiro só no detalhe do motorista', async () => {
    const d = await newDriver();
    fake.behaviors.set(d.cpf!, { kind: 'report', body: sampleReport({ score: 845, pefin: 0 }) });
    await request(d.id, owner, { forceNew: true });
    const list = (await call('GET', `/api/v1/drivers/${d.id}/credit-checks`, undefined, owner)).json();
    expect(list.data[0].report.score.score).toBe(845);
    const viewed = await harness.ctx.mongo.collections.auditLogs.countDocuments({ action: 'credit.report_viewed', entityId: new ObjectId(list.data[0].id) });
    expect(viewed).toBe(1);
  });
});
