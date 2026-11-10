import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import type { PermissionModule } from '@yudirect/contracts';
import { useAuthStore } from '@/stores/auth';

declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean;
    module?: PermissionModule;
    ownerOnly?: boolean;
    title?: string;
  }
}

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/dashboard' },

  /* ----------------------------- públicas -------------------------- */
  {
    path: '/login',
    name: 'login',
    component: () => import('@/features/auth/LoginPage.vue'),
    meta: { public: true, title: 'Entrar' },
  },
  {
    path: '/esqueci-a-senha',
    name: 'forgot-password',
    component: () => import('@/features/auth/ForgotPasswordPage.vue'),
    meta: { public: true, title: 'Esqueci a senha' },
  },
  {
    path: '/redefinir-senha/:token',
    name: 'reset-password',
    component: () => import('@/features/auth/ResetPasswordPage.vue'),
    meta: { public: true, title: 'Nova senha' },
  },
  {
    path: '/convite/:token',
    name: 'invite',
    component: () => import('@/features/auth/AcceptInvitePage.vue'),
    meta: { public: true, title: 'Convite' },
  },
  {
    path: '/vistoria/:token',
    name: 'public-inspection',
    component: () => import('@/features/inspections/PublicInspectionPage.vue'),
    meta: { public: true, title: 'Vistoria' },
  },

  /* ------------------------------ shell ---------------------------- */
  {
    path: '/dashboard',
    component: () => import('@/components/layout/AppShell.vue'),
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('@/features/dashboard/DashboardPage.vue'),
        meta: { module: 'dashboard', title: 'Dashboard' },
      },

      {
        path: 'notifications',
        name: 'notifications',
        component: () => import('@/features/notifications/NotificationsPage.vue'),
        meta: { module: 'notifications', title: 'Notificações' },
      },
      {
        path: 'dispatch',
        name: 'dispatch',
        component: () => import('@/features/notifications/DispatchPage.vue'),
        meta: { module: 'notifications', title: 'Disparo de Mensagens' },
      },
      {
        path: 'messages',
        name: 'messages',
        component: () => import('@/features/messaging/MessagesPage.vue'),
        meta: { module: 'notifications', title: 'Mensagens WhatsApp' },
      },

      {
        path: 'vehicles',
        name: 'vehicles',
        component: () => import('@/features/vehicles/VehicleListPage.vue'),
        meta: { module: 'vehicles', title: 'Consulta de Veículos' },
      },
      {
        path: 'vehicles/new',
        name: 'vehicle-new',
        component: () => import('@/features/vehicles/VehicleFormPage.vue'),
        meta: { module: 'vehicles', title: 'Novo Veículo' },
      },
      {
        path: 'vehicles/import',
        name: 'vehicle-import',
        component: () => import('@/features/vehicles/VehicleImportPage.vue'),
        meta: { module: 'vehicles', title: 'Importar Veículos' },
      },
      {
        path: 'vehicles/:id',
        name: 'vehicle-detail',
        component: () => import('@/features/vehicles/VehicleDetailPage.vue'),
        meta: { module: 'vehicles', title: 'Detalhes do Veículo' },
      },
      {
        path: 'vehicles/:id/edit',
        name: 'vehicle-edit',
        component: () => import('@/features/vehicles/VehicleFormPage.vue'),
        meta: { module: 'vehicles', title: 'Editar Veículo' },
      },

      {
        path: 'drivers',
        name: 'drivers',
        component: () => import('@/features/drivers/DriverListPage.vue'),
        meta: { module: 'drivers', title: 'Consulta de Motoristas' },
      },
      {
        path: 'drivers/new',
        name: 'driver-new',
        component: () => import('@/features/drivers/DriverFormPage.vue'),
        meta: { module: 'drivers', title: 'Novo Motorista' },
      },
      {
        path: 'drivers/:id',
        name: 'driver-detail',
        component: () => import('@/features/drivers/DriverDetailPage.vue'),
        meta: { module: 'drivers', title: 'Detalhes do Motorista' },
      },
      {
        path: 'drivers/:id/edit',
        name: 'driver-edit',
        component: () => import('@/features/drivers/DriverFormPage.vue'),
        meta: { module: 'drivers', title: 'Editar Motorista' },
      },

      {
        path: 'rentals',
        name: 'rentals',
        component: () => import('@/features/rentals/RentalListPage.vue'),
        meta: { module: 'rentals', title: 'Consulta de Locações' },
      },
      {
        path: 'rentals/new',
        name: 'rental-new',
        component: () => import('@/features/rentals/RentalFormPage.vue'),
        meta: { module: 'rentals', title: 'Nova Locação' },
      },
      {
        path: 'rentals/:id/edit',
        name: 'rental-edit',
        component: () => import('@/features/rentals/RentalFormPage.vue'),
        meta: { module: 'rentals', title: 'Editar Locação' },
      },

      {
        path: 'maintenance',
        name: 'maintenance',
        component: () => import('@/features/maintenance/MaintenanceVehiclesPage.vue'),
        meta: { module: 'maintenance', title: 'Manutenções' },
      },
      {
        path: 'maintenance/:vehicleId',
        name: 'maintenance-history',
        component: () => import('@/features/maintenance/MaintenanceHistoryPage.vue'),
        meta: { module: 'maintenance', title: 'Histórico de Manutenções' },
      },
      {
        path: 'maintenance/:vehicleId/new',
        name: 'maintenance-new',
        component: () => import('@/features/maintenance/MaintenanceWizardPage.vue'),
        meta: { module: 'maintenance', title: 'Nova Manutenção' },
      },
      {
        path: 'maintenance/:vehicleId/:orderId/edit',
        name: 'maintenance-edit',
        component: () => import('@/features/maintenance/MaintenanceWizardPage.vue'),
        meta: { module: 'maintenance', title: 'Editar Manutenção' },
      },

      {
        path: 'inspections',
        name: 'inspections',
        component: () => import('@/features/inspections/InspectionVehiclesPage.vue'),
        meta: { module: 'inspections', title: 'Vistorias' },
      },
      {
        path: 'inspections/settings',
        name: 'inspection-settings',
        component: () => import('@/features/inspections/InspectionSettingsPage.vue'),
        meta: { module: 'inspections', title: 'Configuração de fotos' },
      },
      {
        path: 'inspections/:vehicleId',
        name: 'inspection-history',
        component: () => import('@/features/inspections/InspectionHistoryPage.vue'),
        meta: { module: 'inspections', title: 'Histórico de Vistorias' },
      },

      {
        path: 'finance',
        name: 'finance',
        component: () => import('@/features/finance/FinanceDashboardPage.vue'),
        meta: { module: 'finance', title: 'Dashboard Financeiro' },
      },
      {
        path: 'finance/bank-accounts',
        name: 'bank-accounts',
        component: () => import('@/features/finance/BankAccountsPage.vue'),
        meta: { module: 'finance', title: 'Contas bancárias' },
      },
      {
        path: 'finance/bank-accounts/:id',
        name: 'bank-statement',
        component: () => import('@/features/finance/BankStatementPage.vue'),
        meta: { module: 'finance', title: 'Extrato' },
      },
      {
        path: 'finance/accounts-receivable',
        name: 'receivables',
        component: () => import('@/features/finance/ReceivablesPage.vue'),
        meta: { module: 'finance', title: 'Contas a Receber' },
      },
      {
        path: 'finance/accounts-payable',
        name: 'payables',
        component: () => import('@/features/finance/PayablesPage.vue'),
        meta: { module: 'finance', title: 'Contas a Pagar' },
      },
      {
        path: 'finance/accounts-payable/new',
        name: 'payable-new',
        component: () => import('@/features/finance/PayableFormPage.vue'),
        meta: { module: 'finance', title: 'Nova Conta a Pagar' },
      },
      {
        path: 'finance/accounts-payable/:id/edit',
        name: 'payable-edit',
        component: () => import('@/features/finance/PayableFormPage.vue'),
        meta: { module: 'finance', title: 'Editar Conta a Pagar' },
      },
      {
        path: 'finance/reports/by-vehicle',
        name: 'report-by-vehicle',
        component: () => import('@/features/finance/VehicleReportPage.vue'),
        meta: { module: 'finance', title: 'Relatório por veículo' },
      },
      {
        path: 'finance/reports/by-client',
        name: 'report-by-client',
        component: () => import('@/features/finance/ClientReportPage.vue'),
        meta: { module: 'finance', title: 'Relatório por Cliente' },
      },
      {
        path: 'finance/reports/dre',
        name: 'report-dre',
        component: () => import('@/features/finance/DrePage.vue'),
        meta: { module: 'finance', title: 'DRE Mensal' },
      },

      {
        path: 'employees',
        name: 'employees',
        component: () => import('@/features/organization/EmployeesPage.vue'),
        meta: { ownerOnly: true, title: 'Colaboradores' },
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('@/features/organization/AuditPage.vue'),
        meta: { ownerOnly: true, title: 'Auditoria' },
      },
      {
        path: 'profile',
        name: 'profile',
        component: () => import('@/features/organization/ProfilePage.vue'),
        meta: { title: 'Meu Perfil' },
      },
      {
        path: 'subscription',
        name: 'subscription',
        component: () => import('@/features/organization/SubscriptionPage.vue'),
        meta: { title: 'Assinatura' },
      },
    ],
  },

  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/features/shared/NotFoundPage.vue'),
    meta: { public: true, title: 'Página não encontrada' },
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, from, saved) {
    if (saved) return saved;
    if (to.path === from.path) return;
    return { top: 0 };
  },
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.loaded) await auth.load();

  if (to.meta.public) {
    if (to.name === 'login' && auth.isAuthenticated) return { name: 'dashboard' };
    return true;
  }

  if (!auth.isAuthenticated) {
    return { name: 'login', query: to.fullPath !== '/dashboard' ? { redirect: to.fullPath } : undefined };
  }

  if (to.meta.ownerOnly && !auth.isOwnerOrAdmin) return { name: 'dashboard' };
  if (to.meta.module && !auth.hasAccess(to.meta.module)) return { name: 'dashboard' };

  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · YuDirect` : 'YuDirect';
});
