<script setup lang="ts">
import { computed } from 'vue';
import { Loader2 } from 'lucide-vue-next';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline' | 'link';
type Size = 'sm' | 'md' | 'lg';

const props = withDefaults(
  defineProps<{
    variant?: Variant;
    size?: Size;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    loading?: boolean;
    block?: boolean;
  }>(),
  { variant: 'primary', size: 'md', type: 'button', disabled: false, loading: false, block: false },
);

const emit = defineEmits<{ click: [MouseEvent] }>();

const variants: Record<Variant, string> = {
  primary:
    'bg-brand-500 text-white hover:bg-brand-600 active:bg-brand-700 border border-transparent shadow-sm',
  secondary:
    'bg-surface text-ink border border-line hover:bg-surface-muted active:bg-surface-muted',
  ghost: 'bg-transparent text-ink-soft border border-transparent hover:bg-surface-muted',
  danger: 'bg-negative text-white hover:brightness-110 border border-transparent shadow-sm',
  'danger-outline': 'bg-transparent text-negative border border-negative/60 hover:bg-negative/10',
  link: 'bg-transparent text-brand-600 border border-transparent hover:underline px-0',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5',
  md: 'h-[42px] px-4 text-[15px] gap-2',
  lg: 'h-12 px-6 text-base gap-2',
};

const classes = computed(() => [
  'inline-flex items-center justify-center rounded-control font-medium transition-colors select-none',
  'disabled:cursor-not-allowed disabled:opacity-55',
  variants[props.variant],
  props.variant === 'link' ? '' : sizes[props.size],
  props.block ? 'w-full' : '',
]);
</script>

<template>
  <button
    :type="type"
    :class="classes"
    :disabled="disabled || loading"
    :aria-busy="loading ? 'true' : undefined"
    @click="emit('click', $event)"
  >
    <Loader2 v-if="loading" class="size-4 animate-spin" aria-hidden="true" />
    <slot v-else name="icon" />
    <slot />
  </button>
</template>
