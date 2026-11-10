<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { QrCode } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  portalInvoiceStatusLabels,
  type PortalInvoice,
  type PortalInvoices,
} from '@yudirect/contracts';
import AppTabs from '@/components/ui/AppTabs.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { useToastStore } from '@/stores/ui';
import DriverPixModal from './DriverPixModal.vue';
import { portalGet, usePortal, whatsappLink } from './usePortal';

const portal = usePortal();
const toasts = useToastStore();
const data = ref<PortalInvoices | null>(null);
const filter = ref('open');
const paying = ref<PortalInvoice | null>(null);
const statusTone = { OPEN: 'slate', PARTIAL: 'amber', PAID: 'green', OVERDUE: 'red' } as const;
const kindLabel = { RENT: 'Aluguel', FINE: 'Multa', EXTRA_KM: 'KM excedente', DEPOSIT: 'Caução', DAMAGE: 'Avarias' } as const;

const shown = computed(() => {
  const list = data.value?.invoices ?? [];
  return filter.value === 'open' ? list.filter((i) => i.status !== 'PAID').reverse() : list;
});
const payLink = computed(() =>
  whatsappLink(portal.state.me?.organization.whatsappPhone, 'Olá! Quero pagar minha fatura. Pode me enviar a chave Pix?'),
);

async function load() {
  data.value = await portalGet<PortalInvoices>('/driver/invoices');
}

async function onPaid() {
  toasts.success('Pagamento confirmado');
  await load();
}

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-bold text-ink">Faturas</h1>

    <div v-if="data" class="grid grid-cols-2 gap-3">
      <div class="fo-card p-4">
        <p class="text-sm text-ink-muted">Em aberto</p>
        <p class="text-xl font-bold tabular text-ink">{{ formatCentsBRL(data.totals.openCents) }}</p>
      </div>
      <div class="fo-card p-4">
        <p class="text-sm text-ink-muted">Em atraso</p>
        <p class="text-xl font-bold tabular" :class="data.totals.overdueCents > 0 ? 'text-[rgb(var(--c-negative))]' : 'text-ink'">
          {{ formatCentsBRL(data.totals.overdueCents) }}
        </p>
      </div>
    </div>

    <AppTabs
      v-model="filter"
      :items="[
        { key: 'open', label: 'A pagar' },
        { key: 'all', label: 'Todas' },
      ]"
    />

    <p v-if="!data" class="text-[15px] text-ink-muted">Carregando…</p>
    <p v-else-if="shown.length === 0" class="fo-card p-5 text-[15px] text-ink-muted">Nada a pagar. Tudo em dia!</p>
    <ul v-else class="space-y-2">
      <li v-for="i in shown" :key="i.key" class="fo-card p-4">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <p class="font-semibold text-ink">{{ kindLabel[i.kind] }} · {{ i.description }}</p>
            <p class="text-sm text-ink-muted">
              Vence {{ formatIsoDateBR(i.dueDate) }}{{ i.rentalNumber ? ` · ${i.rentalNumber}` : '' }}
            </p>
            <p v-if="i.paidCents > 0 && i.remainingCents > 0" class="text-sm text-ink-muted">Pago {{ formatCentsBRL(i.paidCents) }}</p>
          </div>
          <div class="flex shrink-0 flex-col items-end gap-1">
            <span class="font-bold tabular text-ink">{{ formatCentsBRL(i.status === 'PAID' ? i.amountCents : i.remainingCents) }}</span>
            <StatusBadge :label="portalInvoiceStatusLabels[i.status]" :tone="statusTone[i.status]" :solid="false" />
          </div>
        </div>
        <button
          v-if="i.status !== 'PAID'"
          type="button"
          class="mt-3 flex w-full items-center justify-center gap-2 rounded-control bg-[rgb(var(--c-positive-solid))] px-4 py-2.5 font-semibold text-white"
          @click="paying = i"
        >
          <QrCode class="size-5" aria-hidden="true" /> Pagar com Pix
        </button>
      </li>
    </ul>

    <DriverPixModal :invoice="paying" :fallback-link="payLink" @close="paying = null" @paid="onPaid" />
  </div>
</template>
