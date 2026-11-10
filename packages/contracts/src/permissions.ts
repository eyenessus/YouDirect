import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Matriz de permissões — espelha exatamente o modal "Adicionar
 * colaborador" (pág. 12): Dashboard, Veículos, Motoristas, Locações,
 * Vistorias, Manutenções, Financeiro e Notificações, nesta ordem.
 * Cada módulo (exceto Dashboard, que só tem leitura no modal) expõe o
 * sub-item "Ações" com as ações granulares.
 * ------------------------------------------------------------------ */

export const permissionModules = [
  'dashboard',
  'vehicles',
  'drivers',
  'rentals',
  'inspections',
  'maintenance',
  'fines',
  'finance',
  'notifications',
] as const;
export const permissionModuleSchema = z.enum(permissionModules);
export type PermissionModule = (typeof permissionModules)[number];

export const permissionActions = [
  'read',
  'create',
  'update',
  'delete',
  'export',
  'pay',
  'dispatch',
  'request',
  'review',
] as const;
export const permissionActionSchema = z.enum(permissionActions);
export type PermissionAction = (typeof permissionActions)[number];

export const permissionModuleLabels: Record<PermissionModule, string> = {
  dashboard: 'Dashboard',
  vehicles: 'Veículos',
  drivers: 'Motoristas',
  rentals: 'Locações',
  inspections: 'Vistorias',
  maintenance: 'Manutenções',
  fines: 'Multas',
  finance: 'Financeiro',
  notifications: 'Notificações',
};

export const permissionActionLabels: Record<PermissionAction, string> = {
  read: 'Visualizar',
  create: 'Cadastrar',
  update: 'Editar',
  delete: 'Excluir',
  export: 'Exportar',
  pay: 'Registrar pagamento',
  dispatch: 'Disparar mensagens',
  request: 'Solicitar',
  review: 'Aprovar/Reprovar',
};

/** Ações disponíveis por módulo (o que o sub-menu "Ações" lista). */
export const moduleActions: Record<PermissionModule, readonly PermissionAction[]> = {
  dashboard: ['read'],
  vehicles: ['read', 'create', 'update', 'delete', 'export'],
  drivers: ['read', 'create', 'update', 'delete', 'export'],
  rentals: ['read', 'create', 'update', 'delete'],
  inspections: ['read', 'request', 'review', 'update', 'delete'],
  maintenance: ['read', 'create', 'update', 'delete', 'export'],
  /** `pay` = cobrar a multa do motorista (gera conta a receber). */
  fines: ['read', 'create', 'update', 'delete', 'pay', 'export'],
  finance: ['read', 'create', 'update', 'delete', 'pay', 'export'],
  notifications: ['read', 'update', 'dispatch'],
};

export type PermissionMatrix = Partial<Record<PermissionModule, PermissionAction[]>>;

export const permissionMatrixSchema = z
  .record(permissionModuleSchema, z.array(permissionActionSchema))
  .superRefine((matrix, ctx) => {
    for (const [mod, actions] of Object.entries(matrix) as [PermissionModule, PermissionAction[]][]) {
      const allowed = moduleActions[mod];
      for (const action of actions) {
        if (!allowed.includes(action)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Ação "${action}" não existe no módulo "${mod}"`,
            path: [mod],
          });
        }
      }
    }
  });

export function emptyMatrix(): PermissionMatrix {
  return {};
}

export function fullMatrix(): PermissionMatrix {
  const out: PermissionMatrix = {};
  for (const mod of permissionModules) out[mod] = [...moduleActions[mod]];
  return out;
}

/** OWNER/ADMIN têm acesso total; MEMBER usa a matriz salva no membership. */
export function can(
  role: 'OWNER' | 'ADMIN' | 'MEMBER',
  matrix: PermissionMatrix | null | undefined,
  mod: PermissionModule,
  action: PermissionAction,
): boolean {
  if (role === 'OWNER' || role === 'ADMIN') return true;
  const actions = matrix?.[mod];
  if (!actions || actions.length === 0) return false;
  if (action === 'read') return true; // módulo marcado implica leitura
  return actions.includes(action);
}

export function hasModule(
  role: 'OWNER' | 'ADMIN' | 'MEMBER',
  matrix: PermissionMatrix | null | undefined,
  mod: PermissionModule,
): boolean {
  if (role === 'OWNER' || role === 'ADMIN') return true;
  const actions = matrix?.[mod];
  return Boolean(actions && actions.length > 0);
}
