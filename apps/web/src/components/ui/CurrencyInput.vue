<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { formatCentsPlain } from '@yudirect/contracts';

/**
 * Campo monetário pt-BR. O valor trafega SEMPRE em centavos inteiros;
 * a máscara é apenas de apresentação e nunca altera o que é enviado.
 */
const props = withDefaults(
  defineProps<{
    modelValue: number;
    id?: string;
    disabled?: boolean;
    invalid?: boolean;
    describedBy?: string;
    placeholder?: string;
  }>(),
  { disabled: false, invalid: false, placeholder: 'R$ 0,00' },
);

const emit = defineEmits<{ 'update:modelValue': [number] }>();

const display = ref(props.modelValue ? `R$ ${formatCentsPlain(props.modelValue)}` : '');

watch(
  () => props.modelValue,
  (cents) => {
    const next = cents ? `R$ ${formatCentsPlain(cents)}` : '';
    if (next !== display.value) display.value = next;
  },
);

function onInput(event: Event) {
  const digits = (event.target as HTMLInputElement).value.replace(/\D/g, '');
  const cents = digits === '' ? 0 : Number(digits.slice(0, 15));
  display.value = cents ? `R$ ${formatCentsPlain(cents)}` : '';
  emit('update:modelValue', cents);
}

const classes = computed(() => ['fo-control tabular', props.invalid ? 'fo-control-invalid' : '']);
</script>

<template>
  <input
    :id="id"
    type="text"
    inputmode="numeric"
    :class="classes"
    :value="display"
    :placeholder="placeholder"
    :disabled="disabled"
    :aria-invalid="invalid ? 'true' : undefined"
    :aria-describedby="describedBy"
    @input="onInput"
  />
</template>
