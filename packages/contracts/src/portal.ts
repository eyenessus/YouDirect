import { z } from 'zod';
import {
  amountCentsSchema,
  emailSchema,
  isoDateSchema,
  isoDateTimeSchema,
  nonEmptyString,
  objectIdSchema,
  optionalString,
  phoneSchema,
} from './common.js';

/* ------------------------------------------------------------------ *
 * Área do Motorista (portal) e site público da locadora.
 * Inspirados na área do cliente da Localiza e no app da Zarp: o
 * motorista acompanha locação, faturas, multas e vistorias sozinho.
 * ------------------------------------------------------------------ */

/* --------------------------- Acesso (link) -------------------------- */

export const driverPortalLoginSchema = z.object({ token: z.string().min(16).max(200) });

export const driverPortalAccessResultSchema = z.object({
  link: z.string(),
  expiresAt: isoDateTimeSchema,
  delivered: z.boolean(),
  manualLink: z.string().nullable(),
  error: z.string().nullable(),
});
export type DriverPortalAccessResult = z.infer<typeof driverPortalAccessResultSchema>;

export const driverPortalAccessStatusSchema = z.object({
  activeSessions: z.number().int(),
  lastAccessAt: isoDateTimeSchema.nullable(),
  pendingLinkExpiresAt: isoDateTimeSchema.nullable(),
});
export type DriverPortalAccessStatus = z.infer<typeof driverPortalAccessStatusSchema>;

/* ------------------------------- DTOs ------------------------------- */

export const portalMeSchema = z.object({
  driver: z.object({
    id: objectIdSchema,
    fullName: z.string(),
    phone: z.string(),
    email: z.string().nullable(),
    cnhExpiresAt: isoDateSchema.nullable(),
    hasIdDocument: z.boolean(),
    hasAddressProof: z.boolean(),
  }),
  organization: z.object({
    name: z.string(),
    whatsappPhone: z.string().nullable(),
    emergencyPhone: z.string().nullable(),
  }),
});
export type PortalMe = z.infer<typeof portalMeSchema>;

export const portalRentalSchema = z.object({
  id: objectIdSchema,
  rentalNumber: z.string(),
  status: z.string(),
  rentalType: z.string(),
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullable(),
  periodicAmountCents: z.number().int(),
  depositCents: z.number().int(),
  allowedKm: z.number().int().nullable(),
  vehicle: z.object({
    id: objectIdSchema,
    plate: z.string(),
    brand: z.string(),
    model: z.string(),
    year: z.number().int().nullable(),
    color: z.string().nullable(),
  }),
});
export type PortalRental = z.infer<typeof portalRentalSchema>;

export const portalInvoiceStatuses = ['OPEN', 'PARTIAL', 'PAID', 'OVERDUE'] as const;
export type PortalInvoiceStatus = (typeof portalInvoiceStatuses)[number];
export const portalInvoiceStatusLabels: Record<PortalInvoiceStatus, string> = {
  OPEN: 'Em aberto',
  PARTIAL: 'Parcial',
  PAID: 'Paga',
  OVERDUE: 'Vencida',
};

export const portalInvoiceSchema = z.object({
  key: z.string(),
  kind: z.enum(['RENT', 'FINE', 'EXTRA_KM', 'DEPOSIT', 'DAMAGE']),
  description: z.string(),
  rentalNumber: z.string().nullable(),
  dueDate: isoDateSchema,
  amountCents: z.number().int(),
  paidCents: z.number().int(),
  remainingCents: z.number().int(),
  status: z.enum(portalInvoiceStatuses),
});
export type PortalInvoice = z.infer<typeof portalInvoiceSchema>;

export const portalInvoicesSchema = z.object({
  invoices: z.array(portalInvoiceSchema),
  totals: z.object({ openCents: z.number().int(), overdueCents: z.number().int(), paidCents: z.number().int() }),
  next: portalInvoiceSchema.nullable(),
});
export type PortalInvoices = z.infer<typeof portalInvoicesSchema>;

export const portalFineSchema = z.object({
  id: objectIdSchema,
  fineNumber: z.string(),
  aitNumber: z.string(),
  authorityName: z.string(),
  infractionDescription: z.string(),
  occurredAt: isoDateTimeSchema,
  place: z.string().nullable(),
  plate: z.string(),
  points: z.number().int().nullable(),
  amountCents: z.number().int(),
  chargeAmountCents: z.number().int(),
  discountUntil: isoDateSchema.nullable(),
  indicationDeadline: isoDateSchema.nullable(),
  indicationStatus: z.string(),
  status: z.string(),
  noticeUrl: z.string().nullable(),
  charge: z
    .object({ dueDate: isoDateSchema, amountCents: z.number().int(), remainingCents: z.number().int(), status: z.string() })
    .nullable(),
});
export type PortalFine = z.infer<typeof portalFineSchema>;

export const portalInspectionSchema = z.object({
  id: objectIdSchema,
  plate: z.string(),
  dueDate: isoDateSchema,
  status: z.string(),
  link: z.string().nullable(),
});
export type PortalInspection = z.infer<typeof portalInspectionSchema>;

/* ----------------------- Pedidos de manutenção ---------------------- */

export const maintenanceRequestCategories = ['MECHANICAL', 'TIRES', 'ELECTRICAL', 'BODYWORK', 'REVIEW', 'ACCIDENT', 'OTHER'] as const;
export const maintenanceRequestCategorySchema = z.enum(maintenanceRequestCategories);
export type MaintenanceRequestCategory = z.infer<typeof maintenanceRequestCategorySchema>;
export const maintenanceRequestCategoryLabels: Record<MaintenanceRequestCategory, string> = {
  MECHANICAL: 'Mecânica (motor, câmbio, freio)',
  TIRES: 'Pneus e rodas',
  ELECTRICAL: 'Elétrica e luzes',
  BODYWORK: 'Lataria e vidros',
  REVIEW: 'Revisão programada',
  ACCIDENT: 'Batida / sinistro',
  OTHER: 'Outro',
};

export const maintenanceRequestStatuses = ['OPEN', 'SCHEDULED', 'DONE', 'REJECTED'] as const;
export const maintenanceRequestStatusSchema = z.enum(maintenanceRequestStatuses);
export type MaintenanceRequestStatus = z.infer<typeof maintenanceRequestStatusSchema>;
export const maintenanceRequestStatusLabels: Record<MaintenanceRequestStatus, string> = {
  OPEN: 'Recebido',
  SCHEDULED: 'Agendado',
  DONE: 'Resolvido',
  REJECTED: 'Recusado',
};

export const maintenanceRequestCreateSchema = z.object({
  rentalId: objectIdSchema,
  category: maintenanceRequestCategorySchema,
  description: nonEmptyString(1000),
  vehicleStopped: z.boolean().default(false),
  photoFileIds: z.array(objectIdSchema).max(6).default([]),
});
export type MaintenanceRequestCreate = z.infer<typeof maintenanceRequestCreateSchema>;

export const maintenanceRequestUpdateSchema = z.object({
  status: maintenanceRequestStatusSchema,
  responseNote: optionalString(500),
});

export const maintenanceRequestSchema = z.object({
  id: objectIdSchema,
  category: maintenanceRequestCategorySchema,
  description: z.string(),
  vehicleStopped: z.boolean(),
  status: maintenanceRequestStatusSchema,
  responseNote: z.string().nullable(),
  vehicle: z.object({ id: objectIdSchema, plate: z.string(), model: z.string() }),
  driver: z.object({ id: objectIdSchema, fullName: z.string(), phone: z.string() }),
  rentalNumber: z.string().nullable(),
  photos: z.array(z.object({ fileId: objectIdSchema, url: z.string() })),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type MaintenanceRequest = z.infer<typeof maintenanceRequestSchema>;

export const portalDocumentSchema = z.object({
  kind: z.enum(['CNH', 'ADDRESS_PROOF']),
  fileId: objectIdSchema,
});

/* ------------------------- Site da locadora ------------------------- */

/** Slug da URL pública (`/l/:slug`): minúsculas, números e hífen. */
export const publicSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'Use de 3 a 40 letras minúsculas, números ou hífen');

export const publicSiteSettingsSchema = z.object({
  publicSlug: publicSlugSchema.nullable(),
  enabled: z.boolean(),
  headline: z.string().trim().max(120).nullable(),
  about: z.string().trim().max(600).nullable(),
  city: z.string().trim().max(80).nullable(),
  whatsappPhone: z.string().nullable(),
  emergencyPhone: z.string().nullable(),
  requirements: z.array(z.string().trim().min(1).max(120)).max(10),
});
export type PublicSiteSettings = z.infer<typeof publicSiteSettingsSchema>;

export const publicSiteSettingsUpdateSchema = z.object({
  publicSlug: publicSlugSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  headline: optionalString(120).nullable(),
  about: optionalString(600).nullable(),
  city: optionalString(80).nullable(),
  whatsappPhone: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D+/g, ''))
    .refine((v) => v === '' || v.length === 10 || v.length === 11, 'Telefone deve ter 10 ou 11 dígitos')
    .nullable()
    .optional(),
  emergencyPhone: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D+/g, ''))
    .refine((v) => v === '' || v.length === 10 || v.length === 11, 'Telefone deve ter 10 ou 11 dígitos')
    .nullable()
    .optional(),
  requirements: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
});
export type PublicSiteSettingsUpdate = z.infer<typeof publicSiteSettingsUpdateSchema>;

export const kmPolicies = ['UNLIMITED', 'FRANCHISE'] as const;
export type KmPolicy = (typeof kmPolicies)[number];

/** Oferta do veículo no site (grupo "ou similar", preço semanal, caução, km). */
export const vehicleOfferSchema = z.object({
  showOnSite: z.boolean(),
  groupName: nonEmptyString(40),
  weeklyPriceCents: amountCentsSchema.refine((v) => v > 0, 'Informe o valor semanal'),
  depositCents: amountCentsSchema.default(0),
  kmPolicy: z.enum(kmPolicies).default('UNLIMITED'),
  weeklyKmFranchise: z.coerce.number().int().min(1).max(20_000).nullable().optional(),
  highlights: z.array(z.string().trim().min(1).max(40)).max(6).default([]),
});
export type VehicleOffer = z.infer<typeof vehicleOfferSchema>;

export const publicCatalogGroupSchema = z.object({
  groupName: z.string(),
  fromWeeklyPriceCents: z.number().int(),
  depositCents: z.number().int(),
  kmPolicy: z.enum(kmPolicies),
  weeklyKmFranchise: z.number().int().nullable(),
  models: z.array(z.string()),
  highlights: z.array(z.string()),
  photoUrl: z.string().nullable(),
  available: z.boolean(),
  availableCount: z.number().int(),
});
export type PublicCatalogGroup = z.infer<typeof publicCatalogGroupSchema>;

export const publicCatalogSchema = z.object({
  organization: z.object({
    name: z.string(),
    headline: z.string().nullable(),
    about: z.string().nullable(),
    city: z.string().nullable(),
    whatsappPhone: z.string().nullable(),
    requirements: z.array(z.string()),
  }),
  groups: z.array(publicCatalogGroupSchema),
});
export type PublicCatalog = z.infer<typeof publicCatalogSchema>;

/* ------------------------- Pedidos de reserva ------------------------ */

export const rentalLeadStatuses = ['NEW', 'CONTACTED', 'APPROVED', 'REJECTED'] as const;
export const rentalLeadStatusSchema = z.enum(rentalLeadStatuses);
export type RentalLeadStatus = z.infer<typeof rentalLeadStatusSchema>;
export const rentalLeadStatusLabels: Record<RentalLeadStatus, string> = {
  NEW: 'Novo',
  CONTACTED: 'Em contato',
  APPROVED: 'Aprovado',
  REJECTED: 'Recusado',
};

export const rentalLeadCreateSchema = z.object({
  fullName: nonEmptyString(120),
  phone: phoneSchema,
  email: emailSchema.optional().or(z.literal('').transform(() => undefined)),
  groupName: optionalString(40),
  desiredStartDate: isoDateSchema.optional().or(z.literal('').transform(() => undefined)),
  appPlatforms: z.array(z.enum(['UBER', '99', 'INDRIVE', 'OTHER'])).max(4).default([]),
  hasEarCnh: z.boolean().default(false),
  message: optionalString(600),
  consent: z.literal(true, { errorMap: () => ({ message: 'É preciso aceitar o contato' }) }),
  /** Honeypot: campo invisível; robôs preenchem. */
  website: z.string().max(200).optional(),
});
export type RentalLeadCreate = z.infer<typeof rentalLeadCreateSchema>;

export const rentalLeadSchema = z.object({
  id: objectIdSchema,
  fullName: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  groupName: z.string().nullable(),
  desiredStartDate: isoDateSchema.nullable(),
  appPlatforms: z.array(z.string()),
  hasEarCnh: z.boolean(),
  message: z.string().nullable(),
  status: rentalLeadStatusSchema,
  notes: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});
export type RentalLead = z.infer<typeof rentalLeadSchema>;

export const rentalLeadUpdateSchema = z.object({
  status: rentalLeadStatusSchema.optional(),
  notes: optionalString(1000).nullable(),
});
