import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import { formatCentsBRL, formatIsoDateBR, maskCpf, maskPhone, rentalTypeLabels, type RentalType } from '@yudirect/contracts';
import { brandLogoDataUri, PAGE, PDF_COLORS, renderPdf } from './printer.js';

/**
 * Contrato de locação gerado a partir dos dados da locação. É o
 * documento enviado para assinatura digital (ou baixado para assinar
 * à mão). Cláusulas genéricas: a locadora deve revisá-las com o jurídico.
 */
export interface RentalContractData {
  organization: { name: string; legalId: string | null; city: string | null };
  rental: {
    rentalNumber: string;
    rentalType: string;
    startDate: string;
    endDate: string | null;
    periodicAmountCents: number;
    depositCents: number;
    weeklyFranchiseKm: number | null;
    extraKmPriceCents: number | null;
  };
  driver: { fullName: string; cpf: string | null; cnhNumber: string | null; cnhCategory: string | null; cnhExpiresAt: string | null; phone: string; address: string | null };
  vehicle: { plate: string; brand: string; model: string; year: number | null; color: string | null; renavam: string | null };
  issuedAt: Date;
}

export function buildRentalContractDefinition(d: RentalContractData, logo: string): TDocumentDefinitions {
  const period = rentalTypeLabels[d.rental.rentalType as RentalType] ?? d.rental.rentalType;
  const km =
    d.rental.weeklyFranchiseKm !== null
      ? `franquia de ${d.rental.weeklyFranchiseKm.toLocaleString('pt-BR')} km por semana, proporcional aos dias de uso; o excedente é cobrado a ${formatCentsBRL(d.rental.extraKmPriceCents ?? 0)} por km, apurado pelo hodômetro das vistorias`
      : 'quilometragem livre';
  const clause = (n: number, title: string, text: string): Content => ({
    stack: [
      { text: `Cláusula ${n}ª — ${title}`, style: 'clauseTitle' },
      { text, style: 'clause' },
    ],
    margin: [0, 0, 0, 8],
  });
  const party = (label: string, lines: string[]): Content => ({
    stack: [{ text: label, style: 'partyLabel' }, ...lines.map((t) => ({ text: t, style: 'party' }))],
    margin: [0, 0, 0, 8],
  });

  const content: Content[] = [
    { text: 'Contrato de Locação de Veículo', style: 'title' },
    { text: `Contrato ${d.rental.rentalNumber}`, style: 'meta', margin: [0, 0, 0, 12] },
    party('LOCADORA', [`${d.organization.name}${d.organization.legalId ? ` — CNPJ ${d.organization.legalId}` : ''}`]),
    party('LOCATÁRIO (MOTORISTA)', [
      `${d.driver.fullName}${d.driver.cpf ? ` — CPF ${maskCpf(d.driver.cpf)}` : ''}`,
      `CNH ${d.driver.cnhNumber ?? '—'} (categoria ${d.driver.cnhCategory ?? '—'}, validade ${formatIsoDateBR(d.driver.cnhExpiresAt)})`,
      `Telefone ${maskPhone(d.driver.phone)}${d.driver.address ? ` — ${d.driver.address}` : ''}`,
    ]),
    party('VEÍCULO', [
      `${d.vehicle.brand} ${d.vehicle.model}${d.vehicle.year ? ` ${d.vehicle.year}` : ''}${d.vehicle.color ? `, ${d.vehicle.color}` : ''}`,
      `Placa ${d.vehicle.plate}${d.vehicle.renavam ? ` — Renavam ${d.vehicle.renavam}` : ''}`,
    ]),
    clause(1, 'Objeto e prazo', `A LOCADORA aluga ao LOCATÁRIO o veículo acima, para uso em transporte por aplicativo, de ${formatIsoDateBR(d.rental.startDate)} ${d.rental.endDate ? `até ${formatIsoDateBR(d.rental.endDate)}` : 'por prazo indeterminado, podendo qualquer parte encerrar o contrato com aviso de 7 dias'}.`),
    clause(2, 'Valor e pagamento', `O aluguel é ${period.toLowerCase()}, no valor de ${formatCentsBRL(d.rental.periodicAmountCents)} por período, pago por Pix até o vencimento informado na Área do Motorista. O atraso permite à LOCADORA suspender a locação e recolher o veículo.`),
    clause(3, 'Caução', `O LOCATÁRIO entrega caução de ${formatCentsBRL(d.rental.depositCents)}, devolvida ao fim do contrato, descontados aluguéis em aberto, multas de trânsito, avarias e quilometragem excedente.`),
    clause(4, 'Quilometragem', `A locação tem ${km}.`),
    clause(5, 'Vistorias', 'O LOCATÁRIO realizará as vistorias periódicas solicitadas, enviando as fotos e o hodômetro pelo link ou WhatsApp, no prazo indicado.'),
    clause(6, 'Manutenção', 'A manutenção preventiva e corretiva decorrente do uso normal é da LOCADORA, que deve ser avisada pela Área do Motorista. Danos por mau uso, acidente ou negligência são do LOCATÁRIO.'),
    clause(7, 'Avarias', 'Avarias constatadas em vistoria são cobradas conforme a tabela de avarias da LOCADORA vigente na data da vistoria.'),
    clause(8, 'Multas de trânsito', 'Infrações cometidas durante a locação são de responsabilidade do LOCATÁRIO, que assinará a indicação de condutor no prazo legal; o valor será repassado como cobrança. A multa por não indicação, quando causada pelo LOCATÁRIO, também poderá ser repassada.'),
    clause(9, 'Devolução', 'O veículo deve ser devolvido limpo, sem objetos pessoais, com o mesmo nível de combustível da retirada, e passará por vistoria de devolução.'),
    clause(10, 'Dados pessoais', 'Os dados do LOCATÁRIO são tratados para execução deste contrato, cobrança e cumprimento de obrigações legais (LGPD, art. 7º, II, V e VI).'),
    clause(11, 'Assinatura', 'As partes concordam com a assinatura eletrônica deste contrato, com validação de identidade por selfie e documento, nos termos da MP 2.200-2/2001 e da Lei 14.063/2020.'),
    { text: `${d.organization.city ?? ''}${d.organization.city ? ', ' : ''}${formatIsoDateBR(d.issuedAt.toISOString().slice(0, 10))}.`, style: 'clause', margin: [0, 10, 0, 30] },
    {
      columns: [
        { stack: [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 0.6 }] }, { text: d.organization.name, style: 'sign' }] },
        { stack: [{ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 0.6 }] }, { text: d.driver.fullName, style: 'sign' }] },
      ],
      columnGap: 40,
    },
  ];

  return {
    pageSize: 'A4',
    pageMargins: [PAGE.marginLeft, PAGE.marginTop, PAGE.marginRight, PAGE.marginBottom],
    info: { title: `Contrato ${d.rental.rentalNumber}`, author: d.organization.name, creator: 'YuDirect', producer: 'YuDirect' },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: PDF_COLORS.text, lineHeight: 1.25 },
    header: () => ({
      margin: [PAGE.marginLeft, 9.5, PAGE.marginRight, 0],
      columns: [
        { image: logo, width: 120, height: 29, margin: [0, 17, 0, 0] },
        { text: d.organization.name, style: 'headerOrg', alignment: 'right', margin: [0, 26, 0, 0] },
      ],
    }),
    footer: (page: number, count: number) => ({
      margin: [PAGE.marginLeft, 3.4, PAGE.marginRight, 0],
      columns: [
        { text: `Contrato ${d.rental.rentalNumber}`, style: 'footer' },
        { text: `${page} / ${count}`, style: 'footer', alignment: 'right' },
      ],
    }),
    content,
    styles: {
      title: { fontSize: 15, bold: true, color: PDF_COLORS.title },
      meta: { fontSize: 9, color: PDF_COLORS.muted },
      partyLabel: { fontSize: 8, bold: true, color: PDF_COLORS.muted, margin: [0, 0, 0, 2] },
      party: { fontSize: 9 },
      clauseTitle: { fontSize: 9, bold: true, color: PDF_COLORS.title, margin: [0, 0, 0, 2] },
      clause: { fontSize: 9, alignment: 'justify' },
      sign: { fontSize: 8, color: PDF_COLORS.muted, margin: [0, 4, 0, 0] },
      headerOrg: { fontSize: 9, bold: true, color: PDF_COLORS.title },
      footer: { fontSize: 8, color: PDF_COLORS.muted },
    },
  };
}

export async function renderRentalContract(data: RentalContractData): Promise<Buffer> {
  return renderPdf(buildRentalContractDefinition(data, await brandLogoDataUri()));
}
