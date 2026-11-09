import { computed } from 'vue';
import { useThemeStore } from '@/stores/ui';

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!value) return fallback;
  return value.includes(' ') ? `rgb(${value})` : value;
}

/**
 * Cores dos gráficos derivadas dos mesmos tokens da interface, de modo
 * que claro/escuro permaneçam coerentes.
 */
export function useChartTheme() {
  const theme = useThemeStore();

  return computed(() => {
    // Dependência explícita para recalcular ao trocar de tema.
    void theme.mode;
    return {
      grid: cssVar('--chart-grid', '#e2e8f0'),
      axis: cssVar('--c-ink-muted', '#64748b'),
      ink: cssVar('--c-ink', '#111827'),
      surface: cssVar('--c-surface', '#ffffff'),
      tooltipBg: cssVar('--chart-tooltip-bg', '#ffffff'),
      tooltipInk: cssVar('--chart-tooltip-ink', '#111827'),
      brand: cssVar('--c-brand-500', '#3b82f6'),
      brandSoft: cssVar('--c-brand-200', '#bfdbfe'),
      positive: cssVar('--c-positive', '#10b981'),
      negative: cssVar('--c-negative', '#dc2626'),
      neutral: theme.isDark ? '#64748b' : '#9ca3af',
    };
  });
}

/** Aplica transparência a uma cor "rgb(r g b)" dos tokens. */
export function withAlpha(color: string, alpha: number): string {
  const match = /rgb\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(color);
  if (!match) return color;
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

export function compactBRL(cents: number): string {
  const value = cents / 100;
  const abs = Math.abs(value);
  if (abs >= 1000) {
    const k = value / 1000;
    const text = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(k);
    return `R$ ${text}k`;
  }
  return `R$ ${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value)}`;
}

export function axisBRL(cents: number): string {
  const value = cents / 100;
  if (Math.abs(value) >= 1000) {
    return `R$${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value / 1000)}k`;
  }
  return `R$${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value)}`;
}
