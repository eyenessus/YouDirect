<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string | null | undefined;
    id?: string;
    placeholder?: string;
    rows?: number;
    disabled?: boolean;
    invalid?: boolean;
    describedBy?: string;
    maxlength?: number;
  }>(),
  { rows: 4, disabled: false, invalid: false },
);

const emit = defineEmits<{ 'update:modelValue': [string] }>();
const classes = computed(() => ['fo-control', props.invalid ? 'fo-control-invalid' : '']);
</script>

<template>
  <textarea
    :id="id"
    :class="classes"
    :rows="rows"
    :value="modelValue ?? ''"
    :placeholder="placeholder"
    :disabled="disabled"
    :maxlength="maxlength"
    :aria-invalid="invalid ? 'true' : undefined"
    :aria-describedby="describedBy"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
</template>
