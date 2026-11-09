<script setup lang="ts">
export interface TabItem {
  key: string;
  label: string;
  badge?: string | number;
}

withDefaults(
  defineProps<{ modelValue: string; items: TabItem[]; variant?: 'pill' | 'segment' }>(),
  { variant: 'segment' },
);

const emit = defineEmits<{ 'update:modelValue': [string] }>();
</script>

<template>
  <div
    class="inline-flex items-center gap-1 rounded-control p-1"
    :class="variant === 'segment' ? 'bg-surface-muted' : ''"
    role="tablist"
  >
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      role="tab"
      :aria-selected="modelValue === item.key"
      class="inline-flex items-center gap-2 rounded-[6px] px-4 py-2 text-[15px] transition-colors"
      :class="
        modelValue === item.key
          ? variant === 'segment'
            ? 'bg-surface font-semibold text-ink shadow-card'
            : 'bg-brand-500 font-semibold text-white'
          : 'text-ink-soft hover:text-ink'
      "
      @click="emit('update:modelValue', item.key)"
    >
      {{ item.label }}
      <span
        v-if="item.badge !== undefined"
        class="rounded-full bg-brand-50 px-1.5 text-xs font-semibold text-brand-700"
      >
        {{ item.badge }}
      </span>
    </button>
  </div>
</template>
