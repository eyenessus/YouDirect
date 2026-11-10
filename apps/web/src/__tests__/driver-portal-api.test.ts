import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError, setUnauthorizedHandler } from '@/lib/api';

/** Um 401 da Área do Motorista ou do site público nunca leva ao login da equipe. */
describe('cliente da API e sessões separadas', () => {
  afterEach(() => vi.unstubAllGlobals());

  const unauthorized = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Sem sessão' } }), { status: 401 })),
    );

  it('401 do portal do motorista não dispara o redirecionamento da equipe', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    unauthorized();
    await expect(api.get('/driver/me')).rejects.toBeInstanceOf(ApiRequestError);
    await expect(api.get('/public/minha-locadora/catalog')).rejects.toBeInstanceOf(ApiRequestError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('401 de rota da equipe continua levando ao login', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    unauthorized();
    await expect(api.get('/vehicles')).rejects.toBeInstanceOf(ApiRequestError);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
