import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError, setUnauthorizedHandler } from '@/lib/api';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('cliente HTTP', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setUnauthorizedHandler(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('envia cookies da sessão e content-type JSON em escritas', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await api.post('/auth/login', { email: 'a@b.test', password: 'x' });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.credentials).toBe('include');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ email: 'a@b.test', password: 'x' }));
  });

  it('omite parâmetros vazios da query string', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: [] }));
    await api.get('/vehicles', { query: { q: '', status: 'RENTED', limit: 20, cursor: undefined } });
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/vehicles?status=RENTED&limit=20');
  });

  it('converte o erro da API em ApiRequestError preservando código e requestId', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, {
        error: { code: 'CONFLICT', message: 'Já existe um veículo com esta placa.', requestId: 'req-1' },
      }),
    );
    await expect(api.post('/vehicles', {})).rejects.toMatchObject({
      status: 409,
      code: 'CONFLICT',
      message: 'Já existe um veículo com esta placa.',
      requestId: 'req-1',
    });
  });

  it('expõe erros de validação por campo para o formulário', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        error: {
          code: 'UNPROCESSABLE',
          message: 'Dados inválidos.',
          details: [
            { path: 'plate', message: 'Placa inválida.' },
            { path: 'mileageKm', message: 'Informe o hodômetro.' },
          ],
        },
      }),
    );
    try {
      await api.post('/vehicles', {});
      expect.unreachable('deveria lançar');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiRequestError);
      expect((err as ApiRequestError).fieldErrors()).toEqual({
        plate: 'Placa inválida.',
        mileageKm: 'Informe o hodômetro.',
      });
    }
  });

  it('dispara o handler de sessão expirada em 401, exceto em /auth/me e /auth/login', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);

    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }));
    await expect(api.get('/vehicles')).rejects.toBeInstanceOf(ApiRequestError);
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(api.get('/auth/me')).rejects.toBeInstanceOf(ApiRequestError);
    await expect(api.post('/auth/login', {})).rejects.toBeInstanceOf(ApiRequestError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('usa mensagem genérica quando a resposta de erro não tem corpo JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers(),
      json: async () => {
        throw new Error('sem corpo');
      },
      text: async () => '',
    } as unknown as Response);
    await expect(api.get('/vehicles')).rejects.toMatchObject({
      status: 502,
      message: 'Falha na requisição (HTTP 502).',
    });
  });
});
