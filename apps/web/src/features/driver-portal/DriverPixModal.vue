<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { CheckCircle2 } from 'lucide-vue-next';
import { formatCentsBRL, formatDateTimeBR, type PixCharge, type PortalInvoice } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppModal from '@/components/ui/AppModal.vue';
import { ApiRequestError } from '@/lib/api';
import { portalGet, portalPost } from './usePortal';

/** Pagar uma fatura com Pix: QR Code + copia e cola; acompanha até a baixa automática. */
const props = defineProps<{ invoice: PortalInvoice | null; fallbackLink: string | null }>();
const emit = defineEmits<{ close: []; paid: [] }>();

const charge = ref<PixCharge | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
const copied = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function poll() {
  if (!charge.value || charge.value.status !== 'PENDING') return stop();
  try {
    charge.value = await portalGet<PixCharge>(`/driver/pix/${charge.value.id}`);
    if (charge.value.status === 'PAID') {
      stop();
      emit('paid');
    }
  } catch {
    /* tenta de novo no próximo ciclo */
  }
}

watch(
  () => props.invoice?.key,
  async (key) => {
    stop();
    charge.value = null;
    error.value = null;
    copied.value = false;
    if (!key) return;
    loading.value = true;
    try {
      charge.value = await portalPost<PixCharge>('/driver/invoices/pix', { key });
      timer = setInterval(poll, 5000);
    } catch (err) {
      error.value = err instanceof ApiRequestError ? err.message : 'Não foi possível gerar o Pix.';
    } finally {
      loading.value = false;
    }
  },
  { immediate: true },
);

async function copy() {
  if (!charge.value?.qrCode) return;
  await navigator.clipboard.writeText(charge.value.qrCode).catch(() => undefined);
  copied.value = true;
}

onBeforeUnmount(stop);
</script>

<template>
  <AppModal :open="invoice !== null" title="Pagar com Pix" :description="invoice ? `${invoice.description} · ${formatCentsBRL(invoice.remainingCents)}` : ''" @close="emit('close')">
    <p v-if="loading" class="text-[15px] text-ink-muted">Gerando o Pix…</p>
    <div v-else-if="error" class="space-y-3">
      <p class="text-[15px] text-ink-soft">O pagamento por Pix automático não está disponível agora.</p>
      <p class="text-sm text-ink-muted">{{ error }}</p>
      <a v-if="fallbackLink" :href="fallbackLink" target="_blank" rel="noopener" class="inline-block rounded-control bg-[rgb(var(--c-positive-solid))] px-4 py-2.5 font-semibold text-white">
        Pedir a chave Pix pelo WhatsApp
      </a>
    </div>
    <div v-else-if="charge?.status === 'PAID'" class="space-y-2 text-center">
      <CheckCircle2 class="mx-auto size-12 text-[rgb(var(--c-positive))]" aria-hidden="true" />
      <p class="text-lg font-bold text-ink">Pagamento confirmado!</p>
      <p class="text-[15px] text-ink-muted">A fatura já aparece como paga.</p>
    </div>
    <div v-else-if="charge" class="space-y-4 text-center">
      <img
        v-if="charge.qrCodeBase64"
        :src="`data:image/png;base64,${charge.qrCodeBase64}`"
        alt="QR Code do Pix"
        class="mx-auto size-56 rounded-control border border-line bg-white p-2"
      />
      <p class="text-sm text-ink-muted">Abra o app do seu banco, escolha Pix e leia o QR Code ou use o código abaixo.</p>
      <p v-if="charge.qrCode" class="break-all rounded-control bg-surface-muted p-3 text-left font-mono text-xs text-ink">{{ charge.qrCode }}</p>
      <AppButton block @click="copy">{{ copied ? 'Código copiado!' : 'Copiar código Pix' }}</AppButton>
      <p class="text-xs text-ink-muted">Válido até {{ formatDateTimeBR(charge.expiresAt) }}. A baixa é automática assim que o banco confirmar.</p>
    </div>
    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">Fechar</AppButton>
    </template>
  </AppModal>
</template>
