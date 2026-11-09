<script setup lang="ts">
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from 'lucide-vue-next';
import { useToastStore } from '@/stores/ui';

const toasts = useToastStore();

const icons = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
} as const;

const tones = {
  success: 'text-[rgb(var(--c-positive))]',
  error: 'text-[rgb(var(--c-negative))]',
  warning: 'text-[rgb(var(--c-warning))]',
  info: 'text-brand-500',
} as const;
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
    role="status"
    aria-live="polite"
  >
    <TransitionGroup
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="translate-y-1 opacity-0"
    >
      <div
        v-for="toast in toasts.items"
        :key="toast.id"
        class="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card border border-line bg-surface p-4 shadow-pop"
      >
        <component :is="icons[toast.type]" class="mt-0.5 size-5 shrink-0" :class="tones[toast.type]" />
        <div class="min-w-0 flex-1">
          <p class="text-[15px] font-semibold text-ink">{{ toast.title }}</p>
          <p v-if="toast.description" class="mt-1 text-sm leading-relaxed text-ink-muted">
            {{ toast.description }}
          </p>
        </div>
        <button
          type="button"
          class="rounded p-1 text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
          aria-label="Fechar aviso"
          @click="toasts.dismiss(toast.id)"
        >
          <X class="size-4" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
