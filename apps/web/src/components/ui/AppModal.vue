<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { X } from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string;
    size?: 'sm' | 'md' | 'lg';
    closeOnOverlay?: boolean;
  }>(),
  { size: 'md', closeOnOverlay: true },
);

const emit = defineEmits<{ close: [] }>();

const panel = ref<HTMLElement | null>(null);
const sizes = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' } as const;

function onKeydown(event: KeyboardEvent) {
  if (!props.open) return;
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
    return;
  }
  if (event.key !== 'Tab' || !panel.value) return;
  // Mantém o foco dentro do modal (acessibilidade).
  const focusables = panel.value.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => props.open,
  async (open) => {
    if (typeof document === 'undefined') return;
    document.body.style.overflow = open ? 'hidden' : '';
    if (open) {
      document.addEventListener('keydown', onKeydown, true);
      await nextTick();
      panel.value?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    } else {
      document.removeEventListener('keydown', onKeydown, true);
    }
  },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <div v-if="open" class="fixed inset-0 z-50 overflow-y-auto">
        <div
          class="fixed inset-0 bg-[rgb(var(--overlay)/0.65)] backdrop-blur-[1px]"
          aria-hidden="true"
          @click="closeOnOverlay && emit('close')"
        />
        <div class="relative flex min-h-full items-center justify-center p-4">
          <div
            ref="panel"
            role="dialog"
            aria-modal="true"
            :aria-label="title"
            class="w-full rounded-card border border-line bg-surface shadow-pop"
            :class="sizes[size]"
          >
            <div class="flex items-start justify-between gap-4 px-6 pt-6">
              <div class="min-w-0">
                <h2 class="text-xl font-bold text-ink">{{ title }}</h2>
                <p v-if="description" class="mt-1 text-sm leading-relaxed text-ink-muted">
                  {{ description }}
                </p>
              </div>
              <button
                type="button"
                class="-mr-1 -mt-1 rounded p-1.5 text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
                aria-label="Fechar"
                @click="emit('close')"
              >
                <X class="size-5" />
              </button>
            </div>
            <div class="px-6 py-5">
              <slot />
            </div>
            <div v-if="$slots.footer" class="flex flex-wrap justify-end gap-3 px-6 pb-6">
              <slot name="footer" />
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
