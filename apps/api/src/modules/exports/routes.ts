import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ObjectId } from 'mongodb';
import {
  businessDate,
  driverStatusLabels,
  formatCentsPlain,
  formatIsoDateBR,
  maskCpf,
  payableStatusLabels,
  receivableStatusLabels,
  vehicleStatusLabels,
} from '@yudirect/contracts';
import { csvCell } from '../../common/helpers.js';
import { requireAuthContext } from '../../plugins/auth.js';
import { cpfForViewer } from '../../common/pii-visibility.js';
import { audit } from '../../services/common.js';

/* ------------------------------------------------------------------ *
 * Exportações CSV (PROMPT_MASTER §6). Separador ";" e BOM (abre direto
 * no Excel em pt-BR); células neutralizadas contra injeção de fórmula.
 * Cada exportação exige a permissão `export` do módulo e fica na
 * auditoria (dados pessoais saindo do sistema).
 * ------------------------------------------------------------------ */

const MAX_ROWS = 20_000;
/** BOM UTF-8: faz o Excel reconhecer a acentuação. */
const BOM = String.fromCharCode(0xfeff);

function sendCsv(reply: FastifyReply, name: string, header: string[], rows: Array<Array<string | number | null>>) {
  const lines = [
    header.map(csvCell).join(';'),
    ...rows.map((row) => row.map((v) => csvCell(v === null || v === undefined ? '' : String(v))).join(';')),
  ];
  reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}-${businessDate()}.csv"`)
    .header('cache-control', 'no-store');
  return reply.send(`${BOM}${lines.join('\r\n')}\r\n`);
}

const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? '' : formatCentsPlain(cents));

export async function registerExportRoutes(app: FastifyInstance): Promise<void> {
  const logExport = async (
    ctx: Parameters<typeof audit>[0],
    auth: { organizationId: ObjectId; userId: ObjectId },
    entityType: string,
    rows: number,
  ) =>
    audit(ctx, {
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: 'export.csv',
      entityType,
      entityId: null,
      after: { rows },
    });

  app.get(
    '/exports/vehicles.csv',
    { onRequest: [app.requireAuth, app.requirePermission('vehicles', 'export')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const docs = await ctx.mongo.collections.vehicles
        .find({ organizationId: auth.organizationId, archivedAt: null })
        .sort({ plate: 1 })
        .limit(MAX_ROWS)
        .toArray();
      await logExport(ctx, auth, 'vehicle', docs.length);
      return sendCsv(
        reply,
        'veiculos',
        ['Placa', 'Marca', 'Modelo', 'Ano', 'Cor', 'RENAVAM', 'Chassi', 'Quilometragem', 'Status', 'UF', 'Cidade', 'Data de compra', 'Valor de compra'],
        docs.map((v) => [
          v.plate,
          v.brand,
          v.model,
          v.year,
          v.color,
          v.renavam,
          v.vin,
          v.mileageKm,
          vehicleStatusLabels[v.status],
          v.registration?.state ?? null,
          v.registration?.city ?? null,
          v.purchase?.date ? formatIsoDateBR(v.purchase.date) : null,
          money(v.purchase?.amountCents),
        ]),
      );
    },
  );

  app.get(
    '/exports/drivers.csv',
    { onRequest: [app.requireAuth, app.requirePermission('drivers', 'export')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const docs = await ctx.mongo.collections.drivers
        .find({ organizationId: auth.organizationId, archivedAt: null })
        .sort({ fullNameFold: 1 })
        .limit(MAX_ROWS)
        .toArray();
      await logExport(ctx, auth, 'driver', docs.length);
      return sendCsv(
        reply,
        'motoristas',
        ['Nome', 'CPF', 'Telefone', 'E-mail', 'CNH', 'Categoria', 'Validade da CNH', 'Cidade', 'UF', 'Status'],
        docs.map((d) => {
          const cpf = d.cpfEncrypted ? ctx.pii.decrypt(d.cpfEncrypted) : null;
          return [
            d.fullName,
            cpf && cpfForViewer(request.auth, cpf) === cpf ? maskCpf(cpf) : cpfForViewer(request.auth, cpf),
            d.phone,
            d.emailLower,
            d.cnh?.number ?? null,
            d.cnh?.category ?? null,
            d.cnh?.expiresAt ? formatIsoDateBR(d.cnh.expiresAt) : null,
            d.address?.city ?? null,
            d.address?.state ?? null,
            driverStatusLabels[d.status],
          ];
        }),
      );
    },
  );

  app.get(
    '/exports/payables.csv',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'export')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const [docs, categories, vehicles] = await Promise.all([
        ctx.mongo.collections.payables
          .find({ organizationId: auth.organizationId })
          .sort({ dueDate: 1, _id: 1 })
          .limit(MAX_ROWS)
          .toArray(),
        ctx.mongo.collections.expenseCategories.find({ organizationId: auth.organizationId }).toArray(),
        ctx.mongo.collections.vehicles.find({ organizationId: auth.organizationId }, { projection: { plate: 1 } }).toArray(),
      ]);
      const cat = new Map(categories.map((c) => [c._id.toHexString(), c.label]));
      const plate = new Map(vehicles.map((v) => [v._id.toHexString(), v.plate]));
      await logExport(ctx, auth, 'payable', docs.length);
      return sendCsv(
        reply,
        'contas-a-pagar',
        ['Descrição', 'Categoria', 'Veículo', 'Fornecedor', 'CNPJ', 'Vencimento', 'Valor', 'Pago', 'Saldo', 'Status', 'Parcela'],
        docs.map((p) => [
          p.description,
          p.categoryId ? (cat.get(p.categoryId.toHexString()) ?? '') : '',
          p.vehicleId ? (plate.get(p.vehicleId.toHexString()) ?? '') : '',
          p.supplier?.name ?? null,
          p.supplier?.taxId ?? null,
          formatIsoDateBR(p.dueDate),
          money(p.amountCents),
          money(p.paidAmountCents),
          money(Math.max(0, p.amountCents - p.paidAmountCents)),
          payableStatusLabels[p.status],
          p.installment ? `${p.installment.number}/${p.installment.total}` : null,
        ]),
      );
    },
  );

  app.get(
    '/exports/receivables.csv',
    { onRequest: [app.requireAuth, app.requirePermission('finance', 'export')] },
    async (request, reply) => {
      const ctx = request.appCtx;
      const auth = requireAuthContext(request);
      const docs = await ctx.mongo.collections.receivables
        .find({ organizationId: auth.organizationId })
        .sort({ dueDate: 1, _id: 1 })
        .limit(MAX_ROWS)
        .toArray();
      const drivers = await ctx.mongo.collections.drivers
        .find({ organizationId: auth.organizationId, _id: { $in: [...new Set(docs.map((d) => d.driverId))] } }, { projection: { fullName: 1 } })
        .toArray();
      const name = new Map(drivers.map((d) => [d._id.toHexString(), d.fullName]));
      await logExport(ctx, auth, 'receivable', docs.length);
      return sendCsv(
        reply,
        'contas-a-receber',
        ['Descrição', 'Motorista', 'Vencimento', 'Valor', 'Recebido', 'Saldo', 'Status'],
        docs.map((r) => [
          r.description,
          name.get(r.driverId.toHexString()) ?? '',
          formatIsoDateBR(r.dueDate),
          money(r.grossAmountCents),
          money(r.paidAmountCents),
          money(Math.max(0, r.grossAmountCents - r.paidAmountCents)),
          receivableStatusLabels[r.status],
        ]),
      );
    },
  );
}
