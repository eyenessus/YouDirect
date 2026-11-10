import { reactive } from 'vue';
import type { PortalMe, PortalRental } from '@yudirect/contracts';
import { api, ApiRequestError } from '@/lib/api';
import { router } from '@/router';

/**
 * Estado da Área do Motorista (uma instância por aba). Um 401 em qualquer
 * chamada leva à página "sem acesso" — nunca ao login da equipe.
 */
const state = reactive({
  me: null as PortalMe | null,
  rentals: [] as PortalRental[],
  loaded: false,
});

export async function portalGet<T>(path: string): Promise<T> {
  try {
    return await api.get<T>(path);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) void router.replace('/motorista/sem-acesso');
    throw err;
  }
}

export async function portalPost<T>(path: string, body?: unknown): Promise<T> {
  try {
    return await api.post<T>(path, body);
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) void router.replace('/motorista/sem-acesso');
    throw err;
  }
}

export function usePortal() {
  async function load(force = false) {
    if (state.loaded && !force) return;
    const [me, rentals] = await Promise.all([
      portalGet<PortalMe>('/driver/me'),
      portalGet<{ data: PortalRental[] }>('/driver/rentals'),
    ]);
    state.me = me;
    state.rentals = rentals.data;
    state.loaded = true;
  }
  function reset() {
    state.me = null;
    state.rentals = [];
    state.loaded = false;
  }
  return { state, load, reset };
}

/** Link de WhatsApp para um telefone brasileiro (só dígitos). */
export function whatsappLink(phone: string | null | undefined, text = ''): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D+/g, '');
  const full = digits.length <= 11 ? `55${digits}` : digits;
  return `https://wa.me/${full}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
