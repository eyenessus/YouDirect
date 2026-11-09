import { z } from 'zod';
import {
  amountCentsSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonEmptyString,
  objectIdSchema,
  optionalString,
} from './common.js';
import { maintenanceStatusSchema, maintenanceTypeSchema, paymentMethodSchema } from './enums.js';

export const maintenanceItemSchema = z.object({
  name: z.string(),
  code: z.string().nullable(),
  quantity: z.number().int(),
  unitCostCents: z.number().int(),
  subtotalCents: z.number().int(),
  supplier: z.string().nullable(),
  warrantyUntil: isoDateSchema.nullable(),
  nextDueDate: isoDateSchema.nullable(),
});
export type MaintenanceItem = z.infer<typeof maintenanceItemSchema>;

export const maintenanceAttachmentSchema = z.object({
  fileId: objectIdSchema,
  url: z.string(),
  originalName: z.string(),
  contentType: z.string(),
  label: z.string(),
});

export const maintenanceOrderSchema = z.object({
  id: objectIdSchema,
  orderNumber: z.string(),
  vehicle: z.object({
    id: objectIdSchema,
    plate: z.string(),
    brand: z.string(),
    model: z.string(),
    year: z.number().int().nullable(),
  }),
  type: maintenanceTypeSchema,
  status: maintenanceStatusSchema,
  description: z.string(),
  openedAt: isoDateSchema.nullable(),
  scheduledAt: isoDateSchema.nullable(),
  performedAt: isoDateSchema.nullable(),
  completedAt: isoDateSchema.nullable(),
  canceledAt: isoDateSchema.nullable(),
  mileageKm: z.number().int().nullable(),
  laborCostCents: z.number().int(),
  partsCostCents: z.number().int(),
  totalCents: z.number().int(),
  items: z.array(maintenanceItemSchema),
  paymentMethod: paymentMethodSchema,
  bankAccount: z.object({ id: objectIdSchema, name: z.string() }).nullable(),
  invoice: maintenanceAttachmentSchema.nullable(),
  notes: z.string().nullable(),
  ledgerPosted: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type MaintenanceOrder = z.infer<typeof maintenanceOrderSchema>;

export const maintenanceItemInputSchema = z.object({
  name: nonEmptyString(160),
  code: optionalString(60),
  quantity: z.coerce.number().int().min(1, 'Quantidade deve ser maior que zero').max(100000),
  unitCostCents: amountCentsSchema,
  supplier: optionalString(120),
  warrantyUntil: isoDateSchema.optional().or(z.literal('').transform(() => undefined)),
  nextDueDate: isoDateSchema.optional().or(z.literal('').transform(() => undefined)),
});
export type MaintenanceItemInput = z.infer<typeof maintenanceItemInputSchema>;

export const maintenanceCreateSchema = z.object({
  type: maintenanceTypeSchema,
  performedAt: isoDateSchema.optional().or(z.literal('').transform(() => undefined)),
  description: nonEmptyString(500),
  laborCostCents: amountCentsSchema.default(0),
  mileageKm: z.coerce.number().int().min(0).max(10_000_000).optional(),
  invoiceFileId: objectIdSchema.optional(),
  notes: optionalString(2000),
  items: z.array(maintenanceItemInputSchema).max(100).default([]),
  paymentMethod: paymentMethodSchema.default('CASH'),
  bankAccountId: objectIdSchema.optional(),
  status: maintenanceStatusSchema.default('COMPLETED'),
});
export type MaintenanceCreate = z.infer<typeof maintenanceCreateSchema>;

export const maintenanceUpdateSchema = maintenanceCreateSchema.partial().omit({ status: true });
export type MaintenanceUpdate = z.infer<typeof maintenanceUpdateSchema>;

export const maintenanceListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: maintenanceStatusSchema.optional(),
  type: maintenanceTypeSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const maintenanceVehicleCardSchema = z.object({
  vehicle: z.object({
    id: objectIdSchema,
    plate: z.string(),
    brand: z.string(),
    model: z.string(),
    year: z.number().int().nullable(),
    status: z.string(),
  }),
  orderCount: z.number().int(),
  totalCents: z.number().int(),
  lastPerformedAt: isoDateSchema.nullable(),
});
export type MaintenanceVehicleCard = z.infer<typeof maintenanceVehicleCardSchema>;

export const maintenanceSummarySchema = z.object({
  orderCount: z.number().int(),
  totalCents: z.number().int(),
  completedCount: z.number().int(),
  openCount: z.number().int(),
  canceledCount: z.number().int(),
  laborCents: z.number().int(),
  partsCents: z.number().int(),
  averageCents: z.number().int(),
});
export type MaintenanceSummary = z.infer<typeof maintenanceSummarySchema>;

/**
 * Regra de soma [O/R]:
 *   partsCost = Σ(quantity × unitCostCents)
 *   total     = laborCostCents + partsCost
 * Ordens canceladas são excluídas de todos os totalizadores e do PDF.
 */
export function computePartsCostCents(items: Array<{ quantity: number; unitCostCents: number }>): number {
  return items.reduce((acc, item) => acc + item.quantity * item.unitCostCents, 0);
}

export function computeMaintenanceTotalCents(
  laborCostCents: number,
  items: Array<{ quantity: number; unitCostCents: number }>,
): number {
  return laborCostCents + computePartsCostCents(items);
}
