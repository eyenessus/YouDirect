<script setup lang="ts">
import AppModal from './AppModal.vue';
import AppButton from './AppButton.vue';

withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    loading?: boolean;
  }>(),
  { confirmLabel: 'Confirmar', cancelLabel: 'Cancelar', danger: false, loading: false },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <AppModal :open="open" :title="title" size="sm" @close="emit('cancel')">
    <p class="text-[15px] leading-relaxed text-ink-soft">{{ message }}</p>
    <template #footer>
      <AppButton variant="secondary" :disabled="loading" @click="emit('cancel')">
        {{ cancelLabel }}
      </AppButton>
      <AppButton :variant="danger ? 'danger' : 'primary'" :loading="loading" @click="emit('confirm')">
        {{ confirmLabel }}
      </AppButton>
    </template>
  </AppModal>
</template>
