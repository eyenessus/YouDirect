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
  TrafficFineStatus,
  VehicleStatus,
} from '@yudirect/contracts';

/** Prazo de indicação: vermelho vencido, âmbar até 7 dias, nada se já indicado/encerrado. */
export function fineDeadlineTone(
  fine: { indicationDeadline: string | null; indication: { status: string }; status: TrafficFineStatus },
  today: string,
): { tone: 'red' | 'amber'; label: string } | null {
  if (!fine.indicationDeadline) return null;
  if (fine.indication.status === 'MISSED') return { tone: 'red', label: 'Prazo perdido' };
  if (fine.indication.status !== 'PENDING' || !['RECEIVED', 'DRIVER_IDENTIFIED'].includes(fine.status)) return null;
  const days = Math.round(
    (Date.parse(`${fine.indicationDeadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (days < 0) return { tone: 'red', label: 'Indicação vencida' };
  if (days === 0) return { tone: 'red', label: 'Indicar hoje' };
  if (days <= 7) return { tone: 'amber', label: `Indicar em ${days} dia(s)` };
  return null;
}
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

  fine: {
    RECEIVED: 'amber',
    DRIVER_IDENTIFIED: 'blue',
    INDICATED: 'blue',
    CHARGED: 'amber',
    PAID: 'green',
    COMPANY_LIABLE: 'slate',
    CONTESTED: 'amber',
    CANCELED: 'slate',
  } satisfies Record<TrafficFineStatus, BadgeTone>,

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
