import { ObjectId, type ClientSession } from 'mongodb';
import {
  addDaysIso,
  businessDate,
  diffDaysIso,
  formatIsoDateBR,
  vehicleDueKindLabels,
  type NotificationSeverity,
  type NotificationType,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import { dueBucket, listVehicleDue, vehicleDueTitle } from './vehicle-due.js';

export interface CreateNotificationInput {
  organizationId: ObjectId;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  subjectLabel?: string | null;
  entityType?: string | null;
  entityId?: ObjectId | null;
  targetPath?: string | null;
  dedupeKey: string;
  createdAt?: Date;
}

/**
 * Cria a notificação de forma idempotente. `dedupeKey` carrega o
 * contexto (tipo + entidade + competência), de modo que o job pode
 * rodar quantas vezes for necessário sem duplicar alertas.
 * Retorna `true` quando a notificação foi efetivamente criada.
 */
export async function createNotification(
  ctx: AppContext,
  input: CreateNotificationInput,
  session?: ClientSession,
): Promise<boolean> {
  const now = input.createdAt ?? new Date();
  try {
    await ctx.mongo.collections.notifications.insertOne(
      {
        _id: new ObjectId(),
        organizationId: input.organizationId,
        userId: null,
        type: input.type,
        severity: input.severity,
        title: input.title,
        message: input.message,
        subjectLabel: input.subjectLabel ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        targetPath: input.targetPath ?? null,
        readAt: null,
        dedupeKey: input.dedupeKey,
        createdAt: now,
        updatedAt: now,
      },
      { session },
    );
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return false;
    throw err;
  }
}

/* ------------------------------------------------------------------ *
 * Geradores de alerta. Usam SEMPRE a data efetiva do sistema — um aviso
 * vencido de seed nunca é reemitido como novo (prompt §12).
 * ------------------------------------------------------------------ */

export async function generateCnhNotifications(
  ctx: AppContext,
  organizationId: ObjectId,
  today = businessDate(),
): Promise<number> {
  const drivers = await ctx.mongo.collections.drivers
    .find({
      organizationId,
      status: 'ACTIVE',
      archivedAt: null,
      'cnh.expiresAt': { $type: 'string' },
    })
    .toArray();

  let created = 0;
  for (const driver of drivers) {
    const expiry = driver.cnh.expiresAt!;
    const days = diffDaysIso(expiry, today);
    let severity: NotificationSeverity | null = null;
    let title = '';
    let message = '';

    if (days < 0) {
      severity = 'CRITICAL';
      title = 'CNH vencida';
      message = `A CNH de ${driver.fullName} está vencida desde ${formatIsoDateBR(expiry)}.`;
    } else if (days === 0) {
      severity = 'CRITICAL';
      title = 'CNH vence hoje';
      message = `A CNH de ${driver.fullName} vence hoje (${formatIsoDateBR(expiry)}).`;
    } else if (days <= 30) {
      severity = 'WARNING';
      title = 'CNH próxima do vencimento';
      message = `A CNH de ${driver.fullName} vence em ${days} dia(s) (${formatIsoDateBR(expiry)}).`;
    }

    if (!severity) continue;
    const bucket = days < 0 ? 'expired' : days === 0 ? 'today' : 'soon';
    const ok = await createNotification(ctx, {
      organizationId,
      type: 'CNH',
      severity,
      title,
      message,
      subjectLabel: driver.fullName,
      entityType: 'driver',
      entityId: driver._id,
      targetPath: `/dashboard/drivers/${driver._id.toHexString()}`,
      dedupeKey: `cnh:${driver._id.toHexString()}:${expiry}:${bucket}:${days < 0 ? weekKey(today) : ''}`,
    });
    if (ok) created += 1;
  }
  return created;
}

export async function generateRentalNotifications(
  ctx: AppContext,
  organizationId: ObjectId,
  today = businessDate(),
): Promise<number> {
  const rentals = await ctx.mongo.collections.rentals
    .find({ organizationId, status: 'ACTIVE', endDate: { $type: 'string' } })
    .toArray();

  let created = 0;
  for (const rental of rentals) {
    const days = diffDaysIso(rental.endDate!, today);
    if (days < 0 || days > 15) continue;
    const vehicle = await ctx.mongo.collections.vehicles.findOne({ _id: rental.vehicleId, organizationId });
    const ok = await createNotification(ctx, {
      organizationId,
      type: 'RENTAL',
      severity: days <= 3 ? 'CRITICAL' : 'WARNING',
      title: days === 0 ? 'Locação encerra hoje' : 'Locação próxima do término',
      message: `O contrato ${rental.rentalNumber}${vehicle ? ` (${vehicle.plate})` : ''} termina em ${formatIsoDateBR(
        rental.endDate!,
      )}.`,
      subjectLabel: rental.rentalNumber,
      entityType: 'rental',
      entityId: rental._id,
      targetPath: `/dashboard/rentals`,
      dedupeKey: `rental-end:${rental._id.toHexString()}:${rental.endDate}:${days <= 3 ? 'near' : 'soon'}`,
    });
    if (ok) created += 1;
  }
  return created;
}

export async function generateInspectionNotifications(
  ctx: AppContext,
  organizationId: ObjectId,
  today = businessDate(),
): Promise<number> {
  const pending = await ctx.mongo.collections.inspections
    .find({ organizationId, status: { $in: ['PENDING', 'SUBMITTED'] } })
    .toArray();

  let created = 0;
  for (const inspection of pending) {
    const days = diffDaysIso(inspection.dueDate, today);
    if (inspection.status === 'PENDING' && days > 2) continue;
    if (inspection.status === 'SUBMITTED' && days > 0) continue;
    const vehicle = await ctx.mongo.collections.vehicles.findOne({
      _id: inspection.vehicleId,
      organizationId,
    });
    const overdue = days < 0;
    const ok = await createNotification(ctx, {
      organizationId,
      type: 'INSPECTION',
      severity: overdue ? 'CRITICAL' : 'WARNING',
      title: overdue ? 'Vistoria em atraso' : 'Vistoria com prazo próximo',
      message: `A vistoria de ${vehicle?.plate ?? 'veículo'} tem prazo ${formatIsoDateBR(inspection.dueDate)}.`,
      subjectLabel: vehicle?.plate ?? null,
      entityType: 'inspection',
      entityId: inspection._id,
      targetPath: `/dashboard/inspections/${inspection.vehicleId.toHexString()}`,
      dedupeKey: `inspection-due:${inspection._id.toHexString()}:${inspection.dueDate}:${overdue ? `late:${weekKey(today)}` : 'soon'}`,
    });
    if (ok) created += 1;
  }
  return created;
}

export async function generateMaintenanceNotifications(
  ctx: AppContext,
  organizationId: ObjectId,
  today = businessDate(),
): Promise<number> {
  const orders = await ctx.mongo.collections.maintenanceOrders
    .find({ organizationId, status: 'COMPLETED', 'items.nextDueDate': { $type: 'string' } })
    .toArray();

  let created = 0;
  for (const order of orders) {
    for (const item of order.items) {
      if (!item.nextDueDate) continue;
      const days = diffDaysIso(item.nextDueDate, today);
      if (days > 15 || days < -365) continue;
      const vehicle = await ctx.mongo.collections.vehicles.findOne({
        _id: order.vehicleId,
        organizationId,
      });
      const ok = await createNotification(ctx, {
        organizationId,
        type: 'MAINTENANCE',
        severity: days < 0 ? 'CRITICAL' : 'WARNING',
        title: days < 0 ? 'Manutenção programada em atraso' : 'Manutenção programada',
        message: `${item.name} — ${vehicle?.plate ?? 'veículo'} previsto para ${formatIsoDateBR(item.nextDueDate)}.`,
        subjectLabel: vehicle?.plate ?? null,
        entityType: 'maintenanceOrder',
        entityId: order._id,
        targetPath: `/dashboard/maintenance/${order.vehicleId.toHexString()}`,
        dedupeKey: `maintenance-due:${order._id.toHexString()}:${item.name}:${item.nextDueDate}`,
      });
      if (ok) created += 1;
    }
  }
  return created;
}

/**
 * Multas: prazo de indicação do condutor (7 dias, 2 dias, vencido) e fim do
 * desconto. Prazo perdido marca a indicação como MISSED (provável NIC) —
 * uma vez só, então o alerta crítico não se repete.
 */
export async function generateFineNotifications(
  ctx: AppContext,
  organizationId: ObjectId,
  today = businessDate(),
): Promise<number> {
  let created = 0;
  const pending = await ctx.mongo.collections.trafficFines
    .find({
      organizationId,
      status: { $in: ['RECEIVED', 'DRIVER_IDENTIFIED'] },
      'indication.status': 'PENDING',
      indicationDeadline: { $type: 'string', $lte: addDaysIso(today, 7) },
    })
    .toArray();
  for (const fine of pending) {
    const deadline = fine.indicationDeadline!;
    const days = diffDaysIso(deadline, today);
    const missed = days < 0;
    if (missed) {
      const now = new Date();
      await ctx.mongo.collections.trafficFines.updateOne(
        { _id: fine._id, 'indication.status': 'PENDING' },
        {
          $set: { 'indication.status': 'MISSED', updatedAt: now },
          $inc: { version: 1 },
          $push: { history: { at: now, actorId: null, action: 'indication_missed', detail: 'Prazo de indicação vencido: provável multa NIC.' } },
        },
      );
    }
    const bucket = missed ? 'missed' : days <= 2 ? 'near' : 'soon';
    const ok = await createNotification(ctx, {
      organizationId,
      type: 'FINE',
      severity: missed || days <= 2 ? 'CRITICAL' : 'WARNING',
      title: missed ? 'Prazo de indicação perdido' : 'Indique o condutor da multa',
      message: missed
        ? `O prazo para indicar o condutor da multa ${fine.aitNumber} (${fine.plateSnapshot}) venceu em ${formatIsoDateBR(deadline)}. A empresa pode receber multa NIC.`
        : `Multa ${fine.aitNumber} (${fine.plateSnapshot}): indicar o condutor até ${formatIsoDateBR(deadline)}${days === 0 ? ' (hoje)' : ` (${days} dia(s))`}.`,
      subjectLabel: fine.plateSnapshot,
      entityType: 'trafficFine',
      entityId: fine._id,
      targetPath: `/dashboard/fines/${fine._id.toHexString()}`,
      dedupeKey: `fine-indication:${fine._id.toHexString()}:${deadline}:${bucket}`,
    });
    if (ok) created += 1;
  }

  const discounts = await ctx.mongo.collections.trafficFines
    .find({
      organizationId,
      status: { $in: ['RECEIVED', 'DRIVER_IDENTIFIED', 'INDICATED'] },
      discountUntil: { $type: 'string', $gte: today, $lte: addDaysIso(today, 3) },
    })
    .toArray();
  for (const fine of discounts) {
    const ok = await createNotification(ctx, {
      organizationId,
      type: 'FINE',
      severity: 'INFO',
      title: 'Desconto da multa termina em breve',
      message: `O valor com desconto da multa ${fine.aitNumber} (${fine.plateSnapshot}) vale até ${formatIsoDateBR(fine.discountUntil!)}.`,
      subjectLabel: fine.plateSnapshot,
      entityType: 'trafficFine',
      entityId: fine._id,
      targetPath: `/dashboard/fines/${fine._id.toHexString()}`,
      dedupeKey: `fine-discount:${fine._id.toHexString()}:${fine.discountUntil}`,
    });
    if (ok) created += 1;
  }
  return created;
}

/** Alertas de IPVA, licenciamento e seguro (30, 15 e 7 dias, no dia e vencido, este com reaviso semanal). */
export async function generateVehicleDueNotifications(
  ctx: AppContext,
  organizationId: ObjectId,
  today = businessDate(),
): Promise<number> {
  const items = await listVehicleDue(ctx, organizationId, today, 30);
  let created = 0;
  for (const item of items) {
    const bucket = dueBucket(item.daysLeft);
    if (!bucket) continue;
    const name = vehicleDueKindLabels[item.kind];
    const when =
      item.daysLeft < 0
        ? `venceu em ${formatIsoDateBR(item.dueDate)}`
        : item.daysLeft === 0
          ? 'vence hoje'
          : `vence em ${item.daysLeft} dia(s) (${formatIsoDateBR(item.dueDate)})`;
    const ok = await createNotification(ctx, {
      organizationId,
      type: 'VEHICLE',
      severity: item.daysLeft <= 7 ? 'CRITICAL' : 'WARNING',
      title: vehicleDueTitle(item.kind, item.daysLeft),
      message: `${name} do veículo ${item.plate} (${item.label}) ${when}.`,
      subjectLabel: item.plate,
      entityType: 'vehicle',
      entityId: new ObjectId(item.vehicleId),
      targetPath: '/dashboard/vehicles/due',
      dedupeKey: `vehicle-due:${item.vehicleId}:${item.kind}:${item.dueDate}:${bucket}:${bucket === 'overdue' ? weekKey(today) : ''}`,
    });
    if (ok) created += 1;
  }
  return created;
}

export async function runNotificationGenerators(
  ctx: AppContext,
  organizationId: ObjectId,
  today = businessDate(),
): Promise<number> {
  const results = await Promise.all([
    generateCnhNotifications(ctx, organizationId, today),
    generateRentalNotifications(ctx, organizationId, today),
    generateInspectionNotifications(ctx, organizationId, today),
    generateMaintenanceNotifications(ctx, organizationId, today),
    generateFineNotifications(ctx, organizationId, today),
    generateVehicleDueNotifications(ctx, organizationId, today),
  ]);
  return results.reduce((a, b) => a + b, 0);
}

/** Segunda-feira da semana de `iso` (AAAA-MM-DD): chave de lembrete semanal. */
export function weekKey(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
