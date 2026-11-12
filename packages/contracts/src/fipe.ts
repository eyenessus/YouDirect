import { z } from 'zod';
import { isoDateSchema, isoDateTimeSchema, objectIdSchema } from './common.js';

/* ------------------------------------------------------------------ *
 * Valor de mercado (tabela FIPE) por veículo: vínculo com a tabela,
 * histórico mensal e relatório de desvalorização e rendimento do aluguel.
 * O valor vem da FIPE; o sistema só registra e compara — não recomenda
 * venda nem calcula preço de revenda.
 * ------------------------------------------------------------------ */

export const fipeLinkSchema = z.object({
  brandId: z.string().trim().min(1).max(20),
  modelId: z.string().trim().min(1).max(20),
  /** Código do ano na FIPE, ex.: "2022-1" (ano-combustível). */
  yearId: z.string().trim().regex(/^[\w-]{1,20}$/),
});
export type FipeLink = z.infer<typeof fipeLinkSchema>;

export const fipeItemSchema = z.object({ code: z.string(), name: z.string() });
export type FipeListItem = z.infer<typeof fipeItemSchema>;

export const vehicleFipeSchema = z.object({
  link: fipeLinkSchema,
  codeFipe: z.string(),
  brandName: z.string(),
  modelName: z.string(),
  modelYear: z.number().int(),
  fuel: z.string(),
  referenceMonth: z.string(),
  priceCents: z.number().int(),
  fetchedAt: isoDateTimeSchema,
  history: z.array(z.object({ referenceMonth: z.string(), priceCents: z.number().int() })),
});
export type VehicleFipe = z.infer<typeof vehicleFipeSchema>;

export const fipeReportRowSchema = z.object({
  vehicleId: objectIdSchema,
  plate: z.string(),
  label: z.string(),
  purchaseDate: isoDateSchema.nullable(),
  purchaseAmountCents: z.number().int().nullable(),
  fipePriceCents: z.number().int(),
  referenceMonth: z.string(),
  /** Variação do valor FIPE sobre o preço de compra, em %; negativa = desvalorizou. */
  changeVsPurchasePercent: z.number().nullable(),
  /** Aluguel semanal da locação ativa, em centavos. */
  weeklyRentCents: z.number().int().nullable(),
  /** Aluguel de 52 semanas sobre o valor FIPE, em % ao ano. */
  annualYieldPercent: z.number().nullable(),
});
export type FipeReportRow = z.infer<typeof fipeReportRowSchema>;
