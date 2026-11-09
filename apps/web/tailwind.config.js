/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        /* Tokens mapeados para CSS variables — ver src/styles/tokens.css.
           Os valores são aproximações amostradas das capturas; alterá-los
           em um único lugar recalibra toda a interface. */
        brand: {
          50: 'rgb(var(--c-brand-50) / <alpha-value>)',
          100: 'rgb(var(--c-brand-100) / <alpha-value>)',
          200: 'rgb(var(--c-brand-200) / <alpha-value>)',
          400: 'rgb(var(--c-brand-400) / <alpha-value>)',
          500: 'rgb(var(--c-brand-500) / <alpha-value>)',
          600: 'rgb(var(--c-brand-600) / <alpha-value>)',
          700: 'rgb(var(--c-brand-700) / <alpha-value>)',
          900: 'rgb(var(--c-brand-900) / <alpha-value>)',
        },
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        'surface-muted': 'rgb(var(--c-surface-muted) / <alpha-value>)',
        canvas: 'rgb(var(--c-canvas) / <alpha-value>)',
        line: 'rgb(var(--c-line) / <alpha-value>)',
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        'ink-soft': 'rgb(var(--c-ink-soft) / <alpha-value>)',
        'ink-muted': 'rgb(var(--c-ink-muted) / <alpha-value>)',
        positive: 'rgb(var(--c-positive) / <alpha-value>)',
        negative: 'rgb(var(--c-negative) / <alpha-value>)',
        warning: 'rgb(var(--c-warning) / <alpha-value>)',
        sidebar: 'rgb(var(--c-sidebar) / <alpha-value>)',
        'sidebar-active': 'rgb(var(--c-sidebar-active) / <alpha-value>)',
        'sidebar-hover': 'rgb(var(--c-sidebar-hover) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['InterVariable', 'Inter', 'Roboto', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        card: '10px',
        control: '8px',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgb(15 23 42 / 0.04)',
        pop: '0 10px 30px -10px rgb(15 23 42 / 0.25), 0 2px 8px -2px rgb(15 23 42 / 0.1)',
      },
      spacing: {
        sidebar: '260px',
        'sidebar-collapsed': '82px',
        topbar: '72px',
      },
    },
  },
  plugins: [],
};
