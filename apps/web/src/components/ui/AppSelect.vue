<script setup lang="ts">
import { computed } from 'vue';
import { ChevronDown } from 'lucide-vue-next';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: string | null | undefined;
    options: SelectOption[];
    id?: string;
    placeholder?: string;
    disabled?: boolean;
    invalid?: boolean;
    describedBy?: string;
  }>(),
  { disabled: false, invalid: false },
);

const emit = defineEmits<{ 'update:modelValue': [string] }>();

const classes = computed(() => [
  'fo-control appearance-none pr-10 cursor-pointer',
  props.invalid ? 'fo-control-invalid' : '',
]);
</script>

<template>
  <div class="relative">
    <select
      :id="id"
      :class="classes"
      :value="modelValue ?? ''"
      :disabled="disabled"
      :aria-invalid="invalid ? 'true' : undefined"
      :aria-describedby="describedBy"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-if="placeholder" value="" :disabled="!placeholder">{{ placeholder }}</option>
      <option v-for="option in options" :key="option.value" :value="option.value" :disabled="option.disabled">
        {{ option.label }}
      </option>
    </select>
    <ChevronDown
      class="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
      aria-hidden="true"
    />
  </div>
</template>
