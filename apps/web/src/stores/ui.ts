import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';

export type ThemeMode = 'light' | 'dark';

const THEME_KEY = 'frotaone:theme';
const SIDEBAR_KEY = 'frotaone:sidebar-collapsed';

function readStored<T extends string>(key: string, allowed: readonly T[]): T | null {
  try {
    const value = localStorage.getItem(key);
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

export const useThemeStore = defineStore('theme', () => {
  const stored = readStored<ThemeMode>(THEME_KEY, ['light', 'dark']);
  const prefersDark =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const mode = ref<ThemeMode>(stored ?? (prefersDark ? 'dark' : 'light'));
  const followsSystem = ref(stored === null);

  function apply() {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', mode.value);
    document.documentElement.style.colorScheme = mode.value;
  }

  function set(next: ThemeMode, persist = true) {
    mode.value = next;
    followsSystem.value = !persist;
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* armazenamento indisponível: o tema vale apenas para esta aba */
      }
    }
    apply();
  }

  function toggle() {
    set(mode.value === 'dark' ? 'light' : 'dark');
  }

  apply();

  if (typeof window !== 'undefined' && window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
      if (followsSystem.value) {
        mode.value = event.matches ? 'dark' : 'light';
        apply();
      }
    });
  }

  const isDark = computed(() => mode.value === 'dark');
  return { mode, isDark, followsSystem, set, toggle };
});

export const useSidebarStore = defineStore('sidebar', () => {
  const collapsed = ref(readStored(SIDEBAR_KEY, ['true', 'false']) === 'true');
  /** Drawer para telas pequenas (<1024px). */
  const mobileOpen = ref(false);
  const openGroups = ref<Set<string>>(new Set());

  watch(collapsed, (value) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(value));
    } catch {
      /* ignore */
    }
  });

  function toggle() {
    collapsed.value = !collapsed.value;
    if (collapsed.value) openGroups.value = new Set();
  }

  function toggleGroup(key: string) {
    const next = new Set(openGroups.value);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    openGroups.value = next;
  }

  function openGroup(key: string) {
    if (openGroups.value.has(key)) return;
    const next = new Set(openGroups.value);
    next.add(key);
    openGroups.value = next;
  }

  return { collapsed, mobileOpen, openGroups, toggle, toggleGroup, openGroup };
});

export interface Toast {
  id: number;
  type: 'success' | 'error' | 'info' | 'warning';
  title: string;
  description?: string;
  timeout: number;
}

let toastSeq = 0;

export const useToastStore = defineStore('toast', () => {
  const items = ref<Toast[]>([]);

  function push(toast: Omit<Toast, 'id' | 'timeout'> & { timeout?: number }) {
    const id = ++toastSeq;
    const entry: Toast = { id, timeout: toast.timeout ?? 5000, ...toast };
    items.value = [...items.value, entry];
    if (entry.timeout > 0) {
      setTimeout(() => dismiss(id), entry.timeout);
    }
    return id;
  }

  function dismiss(id: number) {
    items.value = items.value.filter((t) => t.id !== id);
  }

  const success = (title: string, description?: string) => push({ type: 'success', title, description });
  const error = (title: string, description?: string) =>
    push({ type: 'error', title, description, timeout: 8000 });
  const info = (title: string, description?: string) => push({ type: 'info', title, description });
  const warning = (title: string, description?: string) =>
    push({ type: 'warning', title, description, timeout: 7000 });

  return { items, push, dismiss, success, error, info, warning };
});
