import type {
  CollectionStatus,
  MessageStatus,
  DriverStatus,
  InspectionStatus,
  InvoiceStatus,
  MaintenanceStatus,
  NotificationSeverity,
  PayableStatus,
  ReceivableStatus,
  RentalStatus,
  VehicleStatus,
} from '@yudirect/contracts';
import type { BadgeTone } from '@/components/ui/StatusBadge.vue';

/**
 * Mapeamento status → cor do badge, seguindo as cores observadas:
 * azul para "Locado"/"Paga"/"Cancelada", verde para estados concluídos
 * ou ativos, vermelho para vencidos/críticos.
 */
export const statusTone = {
  vehicle: {
    AVAILABLE: 'green',
    RENTED: 'blue',
    MAINTENANCE: 'amber',
    INACTIVE: 'slate',
  } satisfies Record<VehicleStatus, BadgeTone>,

  driver: {
    ACTIVE: 'green',
    INACTIVE: 'slate',
  } satisfies Record<DriverStatus, BadgeTone>,

  rental: {
    ACTIVE: 'green',
    FINISHED: 'slate',
    CANCELED: 'blue',
  } satisfies Record<RentalStatus, BadgeTone>,

  maintenance: {
    OPEN: 'amber',
    COMPLETED: 'green',
    CANCELED: 'blue',
  } satisfies Record<MaintenanceStatus, BadgeTone>,

  inspection: {
    PENDING: 'amber',
    SUBMITTED: 'blue',
    APPROVED: 'green',
    REJECTED: 'red',
    CANCELED: 'blue',
  } satisfies Record<InspectionStatus, BadgeTone>,

  payable: {
    PENDING: 'slate',
    PAID: 'blue',
    OVERDUE: 'red',
    CANCELED: 'slate',
  } satisfies Record<PayableStatus, BadgeTone>,

  receivable: {
    OPEN: 'slate',
    PARTIAL: 'amber',
    PAID: 'blue',
    OVERDUE: 'red',
    CANCELED: 'slate',
  } satisfies Record<ReceivableStatus, BadgeTone>,

  invoice: {
    PENDING: 'amber',
    PAID: 'blue',
    OVERDUE: 'red',
    CANCELED: 'slate',
  } satisfies Record<InvoiceStatus, BadgeTone>,

  severity: {
    CRITICAL: 'red',
    WARNING: 'amber',
    INFO: 'blue',
  } satisfies Record<NotificationSeverity, BadgeTone>,

  message: {
    INTENT_CREATED: 'slate',
    RETRY_SCHEDULED: 'amber',
    SUBMITTED_TO_WHAPLY: 'slate',
    ACCEPTED_BY_WHAPLY: 'slate',
    DEFERRED: 'amber',
    ACCEPTED_BY_META: 'blue',
    SENT: 'blue',
    DELIVERED: 'green',
    READ: 'green',
    FAILED: 'red',
    CANCELED: 'slate',
  } satisfies Record<MessageStatus, BadgeTone>,

  collection: {
    NOT_SCHEDULED: 'slate',
    SCHEDULED: 'slate',
    BLOCKED_NO_CONSENT: 'amber',
    REQUESTED: 'blue',
    IN_PROGRESS: 'blue',
    PARTIAL: 'amber',
    COMPLETE: 'green',
    EXPIRED: 'red',
    FAILED: 'red',
    CANCELED: 'slate',
  } satisfies Record<CollectionStatus, BadgeTone>,
} as const;

/** Cor da borda lateral dos cartões de notificação. */
export const severityBorder: Record<NotificationSeverity, string> = {
  CRITICAL: 'border-l-[rgb(var(--c-negative))]',
  WARNING: 'border-l-[rgb(var(--c-warning))]',
  INFO: 'border-l-brand-500',
};
