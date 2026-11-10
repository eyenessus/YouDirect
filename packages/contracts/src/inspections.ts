import { z } from 'zod';
import {
  emailSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonEmptyString,
  objectIdSchema,
  optionalString,
  phoneSchema,
} from './common.js';
import { inspectionStatusSchema } from './enums.js';

export const MAX_ACTIVE_PHOTO_SLOTS = 12;

export const photoSlotSchema = z.object({
  id: objectIdSchema,
  code: z.string(),
  label: z.string(),
  order: z.number().int(),
  active: z.boolean(),
  isDefault: z.boolean(),
});
export type PhotoSlot = z.infer<typeof photoSlotSchema>;

/** Slots padrão da referência (págs. 58, 60 e 61). */
export const DEFAULT_PHOTO_SLOTS = [
  { code: 'FRONT', label: 'Frente' },
  { code: 'REAR', label: 'Traseira' },
  { code: 'LEFT_SIDE', label: 'Lateral Esquerda' },
  { code: 'RIGHT_SIDE', label: 'Lateral Direita' },
  { code: 'DASHBOARD', label: 'Painel / KM' },
] as const;

export const photoSlotsUpdateSchema = z
  .object({
    slots: z
      .array(
        z.object({
          id: objectIdSchema.optional(),
          code: z
            .string()
            .trim()
            .toUpperCase()
            .regex(/^[A-Z0-9_]{2,32}$/, 'Código deve conter apenas letras, números e _')
            .optional(),
          label: nonEmptyString(60),
          active: z.boolean(),
        }),
      )
      .max(40),
  })
  .refine((v) => v.slots.filter((s) => s.active).length <= MAX_ACTIVE_PHOTO_SLOTS, {
    message: `Máximo de ${MAX_ACTIVE_PHOTO_SLOTS} slots ativos`,
    path: ['slots'],
  });
export type PhotoSlotsUpdate = z.infer<typeof photoSlotsUpdateSchema>;

export const addPhotoSlotSchema = z.object({ label: nonEmptyString(60) });

export const inspectionPhotoSchema = z.object({
  slotCode: z.string(),
  slotLabel: z.string(),
  fileId: objectIdSchema,
  url: z.string(),
});

export const inspectionSchema = z.object({
  id: objectIdSchema,
  vehicle: z.object({
    id: objectIdSchema,
    plate: z.string(),
    brand: z.string(),
    model: z.string(),
    year: z.number().int().nullable(),
  }),
  rentalId: objectIdSchema.nullable(),
  driverId: objectIdSchema.nullable(),
  responsibleName: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  scheduledAt: isoDateSchema,
  dueDate: isoDateSchema,
  submittedAt: isoDateTimeSchema.nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  status: inspectionStatusSchema,
  odometerKm: z.number().int().nullable(),
  photos: z.array(inspectionPhotoSchema),
  notes: z.string().nullable(),
  requestExpiresAt: isoDateTimeSchema.nullable(),
  delivery: z
    .object({
      channel: z.enum(['WHATSAPP', 'EMAIL', 'MANUAL']),
      status: z.enum(['PENDING', 'SENT', 'FAILED', 'UNAVAILABLE']),
      message: z.string().nullable(),
      manualLink: z.string().nullable(),
    })
    .nullable(),
  createdAt: isoDateTimeSchema,
  /** Coleta guiada pelo WhatsApp (ausente em vistorias antigas). */
  collection: z
    .object({
      mode: z.enum(['WHATSAPP', 'WEB_LINK', 'MANUAL']),
      status: z.string(),
      statusLabel: z.string(),
      round: z.number().int(),
      requiredSlots: z.array(z.object({ code: z.string(), label: z.string() })),
      receivedSlots: z.array(z.string()),
      requireOdometer: z.boolean(),
      scheduledSendAt: isoDateTimeSchema.nullable(),
      requestedAt: isoDateTimeSchema.nullable(),
      respondedAt: isoDateTimeSchema.nullable(),
      completedAt: isoDateTimeSchema.nullable(),
      failureReason: z.string().nullable(),
    })
    .nullable()
    .optional(),
  evidence: z
    .array(
      z.object({
        slotCode: z.string().nullable(),
        slotLabel: z.string(),
        url: z.string(),
        source: z.enum(['WHATSAPP', 'WEB', 'OPERATOR']),
        receivedAt: isoDateTimeSchema,
        round: z.number().int(),
        late: z.boolean(),
        superseded: z.boolean(),
      }),
    )
    .optional(),
  correctionRound: z.number().int().optional(),
  corrections: z
    .array(z.object({ slots: z.array(z.string()), reason: z.string(), at: isoDateTimeSchema }))
    .optional(),
});
export type Inspection = z.infer<typeof inspectionSchema>;

export const inspectionVehicleCardSchema = z.object({
  vehicle: z.object({
    id: objectIdSchema,
    plate: z.string(),
    brand: z.string(),
    model: z.string(),
    year: z.number().int().nullable(),
    photoUrl: z.string().nullable(),
  }),
  driverName: z.string().nullable(),
  lastInspectionAt: isoDateSchema.nullable(),
  nextInspectionAt: isoDateSchema.nullable(),
  onSchedule: z.boolean(),
  pendingCount: z.number().int(),
});
export type InspectionVehicleCard = z.infer<typeof inspectionVehicleCardSchema>;

export const inspectionRequestSchema = z.object({
  responsibleName: nonEmptyString(120),
  phone: phoneSchema,
  email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
  scheduledAt: isoDateSchema,
  notes: optionalString(500),
});
export type InspectionRequest = z.infer<typeof inspectionRequestSchema>;

export const inspectionReviewSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  notes: optionalString(500),
});

export const inspectionListQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: inspectionStatusSchema.optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/* ------------------- Formulário público (token) -------------------- */

export const publicInspectionSchema = z.object({
  organizationName: z.string(),
  vehicle: z.object({ plate: z.string(), brand: z.string(), model: z.string(), year: z.number().int().nullable() }),
  responsibleName: z.string(),
  scheduledAt: isoDateSchema,
  expiresAt: isoDateTimeSchema,
  status: inspectionStatusSchema,
  slots: z.array(z.object({ code: z.string(), label: z.string() })),
});
export type PublicInspection = z.infer<typeof publicInspectionSchema>;

export const publicInspectionSubmitSchema = z.object({
  odometerKm: z.coerce.number().int().min(0).max(10_000_000),
  photos: z
    .array(z.object({ slotCode: z.string().min(1).max(32), fileId: objectIdSchema }))
    .min(1, 'Envie as fotos solicitadas'),
  notes: optionalString(500),
});
export type PublicInspectionSubmit = z.infer<typeof publicInspectionSubmitSchema>;
