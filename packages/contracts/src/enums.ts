import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Enums do domínio + rótulos PT-BR de apresentação.
 *
 * Decisão [R] documentada em docs/ASSUMPTIONS.md (A-ENUM-01):
 * o código persistido é sempre em inglês e MAIÚSCULO; a interface
 * exibe sempre o rótulo PT-BR. A referência mostra `RENTED` na tela de
 * detalhe do veículo e `Locado` na listagem/PDF — tratamos como o mesmo
 * estado e exibimos `Locado` em todos os lugares.
 * ------------------------------------------------------------------ */

export const vehicleStatuses = ['AVAILABLE', 'RENTED', 'MAINTENANCE', 'INACTIVE'] as const;
export const vehicleStatusSchema = z.enum(vehicleStatuses);
export type VehicleStatus = z.infer<typeof vehicleStatusSchema>;
export const vehicleStatusLabels: Record<VehicleStatus, string> = {
  AVAILABLE: 'Disponível',
  RENTED: 'Locado',
  MAINTENANCE: 'Em manutenção',
  INACTIVE: 'Inativo',
};

export const driverStatuses = ['ACTIVE', 'INACTIVE'] as const;
export const driverStatusSchema = z.enum(driverStatuses);
export type DriverStatus = z.infer<typeof driverStatusSchema>;
export const driverStatusLabels: Record<DriverStatus, string> = {
  ACTIVE: 'Ativo',
  INACTIVE: 'Inativo',
};

/** [O] Opções visíveis no select "Tipo de Locação": Mensal e Semanal. */
export const rentalTypes = ['MONTHLY', 'WEEKLY'] as const;
export const rentalTypeSchema = z.enum(rentalTypes);
export type RentalType = z.infer<typeof rentalTypeSchema>;
export const rentalTypeLabels: Record<RentalType, string> = {
  MONTHLY: 'Mensal',
  WEEKLY: 'Semanal',
};
/** Rótulo adaptativo do campo de valor (ver págs. 69 e 74). */
export const rentalAmountLabels: Record<RentalType, string> = {
  MONTHLY: 'Valor Mensal',
  WEEKLY: 'Valor Semanal',
};
export const rentalPrepaidLabels: Record<RentalType, string> = {
  MONTHLY: 'Valor mensal já foi pago',
  WEEKLY: 'Primeiro valor semanal já foi pago',
};
export const rentalPeriodDays: Record<RentalType, number> = { MONTHLY: 30, WEEKLY: 7 };

export const rentalStatuses = ['ACTIVE', 'FINISHED', 'CANCELED'] as const;
export const rentalStatusSchema = z.enum(rentalStatuses);
export type RentalStatus = z.infer<typeof rentalStatusSchema>;
export const rentalStatusLabels: Record<RentalStatus, string> = {
  ACTIVE: 'Ativa',
  FINISHED: 'Encerrada',
  CANCELED: 'Cancelada',
};

/** [O] Opções visíveis em "Período de Vistoria". */
export const inspectionPeriods = ['WEEKLY', 'MONTHLY'] as const;
export const inspectionPeriodSchema = z.enum(inspectionPeriods);
export type InspectionPeriod = z.infer<typeof inspectionPeriodSchema>;
export const inspectionPeriodLabels: Record<InspectionPeriod, string> = {
  WEEKLY: 'Semanal (a cada 7 dias)',
  MONTHLY: 'Mensal (a cada 30 dias)',
};
export const inspectionPeriodDays: Record<InspectionPeriod, number> = { WEEKLY: 7, MONTHLY: 30 };

export const inspectionWeekdays = ['ANY', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export const inspectionWeekdaySchema = z.enum(inspectionWeekdays);
export type InspectionWeekday = z.infer<typeof inspectionWeekdaySchema>;
export const inspectionWeekdayLabels: Record<InspectionWeekday, string> = {
  ANY: 'Qualquer dia',
  MON: 'Segunda-feira',
  TUE: 'Terça-feira',
  WED: 'Quarta-feira',
  THU: 'Quinta-feira',
  FRI: 'Sexta-feira',
  SAT: 'Sábado',
  SUN: 'Domingo',
};
export const inspectionWeekdayIndex: Record<Exclude<InspectionWeekday, 'ANY'>, number> = {
  SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
};

/** [O] Opções do select "Tipo de Manutenção" (pág. 50). */
export const maintenanceTypes = ['CORRECTIVE', 'PREVENTIVE', 'WARRANTY'] as const;
export const maintenanceTypeSchema = z.enum(maintenanceTypes);
export type MaintenanceType = z.infer<typeof maintenanceTypeSchema>;
export const maintenanceTypeLabels: Record<MaintenanceType, string> = {
  CORRECTIVE: 'Corretiva',
  PREVENTIVE: 'Preventiva',
  WARRANTY: 'Garantia',
};

export const maintenanceStatuses = ['OPEN', 'COMPLETED', 'CANCELED'] as const;
export const maintenanceStatusSchema = z.enum(maintenanceStatuses);
export type MaintenanceStatus = z.infer<typeof maintenanceStatusSchema>;
export const maintenanceStatusLabels: Record<MaintenanceStatus, string> = {
  OPEN: 'Em aberto',
  COMPLETED: 'Concluída',
  CANCELED: 'Cancelada',
};

export const inspectionStatuses = ['PENDING', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELED'] as const;
export const inspectionStatusSchema = z.enum(inspectionStatuses);
export type InspectionStatus = z.infer<typeof inspectionStatusSchema>;
export const inspectionStatusLabels: Record<InspectionStatus, string> = {
  PENDING: 'Pendente',
  SUBMITTED: 'Enviada',
  APPROVED: 'Aprovada',
  REJECTED: 'Reprovada',
  CANCELED: 'Cancelada',
};

export const payableStatuses = ['PENDING', 'PAID', 'OVERDUE', 'CANCELED'] as const;
export const payableStatusSchema = z.enum(payableStatuses);
export type PayableStatus = z.infer<typeof payableStatusSchema>;
export const payableStatusLabels: Record<PayableStatus, string> = {
  PENDING: 'Em aberto',
  PAID: 'Paga',
  OVERDUE: 'Vencida',
  CANCELED: 'Cancelada',
};

export const receivableStatuses = ['OPEN', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELED'] as const;
export const receivableStatusSchema = z.enum(receivableStatuses);
export type ReceivableStatus = z.infer<typeof receivableStatusSchema>;
export const receivableStatusLabels: Record<ReceivableStatus, string> = {
  OPEN: 'Em aberto',
  PARTIAL: 'Parcial',
  PAID: 'Paga',
  OVERDUE: 'Vencida',
  CANCELED: 'Cancelada',
};

/** "À vista" é o único método observado; os demais são [R] configuráveis. */
export const paymentMethods = ['CASH', 'PIX', 'BOLETO', 'CARD', 'TRANSFER', 'OTHER'] as const;
export const paymentMethodSchema = z.enum(paymentMethods);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export const paymentMethodLabels: Record<PaymentMethod, string> = {
  CASH: 'À vista',
  PIX: 'PIX',
  BOLETO: 'Boleto',
  CARD: 'Cartão',
  TRANSFER: 'Transferência',
  OTHER: 'Outro',
};

export const bankAccountTypes = ['CHECKING', 'SAVINGS', 'CASH'] as const;
export const bankAccountTypeSchema = z.enum(bankAccountTypes);
export type BankAccountType = z.infer<typeof bankAccountTypeSchema>;
export const bankAccountTypeLabels: Record<BankAccountType, string> = {
  CHECKING: 'Conta corrente',
  SAVINGS: 'Conta poupança',
  CASH: 'Caixa',
};

export const transactionDirections = ['IN', 'OUT'] as const;
export const transactionDirectionSchema = z.enum(transactionDirections);
export type TransactionDirection = z.infer<typeof transactionDirectionSchema>;
export const transactionDirectionLabels: Record<TransactionDirection, string> = {
  IN: 'Entrada',
  OUT: 'Saída',
};

export const transactionOrigins = [
  'MANUAL',
  'RECEIVABLE',
  'PAYABLE',
  'MAINTENANCE',
  'RENTAL_DEPOSIT',
  'RENTAL_PREPAYMENT',
  'OPENING_BALANCE',
] as const;
export const transactionOriginSchema = z.enum(transactionOrigins);
export type TransactionOrigin = z.infer<typeof transactionOriginSchema>;
export const transactionOriginLabels: Record<TransactionOrigin, string> = {
  MANUAL: 'Manual',
  RECEIVABLE: 'Recebimento',
  PAYABLE: 'Pagamento',
  MAINTENANCE: 'Manutenção',
  RENTAL_DEPOSIT: 'Caução',
  RENTAL_PREPAYMENT: 'Adiantamento',
  OPENING_BALANCE: 'Saldo inicial',
};

/** Abas observadas na página de Notificações (pág. 24). */
export const notificationTypes = ['MAINTENANCE', 'CNH', 'RENTAL', 'INSPECTION', 'FINE'] as const;
export const notificationTypeSchema = z.enum(notificationTypes);
export type NotificationType = z.infer<typeof notificationTypeSchema>;
export const notificationTypeLabels: Record<NotificationType, string> = {
  MAINTENANCE: 'Manutenção',
  CNH: 'CNH',
  RENTAL: 'Locações',
  INSPECTION: 'Vistorias',
  FINE: 'Multas',
};

/** Tipo da conta a receber. FINE = multa repassada ao motorista. */
export const receivableKinds = ['RENT', 'DEPOSIT', 'OTHER', 'FINE', 'DAMAGE'] as const;
export type ReceivableKind = (typeof receivableKinds)[number];
export const receivableKindLabels: Record<ReceivableKind, string> = {
  RENT: 'Locação',
  DEPOSIT: 'Caução',
  OTHER: 'KM excedente',
  FINE: 'Multa',
  DAMAGE: 'Avarias',
};

export const notificationSeverities = ['CRITICAL', 'WARNING', 'INFO'] as const;
export const notificationSeveritySchema = z.enum(notificationSeverities);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;
export const notificationSeverityLabels: Record<NotificationSeverity, string> = {
  CRITICAL: 'Crítico',
  WARNING: 'Atenção',
  INFO: 'Informativo',
};

export const dispatchDeliveryStatuses = ['PENDING', 'SENT', 'FAILED', 'UNAVAILABLE'] as const;
export const dispatchDeliveryStatusSchema = z.enum(dispatchDeliveryStatuses);
export type DispatchDeliveryStatus = z.infer<typeof dispatchDeliveryStatusSchema>;
export const dispatchDeliveryStatusLabels: Record<DispatchDeliveryStatus, string> = {
  PENDING: 'Pendente',
  SENT: 'Enviada',
  FAILED: 'Falhou',
  UNAVAILABLE: 'Provedor indisponível',
};

export const invoiceStatuses = ['PENDING', 'PAID', 'OVERDUE', 'CANCELED'] as const;
export const invoiceStatusSchema = z.enum(invoiceStatuses);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;
export const invoiceStatusLabels: Record<InvoiceStatus, string> = {
  PENDING: 'Pendente',
  PAID: 'Pago',
  OVERDUE: 'Atrasada',
  CANCELED: 'Cancelada',
};

export const membershipRoles = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export const membershipRoleSchema = z.enum(membershipRoles);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;
export const membershipRoleLabels: Record<MembershipRole, string> = {
  OWNER: 'Proprietário',
  ADMIN: 'Administrador',
  MEMBER: 'Colaborador',
};

export const invitationStatuses = ['PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED'] as const;
export const invitationStatusSchema = z.enum(invitationStatuses);
export type InvitationStatus = z.infer<typeof invitationStatusSchema>;
export const invitationStatusLabels: Record<InvitationStatus, string> = {
  PENDING: 'Pendente',
  ACCEPTED: 'Aceito',
  EXPIRED: 'Expirado',
  REVOKED: 'Revogado',
};

export const monthNamesPtBr = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
] as const;

export const monthShortPtBr = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
] as const;
