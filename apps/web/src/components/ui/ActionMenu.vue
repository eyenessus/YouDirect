<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue';
import { MoreVertical } from 'lucide-vue-next';

export interface ActionItem {
  key: string;
  label: string;
  icon?: unknown;
  danger?: boolean;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{ items: ActionItem[]; label?: string; align?: 'left' | 'right' }>(),
  { label: 'Ações', align: 'right' },
);

const emit = defineEmits<{ select: [string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const menu = ref<HTMLElement | null>(null);
/** Abre para cima quando não há espaço abaixo (menus no fim da tabela). */
const dropUp = ref(false);

function onDocumentClick(event: MouseEvent) {
  if (!root.value?.contains(event.target as Node)) open.value = false;
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    open.value = false;
    root.value?.querySelector('button')?.focus();
  }
}

async function toggle() {
  open.value = !open.value;
  if (open.value) {
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeydown);
    await nextTick();
    const rect = root.value?.getBoundingClientRect();
    const height = menu.value?.offsetHeight ?? 0;
    dropUp.value = Boolean(rect && rect.bottom + height + 16 > window.innerHeight);
    menu.value?.querySelector<HTMLElement>('button')?.focus();
  } else {
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onKeydown);
  }
}

function select(item: ActionItem) {
  if (item.disabled) return;
  open.value = false;
  emit('select', item.key);
}

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div ref="root" class="relative inline-block text-left">
    <button
      type="button"
      class="flex size-9 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
      :aria-label="props.label"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click.stop="toggle"
    >
      <MoreVertical class="size-5" />
    </button>

    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="scale-95 opacity-0"
      leave-active-class="transition duration-75 ease-in"
      leave-to-class="scale-95 opacity-0"
    >
      <div
        v-if="open"
        ref="menu"
        role="menu"
        class="absolute z-30 min-w-[196px] overflow-hidden rounded-card border border-line bg-surface py-1.5 shadow-pop"
        :class="[align === 'right' ? 'right-0' : 'left-0', dropUp ? 'bottom-full mb-1' : 'top-full mt-1']"
      >
        <button
          v-for="item in items"
          :key="item.key"
          type="button"
          role="menuitem"
          class="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-[15px] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          :class="
            item.danger
              ? 'text-negative hover:bg-[rgb(var(--c-negative)/0.08)]'
              : 'text-ink hover:bg-surface-muted'
          "
          :disabled="item.disabled"
          @click.stop="select(item)"
        >
          <component :is="item.icon" v-if="item.icon" class="size-4 shrink-0" />
          {{ item.label }}
        </button>
      </div>
    </Transition>
  </div>
</template>
