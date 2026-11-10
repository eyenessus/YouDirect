<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  formatCentsBRL,
  formatDateTimeBR,
  formatIsoDateBR,
  portalInvoiceStatusLabels,
  type PortalFine,
} from '@yudirect/contracts';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { portalGet, usePortal, whatsappLink } from './usePortal';

const portal = usePortal();
const fines = ref<PortalFine[] | null>(null);
const statusTone = { OPEN: 'slate', PARTIAL: 'amber', PAID: 'green', OVERDUE: 'red' } as const;

function indicationLink(f: PortalFine) {
  return whatsappLink(
    portal.state.me?.organization.whatsappPhone,
    `Olá! Sobre a multa ${f.aitNumber} (${f.plate}): quero assinar a indicação de condutor.`,
  );
}

onMounted(async () => {
  fines.value = (await portalGet<{ data: PortalFine[] }>('/driver/fines')).data;
});
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-bold text-ink">Multas</h1>
    <p class="text-sm text-ink-muted">Multas do período em que o carro estava com você.</p>

    <p v-if="!fines" class="text-[15px] text-ink-muted">Carregando…</p>
    <p v-else-if="fines.length === 0" class="fo-card p-5 text-[15px] text-ink-muted">Nenhuma multa. Continue assim!</p>
    <article v-for="f in fines ?? []" :key="f.id" class="fo-card space-y-3 p-5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="font-semibold text-ink">{{ f.infractionDescription }}</p>
          <p class="text-sm text-ink-muted">{{ formatDateTimeBR(f.occurredAt) }}{{ f.place ? ` · ${f.place}` : '' }}</p>
        </div>
        <span class="shrink-0 text-lg font-bold tabular text-ink">{{ formatCentsBRL(f.charge?.amountCents ?? f.chargeAmountCents) }}</span>
      </div>
      <dl class="grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt class="text-ink-muted">Placa</dt>
          <dd class="font-semibold text-ink">{{ f.plate }}</dd>
        </div>
        <div>
          <dt class="text-ink-muted">Auto de infração</dt>
          <dd class="font-semibold text-ink">{{ f.aitNumber }}</dd>
        </div>
        <div>
          <dt class="text-ink-muted">Órgão</dt>
          <dd class="text-ink">{{ f.authorityName }}</dd>
        </div>
        <div v-if="f.points !== null">
          <dt class="text-ink-muted">Pontos</dt>
          <dd class="text-ink">{{ f.points }}</dd>
        </div>
      </dl>
      <div v-if="f.charge" class="flex items-center justify-between rounded-control bg-surface-muted px-3 py-2 text-sm">
        <span>Cobrança · vence {{ formatIsoDateBR(f.charge.dueDate) }}</span>
        <StatusBadge :label="portalInvoiceStatusLabels[f.charge.status as keyof typeof statusTone]" :tone="statusTone[f.charge.status as keyof typeof statusTone]" :solid="false" />
      </div>
      <p v-if="f.indicationStatus === 'PENDING' && f.indicationDeadline" class="text-sm font-medium text-[rgb(var(--c-warning))]">
        Assine a indicação de condutor até {{ formatIsoDateBR(f.indicationDeadline) }}.
        <a v-if="indicationLink(f)" :href="indicationLink(f)!" target="_blank" rel="noopener" class="font-semibold text-brand-600 underline">Falar com a locadora</a>
      </p>
      <a v-if="f.noticeUrl" :href="f.noticeUrl" target="_blank" rel="noopener" class="inline-block text-sm font-semibold text-brand-600 hover:underline">
        Ver notificação
      </a>
    </article>
  </div>
</template>
