<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { AlertTriangle, Car, FileText, TrendingUp, Trophy, Users } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatSignedPercent,
  type DashboardSummary,
} from '@frotaone/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import MetricCard from '@/components/ui/MetricCard.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import AreaChart from '@/components/charts/AreaChart.vue';
import { api } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const toasts = useToastStore();
const summary = ref<DashboardSummary | null>(null);
const loading = ref(true);

const medals = ['bg-[rgb(253_230_138)] text-[rgb(146_64_14)]', 'bg-surface-muted text-ink-soft', 'bg-[rgb(254_215_170)] text-[rgb(154_52_18)]'];

onMounted(async () => {
  try {
    summary.value = await api.get<DashboardSummary>('/dashboard/summary');
  } catch {
    toasts.error('Falha ao carregar o painel', 'Tente recarregar a página.');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader eyebrow="PAINEL" title="Dashboard" subtitle="Bem-vindo ao FrotaOne" />

    <AppSkeleton v-if="loading" variant="cards" :rows="4" />

    <template v-else-if="summary">
      <!-- KPIs -->
      <div class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Total de Veículos"
          :value="String(summary.totals.vehicles)"
          :delta-percent="summary.deltas.vehiclesPercent"
          :icon="Car"
          icon-tone="blue"
        />
        <MetricCard
          label="Motoristas Ativos"
          :value="String(summary.totals.activeDrivers)"
          :delta-percent="summary.deltas.driversPercent"
          :icon="Users"
          icon-tone="green"
        />
        <MetricCard
          label="Contratos Ativos"
          :value="String(summary.totals.activeRentals)"
          :delta-percent="summary.deltas.rentalsPercent"
          :icon="FileText"
          icon-tone="purple"
        />
        <MetricCard
          label="Receita Mensal"
          :value="formatCentsBRL(summary.totals.monthlyRevenueCents)"
          :delta-percent="summary.deltas.revenuePercent"
          :icon="TrendingUp"
          icon-tone="amber"
        />
      </div>

      <!-- Evolução da receita -->
      <section class="fo-card p-6">
        <div class="mb-1 flex items-center gap-2.5">
          <TrendingUp class="size-5 text-[rgb(var(--c-positive))]" aria-hidden="true" />
          <h2 class="text-xl font-bold text-ink">Evolução da Receita</h2>
        </div>
        <p class="mb-6 text-[15px] text-ink-muted">Últimos 6 meses</p>
        <AreaChart
          :labels="summary.revenueSeries.map((p) => p.label)"
          :values="summary.revenueSeries.map((p) => p.revenueCents)"
          series-name="Receita"
          tone="green"
          height="380px"
          caption="Gráfico da evolução da receita nos últimos seis meses"
        />
      </section>

      <!-- Rankings -->
      <div class="grid gap-6 xl:grid-cols-2">
        <section class="fo-card p-6">
          <div class="mb-1 flex items-center gap-2.5">
            <Trophy class="size-5 text-[rgb(var(--c-warning))]" aria-hidden="true" />
            <h2 class="text-xl font-bold text-ink">Top Veículos Lucrativos</h2>
          </div>
          <p class="mb-5 text-[15px] text-ink-muted">Variação em relação ao mês anterior</p>

          <p v-if="summary.topProfitable.length === 0" class="py-8 text-center text-[15px] text-ink-muted">
            Ainda não há lucro apurado neste mês.
          </p>
          <ul v-else class="space-y-3">
            <li
              v-for="(row, index) in summary.topProfitable"
              :key="row.vehicleId"
              class="flex items-center gap-4 rounded-card border border-line p-4"
            >
              <span
                class="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold"
                :class="medals[index] ?? medals[1]"
              >
                {{ index + 1 }}º
              </span>
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-2 font-semibold text-ink">
                  <Car class="size-4 text-ink-muted" aria-hidden="true" />
                  {{ row.plate }}
                </p>
                <p class="mt-0.5 truncate text-sm text-ink-muted">{{ row.model }}</p>
              </div>
              <div class="text-right">
                <p class="font-bold tabular text-ink">{{ formatCentsBRL(row.amountCents) }}</p>
                <p
                  v-if="row.deltaPercent !== null"
                  class="mt-1 inline-block rounded px-1.5 py-0.5 text-xs font-semibold"
                  :class="
                    row.deltaPercent >= 0
                      ? 'bg-[rgb(var(--c-positive)/0.12)] text-[rgb(var(--c-positive))]'
                      : 'bg-[rgb(var(--c-negative)/0.12)] text-[rgb(var(--c-negative))]'
                  "
                >
                  {{ formatSignedPercent(row.deltaPercent, 2) }}
                </p>
              </div>
            </li>
          </ul>
        </section>

        <section class="fo-card p-6">
          <div class="mb-1 flex items-center gap-2.5">
            <AlertTriangle class="size-5 text-[rgb(var(--c-negative))]" aria-hidden="true" />
            <h2 class="text-xl font-bold text-ink">Top Veículos com Mais Despesas</h2>
          </div>
          <p class="mb-5 text-[15px] text-ink-muted">Variação em relação ao mês anterior</p>

          <p v-if="summary.topExpensive.length === 0" class="py-8 text-center text-[15px] text-ink-muted">
            Nenhuma despesa registrada neste mês.
          </p>
          <ul v-else class="space-y-3">
            <li
              v-for="(row, index) in summary.topExpensive"
              :key="row.vehicleId"
              class="flex items-center gap-4 rounded-card border border-line p-4"
            >
              <span
                class="flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-bold"
                :class="medals[index] ?? medals[1]"
              >
                {{ index + 1 }}º
              </span>
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-2 font-semibold text-ink">
                  <Car class="size-4 text-ink-muted" aria-hidden="true" />
                  {{ row.plate }}
                </p>
                <p class="mt-0.5 truncate text-sm text-ink-muted">{{ row.model }}</p>
              </div>
              <div class="text-right">
                <p class="font-bold tabular text-[rgb(var(--c-negative))]">
                  {{ formatCentsBRL(row.amountCents) }}
                </p>
                <p
                  v-if="row.deltaPercent !== null"
                  class="mt-1 inline-block rounded px-1.5 py-0.5 text-xs font-semibold"
                  :class="
                    row.deltaPercent <= 0
                      ? 'bg-[rgb(var(--c-positive)/0.12)] text-[rgb(var(--c-positive))]'
                      : 'bg-[rgb(var(--c-negative)/0.12)] text-[rgb(var(--c-negative))]'
                  "
                >
                  {{ formatSignedPercent(row.deltaPercent, 2) }}
                </p>
              </div>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>
