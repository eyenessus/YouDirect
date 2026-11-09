import type { ObjectId } from 'mongodb';
import type {
  BankAccountType,
  DispatchDeliveryStatus,
  DriverStatus,
  InspectionPeriod,
  InspectionStatus,
  InspectionWeekday,
  InvitationStatus,
  InvoiceStatus,
  MaintenanceStatus,
  MaintenanceType,
  MembershipRole,
  NotificationSeverity,
  NotificationType,
  PayableStatus,
  PaymentMethod,
  PermissionMatrix,
  ReceivableStatus,
  RentalStatus,
  RentalType,
  TransactionDirection,
  TransactionOrigin,
  VehicleStatus,
  FilePurpose,
} from '@frotaone/contracts';

/** Data pura de negócio no formato `YYYY-MM-DD`. */
export type IsoDate = string;

interface Base {
  _id: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

interface Tenant extends Base {
  organizationId: ObjectId;
}

export interface OrganizationDoc extends Base {
  name: string;
  legalId: string | null;
  timezone: string;
  currency: string;
  settings: {
    freeSeats: number;
    extraSeatPriceCents: number;
  };
}

export interface UserDoc extends Base {
  name: string;
  emailLower: string;
  passwordHash: string;
  phone: string | null;
  status: 'ACTIVE' | 'DISABLED';
  browserNotificationsEnabled: boolean;
  lastLoginAt: Date | null;
}

export interface MembershipDoc extends Tenant {
  userId: ObjectId;
  role: MembershipRole;
  permissions: PermissionMatrix;
  status: 'ACTIVE' | 'SUSPENDED';
}

export interface InvitationDoc extends Tenant {
  name: string;
  emailLower: string;
  phone: string | null;
  permissions: PermissionMatrix;
  tokenHash: string;
  expiresAt: Date;
  status: InvitationStatus;
  invitedBy: ObjectId;
  acceptedAt: Date | null;
  delivery: {
    channel: 'EMAIL' | 'MANUAL';
    status: 'PENDING' | 'SENT' | 'FAILED' | 'UNAVAILABLE';
    message: string | null;
  } | null;
}

export interface SessionDoc {
  _id: ObjectId;
  userId: ObjectId;
  organizationId: ObjectId;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgent: string | null;
  ip: string | null;
}

export interface PasswordResetDoc {
  _id: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface FileDoc extends Tenant {
  originalName: string;
  contentType: string;
  size: number;
  storageKey: string;
  checksum: string;
  purpose: FilePurpose;
  uploadedBy: ObjectId | null;
  status: 'ACTIVE' | 'DELETED';
}

export interface VehicleDoc extends Tenant {
  plate: string;
  renavam: string | null;
  vin: string | null;
  brand: string;
  model: string;
  brandLower: string;
  modelLower: string;
  year: number | null;
  color: string | null;
  colorLower: string | null;
  mileageKm: number;
  registration: { state: string | null; city: string | null };
  purchase: { date: IsoDate | null; amountCents: number | null };
  photoFileIds: ObjectId[];
  status: VehicleStatus;
  archivedAt: Date | null;
  createdBy: ObjectId | null;
  version: number;
}

export interface DriverDoc extends Tenant {
  fullName: string;
  fullNameFold: string;
  cpfEncrypted: string | null;
  cpfLookupHash: string | null;
  cpfLast3: string | null;
  rgEncrypted: string | null;
  birthDate: IsoDate | null;
  emailLower: string | null;
  phone: string;
  cnh: { number: string | null; category: string | null; expiresAt: IsoDate | null };
  address: {
    postalCode: string | null;
    street: string | null;
    number: string | null;
    complement: string | null;
    district: string | null;
    city: string | null;
    state: string | null;
  };
  idDocumentFileId: ObjectId | null;
  addressProofFileId: ObjectId | null;
  status: DriverStatus;
  archivedAt: Date | null;
  createdBy: ObjectId | null;
  version: number;
}

export interface RentalDoc extends Tenant {
  rentalNumber: string;
  sequence: number;
  vehicleId: ObjectId;
  driverId: ObjectId;
  startDate: IsoDate;
  endDate: IsoDate | null;
  rentalType: RentalType;
  inspectionRule: { period: InspectionPeriod | null; weekday: InspectionWeekday };
  periodicAmountCents: number;
  depositCents: number;
  firstPeriodPrepaid: boolean;
  depositPrepaid: boolean;
  allowedKm: number | null;
  monthlyFranchiseKm: number | null;
  contractFileId: ObjectId | null;
  notes: string | null;
  status: RentalStatus;
  closedAt: Date | null;
  history: Array<{ at: Date; actorId: ObjectId | null; action: string; detail?: string }>;
  createdBy: ObjectId | null;
  version: number;
}

export interface MaintenanceItemEmbedded {
  name: string;
  code: string | null;
  quantity: number;
  unitCostCents: number;
  subtotalCents: number;
  supplier: string | null;
  warrantyUntil: IsoDate | null;
  nextDueDate: IsoDate | null;
}

export interface MaintenanceOrderDoc extends Tenant {
  orderNumber: string;
  sequence: number;
  vehicleId: ObjectId;
  type: MaintenanceType;
  status: MaintenanceStatus;
  description: string;
  openedAt: IsoDate | null;
  scheduledAt: IsoDate | null;
  performedAt: IsoDate | null;
  completedAt: IsoDate | null;
  canceledAt: IsoDate | null;
  mileageKm: number | null;
  laborCostCents: number;
  partsCostCents: number;
  totalCents: number;
  items: MaintenanceItemEmbedded[];
  paymentMethod: PaymentMethod;
  bankAccountId: ObjectId | null;
  invoiceFileId: ObjectId | null;
  notes: string | null;
  ledgerTransactionId: ObjectId | null;
  createdBy: ObjectId | null;
  version: number;
}

export interface PhotoSlotDoc extends Tenant {
  code: string;
  label: string;
  order: number;
  active: boolean;
  isDefault: boolean;
}

export interface InspectionDoc extends Tenant {
  vehicleId: ObjectId;
  rentalId: ObjectId | null;
  driverId: ObjectId | null;
  responsibleName: string;
  phone: string;
  email: string | null;
  scheduledAt: IsoDate;
  dueDate: IsoDate;
  submittedAt: Date | null;
  reviewedAt: Date | null;
  reviewerId: ObjectId | null;
  status: InspectionStatus;
  odometerKm: number | null;
  photos: Array<{ slotCode: string; slotLabel: string; fileId: ObjectId }>;
  notes: string | null;
  requestTokenHash: string | null;
  requestExpiresAt: Date | null;
  delivery: {
    channel: 'WHATSAPP' | 'EMAIL' | 'MANUAL';
    status: 'PENDING' | 'SENT' | 'FAILED' | 'UNAVAILABLE';
    message: string | null;
    manualLink: string | null;
    attempts: number;
  } | null;
  source: 'MANUAL' | 'SCHEDULED';
  createdBy: ObjectId | null;
}

export interface BankAccountDoc extends Tenant {
  name: string;
  institution: string | null;
  type: BankAccountType;
  initialBalanceCents: number;
  initialBalanceDate: IsoDate;
  isDefault: boolean;
  active: boolean;
  archivedAt: Date | null;
}

export interface BankTransactionDoc extends Tenant {
  bankAccountId: ObjectId;
  occurredAt: IsoDate;
  description: string;
  direction: TransactionDirection;
  amountCents: number;
  originType: TransactionOrigin;
  originId: ObjectId | null;
  dedupeKey: string | null;
  reversedByTransactionId: ObjectId | null;
  reversalOfTransactionId: ObjectId | null;
  createdBy: ObjectId | null;
}

export interface ExpenseCategoryDoc extends Tenant {
  label: string;
  slug: string;
  active: boolean;
  isDefault: boolean;
}

export interface PayableDoc extends Tenant {
  description: string;
  descriptionFold: string;
  categoryId: ObjectId | null;
  vehicleId: ObjectId | null;
  amountCents: number;
  paidAmountCents: number;
  dueDate: IsoDate;
  supplier: { name: string | null; nameFold: string | null; taxId: string | null };
  documentUrl: string | null;
  recurring: { enabled: boolean; seriesId: string | null; period: string | null };
  notes: string | null;
  status: PayableStatus;
  createdBy: ObjectId | null;
  version: number;
}

export interface ReceivableDoc extends Tenant {
  description: string;
  descriptionFold: string;
  rentalId: ObjectId | null;
  driverId: ObjectId;
  grossAmountCents: number;
  paidAmountCents: number;
  dueDate: IsoDate;
  paymentMethod: PaymentMethod | null;
  kind: 'RENT' | 'DEPOSIT' | 'OTHER';
  installmentNo: number | null;
  expectedPeriod: string | null;
  status: ReceivableStatus;
  createdBy: ObjectId | null;
  version: number;
}

export interface PaymentDoc extends Tenant {
  sourceType: 'RECEIVABLE' | 'PAYABLE';
  sourceId: ObjectId;
  amountCents: number;
  paidAt: IsoDate;
  method: PaymentMethod;
  bankAccountId: ObjectId | null;
  transactionId: ObjectId | null;
  idempotencyKey: string | null;
  notes: string | null;
  createdBy: ObjectId | null;
}

export interface NotificationDoc extends Tenant {
  userId: ObjectId | null;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  subjectLabel: string | null;
  entityType: string | null;
  entityId: ObjectId | null;
  targetPath: string | null;
  readAt: Date | null;
  dedupeKey: string;
}

export interface MessageTemplateDoc extends Tenant {
  name: string;
  body: string;
  isDefault: boolean;
  createdBy: ObjectId | null;
}

export interface MessageDispatchDoc extends Tenant {
  templateId: ObjectId | null;
  bodySnapshot: string;
  providerName: string | null;
  providerAvailable: boolean;
  deliveries: Array<{
    driverId: ObjectId;
    driverName: string;
    phone: string;
    renderedBody: string;
    status: DispatchDeliveryStatus;
    providerMessageId: string | null;
    error: string | null;
    manualLink: string | null;
    idempotencyKey: string;
    updatedAt: Date;
  }>;
  createdBy: ObjectId | null;
}

export interface SubscriptionDoc extends Tenant {
  status: 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'TRIAL';
  planCode: string;
  planLabel: string;
  productLabel: string;
  cycle: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  cycleMonths: number;
  monthlyPriceCents: number;
  discountPercent: number;
  vehicleRange: { min: number; max: number | null };
  periodStart: IsoDate;
  periodEnd: IsoDate;
  nextDueAt: IsoDate | null;
  providerName: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
}

export interface BillingInvoiceDoc extends Tenant {
  description: string;
  amountCents: number;
  status: InvoiceStatus;
  dueDate: IsoDate;
  paidAt: IsoDate | null;
  providerInvoiceId: string | null;
  paymentUrl: string | null;
  invoiceUrl: string | null;
  composition: Array<{ label: string; amountCents: number }> | null;
}

export interface AuditLogDoc extends Tenant {
  actorId: ObjectId | null;
  action: string;
  entityType: string;
  entityId: ObjectId | null;
  before: unknown;
  after: unknown;
  correlationId: string | null;
  occurredAt: Date;
}

export interface CounterDoc {
  _id: string; // `${organizationId}:${scope}:${year}`
  seq: number;
}

export interface ImportDraftDoc {
  _id: ObjectId;
  organizationId: ObjectId;
  userId: ObjectId;
  token: string;
  fileName: string;
  rows: unknown[];
  createdAt: Date;
  expiresAt: Date;
}
