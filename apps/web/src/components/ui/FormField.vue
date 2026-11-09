<script setup lang="ts">
import { computed, useId } from 'vue';

const props = withDefaults(
  defineProps<{
    label?: string;
    hint?: string;
    error?: string;
    required?: boolean;
    for?: string;
  }>(),
  { required: false },
);

const generated = useId();
const controlId = computed(() => props.for ?? `field-${generated}`);
const describedBy = computed(() =>
  props.error ? `${controlId.value}-error` : props.hint ? `${controlId.value}-hint` : undefined,
);
</script>

<template>
  <div>
    <label v-if="label" :for="controlId" class="fo-label">
      {{ label }}<span v-if="required" aria-hidden="true"> *</span>
      <span v-if="required" class="sr-only">(obrigatório)</span>
    </label>
    <slot :id="controlId" :described-by="describedBy" :invalid="Boolean(error)" />
    <p v-if="error" :id="`${controlId}-error`" class="mt-1.5 text-xs text-negative" role="alert">
      {{ error }}
    </p>
    <p v-else-if="hint" :id="`${controlId}-hint`" class="fo-hint">{{ hint }}</p>
  </div>
</template>
