<script setup lang="ts">
import { useId } from 'vue';

withDefaults(
  defineProps<{
    modelValue: boolean;
    label?: string;
    description?: string;
    disabled?: boolean;
    boxed?: boolean;
  }>(),
  { disabled: false, boxed: false },
);

const emit = defineEmits<{ 'update:modelValue': [boolean] }>();
const id = `cb-${useId()}`;
</script>

<template>
  <div :class="boxed ? 'rounded-card border border-line bg-surface p-4' : ''">
    <div class="flex items-start gap-3">
      <input
        :id="id"
        type="checkbox"
        class="mt-0.5 size-[18px] shrink-0 cursor-pointer rounded border-line text-brand-500
               accent-[rgb(var(--c-brand-500))] disabled:cursor-not-allowed"
        :checked="modelValue"
        :disabled="disabled"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
      <div class="min-w-0">
        <label
          :for="id"
          class="cursor-pointer text-[15px] text-ink"
          :class="disabled ? 'cursor-not-allowed opacity-60' : ''"
        >
          {{ label }}<slot />
        </label>
        <p v-if="description" class="mt-1 text-[13px] leading-relaxed text-ink-muted">
          {{ description }}
        </p>
      </div>
    </div>
  </div>
</template>
