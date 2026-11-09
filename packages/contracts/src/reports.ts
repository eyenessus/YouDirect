import { z } from 'zod';
import { isoDateSchema, objectIdSchema } from './common.js';

/* ------------------------- Painel (Dashboard) ---------------------- */

export const dashboardSummarySchema = z.object({
  totals: z.object({
    vehicles: z.number().int(),
    activeDrivers: z.number().int(),
    activeRentals: z.number().int(),
    monthlyRevenueCents: z.number().int(),
  }),
  deltas: z.object({
    vehiclesPercent: z.number().nullable(),
    driversPercent: z.number().nullable(),
    rentalsPercent: z.number().nullable(),
    revenuePercent: z.number().nullable(),
  }),
  revenueSeries: z.array(
    z.object({ month: z.string(), label: z.string(), revenueCents: z.number().int() }),
  ),
  topProfitable: z.array(
    z.object({
      vehicleId: objectIdSchema,
      plate: z.string(),
      model: z.string(),
      amountCents: z.number().int(),
      deltaPercent: z.number().nullable(),
    }),
  ),
  topExpensive: z.array(
    z.object({
      vehicleId: objectIdSchema,
      plate: z.string(),
      model: z.string(),
      amountCents: z.number().int(),
      deltaPercent: z.number().nullable(),
    }),
  ),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

/* ----------------------- Relatório por veículo --------------------- */

export const vehicleReportSchema = z.object({
  period: z.object({ from: isoDateSchema, to: isoDateSchema, label: z.string() }),
  profitCents: z.number().int(),
  revenueCents: z.number().int(),
  expensesCents: z.number().int(),
  activeVehicles: z.number().int(),
  totalVehicles: z.number().int(),
  deltas: z.object({
    profitPercent: z.number().nullable(),
    revenuePercent: z.number().nullable(),
    expensesPercent: z.number().nullable(),
  }),
  monthlyProfit: z.array(z.object({ month: z.string(), label: z.string(), profitCents: z.number().int() })),
  rows: z.array(
    z.object({
      vehicleId: objectIdSchema,
      vehicle: z.string(),
      plate: z.string(),
      revenueCents: z.number().int(),
      expensesCents: z.number().int(),
      profitCents: z.number().int(),
      marginPercent: z.number().nullable(),
    }),
  ),
  vehicleOptions: z.array(
    z.object({ id: objectIdSchema, plate: z.string(), label: z.string(), color: z.string().nullable() }),
  ),
});
export type VehicleReport = z.infer<typeof vehicleReportSchema>;

export const vehicleReportQuerySchema = z.object({
  vehicleId: objectIdSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

/* ----------------------- Relatório por cliente --------------------- */

export const clientReportSchema = z.object({
  rows: z.array(
    z.object({
      driverId: objectIdSchema,
      name: z.string(),
      cpf: z.string().nullable(),
      paidCents: z.number().int(),
      openCents: z.number().int(),
      rentals: z.number().int(),
      status: z.enum(['OPEN', 'SETTLED']),
    }),
  ),
});
export type ClientReport = z.infer<typeof clientReportSchema>;

/* ------------------------------- DRE ------------------------------- */

export const dreLineSchema = z.object({
  key: z.string(),
  label: z.string(),
  amountCents: z.number().int(),
  level: z.number().int(),
  sign: z.enum(['PLUS', 'MINUS', 'EQUALS', 'NONE']),
  emphasis: z.boolean(),
  positive: z.boolean(),
});

export const dreReportSchema = z.object({
  month: z.number().int(),
  year: z.number().int(),
  monthLabel: z.string(),
  organization: z.object({ name: z.string(), legalId: z.string().nullable() }),
  netRevenueCents: z.number().int(),
  grossProfitCents: z.number().int(),
  netResultCents: z.number().int(),
  lines: z.array(dreLineSchema),
  footnote: z.string(),
});
export type DreReport = z.infer<typeof dreReportSchema>;

export const dreQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
});
