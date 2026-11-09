<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Car } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatPercent,
  formatSignedPercent,
  monthLabel,
  type VehicleReport,
} from '@frotaone/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import DataTable, { type Column } from '@/components/ui/DataTable.vue';
import AreaChart from '@/components/charts/AreaChart.vue';
import { api } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const toasts = useToastStore();

const today = new Date();
const vehicleId = ref('');
const month = ref(today.getMonth() + 1);
const year = ref(today.getFullYear());
const chartYear = ref(today.getFullYear());

const report = ref<VehicleReport | null>(null);
const loading = ref(true);

const columns: Column[] = [
  { key: 'vehicle', label: 'Veículo' },
  { key: 'plate', label: 'Placa' },
  { key: 'revenue', label: 'Receita' },
  { key: 'expenses', label: 'Despesa' },
  { key: 'profit', label: 'Lucro líquido' },
  { key: 'margin', label: 'Margem' },
];

const monthOptions = computed(() =>
  Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: monthLabel(year.value, i + 1) })),
);
const yearOptions = Array.from({ length: 6 }, (_, i) => {
  const value = today.getFullYear() - 3 + i;
  return { value: String(value), label: String(value) };
});

const vehicleOptions = computed(() => [
  { value: '', label: 'Todos os veículos' },
  ...(report.value?.vehicleOptions ?? []).map((v) => ({ value: v.id, label: v.label })),
]);

/** Largura da barra proporcional ao maior |margem| da tabela. */
function barWidth(margin: number | null): string {
  if (margin === null) return '0%';
  const max = Math.max(
    100,
    ...((report.value?.rows ?? []).map((r) => Math.abs(r.marginPercent ?? 0)) || [100]),
  );
  return `${Math.min(100, (Math.abs(margin) / max) * 100)}%`;
}

async function load() {
  loading.value = true;
  try {
    report.value = await api.get<VehicleReport>('/reports/by-vehicle', {
      query: {
        vehicleId: vehicleId.value || undefined,
        month: month.value,
        year: year.value,
      },
    });
  } catch {
    toasts.error('Falha ao carregar o relatório');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="FINANCEIRO"
      title="Relatório por veículo"
      subtitle="Análise financeira por veículo e período"
    >
      <template #actions>
        <div class="w-[230px]">
          <AppSelect v-model="vehicleId" :options="vehicleOptions" @update:model-value="load" />
        </div>
        <div class="w-[170px]">
          <AppSelect
            :model-value="String(month)"
            :options="monthOptions"
            @update:model-value="
              month = Number($event);
              load();
            "
          />
        </div>
        <div class="w-[110px]">
          <AppSelect
            :model-value="String(year)"
            :options="yearOptions"
            @update:model-value="
              year = Number($event);
              chartYear = Number($event);
              load();
            "
          />
        </div>
      </template>
    </PageHeader>

    <AppSkeleton v-if="loading" variant="cards" :rows="4" />

    <template v-else-if="report">
      <div class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <div class="fo-card p-6">
          <p class="text-[15px] text-ink-soft">Lucro líquido</p>
          <p
            class="mt-3 text-[30px] font-bold tabular"
            :class="report.profitCents >= 0 ? 'text-[rgb(var(--c-positive))]' : 'text-[rgb(var(--c-negative))]'"
          >
            {{ formatCentsBRL(report.profitCents) }}
          </p>
          <p class="mt-2 text-sm">
            <span
              :class="
                (report.deltas.profitPercent ?? 0) >= 0
                  ? 'text-[rgb(var(--c-positive))]'
                  : 'text-[rgb(var(--c-negative))]'
              "
            >
              {{ formatSignedPercent(report.deltas.profitPercent) }}
            </span>
            <span class="ml-1.5 text-ink-muted">vs Mês anterior</span>
          </p>
        </div>

        <div class="fo-card p-6">
          <p class="text-[15px] text-ink-soft">Receitas</p>
          <p class="mt-3 text-[30px] font-bold tabular text-ink">
            {{ formatCentsBRL(report.revenueCents) }}
          </p>
          <p class="mt-2 text-sm">
            <span
              :class="
                (report.deltas.revenuePercent ?? 0) >= 0
                  ? 'text-[rgb(var(--c-positive))]'
                  : 'text-[rgb(var(--c-negative))]'
              "
            >
              {{ formatSignedPercent(report.deltas.revenuePercent) }}
            </span>
            <span class="ml-1.5 text-ink-muted">vs Mês anterior</span>
          </p>
        </div>

        <div class="fo-card p-6">
          <p class="text-[15px] text-ink-soft">Despesas</p>
          <p class="mt-3 text-[30px] font-bold tabular text-ink">
            {{ formatCentsBRL(report.expensesCents) }}
          </p>
          <p class="mt-2 text-sm">
            <span
              :class="
                (report.deltas.expensesPercent ?? 0) <= 0
                  ? 'text-[rgb(var(--c-positive))]'
                  : 'text-[rgb(var(--c-negative))]'
              "
            >
              {{ formatSignedPercent(report.deltas.expensesPercent) }}
            </span>
            <span class="ml-1.5 text-ink-muted">vs Mês anterior</span>
          </p>
        </div>

        <div class="fo-card p-6">
          <div class="flex items-start justify-between">
            <div>
              <p class="text-[15px] text-ink-soft">Veículos ativos</p>
              <p class="mt-3 text-[30px] font-bold tabular text-ink">{{ report.activeVehicles }}</p>
              <p class="mt-2 text-sm text-ink-muted">de {{ report.totalVehicles }}</p>
            </div>
            <div class="flex size-10 items-center justify-center rounded-full bg-brand-50">
              <Car class="size-5 text-brand-600" aria-hidden="true" />
            </div>
          </div>
        </div>
      </div>

      <section class="fo-card p-6">
        <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-xl font-bold text-ink">Evolução do lucro líquido</h2>
          <div class="w-[110px]">
            <AppSelect
              :model-value="String(chartYear)"
              :options="yearOptions"
              @update:model-value="
                chartYear = Number($event);
                year = Number($event);
                load();
              "
            />
          </div>
        </div>
        <AreaChart
          :labels="report.monthlyProfit.map((m) => m.label)"
          :values="report.monthlyProfit.map((m) => m.profitCents)"
          series-name="Lucro líquido"
          tone="blue"
          height="340px"
          caption="Evolução mensal do lucro líquido no ano selecionado"
        />
      </section>

      <section class="fo-card overflow-hidden">
        <h2 class="px-6 pb-3 pt-6 text-xl font-bold text-ink">Lucro por veículo</h2>
        <DataTable
          :columns="columns"
          :rows="report.rows.map((r) => ({ ...r, id: r.vehicleId }))"
          caption="Resultado financeiro por veículo"
          empty-message="Nenhum veículo com movimentação no período."
        >
          <template #cell-vehicle="{ row }">
            <span class="flex items-center gap-3">
              <span class="flex size-9 items-center justify-center rounded-full bg-surface-muted">
                <Car class="size-[18px] text-ink-muted" aria-hidden="true" />
              </span>
              <span class="font-medium text-ink">{{ row.vehicle }}</span>
            </span>
          </template>
          <template #cell-plate="{ row }">
            <span class="tabular text-ink-muted">{{ row.plate }}</span>
          </template>
          <template #cell-revenue="{ row }">
            <span class="tabular text-[rgb(var(--c-positive))]">
              {{ formatCentsBRL(row.revenueCents) }}
            </span>
          </template>
          <template #cell-expenses="{ row }">
            <span class="tabular text-[rgb(var(--c-negative))]">
              {{ formatCentsBRL(row.expensesCents) }}
            </span>
          </template>
          <template #cell-profit="{ row }">
            <span
              class="font-semibold tabular"
              :class="row.profitCents >= 0 ? 'text-[rgb(var(--c-positive))]' : 'text-[rgb(var(--c-negative))]'"
            >
              {{ formatCentsBRL(row.profitCents) }}
            </span>
          </template>
          <template #cell-margin="{ row }">
            <span class="flex items-center gap-3">
              <span
                class="w-[52px] shrink-0 text-right tabular text-sm font-semibold"
                :class="
                  row.marginPercent === null
                    ? 'text-ink-muted'
                    : row.marginPercent >= 0
                      ? 'text-brand-600'
                      : 'text-[rgb(var(--c-negative))]'
                "
              >
                {{ row.marginPercent === null ? '—' : formatPercent(row.marginPercent, 0) }}
              </span>
              <span class="h-2 w-[100px] overflow-hidden rounded-full bg-surface-muted">
                <span
                  class="block h-full rounded-full"
                  :class="(row.marginPercent ?? 0) >= 0 ? 'bg-brand-500' : 'bg-[rgb(var(--c-negative))]'"
                  :style="{ width: barWidth(row.marginPercent) }"
                />
              </span>
            </span>
          </template>
        </DataTable>
      </section>
    </template>
  </div>
</template>
