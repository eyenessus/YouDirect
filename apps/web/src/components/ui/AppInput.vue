<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string | number | null | undefined;
    id?: string;
    type?: string;
    placeholder?: string;
    disabled?: boolean;
    readonly?: boolean;
    invalid?: boolean;
    describedBy?: string;
    autocomplete?: string;
    inputmode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url' | 'search';
    maxlength?: number;
    min?: string | number;
    max?: string | number;
    step?: string | number;
  }>(),
  { type: 'text', disabled: false, readonly: false, invalid: false },
);

const emit = defineEmits<{ 'update:modelValue': [string]; blur: [FocusEvent] }>();

const classes = computed(() => ['fo-control', props.invalid ? 'fo-control-invalid' : '']);
</script>

<template>
  <input
    :id="id"
    :class="classes"
    :type="type"
    :value="modelValue ?? ''"
    :placeholder="placeholder"
    :disabled="disabled"
    :readonly="readonly"
    :aria-invalid="invalid ? 'true' : undefined"
    :aria-describedby="describedBy"
    :autocomplete="autocomplete"
    :inputmode="inputmode"
    :maxlength="maxlength"
    :min="min"
    :max="max"
    :step="step"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    @blur="emit('blur', $event)"
  />
</template>
