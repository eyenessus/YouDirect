import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { formatCentsBRL, type DreReport } from '@frotaone/contracts';
import { brandLogoDataUri, PAGE, PDF_COLORS, renderPdf, TABLE_PAD } from './printer.js';

/**
 * DRE Mensal em PDF.
 *
 * [P] Não há golden master para este documento (somente o relatório de
 * manutenções foi fornecido). O layout reutiliza os mesmos tokens
 * (A4 retrato, Roboto, cabeçalho/rodapé, cores) para manter coerência
 * visual, e reproduz a hierarquia exibida na tela `/finance/reports/dre`.
 */
export function buildDreDefinition(
  report: DreReport,
  issuedAt: Date,
  logoDataUri: string,
): TDocumentDefinitions {
  const issued = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(issuedAt);

  const body = report.lines.map((line) => {
    const prefix =
      line.sign === 'PLUS' ? '(+) ' : line.sign === 'MINUS' ? '(-) ' : line.sign === 'EQUALS' ? '(=) ' : '';
    return [
      {
        text: `${prefix}${line.label}`,
        style: line.emphasis ? 'lineStrong' : 'line',
        margin: [line.level * 12, 0, 0, 0] as [number, number, number, number],
      },
      {
        text: formatCentsBRL(line.amountCents),
        style: line.emphasis ? 'valueStrong' : 'value',
        alignment: 'right' as const,
        color: line.emphasis && line.positive ? PDF_COLORS.positive : undefined,
      },
    ];
  });

  const content: Content[] = [
    { text: 'DEMONSTRAÇÃO DO RESULTADO DO EXERCÍCIO', style: 'title' },
    { text: `${report.monthLabel}`, style: 'subtitle' },
    {
      text: `${report.organization.name}${
        report.organization.legalId ? ` · ${report.organization.legalId}` : ''
      } · Emitido em ${issued}`,
      style: 'meta',
    },
    {
      margin: [0, 18, 0, 14],
      columns: [
        {
          width: '*',
          stack: [
            { text: 'Receita líquida', style: 'cardLabel' },
            { text: formatCentsBRL(report.netRevenueCents), style: 'cardValue' },
          ],
        },
        {
          width: '*',
          stack: [
            { text: 'Lucro bruto', style: 'cardLabel' },
            { text: formatCentsBRL(report.grossProfitCents), style: 'cardValue' },
          ],
        },
        {
          width: '*',
          stack: [
            { text: 'Resultado do exercício', style: 'cardLabel' },
            { text: formatCentsBRL(report.netResultCents), style: 'cardValue' },
          ],
        },
      ],
    },
    {
      table: { widths: ['*', 120], body },
      layout: {
        hLineWidth: () => 0.4,
        vLineWidth: () => 0,
        hLineColor: () => PDF_COLORS.border,
        paddingLeft: () => TABLE_PAD,
        paddingRight: () => TABLE_PAD,
        paddingTop: () => 5.4,
        paddingBottom: () => 5.4,
        fillColor: (rowIndex: number) => (report.lines[rowIndex]?.emphasis ? PDF_COLORS.zebra : null),
      },
    },
    { text: report.footnote, style: 'note', margin: [0, 14, 0, 0] },
  ];

  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [PAGE.marginLeft, PAGE.marginTop, PAGE.marginRight, PAGE.marginBottom],
    info: {
      title: `DRE ${report.monthLabel}`,
      author: report.organization.name,
      subject: 'Demonstração do Resultado do Exercício',
      creator: 'FrotaOne',
      producer: 'FrotaOne',
    },
    defaultStyle: { font: 'Roboto', fontSize: 8, color: PDF_COLORS.text, lineHeight: 1 },
    header: () => ({
      margin: [PAGE.marginLeft, 9.5, PAGE.marginRight, 0],
      columns: [
        { image: logoDataUri, width: 96, height: 64, margin: [0, 4.5, 0, 0] },
        {
          width: '*',
          stack: [
            { text: report.organization.name, style: 'headerOrg', alignment: 'right' },
            { text: 'DRE Mensal', style: 'headerSub', alignment: 'right' },
          ],
          margin: [0, 22, 0, 0],
        },
      ],
    }),
    footer: (currentPage: number, pageCount: number) => ({
      margin: [PAGE.marginLeft, 3.4, PAGE.marginRight, 0],
      columns: [
        { text: 'Documento gerencial — não substitui a apuração contábil.', style: 'footer' },
        { text: `${currentPage} / ${pageCount}`, style: 'footer', alignment: 'right' },
      ],
    }),
    content,
    styles: {
      title: { fontSize: 16, bold: true, color: PDF_COLORS.title, margin: [0, 0, 0, 2] },
      subtitle: { fontSize: 11, bold: true, color: PDF_COLORS.title, margin: [0, 0, 0, 3] },
      meta: { fontSize: 8, color: PDF_COLORS.muted },
      cardLabel: { fontSize: 8, color: PDF_COLORS.muted, margin: [0, 0, 0, 3] },
      cardValue: { fontSize: 13, bold: true, color: PDF_COLORS.positive },
      line: { fontSize: 8, color: PDF_COLORS.muted },
      lineStrong: { fontSize: 8, bold: true, color: PDF_COLORS.title },
      value: { fontSize: 8, color: PDF_COLORS.text },
      valueStrong: { fontSize: 8, bold: true, color: PDF_COLORS.title },
      note: { fontSize: 8, color: PDF_COLORS.muted },
      headerOrg: { fontSize: 9, bold: true, color: PDF_COLORS.title, margin: [0, 0, 0, 3.9] },
      headerSub: { fontSize: 8, color: PDF_COLORS.muted },
      footer: { fontSize: 8, color: PDF_COLORS.muted },
    },
  };
}

export async function renderDreReport(report: DreReport, issuedAt: Date): Promise<Buffer> {
  const logo = await brandLogoDataUri();
  return renderPdf(buildDreDefinition(report, issuedAt, logo));
}
