/* ------------------------------------------------------------------ *
 * Seed de desenvolvimento/demonstração.
 *
 * Reproduz os NÚMEROS verificáveis das capturas de referência
 * (faturamento, despesas, extrato, contas a receber, manutenções),
 * porém com DADOS PESSOAIS FICTÍCIOS: nomes, CPF, RG, telefones e
 * e-mails das capturas NÃO são reutilizados (prompt §8.5 / LGPD).
 *
 * Tudo é criado pelos mesmos serviços de domínio usados pela API — não
 * há respostas "mockadas": os relatórios são calculados a partir destes
 * registros persistidos.
 * ------------------------------------------------------------------ */
import { ObjectId } from 'mongodb';
import {
  addDaysIso,
  DEFAULT_PHOTO_SLOTS,
  fullMatrix,
  type PaymentMethod,
} from '@yudirect/contracts';
import { loadDotEnv, loadEnv, piiPepper, type Env } from '../config/env.js';
import { buildContext, type AppContext } from '../context.js';
import { foldAccents, hashPassword, lookupHash, slugify } from '../common/helpers.js';
import type {
  BankAccountDoc,
  DriverDoc,
  ExpenseCategoryDoc,
  MaintenanceOrderDoc,
  PayableDoc,
  ReceivableDoc,
  RentalDoc,
  VehicleDoc,
} from './types.js';
import { postTransaction } from '../services/ledger.js';
import { derivePayableStatus, deriveReceivableStatus } from '../services/finance.js';
import { runNotificationGenerators } from '../services/notifications.js';
import { ensureDefaultCategories } from '../modules/finance/accounts.js';
import { ensureDefaultTemplate } from '../modules/notifications/routes.js';

const ORG_NAME = 'FF Veículos';
const ORG_LEGAL_ID = '57005346000108';
const TODAY = '2026-11-08';

/** Credenciais do usuário de teste (somente ambiente de demonstração). */
export const TEST_USER_EMAIL = 'teste@yudirect.test';
export const TEST_USER_PASSWORD = 'Teste@2026';

const brl = (value: number) => Math.round(value * 100);

/* --------------------------- Frota (7 veículos) -------------------- */

interface SeedVehicle {
  plate: string;
  brand: string;
  model: string;
  year: number;
  color: string;
  renavam: string;
  vin: string;
  mileageKm: number;
  purchaseAmount: number;
  /** Arquivado: some das listagens e não conta no painel. */
  archived?: boolean;
}

const VEHICLES: SeedVehicle[] = [
  {
    plate: 'EBR7G53',
    brand: 'VW',
    model: 'GOL MPI',
    year: 2023,
    color: 'BRANCA',
    renavam: '01317572928',
    vin: '9BWAG45UOPT048356',
    mileageKm: 181652,
    purchaseAmount: brl(54975),
  },
  {
    plate: 'RNA8D85',
    brand: 'FIAT',
    model: 'ARGO DRIVE',
    year: 2021,
    color: 'PRATA',
    renavam: '01215889034',
    vin: '9BD358A4XMYH21045',
    mileageKm: 118210,
    purchaseAmount: brl(55544),
  },
  {
    plate: 'RVS9B58',
    brand: 'FIAT',
    model: 'MOBI LIKE',
    year: 2023,
    color: 'BRANCA',
    renavam: '01399120477',
    vin: '9BD341A1XPY663201',
    mileageKm: 116350,
    purchaseAmount: brl(53531),
  },
  {
    plate: 'SEB9B67',
    brand: 'VOLKSWAGEM',
    model: 'VOYAGE MPI',
    year: 2023,
    color: 'BRANCA',
    renavam: '01377004512',
    vin: '9BWDB45U8PT112930',
    mileageKm: 166653,
    purchaseAmount: brl(60350),
  },
  {
    plate: 'RVA9F74',
    brand: 'FIAT',
    model: 'MOBI LIKE',
    year: 2022,
    color: 'BRANCA',
    renavam: '01288745120',
    vin: '9BD341A1XNY551077',
    mileageKm: 98240,
    purchaseAmount: brl(49900),
  },
  {
    plate: 'GCQ0E23',
    brand: 'HYUNDAI',
    model: 'HB20 1.0',
    year: 2021,
    color: 'CINZA',
    renavam: '01190233845',
    vin: '9BHBG51CAMP334812',
    mileageKm: 132480,
    purchaseAmount: brl(51200),
  },
  {
    plate: 'FQT3I57',
    brand: 'VW',
    model: 'VOYAGE',
    year: 2022,
    color: 'BRANCA',
    renavam: '01301998745',
    vin: '9BWDB45U7NT088410',
    mileageKm: 142310,
    purchaseAmount: brl(52800),
    archived: true,
  },
];

/* -------------------- Motoristas (dados fictícios) ----------------- */

const DRIVERS = [
  {
    key: 'driver-a',
    fullName: 'Ana Paula Ribeiro',
    cpf: '52998224725',
    rg: '348291055',
    birthDate: '1985-03-14',
    email: 'ana.ribeiro@exemplo.test',
    phone: '11957260001',
    cnhNumber: '0123456789',
    cnhCategory: 'B',
    cnhExpiresAt: '2029-04-30',
    city: 'São Paulo',
    state: 'SP',
    postalCode: '01310100',
    street: 'Avenida Paulista',
    number: '1000',
    district: 'Bela Vista',
  },
  {
    key: 'driver-b',
    fullName: 'Bruno Carvalho Lima',
    cpf: '11144477735',
    rg: '295817733',
    birthDate: '1990-07-22',
    email: 'bruno.lima@exemplo.test',
    phone: '11957260002',
    cnhNumber: '0234567891',
    cnhCategory: 'B',
    cnhExpiresAt: '2028-11-12',
    city: 'São Paulo',
    state: 'SP',
    postalCode: '04538133',
    street: 'Avenida Brigadeiro Faria Lima',
    number: '3477',
    district: 'Itaim Bibi',
  },
  {
    key: 'driver-c',
    fullName: 'Carla Menezes Duarte',
    cpf: '15350946056',
    rg: '412903877',
    birthDate: '1978-05-14',
    email: 'carla.duarte@exemplo.test',
    phone: '11917360003',
    cnhNumber: '0345678912',
    cnhCategory: 'B',
    // CNH vencida — alimenta os alertas críticos de CNH.
    cnhExpiresAt: '2026-10-29',
    city: 'Osasco',
    state: 'SP',
    postalCode: '06150492',
    street: 'Estrada das Palmeiras',
    number: '29',
    district: 'Santa Maria',
  },
  {
    key: 'driver-d',
    fullName: 'Diego Nogueira Alves',
    cpf: '28625461860',
    rg: '377104922',
    birthDate: '1994-01-09',
    email: 'diego.alves@exemplo.test',
    phone: '11980150004',
    cnhNumber: '0456789123',
    cnhCategory: 'B',
    cnhExpiresAt: '2026-10-19',
    city: 'Jundiaí',
    state: 'SP',
    postalCode: '13201005',
    street: 'Rua Barão de Jundiaí',
    number: '451',
    district: 'Centro',
  },
  {
    key: 'driver-e',
    fullName: 'Eduarda Pires Tavares',
    cpf: '39053344705',
    rg: '301455980',
    birthDate: '1988-09-27',
    email: 'eduarda.tavares@exemplo.test',
    phone: '11941020005',
    cnhNumber: '0567891234',
    cnhCategory: 'AB',
    cnhExpiresAt: '2030-02-18',
    city: 'Franco da Rocha',
    state: 'SP',
    postalCode: '07850000',
    street: 'Avenida Liberdade',
    number: '88',
    district: 'Centro',
  },
  {
    key: 'driver-f',
    fullName: 'Felipe Andrade Souza',
    cpf: '19131243055',
    rg: '366210744',
    birthDate: '1992-12-03',
    email: 'felipe.souza@exemplo.test',
    phone: '11977210006',
    cnhNumber: '0678912345',
    cnhCategory: 'B',
    cnhExpiresAt: '2027-06-05',
    city: 'São Paulo',
    state: 'SP',
    postalCode: '03063000',
    street: 'Rua Celso Garcia',
    number: '2200',
    district: 'Brás',
  },
] as const;

/* ------------------------------ Locações --------------------------- */

const RENTALS = [
  { number: 'LOC-2026-001', plate: 'GCQ0E23', driver: 'driver-f', weekly: brl(500), deposit: brl(1000) },
  { number: 'LOC-2026-002', plate: 'RVA9F74', driver: 'driver-e', weekly: brl(650), deposit: brl(1300) },
  { number: 'LOC-2026-004', plate: 'SEB9B67', driver: 'driver-d', weekly: brl(750), deposit: brl(1500) },
  { number: 'LOC-2026-005', plate: 'RVS9B58', driver: 'driver-c', weekly: brl(650), deposit: brl(1300) },
  { number: 'LOC-2026-006', plate: 'RNA8D85', driver: 'driver-b', weekly: brl(800), deposit: brl(1600) },
  { number: 'LOC-2026-007', plate: 'EBR7G53', driver: 'driver-a', weekly: brl(700), deposit: brl(1500) },
] as const;

/** Totais e pendências exatamente como na tela "Contas a Receber". */
const RECEIVABLES = [
  { rental: 'LOC-2026-007', gross: brl(14180), pending: brl(4540), due: '2026-01-16' },
  { rental: 'LOC-2026-006', gross: brl(14400), pending: brl(4800), due: '2025-10-10' },
  { rental: 'LOC-2026-005', gross: brl(10940), pending: brl(3800), due: '2025-10-01' },
  { rental: 'LOC-2026-004', gross: brl(12078), pending: brl(8250), due: '2025-11-15' },
  { rental: 'LOC-2026-002', gross: brl(18140), pending: brl(9750), due: '2026-08-22' },
  { rental: 'LOC-2026-001', gross: brl(15169), pending: brl(2400), due: '2026-10-10' },
] as const;

/** Movimentações de novembro — espelham o extrato da referência. */
const NOVEMBER_RECEIPTS = [
  { date: '2026-11-01', rental: 'LOC-2026-002', amount: brl(650) },
  { date: '2026-11-01', rental: 'LOC-2026-007', amount: brl(760) },
  { date: '2026-11-02', rental: 'LOC-2026-004', amount: brl(393) },
  { date: '2026-11-03', rental: 'LOC-2026-006', amount: brl(800) },
  { date: '2026-11-05', rental: 'LOC-2026-001', amount: brl(500) },
  { date: '2026-11-05', rental: 'LOC-2026-001', amount: brl(500) },
  { date: '2026-11-06', rental: 'LOC-2026-005', amount: brl(650) },
  { date: '2026-11-07', rental: 'LOC-2026-007', amount: brl(700) },
  { date: '2026-11-08', rental: 'LOC-2026-002', amount: brl(650) },
] as const;

/* ----------------------------- Despesas ---------------------------- */

interface SeedPayable {
  description: string;
  category: string;
  plate?: string;
  amount: number;
  due: string;
  supplier: string;
  supplierTaxId?: string;
  paidAt?: string;
  recurring?: boolean;
}

const PAYABLES: SeedPayable[] = [
  // Vencidas em outubro, quitadas em 03/11 → compõem as despesas de novembro.
  { description: 'FINANCIAMENTO FABIANA', category: 'Financiamento', plate: 'RVS9B58', amount: brl(1720.45), due: '2026-10-27', supplier: 'BANCO PAN', supplierTaxId: '59285411000113', paidAt: '2026-11-03', recurring: true },
  { description: 'SEGURO MOBI', category: 'Seguro', plate: 'RVA9F74', amount: brl(174), due: '2026-10-20', supplier: 'CARSYSTEM', paidAt: '2026-11-03', recurring: true },
  // Quitadas em outubro.
  { description: 'FINANCIAMENTO FABIANA', category: 'Financiamento', plate: 'EBR7G53', amount: brl(1654.64), due: '2026-10-19', supplier: 'BANCO SANTANDER', supplierTaxId: '90400888000142', paidAt: '2026-10-19', recurring: true },
  { description: 'SEGURO FIAT ARGO', category: 'Seguro', plate: 'RNA8D85', amount: brl(198.91), due: '2026-10-05', supplier: 'CARSYSTEM', paidAt: '2026-10-05', recurring: true },
  { description: 'FINANCIAMENTO VOYAGE', category: 'Financiamento', plate: 'SEB9B67', amount: brl(1712.8), due: '2026-10-12', supplier: 'BANCO ITAÚ', paidAt: '2026-10-12', recurring: true },
  { description: 'FINANCIAMENTO ARGO', category: 'Financiamento', plate: 'RNA8D85', amount: brl(1598.32), due: '2026-10-15', supplier: 'BANCO BRADESCO', paidAt: '2026-10-15', recurring: true },
  { description: 'FINANCIAMENTO HB20', category: 'Financiamento', plate: 'GCQ0E23', amount: brl(1489.55), due: '2026-10-08', supplier: 'BANCO PAN', paidAt: '2026-10-08', recurring: true },
  // Setembro (compõem o resultado negativo do mês).
  { description: 'FINANCIAMENTO FABIANA', category: 'Financiamento', plate: 'RVS9B58', amount: brl(1720.45), due: '2026-09-27', supplier: 'BANCO PAN', paidAt: '2026-09-27' },
  { description: 'FINANCIAMENTO FABIANA', category: 'Financiamento', plate: 'EBR7G53', amount: brl(1654.64), due: '2026-09-19', supplier: 'BANCO SANTANDER', paidAt: '2026-09-19' },
  { description: 'FINANCIAMENTO VOYAGE', category: 'Financiamento', plate: 'SEB9B67', amount: brl(1712.8), due: '2026-09-12', supplier: 'BANCO ITAÚ', paidAt: '2026-09-12' },
  { description: 'FINANCIAMENTO ARGO', category: 'Financiamento', plate: 'RNA8D85', amount: brl(1598.32), due: '2026-09-15', supplier: 'BANCO BRADESCO', paidAt: '2026-09-15' },
  { description: 'FINANCIAMENTO HB20', category: 'Financiamento', plate: 'GCQ0E23', amount: brl(1489.55), due: '2026-09-08', supplier: 'BANCO PAN', paidAt: '2026-09-08' },
  { description: 'SEGURO MOBI', category: 'Seguro', plate: 'RVA9F74', amount: brl(174), due: '2026-09-20', supplier: 'CARSYSTEM', paidAt: '2026-09-20' },
  { description: 'SEGURO FIAT ARGO', category: 'Seguro', plate: 'RNA8D85', amount: brl(198.91), due: '2026-09-05', supplier: 'CARSYSTEM', paidAt: '2026-09-05' },
  { description: 'IPVA 2026 - PARCELA 9', category: 'IPVA', amount: brl(1056.83), due: '2026-09-25', supplier: 'SEFAZ SP', paidAt: '2026-09-25' },
  { description: 'ALUGUEL DO PÁTIO', category: 'Outro', amount: brl(2200), due: '2026-09-10', supplier: 'IMOBILIÁRIA CENTRO', paidAt: '2026-09-10' },
  { description: 'HONORÁRIOS CONTÁBEIS', category: 'Outro', amount: brl(1007.84), due: '2026-09-05', supplier: 'CONTABILIDADE ALFA', paidAt: '2026-09-05' },
  // Agosto — primeiro mês de operação (a frota foi cadastrada em 11/08/2026).
  { description: 'FINANCIAMENTO FABIANA', category: 'Financiamento', plate: 'RVS9B58', amount: brl(1720.45), due: '2026-08-27', supplier: 'BANCO PAN', paidAt: '2026-08-27' },
  { description: 'FINANCIAMENTO FABIANA', category: 'Financiamento', plate: 'EBR7G53', amount: brl(1654.64), due: '2026-08-19', supplier: 'BANCO SANTANDER', paidAt: '2026-08-19' },
  { description: 'FINANCIAMENTO ARGO', category: 'Financiamento', plate: 'RNA8D85', amount: brl(1598.32), due: '2026-08-15', supplier: 'BANCO BRADESCO', paidAt: '2026-08-15' },
  { description: 'TARIFA BANCÁRIA', category: 'Outro', amount: brl(33.04), due: '2026-08-05', supplier: 'BANCO PAN', paidAt: '2026-08-05' },
];

/* -------------------------- Manutenções ---------------------------- */

interface SeedMaintenance {
  orderNumber: string;
  plate: string;
  type: 'CORRECTIVE' | 'PREVENTIVE' | 'WARRANTY';
  description: string;
  openedAt: string;
  performedAt: string;
  mileageKm: number | null;
  labor: number;
  items: Array<{ name: string; quantity: number; unitCost: number; supplier: string }>;
}

const MAINTENANCES: SeedMaintenance[] = [
  {
    orderNumber: 'WO-2026-0006',
    plate: 'EBR7G53',
    type: 'CORRECTIVE',
    description: 'TROCA DE ÓLEO E FILTRO DE ÓLEO',
    openedAt: '2026-09-05',
    performedAt: '2026-09-05',
    mileageKm: null,
    labor: 0,
    items: [{ name: 'OLEO E FILTRO DE OLEO', quantity: 1, unitCost: brl(211.5), supplier: 'ESTAÇÃO DO OLEO' }],
  },
  {
    orderNumber: 'WO-2026-0013',
    plate: 'EBR7G53',
    type: 'CORRECTIVE',
    description: 'TROCA DE DISCO DE FREIO E PASTILHA',
    // A referência registra abertura posterior à execução; preservamos o
    // dado histórico (ver docs/ASSUMPTIONS.md A-OS-01).
    openedAt: '2026-10-13',
    performedAt: '2026-10-12',
    mileageKm: 178209,
    labor: brl(250),
    items: [
      { name: 'DISCO DE FREIO E PASTILHA', quantity: 1, unitCost: brl(369.7), supplier: 'MERCADO CAR' },
    ],
  },
  {
    orderNumber: 'WO-2026-0011',
    plate: 'RNA8D85',
    type: 'PREVENTIVE',
    description: 'REVISÃO DE 110.000 KM',
    openedAt: '2026-10-08',
    performedAt: '2026-10-08',
    mileageKm: 117980,
    labor: brl(180),
    items: [
      { name: 'KIT DE REVISÃO', quantity: 1, unitCost: brl(226.9), supplier: 'AUTOPEÇAS BRASIL' },
      { name: 'FILTRO DE AR', quantity: 1, unitCost: brl(110), supplier: 'AUTOPEÇAS BRASIL' },
    ],
  },
  {
    orderNumber: 'WO-2026-0002',
    plate: 'RVS9B58',
    type: 'CORRECTIVE',
    description: 'TROCA DE AMORTECEDORES DIANTEIROS',
    openedAt: '2026-08-11',
    performedAt: '2026-08-11',
    mileageKm: 112400,
    labor: brl(220),
    items: [{ name: 'AMORTECEDOR DIANTEIRO', quantity: 2, unitCost: brl(238.5), supplier: 'MERCADO CAR' }],
  },
  {
    orderNumber: 'WO-2026-0004',
    plate: 'RVS9B58',
    type: 'PREVENTIVE',
    description: 'ALINHAMENTO E BALANCEAMENTO',
    openedAt: '2026-08-26',
    performedAt: '2026-08-26',
    mileageKm: 113800,
    labor: brl(120),
    items: [{ name: 'SERVIÇO DE GEOMETRIA', quantity: 1, unitCost: brl(0), supplier: 'MERCADO CAR' }],
  },
  {
    orderNumber: 'WO-2026-0007',
    plate: 'RVS9B58',
    type: 'CORRECTIVE',
    description: 'TROCA DE CORREIA DENTADA',
    openedAt: '2026-09-09',
    performedAt: '2026-09-09',
    mileageKm: 115100,
    labor: brl(260),
    items: [{ name: 'KIT CORREIA DENTADA', quantity: 1, unitCost: brl(398.16), supplier: 'AUTOPEÇAS BRASIL' }],
  },
  {
    orderNumber: 'WO-2026-0009',
    plate: 'RVS9B58',
    type: 'PREVENTIVE',
    description: 'TROCA DE ÓLEO E FILTROS',
    openedAt: '2026-09-15',
    performedAt: '2026-09-15',
    mileageKm: 115950,
    labor: brl(0),
    items: [{ name: 'OLEO E FILTROS', quantity: 1, unitCost: brl(416), supplier: 'ESTAÇÃO DO OLEO' }],
  },
  {
    orderNumber: 'WO-2026-0001',
    plate: 'SEB9B67',
    type: 'CORRECTIVE',
    description: 'REPARO NO SISTEMA DE ARREFECIMENTO',
    openedAt: '2026-08-14',
    performedAt: '2026-08-14',
    mileageKm: 160100,
    labor: brl(340),
    items: [{ name: 'RADIADOR', quantity: 1, unitCost: brl(412.4), supplier: 'MERCADO CAR' }],
  },
  {
    orderNumber: 'WO-2026-0003',
    plate: 'SEB9B67',
    type: 'CORRECTIVE',
    description: 'TROCA DE EMBREAGEM',
    openedAt: '2026-08-19',
    performedAt: '2026-08-19',
    mileageKm: 161850,
    labor: brl(480),
    items: [{ name: 'KIT EMBREAGEM', quantity: 1, unitCost: brl(1085.9), supplier: 'AUTOPEÇAS BRASIL' }],
  },
  {
    orderNumber: 'WO-2026-0005',
    plate: 'SEB9B67',
    type: 'PREVENTIVE',
    description: 'REVISÃO DE 160.000 KM',
    openedAt: '2026-08-28',
    performedAt: '2026-08-28',
    mileageKm: 162600,
    labor: brl(210),
    items: [{ name: 'KIT DE REVISÃO', quantity: 1, unitCost: brl(318.25), supplier: 'AUTOPEÇAS BRASIL' }],
  },
  {
    orderNumber: 'WO-2026-0008',
    plate: 'SEB9B67',
    type: 'CORRECTIVE',
    description: 'TROCA DE BATERIA',
    openedAt: '2026-09-10',
    performedAt: '2026-09-10',
    mileageKm: 164050,
    labor: brl(0),
    items: [{ name: 'BATERIA 60AH', quantity: 1, unitCost: brl(540.9), supplier: 'MERCADO CAR' }],
  },
  {
    orderNumber: 'WO-2026-0010',
    plate: 'SEB9B67',
    type: 'PREVENTIVE',
    description: 'TROCA DE PNEUS DIANTEIROS',
    openedAt: '2026-09-24',
    performedAt: '2026-09-24',
    mileageKm: 165200,
    labor: brl(60),
    items: [{ name: 'PNEU 175/70 R14', quantity: 2, unitCost: brl(200.05), supplier: 'MERCADO CAR' }],
  },
  {
    orderNumber: 'WO-2026-0012',
    plate: 'SEB9B67',
    type: 'CORRECTIVE',
    description: 'REPARO NA SUSPENSÃO TRASEIRA',
    openedAt: '2026-10-20',
    performedAt: '2026-10-20',
    mileageKm: 166500,
    labor: brl(390),
    items: [{ name: 'KIT SUSPENSÃO TRASEIRA', quantity: 1, unitCost: brl(1358.16), supplier: 'AUTOPEÇAS BRASIL' }],
  },
];

/** Recebimentos históricos (antes de novembro) por contrato e data. */
const HISTORIC_RECEIPTS: Array<{ date: string; rental: string; amount: number }> = [];
function pushHistoric(month: string, rows: Array<[string, string, number]>) {
  for (const [day, rental, amount] of rows) {
    HISTORIC_RECEIPTS.push({ date: `${month}-${day}`, rental, amount });
  }
}
// Março–Maio: operação equilibrada (lucro ≈ 0 no gráfico anual).
pushHistoric('2026-03', [
  ['10', 'LOC-2026-001', brl(700)],
  ['12', 'LOC-2026-002', brl(650)],
  ['18', 'LOC-2026-004', brl(750)],
  ['24', 'LOC-2026-006', brl(800)],
]);
pushHistoric('2026-04', [
  ['06', 'LOC-2026-001', brl(700)],
  ['13', 'LOC-2026-005', brl(650)],
  ['20', 'LOC-2026-007', brl(700)],
  ['27', 'LOC-2026-002', brl(650)],
]);
pushHistoric('2026-05', [
  ['04', 'LOC-2026-004', brl(750)],
  ['11', 'LOC-2026-006', brl(800)],
  ['18', 'LOC-2026-005', brl(650)],
  ['25', 'LOC-2026-007', brl(824)],
]);
// Agosto: receita 8.637,00
pushHistoric('2026-08', [
  ['03', 'LOC-2026-001', brl(1000)],
  ['07', 'LOC-2026-002', brl(1300)],
  ['11', 'LOC-2026-004', brl(1500)],
  ['17', 'LOC-2026-005', brl(1300)],
  ['21', 'LOC-2026-006', brl(1600)],
  ['25', 'LOC-2026-007', brl(1937)],
]);
// Setembro: receita 12.800,00
pushHistoric('2026-09', [
  ['03', 'LOC-2026-001', brl(2000)],
  ['08', 'LOC-2026-002', brl(1950)],
  ['12', 'LOC-2026-004', brl(2250)],
  ['17', 'LOC-2026-005', brl(1950)],
  ['22', 'LOC-2026-006', brl(2400)],
  ['28', 'LOC-2026-007', brl(2250)],
]);
// Outubro: receita 15.703,00
pushHistoric('2026-10', [
  ['02', 'LOC-2026-001', brl(2500)],
  ['06', 'LOC-2026-002', brl(2600)],
  ['09', 'LOC-2026-004', brl(3000)],
  ['14', 'LOC-2026-005', brl(2600)],
  ['19', 'LOC-2026-006', brl(2400)],
  ['23', 'LOC-2026-007', brl(2603)],
]);

/* ------------------------------------------------------------------ */

async function wipe(ctx: AppContext) {
  const c = ctx.mongo.collections;
  await Promise.all([
    c.organizations.deleteMany({}),
    c.users.deleteMany({}),
    c.memberships.deleteMany({}),
    c.invitations.deleteMany({}),
    c.sessions.deleteMany({}),
    c.files.deleteMany({}),
    c.vehicles.deleteMany({}),
    c.drivers.deleteMany({}),
    c.rentals.deleteMany({}),
    c.maintenanceOrders.deleteMany({}),
    c.inspectionPhotoSlots.deleteMany({}),
    c.inspections.deleteMany({}),
    c.bankAccounts.deleteMany({}),
    c.bankTransactions.deleteMany({}),
    c.expenseCategories.deleteMany({}),
    c.payables.deleteMany({}),
    c.receivables.deleteMany({}),
    c.payments.deleteMany({}),
    c.notifications.deleteMany({}),
    c.messageTemplates.deleteMany({}),
    c.messageDispatches.deleteMany({}),
    c.subscriptions.deleteMany({}),
    c.billingInvoices.deleteMany({}),
    c.auditLogs.deleteMany({}),
    c.counters.deleteMany({}),
    c.importDrafts.deleteMany({}),
    ctx.mongo.db.collection('fileBlobs').deleteMany({}),
    c.whatsappMessages.deleteMany({}),
    c.integrationInbox.deleteMany({}),
    c.integrationNonces.deleteMany({}),
    c.integrationCursors.deleteMany({}),
    c.jobLeases.deleteMany({}),
    c.messagingRates.deleteMany({}),
    c.unmatchedMedia.deleteMany({}),
    c.loginAttempts.deleteMany({}),
  ]);
}

export async function seed(ctx: AppContext): Promise<void> {
  const now = new Date();
  const env = ctx.env;
  await wipe(ctx);

  /* --------------------------- organização ------------------------- */
  const organizationId = new ObjectId();
  await ctx.mongo.collections.organizations.insertOne({
    _id: organizationId,
    name: ORG_NAME,
    legalId: ORG_LEGAL_ID,
    timezone: 'America/Sao_Paulo',
    currency: 'BRL',
    settings: { freeSeats: 3, extraSeatPriceCents: 990 },
    createdAt: now,
    updatedAt: now,
  });

  const ownerId = new ObjectId();
  await ctx.mongo.collections.users.insertOne({
    _id: ownerId,
    name: 'Erik',
    emailLower: env.SEED_OWNER_EMAIL.toLowerCase(),
    passwordHash: await hashPassword(env.SEED_OWNER_PASSWORD),
    phone: '11968740000',
    status: 'ACTIVE',
    browserNotificationsEnabled: true,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.mongo.collections.memberships.insertOne({
    _id: new ObjectId(),
    organizationId,
    userId: ownerId,
    role: 'OWNER',
    permissions: fullMatrix(),
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  });

  /* Usuário de teste: ADMIN com acesso total, para QA manual. */
  const testUserId = new ObjectId();
  await ctx.mongo.collections.users.insertOne({
    _id: testUserId,
    name: 'Usuário de Teste',
    emailLower: TEST_USER_EMAIL,
    passwordHash: await hashPassword(TEST_USER_PASSWORD),
    phone: '11900000000',
    status: 'ACTIVE',
    browserNotificationsEnabled: false,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.mongo.collections.memberships.insertOne({
    _id: new ObjectId(),
    organizationId,
    userId: testUserId,
    role: 'ADMIN',
    permissions: fullMatrix(),
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  });

  /* ------------------------------ frota ---------------------------- */
  const vehicleIds = new Map<string, ObjectId>();
  // Datas decrescentes: a listagem ordena por cadastro mais recente e
  // assim reproduz a ordem da referência (EBR7G53 primeiro).
  const vehicleBase = new Date('2026-08-11T12:00:00.000Z').getTime();
  for (const [index, v] of VEHICLES.entries()) {
    const _id = new ObjectId();
    const createdAt = new Date(vehicleBase - index * 60_000);
    vehicleIds.set(v.plate, _id);
    const doc: VehicleDoc = {
      _id,
      organizationId,
      plate: v.plate,
      renavam: v.renavam,
      vin: v.vin,
      brand: v.brand,
      model: v.model,
      brandLower: v.brand.toLowerCase(),
      modelLower: v.model.toLowerCase(),
      year: v.year,
      color: v.color,
      colorLower: v.color.toLowerCase(),
      mileageKm: v.mileageKm,
      registration: { state: 'SP', city: 'São Paulo' },
      purchase: { date: '2026-08-11', amountCents: v.purchaseAmount },
      photoFileIds: [],
      status: v.archived ? 'INACTIVE' : 'AVAILABLE',
      archivedAt: v.archived ? new Date('2026-10-30T12:00:00.000Z') : null,
      createdBy: ownerId,
      createdAt,
      updatedAt: now,
      version: 1,
    };
    await ctx.mongo.collections.vehicles.insertOne(doc);
  }

  /* --------------------------- motoristas -------------------------- */
  const driverIds = new Map<string, ObjectId>();
  for (const d of DRIVERS) {
    const _id = new ObjectId();
    driverIds.set(d.key, _id);
    const doc: DriverDoc = {
      _id,
      organizationId,
      fullName: d.fullName,
      fullNameFold: foldAccents(d.fullName).toLowerCase(),
      cpfEncrypted: ctx.pii.encrypt(d.cpf),
      cpfLookupHash: lookupHash(d.cpf, piiPepper(env)),
      cpfLast3: d.cpf.slice(-3),
      rgEncrypted: ctx.pii.encrypt(d.rg),
      birthDate: d.birthDate,
      emailLower: d.email,
      phone: d.phone,
      cnh: { number: d.cnhNumber, category: d.cnhCategory, expiresAt: d.cnhExpiresAt },
      address: {
        postalCode: d.postalCode,
        street: d.street,
        number: d.number,
        complement: null,
        district: d.district,
        city: d.city,
        state: d.state,
      },
      idDocumentFileId: null,
      addressProofFileId: null,
      status: 'ACTIVE',
      archivedAt: null,
      createdBy: ownerId,
      createdAt: new Date('2026-08-11T12:00:00.000Z'),
      updatedAt: now,
      version: 1,
    };
    await ctx.mongo.collections.drivers.insertOne(doc);
  }

  /* -------------------------- conta bancária ------------------------ */
  const bankAccountId = new ObjectId();
  const bankAccount: BankAccountDoc = {
    _id: bankAccountId,
    organizationId,
    name: 'Conta Principal',
    institution: null,
    type: 'CHECKING',
    // Saldo de abertura calibrado para que o extrato de novembro inicie
    // em R$ 7.802,58, como na referência (ver ASSUMPTIONS A-SEED-01).
    initialBalanceCents: brl(3938.56),
    initialBalanceDate: '2026-09-03',
    isDefault: true,
    active: true,
    archivedAt: null,
    createdAt: new Date('2026-09-03T12:00:00.000Z'),
    updatedAt: now,
  };
  await ctx.mongo.collections.bankAccounts.insertOne(bankAccount);

  /* ---------------------------- categorias ------------------------- */
  await ensureDefaultCategories(ctx, organizationId);
  const categories = await ctx.mongo.collections.expenseCategories.find({ organizationId }).toArray();
  const categoryByLabel = new Map(categories.map((c: ExpenseCategoryDoc) => [c.label, c._id]));

  /* ----------------------------- locações -------------------------- */
  const rentalIds = new Map<string, ObjectId>();
  for (const r of RENTALS) {
    const _id = new ObjectId();
    rentalIds.set(r.number, _id);
    const doc: RentalDoc = {
      _id,
      organizationId,
      rentalNumber: r.number,
      sequence: Number(r.number.slice(-3)),
      vehicleId: vehicleIds.get(r.plate)!,
      driverId: driverIds.get(r.driver)!,
      startDate: '2026-08-11',
      endDate: '2026-12-11',
      rentalType: 'WEEKLY',
      inspectionRule: { period: 'MONTHLY', weekday: 'ANY' },
      periodicAmountCents: r.weekly,
      depositCents: r.deposit,
      firstPeriodPrepaid: false,
      depositPrepaid: false,
      allowedKm: null,
      monthlyFranchiseKm: null,
      contractFileId: null,
      notes: null,
      status: 'ACTIVE',
      closedAt: null,
      history: [{ at: new Date('2026-08-11T12:00:00.000Z'), actorId: ownerId, action: 'created' }],
      createdBy: ownerId,
      createdAt: new Date('2026-08-11T12:00:00.000Z'),
      updatedAt: now,
      version: 1,
    };
    await ctx.mongo.collections.rentals.insertOne(doc);
    await ctx.mongo.collections.vehicles.updateOne(
      { _id: doc.vehicleId },
      { $set: { status: 'RENTED', updatedAt: now } },
    );
  }
  await ctx.mongo.collections.counters.insertOne({
    _id: `${organizationId.toHexString()}:rental:2026`,
    seq: 7,
  });

  /* -------------------------- contas a receber --------------------- */
  const receivableIds = new Map<string, ObjectId>();
  for (const r of RECEIVABLES) {
    const rentalId = rentalIds.get(r.rental)!;
    const rental = RENTALS.find((x) => x.number === r.rental)!;
    const _id = new ObjectId();
    receivableIds.set(r.rental, _id);
    const description = `Locação ${r.rental}`;
    const doc: ReceivableDoc = {
      _id,
      organizationId,
      description,
      descriptionFold: foldAccents(description).toLowerCase(),
      rentalId,
      driverId: driverIds.get(rental.driver)!,
      grossAmountCents: r.gross,
      paidAmountCents: 0,
      dueDate: r.due,
      paymentMethod: null,
      kind: 'RENT',
      installmentNo: null,
      expectedPeriod: 'CONTRACT',
      status: 'OPEN',
      createdBy: ownerId,
      createdAt: new Date('2026-08-11T12:00:00.000Z'),
      updatedAt: now,
      version: 1,
    };
    await ctx.mongo.collections.receivables.insertOne(doc);
  }

  /* --------------------------- recebimentos ------------------------ */
  const registerReceipt = async (date: string, rentalNumber: string, amount: number) => {
    const receivableId = receivableIds.get(rentalNumber);
    if (!receivableId) return;
    const transactionId = await postTransaction(ctx, {
      organizationId,
      bankAccountId,
      occurredAt: date,
      description: `Pagamento da locação - Contrato ${rentalNumber}`,
      direction: 'IN',
      amountCents: amount,
      originType: 'RECEIVABLE',
      originId: receivableId,
      dedupeKey: `seed-receipt:${rentalNumber}:${date}:${amount}:${Math.random().toString(36).slice(2, 8)}`,
      actorId: ownerId,
    });
    await ctx.mongo.collections.payments.insertOne({
      _id: new ObjectId(),
      organizationId,
      sourceType: 'RECEIVABLE',
      sourceId: receivableId,
      amountCents: amount,
      paidAt: date,
      method: 'CASH' as PaymentMethod,
      bankAccountId,
      transactionId,
      idempotencyKey: null,
      notes: null,
      createdBy: ownerId,
      createdAt: new Date(`${date}T12:00:00.000Z`),
      updatedAt: now,
    });
    await ctx.mongo.collections.receivables.updateOne(
      { _id: receivableId },
      { $inc: { paidAmountCents: amount }, $set: { paymentMethod: 'CASH', updatedAt: now } },
    );
  };

  for (const receipt of [...HISTORIC_RECEIPTS].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    await registerReceipt(receipt.date, receipt.rental, receipt.amount);
  }
  for (const receipt of NOVEMBER_RECEIPTS) {
    await registerReceipt(receipt.date, receipt.rental, receipt.amount);
  }

  /* --------- ajuste final: pendente idêntico ao da referência ------- */
  for (const r of RECEIVABLES) {
    const _id = receivableIds.get(r.rental)!;
    const target = r.gross - r.pending;
    const doc = await ctx.mongo.collections.receivables.findOne({ _id });
    if (!doc) continue;
    const delta = target - doc.paidAmountCents;
    if (delta > 0) {
      // Recebimentos anteriores ao período exibido (sem efeito no caixa
      // de setembro em diante, pois ocorrem antes da data do saldo inicial).
      await registerReceipt('2026-02-10', r.rental, delta);
    } else if (delta < 0) {
      await ctx.mongo.collections.receivables.updateOne({ _id }, { $inc: { paidAmountCents: delta } });
    }
  }

  /* --------------------------- contas a pagar ---------------------- */
  for (const p of PAYABLES) {
    const _id = new ObjectId();
    const doc: PayableDoc = {
      _id,
      organizationId,
      description: p.description,
      descriptionFold: foldAccents(p.description).toLowerCase(),
      categoryId: categoryByLabel.get(p.category) ?? null,
      vehicleId: p.plate ? (vehicleIds.get(p.plate) ?? null) : null,
      amountCents: p.amount,
      paidAmountCents: 0,
      dueDate: p.due,
      supplier: {
        name: p.supplier,
        nameFold: foldAccents(p.supplier).toLowerCase(),
        taxId: p.supplierTaxId ?? null,
      },
      documentUrl: null,
      recurring: p.recurring
        ? { enabled: true, seriesId: slugify(`${p.description}-${p.plate ?? 'geral'}`), period: p.due.slice(0, 7) }
        : { enabled: false, seriesId: null, period: null },
      notes: null,
      status: 'PENDING',
      createdBy: ownerId,
      createdAt: new Date(`${p.due}T12:00:00.000Z`),
      updatedAt: now,
      version: 1,
    };
    await ctx.mongo.collections.payables.insertOne(doc);

    if (p.paidAt) {
      const transactionId = await postTransaction(ctx, {
        organizationId,
        bankAccountId,
        occurredAt: p.paidAt,
        description: `Pagamento de conta a pagar - ${p.description}`,
        direction: 'OUT',
        amountCents: p.amount,
        originType: 'PAYABLE',
        originId: _id,
        dedupeKey: `seed-payable:${_id.toHexString()}`,
        actorId: ownerId,
      });
      await ctx.mongo.collections.payments.insertOne({
        _id: new ObjectId(),
        organizationId,
        sourceType: 'PAYABLE',
        sourceId: _id,
        amountCents: p.amount,
        paidAt: p.paidAt,
        method: 'CASH',
        bankAccountId,
        transactionId,
        idempotencyKey: null,
        notes: null,
        createdBy: ownerId,
        createdAt: new Date(`${p.paidAt}T12:00:00.000Z`),
        updatedAt: now,
      });
      await ctx.mongo.collections.payables.updateOne(
        { _id },
        { $set: { paidAmountCents: p.amount, status: 'PAID', updatedAt: now } },
      );
    } else {
      await ctx.mongo.collections.payables.updateOne(
        { _id },
        { $set: { status: derivePayableStatus(doc, TODAY) } },
      );
    }
  }

  /* ---------------------------- manutenções ------------------------ *
   * Cada OS concluída gera a saída bancária correspondente (mesma regra
   * da aplicação: o débito ocorre quando a manutenção é concluída).
   * ---------------------------------------------------------------- */
  for (const m of MAINTENANCES) {
    const items = m.items.map((item) => ({
      name: item.name,
      code: null,
      quantity: item.quantity,
      unitCostCents: item.unitCost,
      subtotalCents: item.quantity * item.unitCost,
      supplier: item.supplier,
      warrantyUntil: null,
      nextDueDate: null,
    }));
    const partsCostCents = items.reduce((a, i) => a + i.subtotalCents, 0);
    const doc: MaintenanceOrderDoc = {
      _id: new ObjectId(),
      organizationId,
      orderNumber: m.orderNumber,
      sequence: Number(m.orderNumber.slice(-4)),
      vehicleId: vehicleIds.get(m.plate)!,
      type: m.type,
      status: 'COMPLETED',
      description: m.description,
      openedAt: m.openedAt,
      scheduledAt: null,
      performedAt: m.performedAt,
      completedAt: m.performedAt,
      canceledAt: null,
      mileageKm: m.mileageKm,
      laborCostCents: m.labor,
      partsCostCents,
      totalCents: m.labor + partsCostCents,
      items,
      paymentMethod: 'CASH',
      bankAccountId,
      invoiceFileId: null,
      notes: null,
      ledgerTransactionId: null,
      createdBy: ownerId,
      createdAt: new Date(`${m.performedAt}T12:00:00.000Z`),
      updatedAt: now,
      version: 1,
    };
    if (doc.totalCents > 0) {
      doc.ledgerTransactionId = await postTransaction(ctx, {
        organizationId,
        bankAccountId,
        occurredAt: m.performedAt,
        description: `Manutenção ${m.orderNumber} - ${m.description}`.slice(0, 180),
        direction: 'OUT',
        amountCents: doc.totalCents,
        originType: 'MAINTENANCE',
        originId: doc._id,
        dedupeKey: `maintenance:${doc._id.toHexString()}`,
        actorId: ownerId,
      });
    }
    await ctx.mongo.collections.maintenanceOrders.insertOne(doc);
  }
  await ctx.mongo.collections.counters.insertOne({
    _id: `${organizationId.toHexString()}:maintenance:2026`,
    seq: 13,
  });

  /* ------------------------ slots de vistoria ---------------------- */
  await ctx.mongo.collections.inspectionPhotoSlots.insertMany(
    DEFAULT_PHOTO_SLOTS.map((slot, index) => ({
      _id: new ObjectId(),
      organizationId,
      code: slot.code,
      label: slot.label,
      order: index,
      active: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    })),
  );

  /* ---------------------------- vistorias -------------------------- */
  const inspectionSeeds = [
    { plate: 'EBR7G53', driver: 'driver-a', scheduledAt: '2026-10-28', status: 'APPROVED' as const, odometerKm: 181652 },
    { plate: 'EBR7G53', driver: 'driver-a', scheduledAt: '2026-10-27', status: 'CANCELED' as const, odometerKm: null },
    { plate: 'RNA8D85', driver: 'driver-b', scheduledAt: '2026-10-30', status: 'PENDING' as const, odometerKm: null },
    { plate: 'RVS9B58', driver: 'driver-c', scheduledAt: '2026-10-25', status: 'SUBMITTED' as const, odometerKm: 116100 },
  ];
  for (const i of inspectionSeeds) {
    await ctx.mongo.collections.inspections.insertOne({
      _id: new ObjectId(),
      organizationId,
      vehicleId: vehicleIds.get(i.plate)!,
      rentalId: null,
      driverId: driverIds.get(i.driver)!,
      responsibleName: DRIVERS.find((d) => d.key === i.driver)!.fullName,
      phone: DRIVERS.find((d) => d.key === i.driver)!.phone,
      email: DRIVERS.find((d) => d.key === i.driver)!.email,
      scheduledAt: i.scheduledAt,
      dueDate: addDaysIso(i.scheduledAt, 2),
      submittedAt: i.status === 'APPROVED' || i.status === 'SUBMITTED' ? new Date(`${i.scheduledAt}T15:00:00.000Z`) : null,
      reviewedAt: i.status === 'APPROVED' ? new Date(`${i.scheduledAt}T18:00:00.000Z`) : null,
      reviewerId: i.status === 'APPROVED' ? ownerId : null,
      status: i.status,
      odometerKm: i.odometerKm,
      photos: [],
      notes: null,
      requestTokenHash: null,
      requestExpiresAt: null,
      delivery: null,
      source: 'MANUAL',
      createdBy: ownerId,
      createdAt: new Date(`${i.scheduledAt}T12:00:00.000Z`),
      updatedAt: now,
    });
  }

  /* -------------------------- template padrão ---------------------- */
  await ensureDefaultTemplate(ctx, organizationId);

  /* ---------------------------- assinatura ------------------------- */
  await ctx.mongo.collections.subscriptions.insertOne({
    _id: new ObjectId(),
    organizationId,
    status: 'ACTIVE',
    planCode: 'ESSENCIAL_6_10',
    planLabel: '6 a 10 veículos',
    productLabel: 'Essencial',
    cycle: 'QUARTERLY',
    cycleMonths: 3,
    monthlyPriceCents: brl(151.91),
    discountPercent: 5,
    vehicleRange: { min: 6, max: 10 },
    periodStart: '2026-08-10',
    periodEnd: '2026-11-09',
    nextDueAt: '2026-11-10',
    providerName: null,
    providerCustomerId: null,
    providerSubscriptionId: null,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.mongo.collections.billingInvoices.insertMany([
    {
      _id: new ObjectId(),
      organizationId,
      description: `Assinatura YuDirect - ${ORG_NAME}`,
      amountCents: brl(455.73),
      status: 'OVERDUE',
      dueDate: '2026-11-07',
      paidAt: null,
      providerInvoiceId: null,
      paymentUrl: null,
      invoiceUrl: null,
      composition: [
        { label: 'Plano Essencial (6 a 10 veículos)', amountCents: brl(455.73) },
      ],
      createdAt: now,
      updatedAt: now,
    },
    {
      _id: new ObjectId(),
      organizationId,
      description: `Assinatura YuDirect - ${ORG_NAME}`,
      amountCents: brl(455.73),
      status: 'PAID',
      dueDate: '2026-08-10',
      paidAt: '2026-08-10',
      providerInvoiceId: null,
      paymentUrl: null,
      invoiceUrl: null,
      composition: [
        { label: 'Plano Essencial (6 a 10 veículos)', amountCents: brl(455.73) },
      ],
      createdAt: now,
      updatedAt: now,
    },
  ]);

  /* ------------------------- status derivados ---------------------- */
  const receivables = await ctx.mongo.collections.receivables.find({ organizationId }).toArray();
  for (const doc of receivables) {
    await ctx.mongo.collections.receivables.updateOne(
      { _id: doc._id },
      { $set: { status: deriveReceivableStatus(doc, TODAY) } },
    );
  }

  /* ---------------------------- alertas ---------------------------- */
  await runNotificationGenerators(ctx, organizationId, TODAY);
}

/** Motivos para NÃO apagar o banco (o seed começa com `wipe`). */
export function seedRisks(env: Pick<Env, 'NODE_ENV' | 'MONGODB_URI'>, usersCount: number): string[] {
  const risky: string[] = [];
  if (env.NODE_ENV === 'production') risky.push('NODE_ENV=production');
  if (/mongodb\.net|mongodb\+srv:/i.test(env.MONGODB_URI ?? '')) risky.push('URI de cluster remoto (Atlas)');
  if (usersCount > 0) risky.push(`o banco já tem ${usersCount} usuário(s)`);
  return risky;
}

async function main() {
  loadDotEnv();
  const env = loadEnv();
  if (!env.MONGODB_URI) {
    console.error(
      'Defina MONGODB_URI antes de rodar o seed (um MongoDB em memória seria descartado ao encerrar o processo).',
    );
    process.exit(1);
  }
  // O seed APAGA todas as coleções antes de popular. Recusa qualquer banco
  // que pareça real, a menos que a pessoa confirme explicitamente.
  const ctx = await buildContext({ env });
  const risky = seedRisks(env, await ctx.mongo.collections.users.countDocuments());
  if (risky.length > 0) {
    const confirmed = process.env.SEED_FORCE === '1' && process.env.SEED_CONFIRM === env.MONGODB_DB;
    if (!confirmed) {
      console.error(
        `Seed recusado: ${risky.join('; ')}.\n` +
          `Ele apagaria TODOS os dados do banco "${env.MONGODB_DB}". Para um ambiente novo e vazio use scripts/bootstrap.ts.\n` +
          `Se tiver certeza, rode com SEED_FORCE=1 SEED_CONFIRM=${env.MONGODB_DB}.`,
      );
      await ctx.mongo.close();
      process.exit(1);
    }
  }
  await seed(ctx);
  console.log('Seed concluído.');
  console.log(`  Organização : ${ORG_NAME}`);
  console.log(`  Usuário     : ${env.SEED_OWNER_EMAIL}`);
  console.log(`  Senha       : ${env.SEED_OWNER_PASSWORD}`);
  console.log(`  Teste       : ${TEST_USER_EMAIL} / ${TEST_USER_PASSWORD}`);
  await ctx.mongo.close();
  process.exit(0);
}

const invokedDirectly = /\/database\/seed\.(ts|js)$/.test(process.argv[1]?.replace(/\\/g, '/') ?? '');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
