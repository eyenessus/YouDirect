import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { MeResponse } from '@yudirect/contracts';
import { useAuthStore } from '@/stores/auth';
import { navigation } from '@/components/layout/navigation';

function me(overrides: Partial<MeResponse['organization']>): MeResponse {
  return {
    user: {
      id: 'u1',
      name: 'Erik',
      email: 'erik@exemplo.test',
      phone: null,
      initials: 'E',
      browserNotificationsEnabled: false,
    },
    organization: {
      id: 'o1',
      name: 'FF Veículos',
      legalId: null,
      role: 'MEMBER',
      permissions: {},
      ...overrides,
    },
    organizations: [{ id: 'o1', name: 'FF Veículos', role: 'MEMBER' }],
  };
}

/** T02 — a interface esconde o que o backend também recusaria. */
describe('permissões no cliente', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('nega tudo sem sessão carregada', () => {
    const auth = useAuthStore();
    expect(auth.isAuthenticated).toBe(false);
    expect(auth.allows('vehicles', 'read')).toBe(false);
    expect(auth.hasAccess('finance')).toBe(false);
  });

  it('OWNER tem acesso total sem depender da matriz salva', () => {
    const auth = useAuthStore();
    auth.me = me({ role: 'OWNER', permissions: {} });
    expect(auth.allows('finance', 'delete')).toBe(true);
    expect(auth.hasAccess('maintenance')).toBe(true);
    expect(auth.isOwnerOrAdmin).toBe(true);
  });

  it('MEMBER respeita a matriz por módulo e ação', () => {
    const auth = useAuthStore();
    auth.me = me({
      role: 'MEMBER',
      permissions: { vehicles: ['read', 'update'], maintenance: ['read'] },
    });
    expect(auth.allows('vehicles', 'read')).toBe(true);
    expect(auth.allows('vehicles', 'update')).toBe(true);
    expect(auth.allows('vehicles', 'delete')).toBe(false);
    expect(auth.allows('maintenance', 'create')).toBe(false);
    expect(auth.hasAccess('finance')).toBe(false);
    expect(auth.isOwnerOrAdmin).toBe(false);
  });

  it('a navegação visível reflete os módulos liberados', () => {
    const auth = useAuthStore();
    auth.me = me({ role: 'MEMBER', permissions: { vehicles: ['read'], drivers: ['read'] } });

    const visible = navigation
      .filter((item) => (item.ownerOnly ? auth.isOwnerOrAdmin : item.module ? auth.hasAccess(item.module) : true))
      .map((item) => item.label);

    expect(visible).toEqual(['Veículos', 'Motoristas']);
    expect(visible).not.toContain('Financeiro');
    expect(visible).not.toContain('Manutenções');
    expect(visible).not.toContain('Colaboradores');
  });

  it('limpa a sessão ao sair', () => {
    const auth = useAuthStore();
    auth.me = me({ role: 'OWNER' });
    auth.clear();
    expect(auth.isAuthenticated).toBe(false);
  });
});
