import {
  Bell,
  CalendarDays,
  ClipboardCheck,
  ScrollText,
  DollarSign,
  Gauge,
  LayoutGrid,
  UserCog,
  Users,
  Car,
  ReceiptText,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-vue-next';
import type { PermissionModule } from '@yudirect/contracts';

export interface NavChild {
  label: string;
  to: string;
  icon?: unknown;
}

export interface NavItem {
  key: string;
  label: string;
  icon: unknown;
  to?: string;
  module?: PermissionModule;
  ownerOnly?: boolean;
  children?: NavChild[];
}

/**
 * Ordem e rótulos exatamente como na navegação lateral da referência
 * (págs. 8, 34, 41, 44, 60 e 66).
 */
export const navigation: NavItem[] = [
  { key: 'dashboard', label: 'Painel', icon: LayoutGrid, to: '/dashboard', module: 'dashboard' },
  {
    key: 'notifications',
    label: 'Notificações',
    icon: Bell,
    module: 'notifications',
    children: [
      { label: 'Alertas', to: '/dashboard/notifications' },
      { label: 'Disparo de Mensagens', to: '/dashboard/dispatch' },
      { label: 'Mensagens WhatsApp', to: '/dashboard/messages' },
    ],
  },
  {
    key: 'vehicles',
    label: 'Veículos',
    icon: Car,
    module: 'vehicles',
    children: [
      { label: 'Consultar', to: '/dashboard/vehicles' },
      { label: 'Cadastrar', to: '/dashboard/vehicles/new' },
      { label: 'Vencimentos', to: '/dashboard/vehicles/due' },
      { label: 'Importar', to: '/dashboard/vehicles/import' },
    ],
  },
  {
    key: 'maintenance',
    label: 'Manutenções',
    icon: Gauge,
    to: '/dashboard/maintenance',
    module: 'maintenance',
  },
  {
    key: 'inspections',
    label: 'Vistorias',
    icon: ClipboardCheck,
    module: 'inspections',
    children: [
      { label: 'Acompanhar', to: '/dashboard/inspections' },
      { label: 'Configurações', to: '/dashboard/inspections/settings' },
    ],
  },
  {
    key: 'drivers',
    label: 'Motoristas',
    icon: Users,
    module: 'drivers',
    children: [
      { label: 'Consultar', to: '/dashboard/drivers' },
      { label: 'Cadastrar', to: '/dashboard/drivers/new' },
    ],
  },
  {
    key: 'credit',
    label: 'Análise de crédito',
    icon: ShieldCheck,
    to: '/dashboard/credit-checks',
    module: 'credit',
  },
  {
    key: 'rentals',
    label: 'Locações',
    icon: CalendarDays,
    module: 'rentals',
    children: [
      { label: 'Consultar', to: '/dashboard/rentals' },
      { label: 'Cadastrar', to: '/dashboard/rentals/new' },
      { label: 'Pedidos do site', to: '/dashboard/leads' },
    ],
  },
  {
    key: 'fines',
    label: 'Multas',
    icon: ReceiptText,
    module: 'fines',
    children: [
      { label: 'Consultar', to: '/dashboard/fines' },
      { label: 'Cadastrar', to: '/dashboard/fines/new' },
    ],
  },
  {
    key: 'claims',
    label: 'Sinistros',
    icon: ShieldAlert,
    module: 'claims',
    children: [
      { label: 'Consultar', to: '/dashboard/claims' },
      { label: 'Registrar', to: '/dashboard/claims/new' },
    ],
  },
  {
    key: 'finance',
    label: 'Financeiro',
    icon: DollarSign,
    module: 'finance',
    children: [
      { label: 'Dashboard', to: '/dashboard/finance' },
      { label: 'Contas bancárias', to: '/dashboard/finance/bank-accounts' },
      { label: 'Contas a Receber', to: '/dashboard/finance/accounts-receivable' },
      { label: 'Contas a Pagar', to: '/dashboard/finance/accounts-payable' },
      { label: 'Relatório por Veículo', to: '/dashboard/finance/reports/by-vehicle' },
      { label: 'Relatório por Cliente', to: '/dashboard/finance/reports/by-client' },
      { label: 'DRE Mensal', to: '/dashboard/finance/reports/dre' },
    ],
  },
  {
    key: 'employees',
    label: 'Colaboradores',
    icon: UserCog,
    to: '/dashboard/employees',
    ownerOnly: true,
  },
  {
    key: 'audit',
    label: 'Auditoria',
    icon: ScrollText,
    to: '/dashboard/audit',
    ownerOnly: true,
  },
];
