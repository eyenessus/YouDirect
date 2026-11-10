<script setup lang="ts">
import { ref, watch } from 'vue';
import { formatCentsBRL, formatDateTimeBR, type PixCharge } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppModal from '@/components/ui/AppModal.vue';
import { api, ApiRequestError } from '@/lib/api';

/** Equipe gera o Pix de uma conta a receber e manda o código ao motorista. A baixa é automática. */
const props = defineProps<{ target: { id: string; description: string; driverName: string; remainingCents: number } | null }>();
const emit = defineEmits<{ close: [] }>();

const charge = ref<PixCharge | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const copied = ref(false);

watch(
  () => props.target?.id,
  async (id) => {
    charge.value = null;
    error.value = null;
    copied.value = false;
    if (!id) return;
    loading.value = true;
    try {
      charge.value = await api.post<PixCharge>(`/receivables/${id}/pix`, {});
    } catch (err) {
      error.value = err instanceof ApiRequestError ? err.message : 'Não foi possível gerar o Pix.';
    } finally {
      loading.value = false;
    }
  },
);

async function copy() {
  if (!charge.value?.qrCode) return;
  await navigator.clipboard.writeText(charge.value.qrCode).catch(() => undefined);
  copied.value = true;
}
</script>

<template>
  <AppModal :open="target !== null" title="Cobrar por Pix" :description="target ? `${target.driverName} · ${target.description} · ${formatCentsBRL(target.remainingCents)}` : ''" @close="emit('close')">
    <p v-if="loading" class="text-[15px] text-ink-muted">Gerando o Pix…</p>
    <p v-else-if="error" class="text-[15px] text-ink-soft">{{ error }}</p>
    <div v-else-if="charge" class="space-y-3 text-center">
      <img v-if="charge.qrCodeBase64" :src="`data:image/png;base64,${charge.qrCodeBase64}`" alt="QR Code do Pix" class="mx-auto size-48 rounded-control border border-line bg-white p-2" />
      <p class="break-all rounded-control bg-surface-muted p-3 text-left font-mono text-xs text-ink">{{ charge.qrCode }}</p>
      <AppButton block @click="copy">{{ copied ? 'Código copiado!' : 'Copiar código Pix' }}</AppButton>
      <p class="text-xs text-ink-muted">Válido até {{ formatDateTimeBR(charge.expiresAt) }}. Quando o motorista pagar, a conta recebe baixa sozinha.</p>
    </div>
    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">Fechar</AppButton>
    </template>
  </AppModal>
</template>
