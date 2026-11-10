import { z } from 'zod';
import {
  amountCentsSchema,
  emailSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonEmptyString,
  objectIdSchema,
  optionalCpfSchema,
  optionalPostalCodeSchema,
  optionalRenavamSchema,
  optionalStateSchema,
  optionalString,
  optionalVinSchema,
  phoneSchema,
  plateSchema,
} from './common.js';
import { driverStatusSchema, vehicleStatusSchema } from './enums.js';

/* ------------------------------ Veículos --------------------------- */

export const vehiclePhotoSchema = z.object({
  fileId: objectIdSchema,
  url: z.string(),
  originalName: z.string(),
});
export type VehiclePhoto = z.infer<typeof vehiclePhotoSchema>;

export const vehicleSchema = z.object({
  id: objectIdSchema,
  plate: z.string(),
  renavam: z.string().nullable(),
  vin: z.string().nullable(),
  brand: z.string(),
  model: z.string(),
  year: z.number().int().nullable(),
  color: z.string().nullable(),
  mileageKm: z.number().int(),
  registrationState: z.string().nullable(),
  registrationCity: z.string().nullable(),
  purchaseDate: isoDateSchema.nullable(),
  purchaseAmountCents: z.number().int().nullable(),
  status: vehicleStatusSchema,
  photos: z.array(vehiclePhotoSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Vehicle = z.infer<typeof vehicleSchema>;

export const vehicleInputSchema = z.object({
  plate: plateSchema,
  renavam: optionalRenavamSchema,
  vin: optionalVinSchema,
  brand: nonEmptyString(60),
  model: nonEmptyString(80),
  year: z
    .union([z.coerce.number().int().min(1900).max(new Date().getFullYear() + 2), z.literal('')])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : (v as number))),
  color: optionalString(40),
  mileageKm: z.coerce.number().int().min(0, 'Hodômetro não pode ser negativo').max(10_000_000).default(0),
  registrationState: optionalStateSchema,
  registrationCity: optionalString(80),
  purchaseDate: isoDateSchema.optional().or(z.literal('').transform(() => undefined)),
  purchaseAmountCents: amountCentsSchema.optional(),
  photoFileIds: z.array(objectIdSchema).max(12).optional(),
});
export type VehicleInput = z.infer<typeof vehicleInputSchema>;

export const vehicleUpdateSchema = vehicleInputSchema.partial();
export type VehicleUpdate = z.infer<typeof vehicleUpdateSchema>;

export const vehicleListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: vehicleStatusSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/* --------------------------- Importação ---------------------------- */

export const vehicleImportRowSchema = z.object({
  line: z.number().int(),
  data: z.object({
    plate: z.string(),
    renavam: z.string().optional(),
    vin: z.string().optional(),
    brand: z.string(),
    model: z.string(),
    year: z.number().int().optional(),
    color: z.string().optional(),
    mileageKm: z.number().int().optional(),
    registrationState: z.string().optional(),
    registrationCity: z.string().optional(),
    purchaseDate: z.string().optional(),
    purchaseAmountCents: z.number().int().optional(),
  }),
  errors: z.array(z.string()),
  duplicateInFile: z.boolean(),
  existsInOrganization: z.boolean(),
});
export type VehicleImportRow = z.infer<typeof vehicleImportRowSchema>;

export const vehicleImportPreviewSchema = z.object({
  token: z.string(),
  fileName: z.string(),
  totalRows: z.number().int(),
  validRows: z.number().int(),
  invalidRows: z.number().int(),
  limit: z.number().int(),
  rows: z.array(vehicleImportRowSchema),
});
export type VehicleImportPreview = z.infer<typeof vehicleImportPreviewSchema>;

export const vehicleImportCommitRequestSchema = z.object({
  token: z.string().min(8).max(200),
  lines: z.array(z.number().int()).min(1, 'Selecione ao menos uma linha válida'),
});
export type VehicleImportCommitRequest = z.infer<typeof vehicleImportCommitRequestSchema>;

export const vehicleImportResultSchema = z.object({
  created: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
});
export type VehicleImportResult = z.infer<typeof vehicleImportResultSchema>;

export const VEHICLE_IMPORT_MAX_ROWS = 200;
export const VEHICLE_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const VEHICLE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

/* ------------------------------ Multas ----------------------------- */

export const trafficFinesResponseSchema = z.object({
  available: z.boolean(),
  provider: z.string().nullable(),
  message: z.string(),
  queriedAt: isoDateTimeSchema.nullable(),
  fines: z.array(
    z.object({
      code: z.string(),
      description: z.string(),
      occurredAt: isoDateTimeSchema.nullable(),
      amountCents: z.number().int(),
      status: z.string(),
    }),
  ),
});
export type TrafficFinesResponse = z.infer<typeof trafficFinesResponseSchema>;

/* ----------------------------- Motoristas -------------------------- */

export const addressSchema = z.object({
  postalCode: z.string().nullable(),
  street: z.string().nullable(),
  number: z.string().nullable(),
  complement: z.string().nullable(),
  district: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
});
export type Address = z.infer<typeof addressSchema>;

export const driverDocumentSchema = z.object({
  fileId: objectIdSchema,
  url: z.string(),
  originalName: z.string(),
  contentType: z.string(),
});

export const driverSchema = z.object({
  id: objectIdSchema,
  fullName: z.string(),
  cpf: z.string().nullable(),
  rg: z.string().nullable(),
  birthDate: isoDateSchema.nullable(),
  email: z.string().nullable(),
  phone: z.string(),
  cnhNumber: z.string().nullable(),
  cnhCategory: z.string().nullable(),
  cnhExpiresAt: isoDateSchema.nullable(),
  cnhExpired: z.boolean(),
  /** Opt-in para mensagens de vistoria pelo WhatsApp. */
  whatsappConsent: z
    .object({
      status: z.enum(['GRANTED', 'REVOKED']),
      grantedAt: isoDateTimeSchema.nullable(),
      source: z.enum(['CONTRACT', 'IN_PERSON', 'WHATSAPP', 'OTHER']).nullable(),
      revokedAt: isoDateTimeSchema.nullable(),
      revokedSource: z.enum(['OPERATOR', 'WHATSAPP_STOP']).nullable(),
    })
    .nullable()
    .optional(),
  address: addressSchema,
  idDocument: driverDocumentSchema.nullable(),
  addressProof: driverDocumentSchema.nullable(),
  status: driverStatusSchema,
  activeRentalsCount: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Driver = z.infer<typeof driverSchema>;

export const driverInputSchema = z.object({
  fullName: nonEmptyString(120),
  birthDate: isoDateSchema.optional().or(z.literal('').transform(() => undefined)),
  cpf: optionalCpfSchema,
  rg: optionalString(20),
  email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
  cnhNumber: optionalString(20),
  cnhCategory: optionalString(5),
  cnhExpiresAt: isoDateSchema.optional().or(z.literal('').transform(() => undefined)),
  phone: phoneSchema,
  idDocumentFileId: objectIdSchema.optional(),
  addressProofFileId: objectIdSchema.optional(),
  address: z
    .object({
      postalCode: optionalPostalCodeSchema,
      street: optionalString(160),
      number: optionalString(20),
      complement: optionalString(80),
      district: optionalString(80),
      city: optionalString(80),
      state: optionalStateSchema,
    })
    .default({}),
});
export type DriverInput = z.infer<typeof driverInputSchema>;

export const driverUpdateSchema = driverInputSchema.partial();
export type DriverUpdate = z.infer<typeof driverUpdateSchema>;

export const driverListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: driverStatusSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/* ------------------------------- CEP ------------------------------- */

export const postalCodeLookupSchema = z.object({
  available: z.boolean(),
  provider: z.string().nullable(),
  message: z.string().optional(),
  address: z
    .object({
      postalCode: z.string(),
      street: z.string().nullable(),
      district: z.string().nullable(),
      city: z.string().nullable(),
      state: z.string().nullable(),
    })
    .nullable(),
});
export type PostalCodeLookup = z.infer<typeof postalCodeLookupSchema>;
