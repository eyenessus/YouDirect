<script setup lang="ts">
import { computed } from 'vue';
import { formatSignedPercent } from '@yudirect/contracts';

const props = withDefaults(
  defineProps<{
    label: string;
    value: string;
    /** Variação percentual; `null` quando não há base de comparação. */
    deltaPercent?: number | null;
    deltaSuffix?: string;
    /** Texto livre sob o valor (ex.: "R$ 15.703,00 em out"). */
    footnote?: string;
    icon?: unknown;
    iconTone?: 'blue' | 'green' | 'purple' | 'amber';
    /** Pílula de variação ao lado do rótulo (dashboard financeiro). */
    pill?: boolean;
    valueTone?: 'default' | 'positive' | 'negative';
    invertDelta?: boolean;
    /** `points` escreve "pp" (pontos percentuais) em vez de "%". */
    deltaUnit?: 'percent' | 'points';
  }>(),
  {
    deltaSuffix: 'do mês passado',
    iconTone: 'blue',
    pill: false,
    valueTone: 'default',
    invertDelta: false,
    deltaUnit: 'percent',
  },
);

const iconTones = {
  blue: 'bg-brand-50 text-brand-600',
  green: 'bg-[rgb(var(--c-positive)/0.12)] text-[rgb(var(--c-positive))]',
  purple: 'bg-[rgb(167_139_250/0.14)] text-[rgb(139_92_246)]',
  amber: 'bg-[rgb(var(--c-warning)/0.12)] text-[rgb(var(--c-warning))]',
} as const;

const hasDelta = computed(() => props.deltaPercent !== undefined && props.deltaPercent !== null);
/** Para despesas, uma queda é positiva — daí `invertDelta`. */
const good = computed(() => {
  if (!hasDelta.value) return true;
  const up = (props.deltaPercent as number) >= 0;
  return props.invertDelta ? !up : up;
});
const deltaText = computed(() => {
  const digits = props.pill ? 1 : 0;
  const text = formatSignedPercent(props.deltaPercent, digits);
  return props.deltaUnit === 'points' ? text.replace('%', ' pp') : text;
});

const pillClass = computed(() =>
  good.value
    ? 'bg-[rgb(var(--c-positive)/0.12)] text-[rgb(var(--c-positive))]'
    : 'bg-[rgb(var(--c-negative)/0.12)] text-[rgb(var(--c-negative))]',
);
const valueClass = computed(() => ({
  default: 'text-ink',
  positive: 'text-[rgb(var(--c-positive))]',
  negative: 'text-[rgb(var(--c-negative))]',
}[props.valueTone]));
</script>

<template>
  <div class="fo-card p-6">
    <div class="flex items-start justify-between gap-3">
      <p class="text-[15px] text-ink-soft">{{ label }}</p>
      <span
        v-if="pill && hasDelta"
        class="rounded-full px-2.5 py-1 text-xs font-semibold leading-none"
        :class="pillClass"
      >
        {{ deltaText }}
      </span>
      <div
        v-else-if="icon"
        class="flex size-9 items-center justify-center rounded-lg"
        :class="iconTones[iconTone]"
      >
        <component :is="icon" class="size-[18px]" aria-hidden="true" />
      </div>
    </div>

    <p class="mt-3 text-[32px] font-bold leading-tight tabular" :class="valueClass">{{ value }}</p>

    <p v-if="footnote" class="mt-2 text-sm text-ink-muted">{{ footnote }}</p>
    <p v-else-if="hasDelta && !pill" class="mt-2 text-sm text-ink-muted">
      {{ deltaText }} {{ deltaSuffix }}
    </p>
    <p v-else-if="deltaPercent === null" class="mt-2 text-sm text-ink-muted">
      Sem base de comparação
    </p>
    <slot />
  </div>
</template>
