import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import {
  formatCentsBRL,
  formatIsoDateBR,
  maintenanceStatusLabels,
  maintenanceTypeLabels,
  vehicleStatusLabels,
  type MaintenanceStatus,
  type MaintenanceType,
} from '@yudirect/contracts';
import {
  brandLogoDataUri,
  COLUMNS,
  PAGE,
  PDF_COLORS,
  pairLayout,
  plainLayout,
  renderPdf,
  tableLayout,
} from './printer.js';

export interface MaintenanceReportVehicle {
  plate: string;
  brand: string;
  model: string;
  year: number | null;
  color: string | null;
  renavam: string | null;
  vin: string | null;
  mileageKm: number | null;
  status: keyof typeof vehicleStatusLabels;
  purchaseDate: string | null;
}

export interface MaintenanceReportItem {
  name: string;
  quantity: number;
  unitCostCents: number;
  subtotalCents: number;
  supplier: string | null;
  warrantyUntil: string | null;
  nextDueDate: string | null;
}

export interface MaintenanceReportOrder {
  orderNumber: string;
  type: MaintenanceType;
  status: MaintenanceStatus;
  description: string;
  openedAt: string | null;
  scheduledAt: string | null;
  performedAt: string | null;
  completedAt: string | null;
  mileageKm: number | null;
  laborCostCents: number;
  partsCostCents: number;
  totalCents: number;
  paymentMethodLabel: string;
  items: MaintenanceReportItem[];
}

export interface MaintenanceReportData {
  organizationName: string;
  issuedAt: Date;
  vehicle: MaintenanceReportVehicle;
  orders: MaintenanceReportOrder[];
}

const DASH = '—';

function km(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH;
  return `${new Intl.NumberFormat('pt-BR').format(value)} km`;
}

function issuedAtLabel(date: Date): string {
  const fmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(date).replace(', ', ', ');
}

function sectionTitle(text: string): Content {
  return { text, style: 'section', margin: [0, 12.2, 0, 6.2] };
}

function labelValueTable(rows: Array<[string, string, string, string]>): Content {
  return {
    table: {
      widths: [...COLUMNS.pair],
      body: rows.map(([l1, v1, l2, v2]) => [
        { text: l1, style: 'cellLabel' },
        { text: v1, style: 'cellValue' },
        { text: l2, style: 'cellLabel' },
        { text: v2, style: 'cellValue' },
      ]),
    },
    layout: pairLayout,
  };
}

/**
 * Relatório de manutenções — reproduz o PDF fornecido como golden
 * master (A4 retrato, cabeçalho/rodapé por página, resumo, distribuição
 * por tipo e situação, histórico consolidado e detalhamento por OS).
 *
 * Regra impressa e aplicada no cálculo: **custos de ordens canceladas
 * ficam fora dos totais**.
 */
export function buildMaintenanceReportDefinition(
  data: MaintenanceReportData,
  logoDataUri: string,
): TDocumentDefinitions {
  const eligible = data.orders.filter((o) => o.status !== 'CANCELED');
  const completed = data.orders.filter((o) => o.status === 'COMPLETED');
  const open = data.orders.filter((o) => o.status === 'OPEN');
  const canceled = data.orders.filter((o) => o.status === 'CANCELED');

  const laborCents = eligible.reduce((a, o) => a + o.laborCostCents, 0);
  const partsCents = eligible.reduce((a, o) => a + o.partsCostCents, 0);
  const totalCents = laborCents + partsCents;
  const averageCents = eligible.length > 0 ? Math.round(totalCents / eligible.length) : 0;

  const byType = new Map<MaintenanceType, { count: number; totalCents: number }>();
  for (const order of eligible) {
    const entry = byType.get(order.type) ?? { count: 0, totalCents: 0 };
    entry.count += 1;
    entry.totalCents += order.totalCents;
    byType.set(order.type, entry);
  }
  const byStatus = new Map<MaintenanceStatus, { count: number; totalCents: number }>();
  for (const order of eligible) {
    const entry = byStatus.get(order.status) ?? { count: 0, totalCents: 0 };
    entry.count += 1;
    entry.totalCents += order.totalCents;
    byStatus.set(order.status, entry);
  }

  const vehicleLabel = `${data.vehicle.brand} ${data.vehicle.model}`.trim();

  const content: Content[] = [
    { text: 'RELATÓRIO DE MANUTENÇÕES', style: 'title' },
    { text: `${data.vehicle.plate} · ${vehicleLabel}`, style: 'subtitle' },
    {
      text: `Emitido em ${issuedAtLabel(data.issuedAt)} · ${data.organizationName}`,
      style: 'meta',
    },

    sectionTitle('Identificação do veículo'),
    labelValueTable([
      ['Placa', data.vehicle.plate, 'Situação', vehicleStatusLabels[data.vehicle.status]],
      ['Marca', data.vehicle.brand || DASH, 'Modelo', data.vehicle.model || DASH],
      ['Ano', data.vehicle.year ? String(data.vehicle.year) : DASH, 'Cor', data.vehicle.color || DASH],
      ['Renavam', data.vehicle.renavam || DASH, 'Chassi', data.vehicle.vin || DASH],
      ['Odômetro', km(data.vehicle.mileageKm), 'Compra', formatIsoDateBR(data.vehicle.purchaseDate)],
    ]),

    sectionTitle('Resumo'),
    {
      table: {
        widths: ['*', '*', '*', '*'],
        body: [
          [
            { text: 'Ordens', style: 'cellLabel' },
            { text: 'Concluídas', style: 'cellLabel' },
            { text: 'Em aberto', style: 'cellLabel' },
            { text: 'Canceladas', style: 'cellLabel' },
          ],
          [
            { text: String(data.orders.length), style: 'metric' },
            { text: String(completed.length), style: 'metric' },
            { text: String(open.length), style: 'metric' },
            { text: String(canceled.length), style: 'metric' },
          ],
          [
            { text: 'Mão de obra', style: 'cellLabel' },
            { text: 'Peças', style: 'cellLabel' },
            { text: 'Custo total', style: 'cellLabel' },
            { text: 'Custo médio', style: 'cellLabel' },
          ],
          [
            { text: formatCentsBRL(laborCents), style: 'cellValue' },
            { text: formatCentsBRL(partsCents), style: 'cellValue' },
            { text: formatCentsBRL(totalCents), style: 'cellValue' },
            { text: formatCentsBRL(averageCents), style: 'cellValue' },
          ],
        ],
      },
      layout: plainLayout,
    },

    sectionTitle('Por tipo'),
    {
      table: {
        widths: [...COLUMNS.group],
        body: [
          [
            { text: 'Grupo', style: 'cellLabel' },
            { text: 'Quantidade', style: 'cellLabel', alignment: 'right' },
            { text: 'Custo', style: 'cellLabel', alignment: 'right' },
          ],
          ...(byType.size === 0
            ? [[{ text: 'Sem ordens elegíveis.', style: 'cellValue', colSpan: 3 }, {}, {}]]
            : [...byType.entries()].map(([type, entry]) => [
                { text: maintenanceTypeLabels[type], style: 'cellValue' },
                { text: String(entry.count), style: 'cellValue', alignment: 'right' },
                { text: formatCentsBRL(entry.totalCents), style: 'cellValue', alignment: 'right' },
              ])),
        ],
      },
      layout: tableLayout,
    },

    sectionTitle('Por situação'),
    {
      table: {
        widths: [...COLUMNS.group],
        body: [
          [
            { text: 'Grupo', style: 'cellLabel' },
            { text: 'Quantidade', style: 'cellLabel', alignment: 'right' },
            { text: 'Custo', style: 'cellLabel', alignment: 'right' },
          ],
          ...(byStatus.size === 0
            ? [[{ text: 'Sem ordens elegíveis.', style: 'cellValue', colSpan: 3 }, {}, {}]]
            : [...byStatus.entries()].map(([status, entry]) => [
                { text: maintenanceStatusLabels[status], style: 'cellValue' },
                { text: String(entry.count), style: 'cellValue', alignment: 'right' },
                { text: formatCentsBRL(entry.totalCents), style: 'cellValue', alignment: 'right' },
              ])),
        ],
      },
      layout: tableLayout,
    },

    sectionTitle('Histórico consolidado'),
    {
      table: {
        headerRows: 1,
        widths: [...COLUMNS.history],
        body: [
          [
            { text: 'OS', style: 'cellLabel' },
            { text: 'Tipo', style: 'cellLabel' },
            { text: 'Situação', style: 'cellLabel' },
            { text: 'Abertura', style: 'cellLabel' },
            { text: 'Execução', style: 'cellLabel' },
            { text: 'KM', style: 'cellLabel', alignment: 'right' },
            { text: 'Total', style: 'cellLabel', alignment: 'right' },
          ],
          ...(data.orders.length === 0
            ? [[{ text: 'Nenhuma ordem de serviço registrada.', style: 'cellValue', colSpan: 7 }, {}, {}, {}, {}, {}, {}]]
            : data.orders.map((order) => [
                { text: order.orderNumber, style: 'cellValue' },
                { text: maintenanceTypeLabels[order.type], style: 'cellValue' },
                { text: maintenanceStatusLabels[order.status], style: 'cellValue' },
                { text: formatIsoDateBR(order.openedAt), style: 'cellValue' },
                { text: formatIsoDateBR(order.performedAt), style: 'cellValue' },
                { text: km(order.mileageKm), style: 'cellValue', alignment: 'right' },
                {
                  text: order.status === 'CANCELED' ? DASH : formatCentsBRL(order.totalCents),
                  style: 'cellValue',
                  alignment: 'right',
                },
              ])),
        ],
      },
      layout: tableLayout,
    },

    sectionTitle('Detalhamento das ordens de serviço'),
  ];

  data.orders.forEach((order, index) => {
    content.push({
      text: `${index + 1}. OS ${order.orderNumber}`,
      style: 'orderTitle',
      margin: [0, index === 0 ? 0 : 10.7, 0, 6],
    });
    content.push(
      labelValueTable([
        ['Tipo', maintenanceTypeLabels[order.type], 'Situação', maintenanceStatusLabels[order.status]],
        ['Abertura', formatIsoDateBR(order.openedAt), 'Agendada', formatIsoDateBR(order.scheduledAt)],
        [
          'Execução',
          formatIsoDateBR(order.performedAt),
          'Encerramento',
          formatIsoDateBR(order.completedAt),
        ],
        ['Odômetro', km(order.mileageKm), 'Pagamento', order.paymentMethodLabel],
        [
          'Mão de obra',
          formatCentsBRL(order.laborCostCents),
          'Peças',
          formatCentsBRL(order.partsCostCents),
        ],
      ]),
    );
    content.push({ text: 'Serviço', style: 'blockLabel', margin: [0, 6, 0, 2] });
    content.push({ text: order.description || DASH, style: 'serviceText' });

    content.push({ text: 'Peças e itens', style: 'blockLabel', margin: [0, 6, 0, 2.6] });
    content.push({
      table: {
        headerRows: 1,
        widths: [...COLUMNS.items],
        body: [
          [
            { text: 'Peça', style: 'cellLabel' },
            { text: 'Qtd', style: 'cellLabel' },
            { text: 'Unitário', style: 'cellLabel', alignment: 'right' },
            { text: 'Fornecedor', style: 'cellLabel' },
            { text: 'Garantia até', style: 'cellLabel' },
            { text: 'Próxima', style: 'cellLabel' },
          ],
          ...(order.items.length === 0
            ? [
                [
                  { text: 'Nenhuma peça registrada nesta OS.', style: 'cellValue', colSpan: 6 },
                  {}, {}, {}, {}, {},
                ],
              ]
            : order.items.map((item) => [
                { text: item.name, style: 'cellValue' },
                { text: String(item.quantity), style: 'cellValue', alignment: 'center' },
                {
                  stack: [
                    { text: formatCentsBRL(item.unitCostCents), style: 'cellValue', alignment: 'right' },
                    { text: formatCentsBRL(item.subtotalCents), style: 'cellMuted', alignment: 'right' },
                  ],
                },
                { text: item.supplier || DASH, style: 'cellValue' },
                { text: formatIsoDateBR(item.warrantyUntil), style: 'cellValue' },
                { text: formatIsoDateBR(item.nextDueDate), style: 'cellValue' },
              ])),
        ],
      },
      layout: tableLayout,
    });

    content.push({
      table: {
        widths: [...COLUMNS.total],
        body: [
          [
            { text: 'Total da OS', style: 'totalLabel', alignment: 'right' },
            {
              text: order.status === 'CANCELED' ? DASH : formatCentsBRL(order.totalCents),
              style: 'totalValue',
              alignment: 'right',
            },
          ],
        ],
      },
      layout: plainLayout,
      margin: [0, 4.3, 0, 0],
    });
  });

  content.push({
    text: 'Custos de ordens canceladas ficam fora dos totais. Valores refletem o cadastro no momento da emissão.',
    style: 'note',
    margin: [0, 18, 0, 0],
  });

  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [PAGE.marginLeft, PAGE.marginTop, PAGE.marginRight, PAGE.marginBottom],
    info: {
      title: `Manutenções ${data.vehicle.plate}`,
      author: data.organizationName,
      subject: 'Relatório de manutenções',
      creator: 'YuDirect',
      producer: 'YuDirect',
    },
    defaultStyle: { font: 'Roboto', fontSize: 8, color: PDF_COLORS.text, lineHeight: 1 },
    header: () => ({
      margin: [PAGE.marginLeft, 9.5, PAGE.marginRight, 0],
      columns: [
        { image: logoDataUri, width: 120, height: 29, margin: [0, 17, 0, 0] },
        {
          width: '*',
          stack: [
            { text: data.organizationName, style: 'headerOrg', alignment: 'right' },
            { text: 'Relatório de manutenções', style: 'headerSub', alignment: 'right' },
          ],
          margin: [0, 22, 0, 0],
        },
      ],
    }),
    footer: (currentPage: number, pageCount: number) => ({
      margin: [PAGE.marginLeft, 3.4, PAGE.marginRight, 0],
      columns: [
        { text: 'Documento para apresentação ao cliente.', style: 'footer' },
        { text: `${currentPage} / ${pageCount}`, style: 'footer', alignment: 'right' },
      ],
    }),
    content,
    styles: {
      title: { fontSize: 16, bold: true, color: PDF_COLORS.title, margin: [0, 0, 0, 2] },
      subtitle: { fontSize: 11, bold: true, color: PDF_COLORS.title, margin: [0, 0, 0, 3] },
      meta: { fontSize: 8, color: PDF_COLORS.muted, margin: [0, 0, 0, 10.8] },
      section: { fontSize: 11, bold: true, color: PDF_COLORS.title },
      orderTitle: { fontSize: 11, bold: true, color: PDF_COLORS.title },
      blockLabel: { fontSize: 8, color: PDF_COLORS.muted },
      serviceText: { fontSize: 9, bold: true, color: PDF_COLORS.title },
      cellLabel: { fontSize: 8, color: PDF_COLORS.muted },
      cellValue: { fontSize: 8, color: PDF_COLORS.text },
      cellMuted: { fontSize: 8, color: PDF_COLORS.muted },
      metric: { fontSize: 11, bold: true, color: PDF_COLORS.title },
      totalLabel: { fontSize: 9, bold: true, color: PDF_COLORS.muted },
      totalValue: { fontSize: 9, bold: true, color: PDF_COLORS.title },
      note: { fontSize: 8, color: PDF_COLORS.muted },
      headerOrg: { fontSize: 9, bold: true, color: PDF_COLORS.title, margin: [0, 0, 0, 3.9] },
      headerSub: { fontSize: 8, color: PDF_COLORS.muted },
      footer: { fontSize: 8, color: PDF_COLORS.muted },
    },
  };
}

export async function renderMaintenanceReport(data: MaintenanceReportData): Promise<Buffer> {
  const logo = await brandLogoDataUri();
  return renderPdf(buildMaintenanceReportDefinition(data, logo));
}
