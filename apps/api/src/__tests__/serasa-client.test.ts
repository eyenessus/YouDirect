import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { creditStatus, serasaBaseUrl, type Env } from '../config/env.js';
import { createCreditBureauProvider, normalizeSerasaReport, tokenLifetimeSeconds } from '../integrations/serasa.js';
import { sampleReport, startFakeSerasa, type FakeSerasa } from '../testing/fake-serasa.js';

/**
 * Cliente da Serasa contra um servidor falso no formato do OpenAPI oficial:
 * token (cache, concorrência, expiração, renovação), mapeamento dos erros
 * documentados e a regra de nunca repetir consulta possivelmente cobrada.
 */
const CPF = '41827365080';

function envFor(fake: FakeSerasa | null, extra: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    SERASA_ENVIRONMENT: 'homologacao',
    SERASA_CLIENT_ID: fake?.clientId,
    SERASA_CLIENT_SECRET: fake?.clientSecret,
    SERASA_API_URL: fake?.url,
    SERASA_REPORT_NAME: 'RELATORIO_BASICO_PF_PME',
    SERASA_OPTIONAL_FEATURES: '',
    SERASA_TIMEOUT_MS: 5000,
    ...extra,
  } as Env;
}

describe('normalização do Relatório Básico PF', () => {
  it('extrai score, anotações por categoria e resumo — sem filiação nem endereço', () => {
    const report = normalizeSerasaReport(sampleReport({ pefin: 2 }))!;
    expect(report.consumerName).toBe('FULANO DE TESTE');
    expect(report.registrationStatus).toBe('REGULAR');
    expect(report.score).toEqual({ score: 612, model: 'HRLN', range: 'D', defaultRate: '7,5%', message: 'Risco moderado' });
    const pefin = report.negatives.find((g) => g.type === 'PEFIN')!;
    expect(pefin).toMatchObject({ availability: 'RETURNED', count: 2, balanceCents: 246912 });
    expect(pefin.items[0]).toMatchObject({ creditor: 'BANCO EXEMPLO 1', amountCents: 123456, state: 'SP', subJudice: false });
    expect(report.negatives.find((g) => g.type === 'PROTESTO')).toMatchObject({ count: 1, balanceCents: 50000 });
    expect(report.negatives.find((g) => g.type === 'COBRANCA')!.availability).toBe('NOT_RETURNED');
    expect(report.hasNegative).toBe(true);
    expect(report.inquiriesThisMonth).toBe(3);
    expect(report.stolenDocumentAlerts).toBe(0);
    const stored = JSON.stringify(report);
    expect(stored).not.toContain('NAO DEVE SER GUARDADO');
    expect(stored).not.toContain('RUA QUE NAO DEVE');
  });

  it('sem score: guarda a mensagem; formato scoreResponse também é aceito', () => {
    const noScore = normalizeSerasaReport(sampleReport({ score: null }))!;
    expect(noScore.score).toBeNull();
    expect(noScore.scoreMessage).toBe('Score não calculado para o documento.');

    const nested = sampleReport();
    (nested.reports[0] as Record<string, unknown>).score = { scoreResponse: { score: 845, scoreModel: 'HSPN', range: 'A' } };
    expect(normalizeSerasaReport(nested)!.score).toMatchObject({ score: 845, model: 'HSPN', range: 'A' });
  });

  it('não afirma "sem anotações" quando os blocos não vieram', () => {
    const body = { reports: [{ reportName: 'X', registration: { consumerName: 'A' } }] };
    const report = normalizeSerasaReport(body)!;
    expect(report.hasNegative).toBeNull();
    expect(report.negatives.every((g) => g.availability === 'NOT_RETURNED')).toBe(true);

    const clean = sampleReport({ pefin: 0 });
    const neg = clean.reports[0]!.negativeData as Record<string, unknown>;
    neg.notary = { notaryResponse: [], summary: { count: 0, balance: 0 } };
    expect(normalizeSerasaReport(clean)!.hasNegative).toBe(false);
  });

  it('negativeData do bloco opcional (ANOTACOES_COMPLETAS) prevalece', () => {
    const body = sampleReport({ pefin: 1 }) as Record<string, unknown>;
    body.optionalFeatures = { negativeData: { pefin: { pefinResponse: [], summary: { count: 7, balance: 70 } } } };
    expect(normalizeSerasaReport(body)!.negatives.find((g) => g.type === 'PEFIN')!.count).toBe(7);
  });

  it('formato desconhecido devolve null', () => {
    expect(normalizeSerasaReport({ unexpected: true })).toBeNull();
    expect(normalizeSerasaReport({ reports: [] })).toBeNull();
    expect(normalizeSerasaReport(null)).toBeNull();
  });

  it('validade do token: aceita segundos em string e limita a 1 h', () => {
    expect(tokenLifetimeSeconds('3600')).toBe(3600);
    expect(tokenLifetimeSeconds('1800')).toBe(1800);
    expect(tokenLifetimeSeconds('999999999')).toBe(3600);
    expect(tokenLifetimeSeconds('abc')).toBe(3600);
    expect(tokenLifetimeSeconds(undefined)).toBe(3600);
  });
});

describe('ambientes e configuração', () => {
  it('sem credenciais: indisponível, sem chamar ninguém', async () => {
    const env = envFor(null);
    expect(creditStatus(env).connected).toBe(false);
    const provider = createCreditBureauProvider(env);
    expect((await provider.fetchReport(CPF))).toMatchObject({ kind: 'REJECTED', outcome: 'NOT_CONFIGURED' });
    expect((await provider.testAuth()).ok).toBe(false);
  });

  it('URLs oficiais por ambiente e bloqueio de credencial de produção fora da produção', () => {
    const base = { SERASA_CLIENT_ID: 'a', SERASA_CLIENT_SECRET: 'b', SERASA_API_URL: undefined };
    expect(serasaBaseUrl(envFor(null, { ...base }))).toBe('https://uat-api.serasaexperian.com.br');
    expect(serasaBaseUrl(envFor(null, { ...base, SERASA_ENVIRONMENT: 'producao' }))).toBe('https://api.serasaexperian.com.br');
    expect(creditStatus(envFor(null, { ...base, SERASA_ENVIRONMENT: 'producao' })).connected).toBe(false);
    expect(creditStatus(envFor(null, { ...base, SERASA_ENVIRONMENT: 'producao', NODE_ENV: 'production' })).connected).toBe(true);
    // Em produção, URL alternativa só HTTPS no domínio da Serasa (evita SSRF/vazamento de credencial).
    expect(creditStatus(envFor(null, { ...base, NODE_ENV: 'production', SERASA_API_URL: 'https://evil.example.com' })).connected).toBe(false);
    expect(creditStatus(envFor(null, { ...base, NODE_ENV: 'production', SERASA_API_URL: 'http://api.serasaexperian.com.br' })).connected).toBe(false);
    expect(creditStatus(envFor(null, { ...base, NODE_ENV: 'production', SERASA_API_URL: 'https://uat-api.serasaexperian.com.br' })).connected).toBe(true);
  });
});

describe('cliente da Serasa (servidor falso)', () => {
  let fake: FakeSerasa;
  beforeAll(async () => {
    fake = await startFakeSerasa();
  });
  afterAll(async () => {
    await fake.close();
  });
  afterEach(() => {
    fake.behaviors.clear();
    fake.reportCalls.length = 0;
    fake.logins = 0;
    fake.expiresIn = '3600';
    fake.delayMs = 0;
    vi.restoreAllMocks();
  });

  it('autentica com Basic, reaproveita o token e manda o CPF só no cabeçalho', async () => {
    const provider = createCreditBureauProvider(envFor(fake, { SERASA_SCORE_MODEL: 'HRLN', SERASA_OPTIONAL_FEATURES: 'ANOTACOES_COMPLETAS_PME' }));
    expect((await provider.fetchReport(CPF)).kind).toBe('REPORT');
    expect((await provider.fetchReport(CPF)).kind).toBe('REPORT');
    expect(fake.logins).toBe(1);
    expect(fake.reportCalls).toHaveLength(2);
    const call = fake.reportCalls[0]!;
    expect(call.cpf).toBe(CPF);
    expect(call.authorization).toMatch(/^Bearer tok-/);
    expect(JSON.stringify(call.query)).not.toContain(CPF);
    expect(call.query.reportName).toBe('RELATORIO_BASICO_PF_PME');
    expect(call.query.optionalFeatures).toBe('ANOTACOES_COMPLETAS_PME');
    expect(JSON.parse(Buffer.from(call.query.reportParameters!, 'base64').toString())).toEqual({ reportParameters: [{ name: 'SCORE', value: 'HRLN' }] });
    expect(call.retailer).toBeUndefined();
  });

  it('consultas simultâneas fazem um único login', async () => {
    const provider = createCreditBureauProvider(envFor(fake));
    const results = await Promise.all(Array.from({ length: 5 }, () => provider.fetchReport(CPF)));
    expect(results.every((r) => r.kind === 'REPORT')).toBe(true);
    expect(fake.logins).toBe(1);
  });

  it('renova o token quando vence', async () => {
    const provider = createCreditBureauProvider(envFor(fake));
    await provider.fetchReport(CPF);
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 3601 * 1000);
    await provider.fetchReport(CPF);
    expect(fake.logins).toBe(2);
  });

  it('token revogado (401 sem código 10): renova uma vez e conclui', async () => {
    const provider = createCreditBureauProvider(envFor(fake));
    await provider.fetchReport(CPF);
    fake.revokeNextToken = true;
    const result = await provider.fetchReport(CPF);
    expect(result.kind).toBe('REPORT');
    expect(fake.logins).toBe(2);
  });

  it('cliente distribuidor envia X-Retailer-Document-Id', async () => {
    const provider = createCreditBureauProvider(envFor(fake, { SERASA_RETAILER_DOCUMENT: '12345678000199' }));
    await provider.fetchReport(CPF);
    expect(fake.reportCalls[0]!.retailer).toBe('12345678000199');
  });

  it('credencial errada: AUTH_FAILED e teste de autenticação falha', async () => {
    const provider = createCreditBureauProvider(envFor(fake, { SERASA_CLIENT_SECRET: 'errado' }));
    expect(await provider.fetchReport(CPF)).toMatchObject({ kind: 'REJECTED', outcome: 'AUTH_FAILED' });
    expect((await provider.testAuth()).ok).toBe(false);
    expect(fake.reportCalls).toHaveLength(0);
    const ok = createCreditBureauProvider(envFor(fake));
    expect(await ok.testAuth()).toMatchObject({ ok: true });
    expect(fake.reportCalls).toHaveLength(0);
  });

  it.each([
    [401, '10', 'REJECTED', 'PRODUCT_NOT_ENABLED'],
    [403, '30', 'NOT_AVAILABLE', undefined],
    [404, '40', 'REJECTED', 'REPORT_NOT_FOUND'],
    [412, '70', 'REJECTED', 'INVALID_DOCUMENT'],
    [412, '60', 'REJECTED', 'REPORT_INACTIVE'],
    [412, '50', 'REJECTED', 'BUSINESS_ID'],
    [429, '429', 'REJECTED', 'RATE_LIMITED'],
    [500, '20', 'UNCERTAIN', 'SERVER_ERROR'],
  ])('HTTP %i código %s => %s %s, sem repetir a consulta', async (status, code, kind, outcome) => {
    fake.behaviors.set(CPF, { kind: 'error', status, code, message: 'mensagem oficial' });
    const provider = createCreditBureauProvider(envFor(fake));
    const result = await provider.fetchReport(CPF);
    expect(result.kind).toBe(kind);
    if (outcome) expect((result as { outcome: string }).outcome).toBe(outcome);
    expect(fake.reportCalls).toHaveLength(1);
  });

  it('tempo esgotado vira incerto e não repete', async () => {
    fake.behaviors.set(CPF, { kind: 'hang' });
    const provider = createCreditBureauProvider(envFor(fake, { SERASA_TIMEOUT_MS: 2000 }));
    expect(await provider.fetchReport(CPF)).toMatchObject({ kind: 'UNCERTAIN', outcome: 'TIMEOUT' });
    expect(fake.reportCalls).toHaveLength(1);
  });

  it('resposta fora do formato vira incerta', async () => {
    fake.behaviors.set(CPF, { kind: 'malformed' });
    const provider = createCreditBureauProvider(envFor(fake));
    expect(await provider.fetchReport(CPF)).toMatchObject({ kind: 'UNCERTAIN', outcome: 'MALFORMED' });
  });

  it('três falhas seguidas abrem o disjuntor: a próxima nem chega à Serasa', async () => {
    fake.behaviors.set(CPF, { kind: 'error', status: 500, code: '20', message: 'erro' });
    const provider = createCreditBureauProvider(envFor(fake));
    for (let i = 0; i < 3; i++) await provider.fetchReport(CPF);
    expect(await provider.fetchReport(CPF)).toMatchObject({ kind: 'REJECTED', outcome: 'CIRCUIT_OPEN' });
    expect(fake.reportCalls).toHaveLength(3);
  });

  it('CPF fora do formato é recusado antes de chamar', async () => {
    const provider = createCreditBureauProvider(envFor(fake));
    expect(await provider.fetchReport('123')).toMatchObject({ kind: 'REJECTED', outcome: 'INVALID_DOCUMENT' });
    expect(fake.logins).toBe(0);
  });

  it('servidor inalcançável: falha de rede sem cobrança', async () => {
    const provider = createCreditBureauProvider(envFor(fake, { SERASA_API_URL: 'http://127.0.0.1:9' }));
    expect(await provider.fetchReport(CPF)).toMatchObject({ kind: 'REJECTED', outcome: 'NETWORK' });
  });
});
