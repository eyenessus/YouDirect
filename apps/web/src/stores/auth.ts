import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  can,
  hasModule,
  type MeResponse,
  type PermissionAction,
  type PermissionModule,
} from '@yudirect/contracts';
import { api } from '@/lib/api';

export const useAuthStore = defineStore('auth', () => {
  const me = ref<MeResponse | null>(null);
  const loading = ref(false);
  const loaded = ref(false);

  const user = computed(() => me.value?.user ?? null);
  const organization = computed(() => me.value?.organization ?? null);
  const isAuthenticated = computed(() => me.value !== null);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      me.value = await api.get<MeResponse>('/auth/me');
    } catch {
      me.value = null;
    } finally {
      loading.value = false;
      loaded.value = true;
    }
  }

  async function login(email: string, password: string, captchaToken?: string | null): Promise<void> {
    await api.post('/auth/login', { email, password, ...(captchaToken ? { captchaToken } : {}) });
    await load();
  }

  async function logout(): Promise<void> {
    try {
      await api.post('/auth/logout');
    } finally {
      me.value = null;
    }
  }

  function clear() {
    me.value = null;
  }

  /** Permissão granular (módulo + ação) — espelha a checagem do backend. */
  function allows(mod: PermissionModule, action: PermissionAction = 'read'): boolean {
    const org = me.value?.organization;
    if (!org) return false;
    return can(org.role, org.permissions, mod, action);
  }

  function hasAccess(mod: PermissionModule): boolean {
    const org = me.value?.organization;
    if (!org) return false;
    return hasModule(org.role, org.permissions, mod);
  }

  const isOwnerOrAdmin = computed(
    () => me.value?.organization.role === 'OWNER' || me.value?.organization.role === 'ADMIN',
  );

  return {
    me,
    user,
    organization,
    loading,
    loaded,
    isAuthenticated,
    isOwnerOrAdmin,
    load,
    login,
    logout,
    clear,
    allows,
    hasAccess,
  };
});
