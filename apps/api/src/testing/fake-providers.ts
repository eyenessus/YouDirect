import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Provedores falsos para os testes (sem rede): imitam o Mercado Pago
 * (POST/GET /v1/payments) e a ZapSign (POST /api/v1/docs/, GET /api/v1/docs/:token/,
 * download do PDF assinado). O teste controla o estado dos pagamentos e documentos.
 */
export interface FakePayment {
  id: string;
  status: string;
  amount: number;
  externalReference: string;
  idempotencyKey: string | null;
  approvedAt: string | null;
  body: Record<string, unknown>;
}

export interface FakeDoc {
  token: string;
  status: 'pending' | 'signed' | 'refused';
  externalId: string;
  signer: Record<string, unknown>;
}

export interface FakeProviders {
  url: string;
  payments: Map<string, FakePayment>;
  docs: Map<string, FakeDoc>;
  requests: Array<{ method: string; path: string; headers: IncomingMessage['headers'] }>;
  /** Próximas respostas de erro (HTTP) para POST /v1/payments. */
  failNextCreate: number;
  /** Tabela FIPE falsa em `${url}/fipe`: preços por código de ano, editáveis pelo teste. */
  fipePrices: Map<string, string>;
  approve(id: string, amountOverride?: number): void;
  sign(token: string): void;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export async function startFakeProviders(): Promise<FakeProviders> {
  let seq = 1000;
  const payments = new Map<string, FakePayment>();
  const byIdem = new Map<string, string>();
  const docs = new Map<string, FakeDoc>();
  const requests: FakeProviders['requests'] = [];
  const state = { failNextCreate: 0 };
  const fipePrices = new Map<string, string>([['21/4828/2022-1', 'R$ 62.350,00']]);
  let baseUrl = '';

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({ method: req.method ?? '', path: url.pathname, headers: req.headers });
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    // ----------------------- Mercado Pago -----------------------
    if (url.pathname === '/v1/payments' && req.method === 'POST') {
      if (state.failNextCreate > 0) {
        state.failNextCreate -= 1;
        return send(res, 400, { message: 'invalid payer' });
      }
      const idem = (req.headers['x-idempotency-key'] as string | undefined) ?? null;
      if (idem && byIdem.has(idem)) {
        const p = payments.get(byIdem.get(idem)!)!;
        return send(res, 201, mpPayment(p));
      }
      seq += 1;
      const p: FakePayment = {
        id: String(seq),
        status: 'pending',
        amount: Number(body.transaction_amount),
        externalReference: String(body.external_reference),
        idempotencyKey: idem,
        approvedAt: null,
        body,
      };
      payments.set(p.id, p);
      if (idem) byIdem.set(idem, p.id);
      return send(res, 201, mpPayment(p));
    }
    const pay = url.pathname.match(/^\/v1\/payments\/(\w+)$/);
    if (pay) {
      const p = payments.get(pay[1]!);
      if (!p) return send(res, 404, { message: 'not found' });
      if (req.method === 'PUT') {
        p.status = String(body.status ?? p.status);
        return send(res, 200, mpPayment(p));
      }
      return send(res, 200, mpPayment(p));
    }

    // --------------------------- FIPE ---------------------------
    // Caminho: /fipe/cars/brands[/<marca>[/models[/<modelo>[/years[/<ano>]]]]]
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'fipe' && parts[1] === 'cars' && parts[2] === 'brands' && req.method === 'GET') {
      const brand = parts[3];
      const model = parts[5];
      const year = parts[7];
      if (parts.length === 3) return send(res, 200, [{ code: '21', name: 'Fiat' }, { code: '59', name: 'VW - VolksWagen' }]);
      if (parts.length === 5) return send(res, brand === '21' ? 200 : 404, brand === '21' ? [{ code: '4828', name: 'Mobi Like 1.0' }] : { message: 'x' });
      if (parts.length === 7) return send(res, 200, [{ code: '2022-1', name: '2022 Gasolina' }]);
      const price = fipePrices.get(`${brand}/${model}/${year}`);
      if (!price) return send(res, 404, { error: 'not found' });
      return send(res, 200, { vehicleType: 1, price, brand: 'Fiat', model: 'Mobi Like 1.0', modelYear: 2022, fuel: 'Gasolina', codeFipe: '001478-1', referenceMonth: 'novembro de 2026', fuelAcronym: 'G' });
    }

    // ------------------------- ZapSign -------------------------
    if (url.pathname === '/api/v1/docs/' && req.method === 'POST') {
      seq += 1;
      const token = `doc-${seq}`;
      const signer = ((body.signers as Array<Record<string, unknown>>) ?? [])[0] ?? {};
      docs.set(token, { token, status: 'pending', externalId: String(body.external_id), signer });
      return send(res, 200, {
        token,
        status: 'pending',
        signers: [{ token: `signer-${seq}`, sign_url: `https://app.zapsign.com.br/verificar/signer-${seq}`, status: 'new' }],
      });
    }
    const doc = url.pathname.match(/^\/api\/v1\/docs\/([\w-]+)\/$/);
    if (doc && req.method === 'GET') {
      const d = docs.get(doc[1]!);
      if (!d) return send(res, 404, { detail: 'not found' });
      return send(res, 200, {
        token: d.token,
        status: d.status,
        external_id: d.externalId,
        signed_file: d.status === 'signed' ? `${baseUrl}/files/${d.token}.pdf` : null,
        signers: [
          {
            status: d.status === 'signed' ? 'signed' : 'new',
            signed_at: d.status === 'signed' ? new Date().toISOString() : null,
            require_selfie_photo: Boolean(d.signer.require_selfie_photo),
            require_document_photo: Boolean(d.signer.require_document_photo),
          },
        ],
      });
    }
    const file = url.pathname.match(/^\/files\/([\w-]+)\.pdf$/);
    if (file) return send(res, 200, Buffer.from('%PDF-1.4\n% contrato assinado (fake)\n%%EOF'), 'application/pdf');

    send(res, 404, { message: 'rota falsa inexistente' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: baseUrl,
    payments,
    docs,
    requests,
    fipePrices,
    get failNextCreate() {
      return state.failNextCreate;
    },
    set failNextCreate(v: number) {
      state.failNextCreate = v;
    },
    approve(id, amountOverride) {
      const p = payments.get(id)!;
      p.status = 'approved';
      p.approvedAt = new Date().toISOString();
      if (amountOverride !== undefined) p.amount = amountOverride;
    },
    sign(token) {
      docs.get(token)!.status = 'signed';
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function mpPayment(p: FakePayment) {
  return {
    id: Number(p.id),
    status: p.status,
    transaction_amount: p.amount,
    external_reference: p.externalReference,
    date_approved: p.approvedAt,
    point_of_interaction: {
      transaction_data: {
        qr_code: `00020126580014br.gov.bcb.pix0136fake-${p.id}5204000053039865802BR`,
        qr_code_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        ticket_url: `https://www.mercadopago.com.br/payments/${p.id}/ticket`,
      },
    },
  };
}
