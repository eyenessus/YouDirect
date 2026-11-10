<script setup lang="ts">
import { ref } from 'vue';
import { Download } from 'lucide-vue-next';
import type { PermissionModule } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import { ApiRequestError, downloadFile } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/** Botão "Exportar CSV" — só aparece para quem tem a permissão `export` do módulo. */
const props = defineProps<{ path: string; filename: string; module: PermissionModule }>();
const auth = useAuthStore();
const toasts = useToastStore();
const busy = ref(false);

async function run() {
  busy.value = true;
  try {
    await downloadFile(props.path, props.filename);
  } catch (err) {
    toasts.error('Não foi possível exportar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppButton v-if="auth.allows(module, 'export')" variant="secondary" :loading="busy" @click="run">
    <template #icon><Download class="size-4" /></template>
    Exportar CSV
  </AppButton>
</template>
