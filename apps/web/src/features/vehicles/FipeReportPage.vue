<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { TrendingDown } from 'lucide-vue-next';
import { formatCentsBRL, type FipeReportRow } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

/** Valor de mercado da frota (FIPE) frente ao preço de compra e ao rendimento do aluguel. */
const toasts = useToastStore();
const rows = ref<FipeReportRow[]>([]);
const loading = ref(true);

const pct = (n: number | null) => (n === null ? '—' : `${n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

onMounted(async () => {
  try {
    rows.value = (await api.get<{ data: FipeReportRow[] }>('/vehicles/fipe-report')).data;
  } catch (err) {
    toasts.error('Não foi possível carregar o relatório', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Veículos"
      title="Valor de mercado (FIPE)"
      subtitle="Quanto cada carro vale hoje na tabela FIPE, quanto desvalorizou desde a compra e quanto o aluguel semanal rende por ano sobre esse valor."
    />
    <div class="fo-card overflow-x-auto">
      <p v-if="loading" class="p-8 text-ink-muted" role="status">Carregando...</p>
      <EmptyState
        v-else-if="rows.length === 0"
        :icon="TrendingDown"
        title="Nenhum veículo vinculado"
        message="Abra um veículo e use “Vincular à FIPE” para acompanhar o valor de mercado."
      />
      <table v-else class="w-full text-left text-[15px]">
        <thead class="border-b border-line text-sm text-ink-muted">
          <tr>
            <th class="px-5 py-3 font-semibold">Veículo</th>
            <th class="px-5 py-3 font-semibold">Compra</th>
            <th class="px-5 py-3 font-semibold">FIPE</th>
            <th class="px-5 py-3 font-semibold">Variação</th>
            <th class="px-5 py-3 font-semibold">Aluguel/semana</th>
            <th class="px-5 py-3 font-semibold">Rendimento/ano</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.vehicleId" class="border-b border-line last:border-0">
            <td class="px-5 py-3">
              <RouterLink :to="`/dashboard/vehicles/${r.vehicleId}`" class="font-semibold text-brand-600 hover:underline">{{ r.plate }}</RouterLink>
              <span class="ml-2 text-ink-muted">{{ r.label }}</span>
            </td>
            <td class="px-5 py-3">{{ r.purchaseAmountCents ? formatCentsBRL(r.purchaseAmountCents) : '—' }}</td>
            <td class="px-5 py-3">{{ formatCentsBRL(r.fipePriceCents) }} <span class="block text-xs text-ink-muted">{{ r.referenceMonth }}</span></td>
            <td class="px-5 py-3 tabular font-semibold" :class="r.changeVsPurchasePercent !== null && r.changeVsPurchasePercent < 0 ? 'text-[rgb(var(--c-negative))]' : 'text-ink'">{{ pct(r.changeVsPurchasePercent) }}</td>
            <td class="px-5 py-3">{{ r.weeklyRentCents ? formatCentsBRL(r.weeklyRentCents) : '—' }}</td>
            <td class="px-5 py-3 tabular">{{ pct(r.annualYieldPercent) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="mt-4 text-sm text-ink-muted">Valores da tabela FIPE, atualizados todo mês. O rendimento considera 52 semanas do aluguel atual e não desconta manutenção, impostos nem ociosidade.</p>
  </div>
</template>
