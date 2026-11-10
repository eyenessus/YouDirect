import { z } from 'zod';
import {
  emailSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonEmptyString,
  objectIdSchema,
  optionalPhoneSchema,
} from './common.js';
import { invitationStatusSchema, invoiceStatusSchema, membershipRoleSchema } from './enums.js';
import { permissionMatrixSchema } from './permissions.js';

/* --------------------------- Colaboradores ------------------------- */

export const membershipSchema = z.object({
  id: objectIdSchema,
  user: z.object({ id: objectIdSchema, name: z.string(), email: z.string(), phone: z.string().nullable() }),
  role: membershipRoleSchema,
  permissions: permissionMatrixSchema,
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  createdAt: isoDateTimeSchema,
});
export type Membership = z.infer<typeof membershipSchema>;

export const invitationSchema = z.object({
  id: objectIdSchema,
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  permissions: permissionMatrixSchema,
  status: invitationStatusSchema,
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  acceptUrl: z.string().nullable(),
  delivery: z
    .object({
      channel: z.enum(['EMAIL', 'MANUAL']),
      status: z.enum(['PENDING', 'SENT', 'FAILED', 'UNAVAILABLE']),
      message: z.string().nullable(),
    })
    .nullable(),
});
export type Invitation = z.infer<typeof invitationSchema>;

export const invitationCreateSchema = z.object({
  name: nonEmptyString(120),
  email: emailSchema,
  phone: optionalPhoneSchema,
  permissions: permissionMatrixSchema,
});
export type InvitationCreate = z.infer<typeof invitationCreateSchema>;

export const membershipPermissionsUpdateSchema = z.object({
  permissions: permissionMatrixSchema,
});

export const membershipRoleUpdateSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER']),
});

export const employeesOverviewSchema = z.object({
  freeSeats: z.number().int(),
  extraSeatPriceCents: z.number().int(),
  usedSeats: z.number().int(),
  memberships: z.array(membershipSchema),
  invitations: z.array(invitationSchema),
});
export type EmployeesOverview = z.infer<typeof employeesOverviewSchema>;

/* ----------------------------- Assinatura -------------------------- */

export const subscriptionSchema = z.object({
  status: z.enum(['ACTIVE', 'PAST_DUE', 'CANCELED', 'TRIAL']),
  statusLabel: z.string(),
  planCode: z.string(),
  planLabel: z.string(),
  productLabel: z.string(),
  cycle: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']),
  cycleLabel: z.string(),
  cycleMonths: z.number().int(),
  nextDueAt: isoDateSchema.nullable(),
  monthlyPriceCents: z.number().int(),
  discountPercent: z.number(),
  cycleTotalCents: z.number().int(),
  periodStart: isoDateSchema,
  periodEnd: isoDateSchema,
  vehicleRange: z.object({ min: z.number().int(), max: z.number().int().nullable() }),
  provider: z.object({ name: z.string().nullable(), connected: z.boolean(), message: z.string().nullable() }),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

export const billingInvoiceSchema = z.object({
  id: objectIdSchema,
  description: z.string(),
  amountCents: z.number().int(),
  status: invoiceStatusSchema,
  dueDate: isoDateSchema,
  paidAt: isoDateSchema.nullable(),
  hasDetail: z.boolean(),
  paymentUrl: z.string().nullable(),
  invoiceUrl: z.string().nullable(),
  composition: z
    .array(z.object({ label: z.string(), amountCents: z.number().int() }))
    .nullable(),
});
export type BillingInvoice = z.infer<typeof billingInvoiceSchema>;

export const subscriptionOverviewSchema = z.object({
  subscription: subscriptionSchema,
  invoices: z.array(billingInvoiceSchema),
  statement: z.object({
    periodLabel: z.string(),
    planRangeLabel: z.string(),
    lines: z.array(z.object({ label: z.string(), hint: z.string().nullable(), amountCents: z.number().int() })),
    totalCents: z.number().int(),
  }),
});
export type SubscriptionOverview = z.infer<typeof subscriptionOverviewSchema>;

/* ------------------------------ Arquivos --------------------------- */

export const filePurposes = [
  'VEHICLE_PHOTO',
  'DRIVER_ID',
  'DRIVER_ADDRESS_PROOF',
  'RENTAL_CONTRACT',
  'MAINTENANCE_INVOICE',
  'INSPECTION_PHOTO',
  'TRAFFIC_FINE_NOTICE',
  'TRAFFIC_FINE_PROOF',
  'MAINTENANCE_REQUEST_PHOTO',
] as const;
export const filePurposeSchema = z.enum(filePurposes);
export type FilePurpose = z.infer<typeof filePurposeSchema>;

export const uploadedFileSchema = z.object({
  id: objectIdSchema,
  originalName: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  purpose: filePurposeSchema,
  url: z.string(),
  createdAt: isoDateTimeSchema,
});
export type UploadedFile = z.infer<typeof uploadedFileSchema>;
