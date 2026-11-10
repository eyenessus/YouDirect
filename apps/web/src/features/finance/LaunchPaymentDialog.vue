<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  formatCentsBRL,
  formatIsoDateBR,
  receivableStatusLabels,
  type Receivable,
} from '@yudirect/contracts';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import RegisterPaymentModal from './RegisterPaymentModal.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

/**
 * Atalho de baixa: lista as contas a receber em aberto do motorista (ou de uma
 * locação) e reutiliza o RegisterPaymentModal, que chama
 * POST /receivables/:id/payments — o mesmo caminho de Contas a Receber > Pagar.
 */
const props = defineProps<{
  open: boolean;
  driverId?: string;
  rentalId?: string;
  title?: string;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();

const toasts = useToastStore();
const rows = ref<Receivable[]>([]);
const loading = ref(false);
const payTarget = ref<Receivable | null>(null);

async function load() {
  loading.value = true;
  try {
    // Atualiza status vencidos antes de listar, como a tela de Contas a Receber.
    await api.post('/finance/refresh-statuses').catch(() => undefined);
    const res = await api.get<{ data: Receivable[] }>('/receivables', {
      query: {
        driverId: props.driverId,
        rentalId: props.rentalId,
        openOnly: 'true',
        sort: 'dueDate',
        limit: 50,
      },
    });
    rows.value = res.data.filter((r) => r.remainingCents > 0);
  } catch (err) {
    toasts.error('Falha ao carregar contas a receber', err instanceof ApiRequestError ? err.message : undefined);
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
);

async function onSaved() {
  emit('saved');
  await load();
}
</script>

<template>
  <AppModal :open="open && payTarget === null" :title="title ?? 'Lançar pagamento'" @close="emit('close')">
    <p v-if="loading" class="py-6 text-center text-ink-muted">Carregando…</p>
    <p v-else-if="rows.length === 0" class="py-6 text-center text-ink-muted">
      Nenhuma conta a receber em aberto.
    </p>
    <ul v-else class="divide-y divide-line">
      <li v-for="r in rows" :key="r.id" class="flex items-center justify-between gap-4 py-4">
        <div class="min-w-0">
          <p class="truncate font-semibold text-ink">{{ r.description }}</p>
          <p class="mt-0.5 text-sm text-ink-muted">
            Vencimento {{ formatIsoDateBR(r.dueDate) }} · Pendente
            <span class="font-semibold tabular text-ink">{{ formatCentsBRL(r.remainingCents) }}</span>
          </p>
          <StatusBadge
            class="mt-1"
            :label="receivableStatusLabels[r.status]"
            :tone="statusTone.receivable[r.status]"
            :solid="false"
          />
        </div>
        <AppButton @click="payTarget = r">Pagar</AppButton>
      </li>
    </ul>
    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">Fechar</AppButton>
    </template>
  </AppModal>

  <RegisterPaymentModal
    :open="payTarget !== null"
    kind="receivable"
    :target="payTarget && { id: payTarget.id, description: payTarget.description, remainingCents: payTarget.remainingCents }"
    @close="payTarget = null"
    @saved="onSaved"
  />
</template>
