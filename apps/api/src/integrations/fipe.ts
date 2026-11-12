import { z } from 'zod';
import type { Env, IntegrationStatus } from '../config/env.js';

/* ------------------------------------------------------------------ *
 * Tabela FIPE (API pública da Parallelum, v2). Consulta de marcas,
 * modelos, anos e preço médio de mercado. Sem token a API aplica um
 * limite diário; com FIPE_API_TOKEN o limite é maior. Falha de rede ou
 * resposta fora do formato vira erro claro — nunca um preço inventado.
 * ------------------------------------------------------------------ */

export type FipeVehicleType = 'cars' | 'motorcycles' | 'trucks';

export interface FipeItem {
  code: string;
  name: string;
}

export interface FipePrice {
  priceCents: number;
  codeFipe: string;
  /** Mês de referência como a FIPE informa, ex.: "novembro de 2026". */
  referenceMonth: string;
  brand: string;
  model: string;
  modelYear: number;
  fuel: string;
}

export interface FipeProvider {
  status(): IntegrationStatus;
  brands(type?: FipeVehicleType): Promise<FipeItem[]>;
  models(brandId: string, type?: FipeVehicleType): Promise<FipeItem[]>;
  years(brandId: string, modelId: string, type?: FipeVehicleType): Promise<FipeItem[]>;
  price(brandId: string, modelId: string, yearId: string, type?: FipeVehicleType): Promise<FipePrice>;
}

export class FipeError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'FipeError';
  }
}

const TIMEOUT_MS = 10_000;
const itemsSchema = z.array(z.object({ code: z.string(), name: z.string() }));
const priceSchema = z.object({
  price: z.string(),
  brand: z.string(),
  model: z.string(),
  modelYear: z.number().int(),
  fuel: z.string(),
  codeFipe: z.string(),
  referenceMonth: z.string(),
});

/** "R$ 85.386,00" → 8538600. Qualquer outro formato é recusado. */
export function parseFipePrice(text: string): number {
  // `\s` já cobre o espaço sem quebra que a FIPE às vezes usa depois de "R$".
  const m = /^R\$\s*([\d.]+),(\d{2})$/.exec(text.trim());
  if (!m) throw new FipeError(`Preço da FIPE em formato inesperado: "${text}".`, null);
  return Number(m[1]!.replace(/\./g, '')) * 100 + Number(m[2]);
}

export function fipeStatus(env: Env): IntegrationStatus {
  return {
    name: env.FIPE_ENABLED ? 'fipe-parallelum' : null,
    connected: env.FIPE_ENABLED,
    message: env.FIPE_ENABLED
      ? env.FIPE_API_TOKEN
        ? 'Consulta à tabela FIPE configurada (com token).'
        : 'Consulta à tabela FIPE ativa sem token (limite diário da API pública).'
      : 'Consulta à tabela FIPE desativada (FIPE_ENABLED=false).',
  };
}

export function createFipeProvider(env: Env): FipeProvider {
  const base = env.FIPE_API_URL.replace(/\/$/, '');
  const get = async <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    if (!env.FIPE_ENABLED) throw new FipeError('Consulta à FIPE desativada.', null);
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: 'application/json', ...(env.FIPE_API_TOKEN ? { 'X-Subscription-Token': env.FIPE_API_TOKEN } : {}) },
      });
    } catch {
      throw new FipeError('Não foi possível falar com a tabela FIPE agora. Tente novamente em instantes.', null);
    }
    if (res.status === 429) throw new FipeError('Limite de consultas à FIPE atingido. Tente novamente mais tarde.', 429);
    if (res.status === 404) throw new FipeError('Veículo não encontrado na tabela FIPE.', 404);
    if (!res.ok) throw new FipeError(`A tabela FIPE respondeu HTTP ${res.status}.`, res.status);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new FipeError('Resposta da tabela FIPE fora do formato esperado.', null);
    return parsed.data;
  };
  const enc = encodeURIComponent;
  return {
    status: () => fipeStatus(env),
    brands: (type = 'cars') => get(`/${type}/brands`, itemsSchema),
    models: (brandId, type = 'cars') => get(`/${type}/brands/${enc(brandId)}/models`, itemsSchema),
    years: (brandId, modelId, type = 'cars') => get(`/${type}/brands/${enc(brandId)}/models/${enc(modelId)}/years`, itemsSchema),
    async price(brandId, modelId, yearId, type = 'cars') {
      const p = await get(`/${type}/brands/${enc(brandId)}/models/${enc(modelId)}/years/${enc(yearId)}`, priceSchema);
      return { priceCents: parseFipePrice(p.price), codeFipe: p.codeFipe, referenceMonth: p.referenceMonth, brand: p.brand, model: p.model, modelYear: p.modelYear, fuel: p.fuel };
    },
  };
}
