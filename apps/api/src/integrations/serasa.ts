import type { CreditNegativeGroup, CreditNegativeType, CreditReport } from '@yudirect/contracts';
import { creditStatus, serasaBaseUrl, type Env, type IntegrationStatus } from '../config/env.js';

/* ------------------------------------------------------------------ *
 * Serasa Experian — Relatório Básico PF ("person-information-report").
 * Fonte: manual oficial + OpenAPI em docs/integrations/serasa/.
 *
 * - Token: POST {base}/security/iam/v1/client-identities/login com
 *   "Authorization: Basic <client_id:client_secret em base64>". Vale 1 h;
 *   guardado só em memória, renovado antes de vencer, com uma única
 *   requisição de login em voo (sem logins concorrentes).
 * - Relatório: GET {base}/credit-services/person-information-report/v1/creditreport
 *   ?reportName=&optionalFeatures=&reportParameters= com o CPF no
 *   cabeçalho X-Document-Id (nunca na URL).
 * - Erros oficiais: 401/10 produto não liberado, 403/30 informação não
 *   disponível, 404/40 relatório ou feature inexistente, 412/50|60|70
 *   BusinessId, relatório inativo, documento incorreto, 429, 500/20.
 * - Consulta potencialmente cobrada NUNCA é repetida automaticamente:
 *   tempo esgotado, 5xx e resposta fora do formato viram "incerto".
 * ------------------------------------------------------------------ */

const LOGIN_PATH = '/security/iam/v1/client-identities/login';
const REPORT_PATH = '/credit-services/person-information-report/v1/creditreport';
const TOKEN_MAX_SECONDS = 3600;
const TOKEN_SAFETY_SECONDS = 120;
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 120_000;
const MAX_ITEMS_PER_GROUP = 50;

export type SerasaRejection =
  | 'PRODUCT_NOT_ENABLED'
  | 'AUTH_FAILED'
  | 'INVALID_DOCUMENT'
  | 'REPORT_NOT_FOUND'
  | 'REPORT_INACTIVE'
  | 'BUSINESS_ID'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'NETWORK'
  | 'CIRCUIT_OPEN'
  | 'NOT_CONFIGURED';

export type SerasaOutcome =
  | { kind: 'REPORT'; report: CreditReport; httpStatus: number }
  /** 403/30: a Serasa não tem informação para o CPF. Não é "sem risco". */
  | { kind: 'NOT_AVAILABLE'; message: string; httpStatus: number; providerCode: string | null }
  /** Recusada antes de processar: não houve consulta cobrada. */
  | { kind: 'REJECTED'; outcome: SerasaRejection; message: string; httpStatus: number | null; providerCode: string | null }
  /** Pode ter sido processada/cobrada: não repetir automaticamente. */
  | { kind: 'UNCERTAIN'; outcome: 'TIMEOUT' | 'SERVER_ERROR' | 'MALFORMED' | 'CONNECTION_LOST'; message: string; httpStatus: number | null };

export interface SerasaProduct {
  reportName: string;
  optionalFeatures: string[];
  scoreModel: string | null;
}

export interface CreditBureauProvider {
  status(): IntegrationStatus;
  environment(): 'homologacao' | 'producao';
  product(): SerasaProduct;
  /** Só autentica (não consulta CPF, não gera cobrança). */
  testAuth(): Promise<{ ok: boolean; message: string }>;
  fetchReport(cpf: string): Promise<SerasaOutcome>;
}

interface CachedToken {
  value: string;
  type: string;
  expiresAt: number;
}

class AuthError extends Error {
  constructor(
    message: string,
    readonly network: boolean,
  ) {
    super(message);
  }
}

/** Corpo de erro oficial: [{ code, message }] (às vezes um objeto só). */
function firstError(body: unknown): { code: string | null; message: string | null } {
  const item = Array.isArray(body) ? body[0] : body;
  if (item && typeof item === 'object') {
    const o = item as Record<string, unknown>;
    return {
      code: o.code !== undefined && o.code !== null ? String(o.code) : null,
      message: typeof o.message === 'string' ? o.message.slice(0, 300) : null,
    };
  }
  return { code: null, message: null };
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    for (const actual of Object.keys(obj)) if (actual.toLowerCase() === k.toLowerCase()) return obj[actual];
  }
  return undefined;
}

/** ExpiresIn vem como string; aceita segundos e cai para 1 h quando não reconhece. */
export function tokenLifetimeSeconds(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 86_400) return TOKEN_MAX_SECONDS;
  return Math.min(n, TOKEN_MAX_SECONDS);
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Falha antes de a requisição chegar à Serasa (nada foi processado). */
function neverReached(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } })?.cause?.code ?? '';
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code);
}

/* ------------------------------ Normalização ------------------------------ */

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const asStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const asInt = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
};
const toCents = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

const NEGATIVE_BLOCKS: Array<{ key: string; type: CreditNegativeType }> = [
  { key: 'pefin', type: 'PEFIN' },
  { key: 'refin', type: 'REFIN' },
  { key: 'notary', type: 'PROTESTO' },
  { key: 'check', type: 'CHEQUE' },
  { key: 'collectionRecords', type: 'COBRANCA' },
];

function normalizeGroup(type: CreditNegativeType, block: unknown): CreditNegativeGroup {
  const b = asObj(block);
  if (!b) {
    return { type, availability: 'NOT_RETURNED', count: 0, balanceCents: 0, firstDate: null, lastDate: null, items: [], message: null };
  }
  const list = Object.entries(b).find(([k, v]) => k.endsWith('Response') && Array.isArray(v))?.[1] as unknown[] | undefined;
  const items = (list ?? []).map((raw) => {
    const i = asObj(raw) ?? {};
    return {
      date: asStr(i.occurrenceDate),
      creditor: asStr(i.creditorName) ?? asStr(i.officeName) ?? asStr(i.bankName),
      amountCents: toCents(i.amount),
      city: asStr(i.city),
      state: asStr(i.federalUnit),
      subJudice: i.flagSubJudice === true,
    };
  });
  const summary = asObj(b.summary) ?? {};
  const error = firstError(b.error);
  const count = asInt(summary.count) ?? items.length;
  const balanceCents = toCents(summary.balance) ?? items.reduce((s, i) => s + (i.amountCents ?? 0), 0);
  const dates = items.map((i) => i.date).filter((d): d is string => Boolean(d)).sort();
  const availability = !list && !b.summary && (error.code || error.message) ? 'ERROR' : 'RETURNED';
  return {
    type,
    availability,
    count,
    balanceCents,
    firstDate: asStr(summary.firstOccurrence) ?? dates[0] ?? null,
    lastDate: asStr(summary.lastOccurrence) ?? dates[dates.length - 1] ?? null,
    items: items.slice(0, MAX_ITEMS_PER_GROUP),
    message: availability === 'ERROR' ? error.message ?? 'Bloco retornou erro.' : asStr(summary.message),
  };
}

/**
 * Converte a resposta oficial no formato guardado pelo YuDirect. Só os
 * campos necessários à análise da locação (minimização): sem filiação,
 * endereços, telefones ou e-mails do relatório.
 * Retorna null quando a resposta não tem o formato documentado.
 */
export function normalizeSerasaReport(body: unknown): CreditReport | null {
  const root = asObj(body);
  if (!root || !Array.isArray(root.reports) || root.reports.length === 0) return null;
  const report = asObj(root.reports[0]);
  if (!report) return null;
  const optional = asObj(root.optionalFeatures) ?? {};
  const block = (key: string) => (optional[key] !== undefined ? optional[key] : report[key]);

  const registration = asObj(block('registration')) ?? {};
  const scoreBlock = asObj(block('score'));
  const scoreSrc = scoreBlock ? asObj(scoreBlock.scoreResponse) ?? scoreBlock : null;
  const scoreValue = scoreSrc ? asInt(scoreSrc.score) : null;
  const scoreError = scoreBlock ? firstError(scoreBlock.error) : { code: null, message: null };

  // ANOTACOES_COMPLETAS devolve o negativeData mais completo no bloco opcional.
  const negativeData = asObj(optional.negativeData) ?? asObj(report.negativeData);
  const negatives = NEGATIVE_BLOCKS.map(({ key, type }) => normalizeGroup(type, negativeData?.[key]));

  const negativeSummary = asObj(block('negativeSummary'));
  let hasNegative: boolean | null = typeof negativeSummary?.hasNegative === 'boolean' ? (negativeSummary.hasNegative as boolean) : null;
  if (hasNegative === null) {
    const returned = negatives.filter((g) => g.availability === 'RETURNED');
    if (returned.some((g) => g.count > 0)) hasNegative = true;
    // Só afirma "sem anotações" se os quatro blocos principais vieram.
    else if (['PEFIN', 'REFIN', 'PROTESTO', 'CHEQUE'].every((t) => returned.some((g) => g.type === t))) hasNegative = false;
  }

  const facts = asObj(block('facts')) ?? {};
  const stolen = asObj(facts.stolenDocuments);
  const stolenList = stolen && Array.isArray(stolen.stolenDocumentsResponse) ? stolen.stolenDocumentsResponse.length : null;
  const inquiryQty = asObj(asObj(facts.inquirySummary)?.inquiryQuantity);

  return {
    reportName: asStr(report.reportName),
    consumerName: asStr(registration.consumerName),
    registrationStatus: asStr(registration.statusRegistration),
    score:
      scoreSrc && scoreValue !== null
        ? {
            score: scoreValue,
            model: asStr(scoreSrc.scoreModel),
            range: asStr(scoreSrc.range),
            defaultRate: asStr(scoreSrc.defaultRate),
            message: asStr(scoreSrc.message),
          }
        : null,
    scoreMessage: scoreValue !== null ? null : (scoreSrc ? asStr(scoreSrc.message) : null) ?? scoreError.message ?? null,
    hasNegative,
    negatives,
    stolenDocumentAlerts: stolen ? asInt(asObj(stolen.summary)?.count) ?? stolenList : null,
    inquiriesThisMonth: inquiryQty ? asInt(inquiryQty.actual) : null,
  };
}

/* -------------------------------- Cliente -------------------------------- */

export function createCreditBureauProvider(env: Env, fetchImpl: typeof fetch = fetch): CreditBureauProvider {
  const status = creditStatus(env);
  const base = serasaBaseUrl(env);
  const product: SerasaProduct = {
    reportName: env.SERASA_REPORT_NAME,
    optionalFeatures: env.SERASA_OPTIONAL_FEATURES.split(',').map((s) => s.trim()).filter(Boolean),
    scoreModel: env.SERASA_SCORE_MODEL || null,
  };
  let token: CachedToken | null = null;
  let inflight: Promise<CachedToken> | null = null;
  let failures = 0;
  let openUntil = 0;

  async function login(): Promise<CachedToken> {
    const basic = Buffer.from(`${env.SERASA_CLIENT_ID}:${env.SERASA_CLIENT_SECRET}`).toString('base64');
    let res: Response;
    try {
      res = await fetchImpl(`${base}${LOGIN_PATH}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(env.SERASA_TIMEOUT_MS),
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json', accept: 'application/json' },
      });
    } catch (err) {
      throw new AuthError(isTimeout(err) ? 'Tempo esgotado ao autenticar na Serasa.' : 'Não foi possível contatar a Serasa para autenticar.', true);
    }
    const body = asObj(await res.json().catch(() => null)) ?? {};
    const accessToken = asStr(pick(body, 'accessToken', 'access_token'));
    if (!res.ok || !accessToken) {
      const e = firstError(body);
      throw new AuthError(
        res.status === 401 || res.status === 403
          ? 'Credenciais da Serasa recusadas (verifique client id/secret e o ambiente).'
          : `Serasa recusou a autenticação (HTTP ${res.status}${e.code ? `, código ${e.code}` : ''}).`,
        res.status >= 500,
      );
    }
    const lifetime = tokenLifetimeSeconds(pick(body, 'expiresIn', 'expires_in'));
    return {
      value: accessToken,
      type: asStr(pick(body, 'tokenType', 'token_type')) ?? 'Bearer',
      expiresAt: Date.now() + Math.max(60, lifetime - TOKEN_SAFETY_SECONDS) * 1000,
    };
  }

  /** Token em cache; um único login concorrente. */
  async function getToken(forceRefresh = false): Promise<CachedToken> {
    if (!forceRefresh && token && token.expiresAt > Date.now()) return token;
    if (!inflight) {
      inflight = login()
        .then((t) => {
          token = t;
          return t;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  }

  function reportUrl(): string {
    const url = new URL(`${base}${REPORT_PATH}`);
    url.searchParams.set('reportName', product.reportName);
    if (product.optionalFeatures.length) url.searchParams.set('optionalFeatures', product.optionalFeatures.join(','));
    if (product.scoreModel) {
      const params = { reportParameters: [{ name: 'SCORE', value: product.scoreModel }] };
      url.searchParams.set('reportParameters', Buffer.from(JSON.stringify(params)).toString('base64'));
    }
    return url.toString();
  }

  function recordHealth(ok: boolean) {
    if (ok) {
      failures = 0;
      return;
    }
    failures += 1;
    if (failures >= BREAKER_THRESHOLD) openUntil = Date.now() + BREAKER_OPEN_MS;
  }

  async function callReport(cpf: string, t: CachedToken): Promise<Response> {
    return fetchImpl(reportUrl(), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(env.SERASA_TIMEOUT_MS),
      headers: {
        authorization: `${t.type} ${t.value}`,
        accept: 'application/json',
        'X-Document-Id': cpf,
        ...(env.SERASA_RETAILER_DOCUMENT ? { 'X-Retailer-Document-Id': env.SERASA_RETAILER_DOCUMENT } : {}),
        ...(env.SERASA_COST_CENTER ? { 'X-Cost-Center': env.SERASA_COST_CENTER } : {}),
      },
    });
  }

  return {
    status: () => status,
    environment: () => env.SERASA_ENVIRONMENT,
    product: () => product,

    async testAuth() {
      if (!status.connected) return { ok: false, message: status.message };
      try {
        await getToken(true);
        return { ok: true, message: 'Autenticação na Serasa confirmada (nenhuma consulta foi feita).' };
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    },

    async fetchReport(cpf) {
      if (!status.connected) return { kind: 'REJECTED', outcome: 'NOT_CONFIGURED', message: status.message, httpStatus: null, providerCode: null };
      if (!/^\d{11}$/.test(cpf)) {
        return { kind: 'REJECTED', outcome: 'INVALID_DOCUMENT', message: 'CPF inválido.', httpStatus: null, providerCode: null };
      }
      if (openUntil > Date.now()) {
        return {
          kind: 'REJECTED',
          outcome: 'CIRCUIT_OPEN',
          message: 'A Serasa falhou várias vezes seguidas. Novas consultas ficam pausadas por 2 minutos.',
          httpStatus: null,
          providerCode: null,
        };
      }

      let res: Response | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        let t: CachedToken;
        try {
          t = await getToken(attempt > 0);
        } catch (err) {
          const authErr = err as AuthError;
          recordHealth(!authErr.network);
          return { kind: 'REJECTED', outcome: authErr.network ? 'NETWORK' : 'AUTH_FAILED', message: authErr.message, httpStatus: null, providerCode: null };
        }
        try {
          res = await callReport(cpf, t);
        } catch (err) {
          recordHealth(false);
          if (neverReached(err)) {
            return { kind: 'REJECTED', outcome: 'NETWORK', message: 'Não foi possível contatar a Serasa. Nenhuma consulta foi feita.', httpStatus: null, providerCode: null };
          }
          return {
            kind: 'UNCERTAIN',
            outcome: isTimeout(err) ? 'TIMEOUT' : 'CONNECTION_LOST',
            message: isTimeout(err)
              ? 'A Serasa não respondeu a tempo. A consulta pode ter sido processada e cobrada.'
              : 'A conexão com a Serasa caiu durante a consulta. Ela pode ter sido processada e cobrada.',
            httpStatus: null,
          };
        }
        // 401 sem o código 10 = token recusado: renova uma vez (não houve consulta).
        if (res.status === 401 && attempt === 0) {
          const e = firstError(await res.clone().json().catch(() => null));
          if (e.code !== '10') {
            token = null;
            continue;
          }
        }
        break;
      }
      const response = res!;
      recordHealth(response.status < 500);
      const body = await response.json().catch(() => undefined);
      const e = firstError(body);
      const providerMsg = e.message ? ` Serasa: "${e.message}"` : '';

      if (response.ok) {
        const report = normalizeSerasaReport(body);
        if (!report) {
          return { kind: 'UNCERTAIN', outcome: 'MALFORMED', message: 'A Serasa respondeu fora do formato documentado. A consulta pode ter sido cobrada.', httpStatus: response.status };
        }
        return { kind: 'REPORT', report, httpStatus: response.status };
      }
      const reject = (outcome: SerasaRejection, message: string) =>
        ({ kind: 'REJECTED', outcome, message: `${message}${providerMsg}`, httpStatus: response.status, providerCode: e.code }) as const;

      switch (response.status) {
        case 401:
          return e.code === '10'
            ? reject('PRODUCT_NOT_ENABLED', 'Este relatório não está liberado no contrato com a Serasa.')
            : reject('AUTH_FAILED', 'A Serasa recusou a credencial.');
        case 403:
          if (e.code === '30') {
            return { kind: 'NOT_AVAILABLE', message: 'A Serasa não tem informação disponível para este CPF.', httpStatus: 403, providerCode: e.code };
          }
          return reject('AUTH_FAILED', 'Usuário da Serasa sem autorização para esta transação.');
        case 404:
          return reject('REPORT_NOT_FOUND', `Relatório ou feature opcional não existe (${product.reportName}).`);
        case 412:
          if (e.code === '70') return reject('INVALID_DOCUMENT', 'A Serasa considerou o CPF incorreto.');
          if (e.code === '60') return reject('REPORT_INACTIVE', `O relatório ${product.reportName} está inativo no contrato.`);
          if (e.code === '50') return reject('BUSINESS_ID', 'A Serasa não identificou o BusinessId da conta. Contate o suporte da Serasa.');
          return reject('BAD_REQUEST', 'A Serasa recusou a requisição (campo obrigatório).');
        case 429:
          return reject('RATE_LIMITED', 'Limite de requisições da Serasa atingido. Tente mais tarde.');
        case 400:
          return reject('BAD_REQUEST', 'A Serasa recusou a requisição.');
        default:
          if (response.status >= 500) {
            return {
              kind: 'UNCERTAIN',
              outcome: 'SERVER_ERROR',
              message: `Erro interno da Serasa (HTTP ${response.status}). A consulta pode ter sido processada.${providerMsg}`,
              httpStatus: response.status,
            };
          }
          return reject('BAD_REQUEST', `A Serasa respondeu HTTP ${response.status}.`);
      }
    },
  };
}
