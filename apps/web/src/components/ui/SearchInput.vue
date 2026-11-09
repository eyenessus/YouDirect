<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { Search } from 'lucide-vue-next';

const props = withDefaults(
  defineProps<{ modelValue: string; placeholder?: string; debounce?: number; label?: string }>(),
  { placeholder: 'Buscar…', debounce: 300 },
);

const emit = defineEmits<{ 'update:modelValue': [string]; search: [string] }>();

const local = ref(props.modelValue);
let timer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => props.modelValue,
  (value) => {
    if (value !== local.value) local.value = value;
  },
);

function onInput(event: Event) {
  local.value = (event.target as HTMLInputElement).value;
  emit('update:modelValue', local.value);
  clearTimeout(timer);
  timer = setTimeout(() => emit('search', local.value), props.debounce);
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div class="relative">
    <Search class="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-ink-muted" />
    <input
      type="search"
      class="fo-control pl-11"
      :value="local"
      :placeholder="placeholder"
      :aria-label="label ?? placeholder"
      @input="onInput"
      @keydown.enter="emit('search', local)"
    />
  </div>
</template>
