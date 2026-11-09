<script setup lang="ts">
import { computed } from 'vue';

export type BadgeTone = 'blue' | 'green' | 'red' | 'amber' | 'slate';

const props = withDefaults(
  defineProps<{ label: string; tone?: BadgeTone; solid?: boolean }>(),
  { tone: 'slate', solid: true },
);

/* Tons observados: azul (Locado/Pago/Cancelada), verde (Ativo/Concluída/
   Aprovada/Em dia), vermelho (Vencida/Crítico), âmbar (atenção). */
const solidTones: Record<BadgeTone, string> = {
  blue: 'bg-brand-500 text-white',
  green: 'bg-[rgb(var(--c-positive-solid))] text-white',
  red: 'bg-[rgb(var(--c-negative-solid))] text-white',
  amber: 'bg-[rgb(var(--c-warning-solid))] text-white',
  slate: 'bg-surface-muted text-ink-soft border border-line',
};

const softTones: Record<BadgeTone, string> = {
  blue: 'bg-brand-50 text-brand-700 border border-brand-100',
  green: 'bg-[rgb(var(--c-positive)/0.12)] text-[rgb(var(--c-positive))] border border-[rgb(var(--c-positive)/0.25)]',
  red: 'bg-[rgb(var(--c-negative)/0.12)] text-[rgb(var(--c-negative))] border border-[rgb(var(--c-negative)/0.25)]',
  amber: 'bg-[rgb(var(--c-warning)/0.12)] text-[rgb(var(--c-warning))] border border-[rgb(var(--c-warning)/0.25)]',
  slate: 'bg-surface-muted text-ink-soft border border-line',
};

const classes = computed(() => (props.solid ? solidTones[props.tone] : softTones[props.tone]));
</script>

<template>
  <span
    class="inline-flex items-center whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold leading-none"
    :class="classes"
  >
    {{ label }}
  </span>
</template>
