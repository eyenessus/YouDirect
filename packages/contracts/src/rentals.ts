import { z } from 'zod';
import {
  amountCentsSchema,
  isoDateSchema,
  isoDateTimeSchema,
  objectIdSchema,
  optionalString,
} from './common.js';
import {
  inspectionPeriodSchema,
  inspectionWeekdaySchema,
  rentalStatusSchema,
  rentalTypeSchema,
} from './enums.js';

export const rentalSchema = z.object({
  id: objectIdSchema,
  rentalNumber: z.string(),
  vehicle: z.object({
    id: objectIdSchema,
    plate: z.string(),
    brand: z.string(),
    model: z.string(),
    year: z.number().int().nullable(),
  }),
  driver: z.object({
    id: objectIdSchema,
    fullName: z.string(),
    cpf: z.string().nullable(),
    phone: z.string(),
  }),
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullable(),
  rentalType: rentalTypeSchema,
  inspectionPeriod: inspectionPeriodSchema.nullable(),
  inspectionWeekday: inspectionWeekdaySchema,
  periodicAmountCents: z.number().int(),
  depositCents: z.number().int(),
  firstPeriodPrepaid: z.boolean(),
  depositPrepaid: z.boolean(),
  allowedKm: z.number().int().nullable(),
  monthlyFranchiseKm: z.number().int().nullable(),
  contractFile: z
    .object({ fileId: objectIdSchema, url: z.string(), originalName: z.string() })
    .nullable(),
  notes: z.string().nullable(),
  status: rentalStatusSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Rental = z.infer<typeof rentalSchema>;

const baseRentalFields = {
  startDate: isoDateSchema,
  endDate: isoDateSchema.optional().or(z.literal('').transform(() => undefined)),
  rentalType: rentalTypeSchema,
  inspectionPeriod: inspectionPeriodSchema.optional(),
  inspectionWeekday: inspectionWeekdaySchema.default('ANY'),
  periodicAmountCents: amountCentsSchema.refine((v) => v > 0, 'Informe o valor da locação'),
  depositCents: amountCentsSchema.default(0),
  firstPeriodPrepaid: z.boolean().default(false),
  depositPrepaid: z.boolean().default(false),
  allowedKm: z.coerce.number().int().min(0).max(10_000_000).optional(),
  monthlyFranchiseKm: z.coerce.number().int().min(0).max(10_000_000).optional(),
  contractFileId: objectIdSchema.optional(),
  notes: optionalString(2000),
};

export const rentalCreateSchema = z
  .object({
    vehicleId: objectIdSchema,
    driverId: objectIdSchema,
    ...baseRentalFields,
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, {
    message: 'A data de término deve ser igual ou posterior à data de início',
    path: ['endDate'],
  })
  .refine((v) => !v.depositPrepaid || v.depositCents > 0, {
    message: 'Informe o valor do caução para marcá-lo como recebido',
    path: ['depositPrepaid'],
  });
export type RentalCreate = z.infer<typeof rentalCreateSchema>;

export const rentalUpdateSchema = z
  .object(baseRentalFields)
  .partial()
  .refine((v) => !v.endDate || !v.startDate || v.endDate >= v.startDate, {
    message: 'A data de término deve ser igual ou posterior à data de início',
    path: ['endDate'],
  });
export type RentalUpdate = z.infer<typeof rentalUpdateSchema>;

export const rentalListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: rentalStatusSchema.optional(),
  vehicleId: objectIdSchema.optional(),
  driverId: objectIdSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const rentalCloseSchema = z.object({
  endDate: isoDateSchema,
  notes: optionalString(1000),
});
