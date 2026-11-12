import { z } from 'zod';
import { amountCentsSchema, isoDateSchema, isoDateTimeSchema, objectIdSchema } from './common.js';

/* ------------------------------------------------------------------ *
 * Abastecimento e custo por km. Cada abastecimento registra data,
 * litros, valor e hodômetro; o sistema calcula consumo (km/l) e custo
 * por km entre abastecimentos com tanque cheio.
 * ------------------------------------------------------------------ */

export const fuelTypes = ['GASOLINE', 'ETHANOL', 'DIESEL', 'CNG'] as const;
export const fuelTypeSchema = z.enum(fuelTypes);
export type FuelType = z.infer<typeof fuelTypeSchema>;
export const fuelTypeLabels: Record<FuelType, string> = {
  GASOLINE: 'Gasolina',
  ETHANOL: 'Etanol',
  DIESEL: 'Diesel',
  CNG: 'GNV',
};

export const fuelLogCreateSchema = z.object({
  vehicleId: objectIdSchema,
  date: isoDateSchema,
  fuelType: fuelTypeSchema,
  /** Litros (ou m³ no GNV) com até 3 casas. */
  liters: z.coerce.number().positive('Informe os litros').max(500).transform((v) => Math.round(v * 1000) / 1000),
  totalCents: amountCentsSchema.refine((v) => v > 0, 'Informe o valor pago'),
  odometerKm: z.coerce.number().int().min(0).max(10_000_000),
  /** Tanque cheio: base do cálculo de consumo. */
  fullTank: z.boolean().default(true),
  station: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(300).optional(),
});
export type FuelLogCreate = z.infer<typeof fuelLogCreateSchema>;

export const fuelLogListQuerySchema = z.object({
  vehicleId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const fuelLogSchema = z.object({
  id: objectIdSchema,
  vehicle: z.object({ id: objectIdSchema, plate: z.string(), label: z.string() }),
  driver: z.object({ id: objectIdSchema, fullName: z.string() }).nullable(),
  date: isoDateSchema,
  fuelType: fuelTypeSchema,
  liters: z.number(),
  totalCents: z.number().int(),
  pricePerLiterCents: z.number().int(),
  odometerKm: z.number().int(),
  fullTank: z.boolean(),
  station: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type FuelLog = z.infer<typeof fuelLogSchema>;

/** Resumo por veículo (últimos 90 dias por padrão). */
export const fuelSummarySchema = z.object({
  vehicleId: objectIdSchema,
  plate: z.string(),
  label: z.string(),
  fills: z.number().int(),
  liters: z.number(),
  totalCents: z.number().int(),
  /** Km rodados entre o primeiro e o último abastecimento do período; null com menos de 2. */
  distanceKm: z.number().int().nullable(),
  /** Km por litro, só com tanque cheio entre dois abastecimentos; null se não der para calcular. */
  kmPerLiter: z.number().nullable(),
  /** Custo por km em centavos; null se não der para calcular. */
  costPerKmCents: z.number().nullable(),
});
export type FuelSummary = z.infer<typeof fuelSummarySchema>;

export const fuelSummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(90),
});
