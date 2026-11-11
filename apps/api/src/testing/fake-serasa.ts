import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Serasa falsa para os testes (sem rede), no formato do OpenAPI oficial
 * (docs/integrations/serasa/relatorio-basico-pf.swagger.yaml):
 * POST /security/iam/v1/client-identities/login (Basic) e
 * GET /credit-services/person-information-report/v1/creditreport (X-Document-Id).
 * O teste escolhe a resposta de cada CPF e conta as chamadas.
 */
export type FakeSerasaBehavior =
  | { kind: 'report'; body: unknown }
  | { kind: 'error'; status: number; code: string; message: string }
  | { kind: 'hang' }
  | { kind: 'malformed' };

export interface FakeSerasa {
  url: string;
  clientId: string;
  clientSecret: string;
  logins: number;
  reportCalls: Array<{ cpf: string | undefined; query: Record<string, string>; authorization: string | undefined; retailer: string | undefined }>;
  behaviors: Map<string, FakeSerasaBehavior>;
  /** Próximo token emitido expira em N segundos (string, como no manual). */
  expiresIn: string;
  /** Faz o próximo relatório responder 401 (token revogado) uma vez. */
  revokeNextToken: boolean;
  /** Atraso artificial do relatório (ms). */
  delayMs: number;
  close(): Promise<void>;
}

/** Relatório no formato documentado, com PEFIN, protesto e score. */
export function sampleReport(opts: { score?: number | null; pefin?: number; name?: string } = {}) {
  const pefinItems = Array.from({ length: opts.pefin ?? 1 }, (_, i) => ({
    occurrenceDate: `2026-0${(i % 9) + 1}-10`,
    inclusionDate: `2026-0${(i % 9) + 1}-12`,
    legalNature: 'FINANCIAMENTO',
    contractId: `C${i}`,
    creditorName: `BANCO EXEMPLO ${i + 1}`,
    amount: 1234.56,
    city: 'SAO PAULO',
    federalUnit: 'SP',
    principal: true,
    flagSubJudice: false,
  }));
  return {
    reports: [
      {
        reportName: 'RELATORIO_BASICO_PF_PME',
        registration: {
          documentNumber: '00000000000',
          consumerName: opts.name ?? 'FULANO DE TESTE',
          motherName: 'NAO DEVE SER GUARDADO',
          statusRegistration: 'REGULAR',
          address: { addressLine: 'RUA QUE NAO DEVE SER GUARDADA' },
        },
        negativeData: {
          pefin: { pefinResponse: pefinItems, summary: { count: pefinItems.length, balance: 1234.56 * pefinItems.length } },
          refin: { refinResponse: [], summary: { count: 0, balance: 0 } },
          notary: {
            notaryResponse: [{ occurrenceDate: '2025-11-01', amount: 500, officeName: '1 TABELIAO', city: 'CAMPINAS', federalUnit: 'SP' }],
            summary: { count: 1, balance: 500 },
          },
          check: { checkResponse: [], summary: { count: 0, balance: 0 } },
        },
        score:
          opts.score === null
            ? { message: 'Score não calculado para o documento.', codeMessage: 99 }
            : { score: opts.score ?? 612, scoreModel: 'HRLN', range: 'D', defaultRate: '7,5%', message: 'Risco moderado' },
        facts: {
          stolenDocuments: { stolenDocumentsResponse: [], summary: { count: 0 } },
          inquirySummary: { inquiryQuantity: { actual: 3 } },
        },
      },
    ],
  };
}

function readHeader(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export async function startFakeSerasa(): Promise<FakeSerasa> {
  const clientId = 'yudirect-client';
  const clientSecret = 'segredo-de-teste';
  const tokens = new Set<string>();
  let tokenSeq = 0;
  const state: Omit<FakeSerasa, 'url' | 'close' | 'clientId' | 'clientSecret'> = {
    logins: 0,
    reportCalls: [],
    behaviors: new Map(),
    expiresIn: '3600',
    revokeNextToken: false,
    delayMs: 0,
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && url.pathname === '/security/iam/v1/client-identities/login') {
      state.logins += 1;
      const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      if (readHeader(req, 'authorization') !== expected) return json(401, [{ code: '401', message: 'Unauthorized.' }]);
      const token = `tok-${++tokenSeq}`;
      tokens.add(token);
      return json(200, { accessToken: token, tokenType: 'Bearer', expiresIn: state.expiresIn, scope: 'read' });
    }
    if (req.method === 'GET' && url.pathname === '/credit-services/person-information-report/v1/creditreport') {
      const cpf = readHeader(req, 'x-document-id');
      const authorization = readHeader(req, 'authorization');
      state.reportCalls.push({ cpf, query: Object.fromEntries(url.searchParams), authorization, retailer: readHeader(req, 'x-retailer-document-id') });
      const token = authorization?.replace(/^Bearer /, '');
      if (state.revokeNextToken) {
        state.revokeNextToken = false;
        if (token) tokens.delete(token);
      }
      if (!token || !tokens.has(token)) return json(401, [{ code: '401', message: 'Unauthorized.' }]);
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      const behavior = state.behaviors.get(cpf ?? '') ?? { kind: 'report', body: sampleReport() };
      if (behavior.kind === 'hang') return; // nunca responde (o cliente estoura o tempo)
      if (behavior.kind === 'malformed') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"unexpected": true}');
      }
      if (behavior.kind === 'error') return json(behavior.status, [{ code: behavior.code, message: behavior.message }]);
      return json(200, behavior.body);
    }
    json(404, [{ code: '41', message: 'The service does not exist.' }]);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const fake = Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    clientId,
    clientSecret,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return fake as FakeSerasa;
}
