import type { ObjectId } from 'mongodb';
import {
  diffDaysIso,
  vehicleDueAlertWindows,
  vehicleDueKindLabels,
  vehicleDueKinds,
  type VehicleDueItem,
  type VehicleDueKind,
} from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import type { VehicleDoc } from '../database/types.js';

/* ------------------------------------------------------------------ *
 * Vencimentos da frota: IPVA, licenciamento e seguro por veículo.
 * Só veículos ativos (não arquivados) entram; datas vazias são ignoradas.
 * ------------------------------------------------------------------ */

const dateOf = (v: VehicleDoc, kind: VehicleDueKind): string | null => {
  const c = v.compliance;
  if (!c) return null;
  return kind === 'IPVA' ? c.ipvaDueDate : kind === 'LICENSING' ? c.licensingDueDate : c.insuranceDueDate;
};

/** Faixa do alerta: 'overdue', 'today' ou a janela (7, 15, 30) em que a data cai. null = ainda longe. */
export function dueBucket(daysLeft: number): string | null {
  if (daysLeft < 0) return 'overdue';
  if (daysLeft === 0) return 'today';
  const window = [...vehicleDueAlertWindows].sort((a, b) => a - b).find((w) => daysLeft <= w);
  return window ? `d${window}` : null;
}

export function vehicleDueItemsOf(vehicles: VehicleDoc[], today: string, withinDays: number, kind?: VehicleDueKind): VehicleDueItem[] {
  const items: VehicleDueItem[] = [];
  for (const v of vehicles) {
    for (const k of vehicleDueKinds) {
      if (kind && k !== kind) continue;
      const dueDate = dateOf(v, k);
      if (!dueDate) continue;
      const daysLeft = diffDaysIso(dueDate, today);
      if (daysLeft > withinDays) continue;
      items.push({
        vehicleId: v._id.toHexString(),
        plate: v.plate,
        label: `${v.brand} ${v.model}`,
        kind: k,
        dueDate,
        daysLeft,
        status: daysLeft < 0 ? 'OVERDUE' : daysLeft <= 30 ? 'SOON' : 'OK',
      });
    }
  }
  return items.sort((a, b) => a.daysLeft - b.daysLeft || a.plate.localeCompare(b.plate));
}

export async function listVehicleDue(
  ctx: AppContext,
  organizationId: ObjectId,
  today: string,
  withinDays: number,
  kind?: VehicleDueKind,
): Promise<VehicleDueItem[]> {
  const vehicles = await ctx.mongo.collections.vehicles
    .find({ organizationId, archivedAt: null, compliance: { $ne: null } })
    .toArray();
  return vehicleDueItemsOf(vehicles, today, withinDays, kind);
}

export const vehicleDueTitle = (kind: VehicleDueKind, daysLeft: number): string => {
  const name = vehicleDueKindLabels[kind];
  return daysLeft < 0 ? `${name} vencido` : daysLeft === 0 ? `${name} vence hoje` : `${name} próximo do vencimento`;
};
