import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import {
  addDaysIso,
  businessDate,
  dreQuerySchema,
  financePeriodQuerySchema,
  formatCentsBRL,
  lastMonths,
  monthLabel,
  monthRange,
  monthShortLabel,
  percentDelta,
  previousMonth,
  previousPeriod,
  vehicleReportQuerySchema,
  type ClientReport,
  type DashboardSummary,
  type DreReport,
  type FinanceDashboard,
  type VehicleReport,
} from '@frotaone/contracts';
import { requireAuthContext } from '../../plugins/auth.js';
import { toObjectId } from '../../common/helpers.js';
import {
  expensesByCategory,
  monthlySeries,
  monthWindows,
  periodTotals,
  totalsByVehicle,
} from '../../services/analytics.js';
import { organizationCashTotal } from '../../services/ledger.js';
import { remainingCents } from '../../services/finance.js';
import { renderDreReport } from '../../pdf/dre-report.js';

function resolvePeriod(query: { from?: string; to?: string; month?: number; year?: number }) {
  const today = businessDate();
  if (query.from && query.to) {
    return { from: query.from, to: query.to, label: `${query.from} a ${query.to}`, custom: true };
  }
  const year = query.year ?? Number(today.slice(0, 4));
  const month = query.month ?? Number(today.slice(5, 7));
  const range = monthRange(year, month);
  return { from: range.from, to: range.to, label: monthLabel(year, month), custom: false, year, month };
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  /* -------------------------- Painel inicial ----------------------- */
  app.get(
    '/dashboard/summary',
    { onRequest: [app.requireAuth, app.requirePermission('dashboard', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const today = businessDate();
      const year = Number(today.slice(0, 4));
      const month = Number(today.slice(5, 7));
      const current = monthRange(year, month);
      const prev = previousMonth(year, month);
      const previous = monthRange(prev.year, prev.month);

      const [vehicles, drivers, rentals, currentTotals, previousTotals] = await Promise.all([
        ctx.mongo.collections.vehicles.countDocuments({ organizationId, archivedAt: null }),
        ctx.mongo.collections.drivers.countDocuments({ organizationId, archivedAt: null, status: 'ACTIVE' }),
        ctx.mongo.collections.rentals.countDocuments({ organizationId, status: 'ACTIVE' }),
        periodTotals(ctx, organizationId, current.from, current.to),
        periodTotals(ctx, organizationId, previous.from, previous.to),
      ]);

      const months = monthWindows(lastMonths(year, month, 6));
      const series = await monthlySeries(ctx, organizationId, months);

      const [currentByVehicle, previousByVehicle, vehicleDocs] = await Promise.all([
        totalsByVehicle(ctx, organizationId, current.from, current.to),
        totalsByVehicle(ctx, organizationId, previous.from, previous.to),
        ctx.mongo.collections.vehicles.find({ organizationId, archivedAt: null }).toArray(),
      ]);
      const vMap = new Map(vehicleDocs.map((v) => [v._id.toHexString(), v]));

      const profitRows = [...currentByVehicle.values()]
        .map((entry) => ({
          entry,
          profit: entry.revenueCents - entry.expensesCents,
        }))
        .filter((row) => row.profit > 0)
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 3);

      const expenseRows = [...currentByVehicle.values()]
        .filter((entry) => entry.expensesCents > 0)
        .sort((a, b) => b.expensesCents - a.expensesCents)
        .slice(0, 3);

      const payload: DashboardSummary = {
        totals: {
          vehicles,
          activeDrivers: drivers,
          activeRentals: rentals,
          monthlyRevenueCents: currentTotals.revenueCents,
        },
        deltas: {
          vehiclesPercent: 0,
          driversPercent: 0,
          rentalsPercent: 0,
          revenuePercent: percentDelta(currentTotals.revenueCents, previousTotals.revenueCents),
        },
        revenueSeries: months.map((m) => ({
          month: m.key,
          label: monthShortLabel(m.key),
          revenueCents: series.get(m.key)?.revenueCents ?? 0,
        })),
        topProfitable: profitRows.map((row) => {
          const v = vMap.get(row.entry.vehicleId);
          const prevEntry = previousByVehicle.get(row.entry.vehicleId);
          const prevProfit = prevEntry ? prevEntry.revenueCents - prevEntry.expensesCents : 0;
          return {
            vehicleId: row.entry.vehicleId,
            plate: v?.plate ?? '—',
            model: `${v?.brand ?? ''} ${v?.model ?? ''}`.trim() || '—',
            amountCents: row.profit,
            deltaPercent: percentDelta(row.profit, prevProfit),
          };
        }),
        topExpensive: expenseRows.map((entry) => {
          const v = vMap.get(entry.vehicleId);
          const prevEntry = previousByVehicle.get(entry.vehicleId);
          return {
            vehicleId: entry.vehicleId,
            plate: v?.plate ?? '—',
            model: `${v?.brand ?? ''} ${v?.model ?? ''}`.trim() || '—',
            amountCents: entry.expensesCents,
            deltaPercent: percentDelta(entry.expensesCents, prevEntry?.expensesCents ?? 0),
          };
        }),
      };
      return payload;
    },
  );

  /* ---------------------- Dashboard financeiro --------------------- */
  app.get(
    '/finance/dashboard',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const query = financePeriodQuerySchema.parse(request.query);
      const period = resolvePeriod(query);
      const prevWindow = period.custom
        ? previousPeriod(period.from, period.to)
        : (() => {
            const prev = previousMonth(period.year!, period.month!);
            return monthRange(prev.year, prev.month);
          })();
      const comparisonShortLabel = period.custom
        ? null
        : (() => {
            const prev = previousMonth(period.year!, period.month!);
            return monthShortLabel(`${prev.year}-${String(prev.month).padStart(2, '0')}`).toLowerCase();
          })();
      const comparisonLabel = period.custom
        ? `${prevWindow.from} a ${prevWindow.to}`
        : (() => {
            const prev = previousMonth(period.year!, period.month!);
            return monthLabel(prev.year, prev.month).split(' ')[0]!.toLowerCase();
          })();

      const [current, previous, categories, byVehicle, vehicleDocs, cash] =
        await Promise.all([
          periodTotals(ctx, organizationId, period.from, period.to),
          periodTotals(ctx, organizationId, prevWindow.from, prevWindow.to),
          expensesByCategory(ctx, organizationId, period.from, period.to),
          totalsByVehicle(ctx, organizationId, period.from, period.to),
          ctx.mongo.collections.vehicles.find({ organizationId, archivedAt: null }).toArray(),
          organizationCashTotal(ctx, organizationId),
        ]);

      const vMap = new Map(vehicleDocs.map((v) => [v._id.toHexString(), v]));
      const activeVehicles = vehicleDocs.filter((v) => v.status !== 'INACTIVE').length;
      const rentedVehicles = vehicleDocs.filter((v) => v.status === 'RENTED').length;
      const occupancy = activeVehicles > 0 ? (rentedVehicles / activeVehicles) * 100 : 0;

      const rows = [...byVehicle.values()].map((entry) => ({
        entry,
        profit: entry.revenueCents - entry.expensesCents,
        margin: entry.revenueCents > 0 ? ((entry.revenueCents - entry.expensesCents) / entry.revenueCents) * 100 : null,
      }));
      const best = rows.filter((r) => r.profit > 0).sort((a, b) => b.profit - a.profit)[0];
      const worst = rows.sort((a, b) => a.profit - b.profit)[0];

      const year = period.year ?? Number(period.to.slice(0, 4));
      const month = period.month ?? Number(period.to.slice(5, 7));
      const months = monthWindows(lastMonths(year, month, 6));
      const series = await monthlySeries(ctx, organizationId, months);

      const totalExpenses = categories.reduce((a, c) => a + c.amountCents, 0);
      const horizon = addDaysIso(businessDate(), 30);
      const [upcomingReceivables, upcomingPayables, openReceivables] = await Promise.all([
        ctx.mongo.collections.receivables
          .find({
            organizationId,
            status: { $nin: ['PAID', 'CANCELED'] },
            dueDate: { $gte: businessDate(), $lte: horizon },
          })
          .sort({ dueDate: 1 })
          .limit(5)
          .toArray(),
        ctx.mongo.collections.payables
          .find({
            organizationId,
            status: { $nin: ['PAID', 'CANCELED'] },
            dueDate: { $gte: businessDate(), $lte: horizon },
          })
          .sort({ dueDate: 1 })
          .limit(5)
          .toArray(),
        ctx.mongo.collections.receivables
          .find({ organizationId, status: { $nin: ['PAID', 'CANCELED'] } })
          .toArray(),
      ]);

      const today = businessDate();
      const overdue = openReceivables.filter((r) => r.dueDate < today);

      const payload: FinanceDashboard = {
        period: {
          from: period.from,
          to: period.to,
          label: period.label,
          comparisonLabel,
          comparisonShortLabel,
        },
        revenueCents: current.revenueCents,
        expensesCents: current.expensesCents,
        profitCents: current.profitCents,
        marginPercent:
          current.revenueCents > 0 ? (current.profitCents / current.revenueCents) * 100 : null,
        previous: {
          revenueCents: previous.revenueCents,
          expensesCents: previous.expensesCents,
          profitCents: previous.profitCents,
          marginPercent:
            previous.revenueCents > 0 ? (previous.profitCents / previous.revenueCents) * 100 : null,
        },
        deltas: {
          revenuePercent: percentDelta(current.revenueCents, previous.revenueCents),
          expensesPercent: percentDelta(current.expensesCents, previous.expensesCents),
          profitPercent: percentDelta(current.profitCents, previous.profitCents),
          marginPoints:
            current.revenueCents > 0 && previous.revenueCents > 0
              ? (current.profitCents / current.revenueCents) * 100 -
                (previous.profitCents / previous.revenueCents) * 100
              : null,
        },
        highlight: best
          ? `${vMap.get(best.entry.vehicleId)?.brand ?? ''} ${
              vMap.get(best.entry.vehicleId)?.model ?? ''
            }`.trim() +
            ` lidera com ${formatCentsBRL(best.profit)} de lucro e ${
              best.margin === null ? '—' : `${best.margin.toFixed(0).replace('.', ',')}%`
            } de margem.`
          : null,
        attention:
          worst && worst.profit < 0
            ? `${`${vMap.get(worst.entry.vehicleId)?.brand ?? ''} ${
                vMap.get(worst.entry.vehicleId)?.model ?? ''
              }`.trim()} (${vMap.get(worst.entry.vehicleId)?.plate ?? '—'}) teve o menor resultado: prejuízo de ${formatCentsBRL(
                Math.abs(worst.profit),
              )}, margem de ${
                worst.margin === null ? '—' : `${worst.margin.toFixed(1).replace('.', ',')}%`
              }.`
            : null,
        monthlySeries: months.map((m) => {
          const entry = series.get(m.key) ?? { revenueCents: 0, expensesCents: 0, profitCents: 0 };
          return {
            month: m.key,
            label: monthShortLabel(m.key),
            revenueCents: entry.revenueCents,
            expensesCents: entry.expensesCents,
            profitCents: entry.profitCents,
          };
        }),
        expensesByCategory: categories.map((c) => ({
          label: c.label,
          amountCents: c.amountCents,
          percent: totalExpenses > 0 ? (c.amountCents / totalExpenses) * 100 : 0,
        })),
        fleet: {
          occupancyPercent: occupancy,
          occupancyDeltaPoints: 0,
          revenuePerVehicleCents:
            activeVehicles > 0 ? Math.round(current.revenueCents / activeVehicles) : 0,
          revenuePerVehicleDeltaPercent: percentDelta(
            activeVehicles > 0 ? current.revenueCents / activeVehicles : 0,
            activeVehicles > 0 ? previous.revenueCents / activeVehicles : 0,
          ),
          activeVehicles,
          activeVehiclesDelta: 0,
        },
        cash: {
          accounts: cash.accounts.map((a) => ({
            id: a.id.toHexString(),
            name: a.name,
            balanceCents: a.balanceCents,
          })),
          totalCents: cash.totalCents,
          receivableCents: upcomingReceivables.reduce(
            (a, r) => a + remainingCents(r.grossAmountCents, r.paidAmountCents),
            0,
          ),
          receivableCount: upcomingReceivables.length,
          payableCents: upcomingPayables.reduce(
            (a, p) => a + remainingCents(p.amountCents, p.paidAmountCents),
            0,
          ),
          payableCount: upcomingPayables.length,
          overdueCents: overdue.reduce(
            (a, r) => a + remainingCents(r.grossAmountCents, r.paidAmountCents),
            0,
          ),
          overdueClients: new Set(overdue.map((r) => r.driverId.toHexString())).size,
        },
        upcoming: [
          ...upcomingReceivables.map((r) => ({
            kind: 'RECEIVABLE' as const,
            id: r._id.toHexString(),
            description: r.description,
            dueDate: r.dueDate,
            amountCents: remainingCents(r.grossAmountCents, r.paidAmountCents),
          })),
          ...upcomingPayables.map((p) => ({
            kind: 'PAYABLE' as const,
            id: p._id.toHexString(),
            description: p.description,
            dueDate: p.dueDate,
            amountCents: remainingCents(p.amountCents, p.paidAmountCents),
          })),
        ].sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)),
      };
      return payload;
    },
  );

  /* --------------------- Relatório por veículo --------------------- */
  app.get(
    '/reports/by-vehicle',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const query = vehicleReportQuerySchema.parse(request.query);
      const period = resolvePeriod(query);
      const prevWindow = period.custom
        ? previousPeriod(period.from, period.to)
        : (() => {
            const prev = previousMonth(period.year!, period.month!);
            return monthRange(prev.year, prev.month);
          })();

      const vehicleFilter: Record<string, unknown> = { organizationId, archivedAt: null };
      const vehicles = await ctx.mongo.collections.vehicles.find(vehicleFilter).sort({ plate: 1 }).toArray();
      const selectedId = query.vehicleId ? toObjectId(query.vehicleId, 'vehicleId').toHexString() : null;

      const [currentTotals, prevTotals] = await Promise.all([
        totalsByVehicle(ctx, organizationId, period.from, period.to),
        totalsByVehicle(ctx, organizationId, prevWindow.from, prevWindow.to),
      ]);

      const selectedVehicles = selectedId
        ? vehicles.filter((v) => v._id.toHexString() === selectedId)
        : vehicles;

      const rows = selectedVehicles.map((v) => {
        const key = v._id.toHexString();
        const entry = currentTotals.get(key) ?? { vehicleId: key, revenueCents: 0, expensesCents: 0 };
        const profit = entry.revenueCents - entry.expensesCents;
        return {
          vehicleId: key,
          vehicle: `${v.brand} ${v.model}${v.year ? ` ${v.year}` : ''}`.trim(),
          plate: v.plate,
          revenueCents: entry.revenueCents,
          expensesCents: entry.expensesCents,
          profitCents: profit,
          marginPercent: entry.revenueCents > 0 ? (profit / entry.revenueCents) * 100 : null,
        };
      });

      const sum = rows.reduce(
        (acc, r) => ({
          revenue: acc.revenue + r.revenueCents,
          expenses: acc.expenses + r.expensesCents,
          profit: acc.profit + r.profitCents,
        }),
        { revenue: 0, expenses: 0, profit: 0 },
      );
      const prevSum = selectedVehicles.reduce(
        (acc, v) => {
          const entry = prevTotals.get(v._id.toHexString());
          return {
            revenue: acc.revenue + (entry?.revenueCents ?? 0),
            expenses: acc.expenses + (entry?.expensesCents ?? 0),
          };
        },
        { revenue: 0, expenses: 0 },
      );

      const reportYear = query.year ?? Number(period.to.slice(0, 4));
      const yearMonths = monthWindows(
        Array.from({ length: 12 }, (_, i) => ({
          year: reportYear,
          month: i + 1,
          key: `${reportYear}-${String(i + 1).padStart(2, '0')}`,
        })),
      );
      const monthlyByVehicle = new Map<string, number>();
      for (const window of yearMonths) {
        const totals = await totalsByVehicle(ctx, organizationId, window.from, window.to);
        const relevant = selectedId ? [totals.get(selectedId)] : [...totals.values()];
        const profit = relevant.reduce(
          (a, entry) => a + (entry ? entry.revenueCents - entry.expensesCents : 0),
          0,
        );
        monthlyByVehicle.set(window.key, profit);
      }

      const payload: VehicleReport = {
        period: { from: period.from, to: period.to, label: period.label },
        profitCents: sum.profit,
        revenueCents: sum.revenue,
        expensesCents: sum.expenses,
        activeVehicles: vehicles.filter((v) => v.status === 'RENTED').length,
        totalVehicles: vehicles.length,
        deltas: {
          profitPercent: percentDelta(sum.profit, prevSum.revenue - prevSum.expenses),
          revenuePercent: percentDelta(sum.revenue, prevSum.revenue),
          expensesPercent: percentDelta(sum.expenses, prevSum.expenses),
        },
        monthlyProfit: yearMonths.map((m) => ({
          month: m.key,
          label: monthShortLabel(m.key).toUpperCase(),
          profitCents: monthlyByVehicle.get(m.key) ?? 0,
        })),
        rows,
        vehicleOptions: vehicles.map((v) => ({
          id: v._id.toHexString(),
          plate: v.plate,
          label: `${v.plate} — ${v.brand} ${v.model}${v.color ? ` — ${v.color}` : ''}`,
          color: v.color,
        })),
      };
      return payload;
    },
  );

  /* --------------------- Relatório por cliente --------------------- */
  app.get(
    '/reports/by-client',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const { q } = request.query as { q?: string };

      const receivables = await ctx.mongo.collections.receivables
        .find({ organizationId, status: { $ne: 'CANCELED' } })
        .toArray();
      const driverIds = [...new Set(receivables.map((r) => r.driverId.toHexString()))].map(
        (s) => new ObjectId(s),
      );
      const drivers = await ctx.mongo.collections.drivers
        .find({ organizationId, _id: { $in: driverIds } })
        .toArray();
      const rentals = await ctx.mongo.collections.rentals.find({ organizationId }).toArray();

      const rentalsByDriver = new Map<string, number>();
      for (const rental of rentals) {
        const key = rental.driverId.toHexString();
        rentalsByDriver.set(key, (rentalsByDriver.get(key) ?? 0) + 1);
      }

      const rows: ClientReport['rows'] = drivers
        .map((driver) => {
          const key = driver._id.toHexString();
          const own = receivables.filter((r) => r.driverId.toHexString() === key);
          const paidCents = own.reduce((a, r) => a + r.paidAmountCents, 0);
          const openCents = own.reduce(
            (a, r) => a + remainingCents(r.grossAmountCents, r.paidAmountCents),
            0,
          );
          return {
            driverId: key,
            name: driver.fullName,
            cpf: ctx.pii.decrypt(driver.cpfEncrypted),
            paidCents,
            openCents,
            rentals: rentalsByDriver.get(key) ?? 0,
            status: openCents > 0 ? ('OPEN' as const) : ('SETTLED' as const),
          };
        })
        .filter((row) => {
          if (!q) return true;
          const term = q.trim().toLowerCase();
          const digits = term.replace(/\D+/g, '');
          return (
            row.name.toLowerCase().includes(term) ||
            (digits.length >= 3 && (row.cpf ?? '').includes(digits))
          );
        })
        .sort((a, b) => b.openCents - a.openCents || a.name.localeCompare(b.name, 'pt-BR'));

      const payload: ClientReport = { rows };
      return payload;
    },
  );

  /* ------------------------------- DRE ----------------------------- */
  const buildDre = async (organizationId: ObjectId, ctx: ReturnType<typeof requireAuthContext> extends never ? never : import('../../context.js').AppContext, month: number, year: number): Promise<DreReport> => {
    const range = monthRange(year, month);
    const [totals, categories, organization] = await Promise.all([
      periodTotals(ctx, organizationId, range.from, range.to),
      expensesByCategory(ctx, organizationId, range.from, range.to),
      ctx.mongo.collections.organizations.findOne({ _id: organizationId }),
    ]);

    const grossRevenue = totals.revenueCents;
    const deductions = 0;
    const netRevenue = grossRevenue - deductions;
    const fleetCosts = categories.reduce((a, c) => a + c.amountCents, 0);
    const grossProfit = netRevenue - fleetCosts;
    const personnel = 0;
    const administrative = 0;
    const commercial = 0;
    const otherOperating = 0;
    const financial = 0;
    const beforeTax = grossProfit - personnel - administrative - commercial - otherOperating - financial;
    const taxes = 0;
    const netResult = beforeTax - taxes;

    const lines: DreReport['lines'] = [
      { key: 'gross-revenue', label: 'Receita bruta', amountCents: grossRevenue, level: 0, sign: 'PLUS', emphasis: true, positive: grossRevenue >= 0 },
      { key: 'rental-revenue', label: 'Receita de locações', amountCents: grossRevenue, level: 1, sign: 'NONE', emphasis: false, positive: true },
      { key: 'deductions', label: 'Deduções da receita bruta', amountCents: deductions, level: 1, sign: 'MINUS', emphasis: false, positive: false },
      { key: 'net-revenue', label: 'Receita líquida', amountCents: netRevenue, level: 0, sign: 'EQUALS', emphasis: true, positive: true },
      { key: 'fleet-costs', label: 'Custos da frota', amountCents: fleetCosts, level: 0, sign: 'MINUS', emphasis: true, positive: false },
      ...categories.map((c) => ({
        key: `category-${c.label}`,
        label: c.label,
        amountCents: c.amountCents,
        level: 1,
        sign: 'NONE' as const,
        emphasis: false,
        positive: false,
      })),
      { key: 'gross-profit', label: 'Lucro bruto', amountCents: grossProfit, level: 0, sign: 'EQUALS', emphasis: true, positive: grossProfit >= 0 },
      { key: 'personnel', label: 'Despesas com pessoal', amountCents: personnel, level: 1, sign: 'MINUS', emphasis: false, positive: false },
      { key: 'administrative', label: 'Despesas administrativas', amountCents: administrative, level: 1, sign: 'MINUS', emphasis: false, positive: false },
      { key: 'commercial', label: 'Despesas comerciais', amountCents: commercial, level: 1, sign: 'MINUS', emphasis: false, positive: false },
      { key: 'other-operating', label: 'Outras despesas operacionais', amountCents: otherOperating, level: 1, sign: 'MINUS', emphasis: false, positive: false },
      { key: 'financial', label: 'Despesas financeiras', amountCents: financial, level: 1, sign: 'MINUS', emphasis: false, positive: false },
      { key: 'before-tax', label: 'Resultado antes do IRPJ/CSLL', amountCents: beforeTax, level: 0, sign: 'EQUALS', emphasis: true, positive: beforeTax >= 0 },
      { key: 'taxes', label: 'Provisão para IRPJ e CSLL', amountCents: taxes, level: 0, sign: 'MINUS', emphasis: false, positive: false },
      { key: 'net-result', label: 'Resultado do exercício', amountCents: netResult, level: 0, sign: 'EQUALS', emphasis: true, positive: netResult >= 0 },
    ];

    return {
      month,
      year,
      monthLabel: monthLabel(year, month),
      organization: { name: organization?.name ?? 'FrotaOne', legalId: organization?.legalId ?? null },
      netRevenueCents: netRevenue,
      grossProfitCents: grossProfit,
      netResultCents: netResult,
      lines,
      footnote:
        'DRE gerencial com base em pagamentos recebidos e contas a pagar quitadas no mês. A provisão de IRPJ/CSLL deve ser apurada pela contabilidade.',
    };
  };

  app.get(
    '/reports/dre',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'read')] },
    async (request) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const today = businessDate();
      const raw = request.query as Record<string, string>;
      const query = dreQuerySchema.parse({
        month: raw.month ?? today.slice(5, 7),
        year: raw.year ?? today.slice(0, 4),
      });
      return buildDre(organizationId, ctx, query.month, query.year);
    },
  );

  app.get(
    '/reports/dre.pdf',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'export')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const { organizationId } = requireAuthContext(request);
      const today = businessDate();
      const raw = request.query as Record<string, string>;
      const query = dreQuerySchema.parse({
        month: raw.month ?? today.slice(5, 7),
        year: raw.year ?? today.slice(0, 4),
      });
      const report = await buildDre(organizationId, ctx, query.month, query.year);
      const pdf = await renderDreReport(report, new Date());
      reply
        .header('content-type', 'application/pdf')
        .header(
          'content-disposition',
          `attachment; filename="dre-${query.year}-${String(query.month).padStart(2, '0')}.pdf"`,
        );
      return reply.send(pdf);
    },
  );
}
