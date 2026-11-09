import { ObjectId } from 'mongodb';
import { monthKey } from '@yudirect/contracts';
import type { AppContext } from '../context.js';
import type { IsoDate } from '../database/types.js';

/* ------------------------------------------------------------------ *
 * Agregações financeiras.
 *
 * Metodologia (gerencial, igual à nota de rodapé da DRE da referência):
 *   RECEITA  = recebimentos efetivamente liquidados no período
 *              (pagamentos de contas a receber). Caução NÃO é receita.
 *   DESPESA  = contas a pagar quitadas no período + saídas de
 *              manutenção concluída no período.
 *   LUCRO    = receita − despesa.
 * Todos os valores em centavos inteiros.
 * ------------------------------------------------------------------ */

export const MAINTENANCE_CATEGORY_LABEL = 'Manutenção';

export interface PeriodTotals {
  revenueCents: number;
  expensesCents: number;
  profitCents: number;
}

export async function revenueInPeriod(
  ctx: AppContext,
  organizationId: ObjectId,
  from: IsoDate,
  to: IsoDate,
): Promise<number> {
  const rows = await ctx.mongo.collections.payments
    .aggregate<{ total: number }>([
      {
        $match: {
          organizationId,
          sourceType: 'RECEIVABLE',
          paidAt: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: null, total: { $sum: '$amountCents' } } },
    ])
    .toArray();
  return rows[0]?.total ?? 0;
}

export async function expensesInPeriod(
  ctx: AppContext,
  organizationId: ObjectId,
  from: IsoDate,
  to: IsoDate,
): Promise<number> {
  const [payables, maintenance] = await Promise.all([
    ctx.mongo.collections.payments
      .aggregate<{ total: number }>([
        { $match: { organizationId, sourceType: 'PAYABLE', paidAt: { $gte: from, $lte: to } } },
        { $group: { _id: null, total: { $sum: '$amountCents' } } },
      ])
      .toArray(),
    ctx.mongo.collections.maintenanceOrders
      .aggregate<{ total: number }>([
        {
          $match: {
            organizationId,
            status: 'COMPLETED',
            ledgerTransactionId: { $ne: null },
            completedAt: { $gte: from, $lte: to },
          },
        },
        { $group: { _id: null, total: { $sum: '$totalCents' } } },
      ])
      .toArray(),
  ]);
  return (payables[0]?.total ?? 0) + (maintenance[0]?.total ?? 0);
}

export async function periodTotals(
  ctx: AppContext,
  organizationId: ObjectId,
  from: IsoDate,
  to: IsoDate,
): Promise<PeriodTotals> {
  const [revenueCents, expensesCents] = await Promise.all([
    revenueInPeriod(ctx, organizationId, from, to),
    expensesInPeriod(ctx, organizationId, from, to),
  ]);
  return { revenueCents, expensesCents, profitCents: revenueCents - expensesCents };
}

export async function expensesByCategory(
  ctx: AppContext,
  organizationId: ObjectId,
  from: IsoDate,
  to: IsoDate,
): Promise<Array<{ label: string; amountCents: number }>> {
  const rows = await ctx.mongo.collections.payments
    .aggregate<{ _id: ObjectId | null; total: number }>([
      { $match: { organizationId, sourceType: 'PAYABLE', paidAt: { $gte: from, $lte: to } } },
      {
        $lookup: {
          from: 'payables',
          localField: 'sourceId',
          foreignField: '_id',
          as: 'payable',
        },
      },
      { $unwind: '$payable' },
      { $group: { _id: '$payable.categoryId', total: { $sum: '$amountCents' } } },
    ])
    .toArray();

  const categoryIds = rows.map((r) => r._id).filter((v): v is ObjectId => Boolean(v));
  const categories = categoryIds.length
    ? await ctx.mongo.collections.expenseCategories
        .find({ organizationId, _id: { $in: categoryIds } })
        .toArray()
    : [];
  const map = new Map(categories.map((c) => [c._id.toHexString(), c.label]));

  const out = rows.map((r) => ({
    label: r._id ? (map.get(r._id.toHexString()) ?? 'Outro') : 'Outro',
    amountCents: r.total,
  }));

  const maintenance = await ctx.mongo.collections.maintenanceOrders
    .aggregate<{ total: number }>([
      {
        $match: {
          organizationId,
          status: 'COMPLETED',
          ledgerTransactionId: { $ne: null },
          completedAt: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: null, total: { $sum: '$totalCents' } } },
    ])
    .toArray();
  if ((maintenance[0]?.total ?? 0) > 0) {
    out.push({ label: MAINTENANCE_CATEGORY_LABEL, amountCents: maintenance[0]!.total });
  }

  return out.sort((a, b) => b.amountCents - a.amountCents);
}

export interface VehicleTotals {
  vehicleId: string;
  revenueCents: number;
  expensesCents: number;
}

/** Receita e despesa atribuídas a cada veículo no período. */
export async function totalsByVehicle(
  ctx: AppContext,
  organizationId: ObjectId,
  from: IsoDate,
  to: IsoDate,
): Promise<Map<string, VehicleTotals>> {
  const map = new Map<string, VehicleTotals>();
  const ensure = (id: string) => {
    let entry = map.get(id);
    if (!entry) {
      entry = { vehicleId: id, revenueCents: 0, expensesCents: 0 };
      map.set(id, entry);
    }
    return entry;
  };

  const revenue = await ctx.mongo.collections.payments
    .aggregate<{ _id: ObjectId; total: number }>([
      { $match: { organizationId, sourceType: 'RECEIVABLE', paidAt: { $gte: from, $lte: to } } },
      { $lookup: { from: 'receivables', localField: 'sourceId', foreignField: '_id', as: 'receivable' } },
      { $unwind: '$receivable' },
      { $match: { 'receivable.rentalId': { $ne: null } } },
      { $lookup: { from: 'rentals', localField: 'receivable.rentalId', foreignField: '_id', as: 'rental' } },
      { $unwind: '$rental' },
      { $group: { _id: '$rental.vehicleId', total: { $sum: '$amountCents' } } },
    ])
    .toArray();
  for (const row of revenue) ensure(row._id.toHexString()).revenueCents += row.total;

  const payableExpenses = await ctx.mongo.collections.payments
    .aggregate<{ _id: ObjectId; total: number }>([
      { $match: { organizationId, sourceType: 'PAYABLE', paidAt: { $gte: from, $lte: to } } },
      { $lookup: { from: 'payables', localField: 'sourceId', foreignField: '_id', as: 'payable' } },
      { $unwind: '$payable' },
      { $match: { 'payable.vehicleId': { $ne: null } } },
      { $group: { _id: '$payable.vehicleId', total: { $sum: '$amountCents' } } },
    ])
    .toArray();
  for (const row of payableExpenses) ensure(row._id.toHexString()).expensesCents += row.total;

  const maintenanceExpenses = await ctx.mongo.collections.maintenanceOrders
    .aggregate<{ _id: ObjectId; total: number }>([
      {
        $match: {
          organizationId,
          status: 'COMPLETED',
          ledgerTransactionId: { $ne: null },
          completedAt: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: '$vehicleId', total: { $sum: '$totalCents' } } },
    ])
    .toArray();
  for (const row of maintenanceExpenses) ensure(row._id.toHexString()).expensesCents += row.total;

  return map;
}

/** Série mensal de receita/despesa para um intervalo de meses. */
export async function monthlySeries(
  ctx: AppContext,
  organizationId: ObjectId,
  months: Array<{ key: string; from: IsoDate; to: IsoDate }>,
): Promise<Map<string, PeriodTotals>> {
  const out = new Map<string, PeriodTotals>();
  if (months.length === 0) return out;
  const from = months[0]!.from;
  const to = months[months.length - 1]!.to;

  const revenue = await ctx.mongo.collections.payments
    .aggregate<{ _id: string; total: number }>([
      { $match: { organizationId, sourceType: 'RECEIVABLE', paidAt: { $gte: from, $lte: to } } },
      { $group: { _id: { $substrBytes: ['$paidAt', 0, 7] }, total: { $sum: '$amountCents' } } },
    ])
    .toArray();
  const payableExpense = await ctx.mongo.collections.payments
    .aggregate<{ _id: string; total: number }>([
      { $match: { organizationId, sourceType: 'PAYABLE', paidAt: { $gte: from, $lte: to } } },
      { $group: { _id: { $substrBytes: ['$paidAt', 0, 7] }, total: { $sum: '$amountCents' } } },
    ])
    .toArray();
  const maintenanceExpense = await ctx.mongo.collections.maintenanceOrders
    .aggregate<{ _id: string; total: number }>([
      {
        $match: {
          organizationId,
          status: 'COMPLETED',
          ledgerTransactionId: { $ne: null },
          completedAt: { $gte: from, $lte: to },
        },
      },
      { $group: { _id: { $substrBytes: ['$completedAt', 0, 7] }, total: { $sum: '$totalCents' } } },
    ])
    .toArray();

  for (const month of months) out.set(month.key, { revenueCents: 0, expensesCents: 0, profitCents: 0 });
  for (const row of revenue) {
    const entry = out.get(row._id);
    if (entry) entry.revenueCents += row.total;
  }
  for (const row of [...payableExpense, ...maintenanceExpense]) {
    const entry = out.get(row._id);
    if (entry) entry.expensesCents += row.total;
  }
  for (const entry of out.values()) entry.profitCents = entry.revenueCents - entry.expensesCents;
  return out;
}

export function monthWindows(
  months: Array<{ year: number; month: number; key: string }>,
): Array<{ key: string; from: IsoDate; to: IsoDate }> {
  return months.map((m) => {
    const lastDay = new Date(Date.UTC(m.year, m.month, 0)).getUTCDate();
    const mm = String(m.month).padStart(2, '0');
    return { key: m.key, from: `${m.year}-${mm}-01`, to: `${m.year}-${mm}-${String(lastDay).padStart(2, '0')}` };
  });
}

export { monthKey };
