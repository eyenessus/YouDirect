import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { formatCentsBRL, formatIsoDateBR, paymentMethodLabels, type PaymentMethod } from '@yudirect/contracts';
import { brandLogoDataUri, PAGE, PDF_COLORS, renderPdf } from './printer.js';

/**
 * Recibo de pagamento de um recebimento (aluguel, km excedente etc.).
 * É um comprovante de que o valor foi recebido; NÃO substitui a nota fiscal de serviço.
 */
export interface PaymentReceiptData {
  receiptNumber: string;
  organization: { name: string; legalId: string | null };
  payer: { fullName: string; cpfMasked: string | null };
  description: string;
  amountCents: number;
  paidAt: string;
  method: PaymentMethod | string;
  issuedAt: Date;
}

export function buildPaymentReceiptDefinition(d: PaymentReceiptData, logo: string): TDocumentDefinitions {
  const row = (label: string, value: string): Content[] => [
    { text: label, style: 'label' },
    { text: value, style: 'value' },
  ];
  const method = paymentMethodLabels[d.method as PaymentMethod] ?? d.method;
  return {
    pageSize: 'A4',
    pageMargins: [PAGE.marginLeft, PAGE.marginTop, PAGE.marginRight, PAGE.marginBottom],
    info: { title: `Recibo ${d.receiptNumber}`, author: d.organization.name, creator: 'YuDirect', producer: 'YuDirect' },
    defaultStyle: { font: 'Roboto', fontSize: 10, color: PDF_COLORS.text, lineHeight: 1.3 },
    header: () => ({
      margin: [PAGE.marginLeft, 9.5, PAGE.marginRight, 0],
      columns: [
        { image: logo, width: 120, height: 29, margin: [0, 17, 0, 0] },
        { text: d.organization.name, style: 'headerOrg', alignment: 'right', margin: [0, 26, 0, 0] },
      ],
    }),
    footer: () => ({
      margin: [PAGE.marginLeft, 3.4, PAGE.marginRight, 0],
      text: `Recibo ${d.receiptNumber} · emitido em ${formatIsoDateBR(d.issuedAt.toISOString().slice(0, 10))}`,
      style: 'footer',
    }),
    content: [
      { text: 'Recibo de pagamento', style: 'title' },
      { text: d.receiptNumber, style: 'meta', margin: [0, 0, 0, 14] },
      {
        table: {
          widths: [130, '*'],
          body: [
            row('Recebido de', `${d.payer.fullName}${d.payer.cpfMasked ? ` — CPF ${d.payer.cpfMasked}` : ''}`),
            row('Referente a', d.description),
            row('Valor', formatCentsBRL(d.amountCents)),
            row('Data do pagamento', formatIsoDateBR(d.paidAt)),
            row('Forma de pagamento', method),
            row('Recebido por', `${d.organization.name}${d.organization.legalId ? ` — CNPJ ${d.organization.legalId}` : ''}`),
          ],
        },
        layout: {
          hLineWidth: () => 0.4,
          vLineWidth: () => 0,
          hLineColor: () => PDF_COLORS.border,
          paddingTop: () => 7,
          paddingBottom: () => 7,
          fillColor: (i: number) => (i % 2 === 1 ? PDF_COLORS.zebra : null),
        },
      },
      {
        text: 'Este recibo comprova o recebimento do valor acima. Não substitui a nota fiscal de serviço, que é emitida separadamente conforme a legislação municipal.',
        style: 'notice',
        margin: [0, 18, 0, 0],
      },
    ],
    styles: {
      title: { fontSize: 18, bold: true, color: PDF_COLORS.title },
      meta: { fontSize: 10, color: PDF_COLORS.muted },
      label: { fontSize: 9, bold: true, color: PDF_COLORS.muted },
      value: { fontSize: 10 },
      notice: { fontSize: 8.5, color: PDF_COLORS.muted, italics: true },
      headerOrg: { fontSize: 9, bold: true, color: PDF_COLORS.title },
      footer: { fontSize: 8, color: PDF_COLORS.muted },
    },
  };
}

export async function renderPaymentReceipt(data: PaymentReceiptData): Promise<Buffer> {
  return renderPdf(buildPaymentReceiptDefinition(data, await brandLogoDataUri()));
}
