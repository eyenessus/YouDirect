<script setup lang="ts">
export interface WizardStep {
  key: string;
  label: string;
}

withDefaults(
  defineProps<{ steps: WizardStep[]; current: number; clickableUpTo?: number }>(),
  { clickableUpTo: 0 },
);

const emit = defineEmits<{ select: [number] }>();
</script>

<template>
  <div class="grid gap-2 rounded-card bg-surface-muted p-1.5 sm:grid-cols-3" role="tablist">
    <button
      v-for="(step, index) in steps"
      :key="step.key"
      type="button"
      role="tab"
      :aria-selected="current === index"
      :disabled="index > clickableUpTo"
      class="rounded-[8px] px-4 py-3 text-center text-[15px] transition-colors disabled:cursor-not-allowed"
      :class="
        current === index
          ? 'bg-surface font-semibold text-ink shadow-card'
          : index <= clickableUpTo
            ? 'text-ink-soft hover:text-ink'
            : 'text-ink-muted'
      "
      @click="index <= clickableUpTo && emit('select', index)"
    >
      {{ index + 1 }}. {{ step.label }}
    </button>
  </div>
</template>
