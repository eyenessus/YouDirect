<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  formatPercent,
  formatSignedPercent,
  monthLabel,
  type FinanceDashboard,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import MetricCard from '@/components/ui/MetricCard.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import FormField from '@/components/ui/FormField.vue';
import ComparisonBarChart from '@/components/charts/ComparisonBarChart.vue';
import DonutChart from '@/components/charts/DonutChart.vue';
import { compactBRL } from '@/components/charts/useChartTheme';
import { api } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const router = useRouter();
const toasts = useToastStore();

const today = new Date();
const month = ref(today.getMonth() + 1);
const year = ref(today.getFullYear());
const custom = ref<{ from: string; to: string } | null>(null);
const popoverOpen = ref(false);
const draft = ref({ from: '', to: '' });

const data = ref<FinanceDashboard | null>(null);
const loading = ref(true);
const root = ref<HTMLElement | null>(null);

const periodTitle = computed(() =>
  custom.value ? `${formatIsoDateBR(custom.value.from)} – ${formatIsoDateBR(custom.value.to)}` : monthLabel(year.value, month.value),
);

async function load() {
  loading.value = true;
  try {
    data.value = await api.get<FinanceDashboard>('/finance/dashboard', {
      query: custom.value
        ? { from: custom.value.from, to: custom.value.to }
        : { month: month.value, year: year.value },
    });
  } catch {
    toasts.error('Falha ao carregar o dashboard financeiro');
  } finally {
    loading.value = false;
  }
}

function shiftMonth(delta: number) {
  custom.value = null;
  const next = new Date(year.value, month.value - 1 + delta, 1);
  year.value = next.getFullYear();
  month.value = next.getMonth() + 1;
  void load();
}

function applyCustom() {
  if (!draft.value.from || !draft.value.to) {
    toasts.warning('Informe as duas datas');
    return;
  }
  if (draft.value.from > draft.value.to) {
    toasts.warning('A data inicial não pode ser maior que a final');
    return;
  }
  custom.value = { ...draft.value };
  popoverOpen.value = false;
  void load();
}

function onDocumentClick(event: MouseEvent) {
  if (!root.value?.contains(event.target as Node)) popoverOpen.value = false;
}

function togglePopover() {
  popoverOpen.value = !popoverOpen.value;
  if (popoverOpen.value) {
    const range = data.value?.period;
    draft.value = { from: range?.from ?? '', to: range?.to ?? '' };
    document.addEventListener('click', onDocumentClick);
  } else {
    document.removeEventListener('click', onDocumentClick);
  }
}

function selectMonthFromChart(index: number) {
  const key = data.value?.monthlySeries[index]?.month;
  if (!key) return;
  const [y, m] = key.split('-').map(Number);
  custom.value = null;
  year.value = y!;
  month.value = m!;
  void load();
}

onMounted(load);
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick));
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="FINANCEIRO"
      title="Dashboard Financeiro"
      :subtitle="
        data
          ? `Resumo da operação em ${periodTitle}${data.period.comparisonLabel ? ` · comparado com ${data.period.comparisonLabel}` : ''}`
          : 'Resumo da operação'
      "
    >
      <template #actions>
        <div class="flex items-center rounded-control border border-line bg-surface">
          <button
            type="button"
            class="flex size-10 items-center justify-center rounded-l-control text-ink-soft transition-colors hover:bg-surface-muted"
            aria-label="Mês anterior"
            @click="shiftMonth(-1)"
          >
            <ChevronLeft class="size-5" />
          </button>
          <span class="min-w-[150px] px-2 text-center text-[15px] font-medium text-ink">
            {{ periodTitle }}
          </span>
          <button
            type="button"
            class="flex size-10 items-center justify-center rounded-r-control text-ink-soft transition-colors hover:bg-surface-muted"
            aria-label="Próximo mês"
            @click="shiftMonth(1)"
          >
            <ChevronRight class="size-5" />
          </button>
        </div>

        <div ref="root" class="relative">
          <AppButton variant="secondary" @click.stop="togglePopover">Período personalizado</AppButton>
          <div
            v-if="popoverOpen"
            class="absolute right-0 top-full z-30 mt-2 w-[330px] rounded-card border border-line bg-surface p-5 shadow-pop"
          >
            <FormField v-slot="field" label="Data inicial">
              <AppInput :id="field.id" v-model="draft.from" type="date" />
            </FormField>
            <div class="mt-4">
              <FormField v-slot="field" label="Data final">
                <AppInput :id="field.id" v-model="draft.to" type="date" />
              </FormField>
            </div>
            <div class="mt-5 flex justify-end">
              <AppButton @click="applyCustom">Aplicar</AppButton>
            </div>
          </div>
        </div>

        <AppButton variant="link" @click="router.push('/dashboard/finance/bank-accounts')">
          Gerenciar contas
        </AppButton>
      </template>
    </PageHeader>

    <AppSkeleton v-if="loading" variant="cards" :rows="4" />

    <template v-else-if="data">
      <div class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Faturamento"
          :value="formatCentsBRL(data.revenueCents)"
          :delta-percent="data.deltas.revenuePercent"
          pill
          :footnote="`${formatCentsBRL(data.previous.revenueCents)} em ${data.period.comparisonShortLabel ?? data.period.comparisonLabel ?? 'período anterior'}`"
        />
        <MetricCard
          label="Despesas"
          :value="formatCentsBRL(data.expensesCents)"
          :delta-percent="data.deltas.expensesPercent"
          invert-delta
          pill
          :footnote="`${formatCentsBRL(data.previous.expensesCents)} em ${data.period.comparisonShortLabel ?? data.period.comparisonLabel ?? 'período anterior'}`"
        />
        <MetricCard
          label="Lucro líquido"
          :value="formatCentsBRL(data.profitCents)"
          :delta-percent="data.deltas.profitPercent"
          pill
          :footnote="`${formatCentsBRL(data.previous.profitCents)} em ${data.period.comparisonShortLabel ?? data.period.comparisonLabel ?? 'período anterior'}`"
        />
        <MetricCard
          label="Margem de lucro"
          :value="formatPercent(data.marginPercent)"
          :delta-percent="data.deltas.marginPoints"
          delta-unit="points"
          pill
          :footnote="`${formatPercent(data.previous.marginPercent)} em ${data.period.comparisonShortLabel ?? data.period.comparisonLabel ?? 'período anterior'}`"
        />
      </div>

      <div class="grid gap-5 lg:grid-cols-2">
        <div v-if="data.highlight" class="fo-card border-l-4 border-l-[rgb(var(--c-positive))] p-6">
          <p class="fo-eyebrow text-[rgb(var(--c-positive))]">DESTAQUE</p>
          <p class="mt-2 text-[17px] leading-relaxed text-ink">{{ data.highlight }}</p>
        </div>
        <div v-if="data.attention" class="fo-card border-l-4 border-l-[rgb(var(--c-negative))] p-6">
          <p class="fo-eyebrow text-[rgb(var(--c-negative))]">ATENÇÃO</p>
          <p class="mt-2 text-[17px] leading-relaxed text-ink">{{ data.attention }}</p>
        </div>
      </div>

      <div class="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <section class="fo-card p-6">
          <div class="mb-1 flex flex-wrap items-center justify-between gap-3">
            <h2 class="text-xl font-bold text-ink">Faturamento × despesas</h2>
            <div class="flex items-center gap-4 text-sm text-ink-soft">
              <span class="flex items-center gap-1.5">
                <span class="size-2.5 rounded-full bg-brand-500" aria-hidden="true" /> Faturamento
              </span>
              <span class="flex items-center gap-1.5">
                <span class="size-2.5 rounded-full bg-ink-muted" aria-hidden="true" /> Despesas
              </span>
              <span class="text-ink-muted">R$ Lucro (no topo)</span>
            </div>
          </div>
          <p class="mb-5 text-[15px] text-ink-muted">
            Últimos 6 meses · clique em um mês para analisá-lo
          </p>
          <ComparisonBarChart
            :labels="data.monthlySeries.map((m) => m.label)"
            :revenue="data.monthlySeries.map((m) => m.revenueCents)"
            :expenses="data.monthlySeries.map((m) => m.expensesCents)"
            :profit="data.monthlySeries.map((m) => m.profitCents)"
            :highlight-index="data.monthlySeries.length - 1"
            height="360px"
            caption="Gráfico comparativo de faturamento e despesas dos últimos seis meses"
            @select-month="selectMonthFromChart"
          />
        </section>

        <section class="fo-card p-6">
          <h2 class="text-xl font-bold text-ink">Despesas por categoria</h2>
          <p class="mb-4 text-[15px] text-ink-muted">{{ periodTitle }}</p>

          <p
            v-if="data.expensesByCategory.length === 0"
            class="py-12 text-center text-[15px] text-ink-muted"
          >
            Nenhuma despesa registrada no período.
          </p>
          <div v-else class="grid items-center gap-6 sm:grid-cols-[220px_1fr]">
            <DonutChart
              :items="data.expensesByCategory"
              height="220px"
              caption="Distribuição das despesas por categoria"
            />
            <ul class="space-y-3">
              <li
                v-for="(item, index) in data.expensesByCategory"
                :key="item.label"
                class="flex items-center justify-between gap-3 text-[15px]"
              >
                <span class="flex min-w-0 items-center gap-2">
                  <span
                    class="size-2.5 shrink-0 rounded-full"
                    :style="{
                      backgroundColor: ['rgb(var(--c-brand-500))', '#1d4ed8', '#60a5fa', '#93c5fd'][index % 4],
                    }"
                    aria-hidden="true"
                  />
                  <span class="truncate text-ink">{{ item.label }}</span>
                </span>
                <span class="flex shrink-0 items-center gap-4">
                  <span class="tabular text-ink-muted">{{ formatPercent(item.percent) }}</span>
                  <span class="tabular font-semibold text-ink">{{ compactBRL(item.amountCents) }}</span>
                </span>
              </li>
            </ul>
          </div>
        </section>
      </div>

      <!-- Indicadores da frota -->
      <section>
        <h2 class="fo-eyebrow mb-4">INDICADORES DA FROTA</h2>
        <div class="grid gap-5 lg:grid-cols-3">
          <div class="fo-card p-6">
            <p class="text-[15px] text-ink-soft">Ocupação da frota</p>
            <p class="mt-3 flex items-baseline gap-2">
              <span class="text-[32px] font-bold tabular text-ink">
                {{ formatPercent(data.fleet.occupancyPercent, 0) }}
              </span>
              <span class="text-sm text-ink-muted">
                {{ formatSignedPercent(data.fleet.occupancyDeltaPoints, 1) }} pp
              </span>
            </p>
            <div class="mt-4 h-2 overflow-hidden rounded-full bg-surface-muted">
              <div
                class="h-full rounded-full bg-brand-500"
                :style="{ width: `${Math.min(100, data.fleet.occupancyPercent)}%` }"
              />
            </div>
          </div>
          <div class="fo-card p-6">
            <p class="text-[15px] text-ink-soft">Receita por veículo</p>
            <p class="mt-3 flex items-baseline gap-2">
              <span class="text-[32px] font-bold tabular text-ink">
                {{ formatCentsBRL(data.fleet.revenuePerVehicleCents) }}
              </span>
              <span
                class="text-sm"
                :class="
                  (data.fleet.revenuePerVehicleDeltaPercent ?? 0) >= 0
                    ? 'text-[rgb(var(--c-positive))]'
                    : 'text-[rgb(var(--c-negative))]'
                "
              >
                {{ formatSignedPercent(data.fleet.revenuePerVehicleDeltaPercent) }}
              </span>
            </p>
          </div>
          <div class="fo-card p-6">
            <p class="text-[15px] text-ink-soft">Frota ativa</p>
            <p class="mt-3 flex items-baseline gap-2">
              <span class="text-[32px] font-bold tabular text-ink">
                {{ data.fleet.activeVehicles }} veículos
              </span>
              <span class="text-sm text-ink-muted">
                {{ data.fleet.activeVehiclesDelta ? `${data.fleet.activeVehiclesDelta}` : 'sem variação' }}
              </span>
            </p>
          </div>
        </div>
      </section>

      <!-- Caixa e vencimentos -->
      <div class="grid gap-6 xl:grid-cols-2">
        <section class="fo-card p-6">
          <div class="mb-5 flex items-center justify-between gap-3">
            <h2 class="text-xl font-bold text-ink">Caixa e projeção</h2>
            <span class="text-[15px] text-ink-muted">próximos 30 dias</span>
          </div>

          <ul class="space-y-3">
            <li
              v-for="account in data.cash.accounts"
              :key="account.id"
              class="flex items-center justify-between gap-3 text-[17px]"
            >
              <span class="text-ink">{{ account.name }}</span>
              <span class="tabular font-semibold text-ink">{{ formatCentsBRL(account.balanceCents) }}</span>
            </li>
          </ul>

          <div class="mt-4 flex items-center justify-between border-t border-line pt-4 text-[17px] font-bold">
            <span class="text-ink">Total consolidado</span>
            <span class="tabular text-ink">{{ formatCentsBRL(data.cash.totalCents) }}</span>
          </div>

          <div class="mt-5 grid grid-cols-3 gap-3">
            <div class="rounded-card border border-line p-4">
              <p class="text-sm text-ink-soft">A receber</p>
              <p class="mt-1.5 text-[19px] font-bold tabular text-[rgb(var(--c-positive))]">
                {{ formatCentsBRL(data.cash.receivableCents) }}
              </p>
              <p class="mt-1 text-xs text-ink-muted">{{ data.cash.receivableCount }} contratos</p>
            </div>
            <div class="rounded-card border border-line p-4">
              <p class="text-sm text-ink-soft">A pagar</p>
              <p class="mt-1.5 text-[19px] font-bold tabular text-ink">
                {{ formatCentsBRL(data.cash.payableCents) }}
              </p>
              <p class="mt-1 text-xs text-ink-muted">{{ data.cash.payableCount }} contas</p>
            </div>
            <div class="rounded-card border border-line p-4">
              <p class="text-sm text-ink-soft">Vencidas</p>
              <p class="mt-1.5 text-[19px] font-bold tabular text-[rgb(var(--c-negative))]">
                {{ formatCentsBRL(data.cash.overdueCents) }}
              </p>
              <p class="mt-1 text-xs text-ink-muted">{{ data.cash.overdueClients }} clientes</p>
            </div>
          </div>
        </section>

        <section class="fo-card p-6">
          <div class="mb-5 flex items-center justify-between gap-3">
            <h2 class="text-xl font-bold text-ink">Próximos vencimentos</h2>
            <div class="flex gap-4 text-[15px]">
              <RouterLink to="/dashboard/finance/accounts-receivable" class="text-brand-600 hover:underline">
                A receber
              </RouterLink>
              <RouterLink to="/dashboard/finance/accounts-payable" class="text-brand-600 hover:underline">
                A pagar
              </RouterLink>
            </div>
          </div>

          <p v-if="data.upcoming.length === 0" class="py-12 text-center text-[17px] text-ink-muted">
            Nenhum vencimento nos próximos 30 dias
          </p>
          <ul v-else class="divide-y divide-line">
            <li v-for="item in data.upcoming" :key="`${item.kind}-${item.id}`" class="flex items-center justify-between gap-4 py-3.5">
              <div class="min-w-0">
                <p class="truncate text-[15px] font-medium text-ink">{{ item.description }}</p>
                <p class="mt-0.5 text-sm text-ink-muted">
                  {{ item.kind === 'RECEIVABLE' ? 'A receber' : 'A pagar' }} ·
                  {{ formatIsoDateBR(item.dueDate) }}
                </p>
              </div>
              <span
                class="shrink-0 tabular font-semibold"
                :class="item.kind === 'RECEIVABLE' ? 'text-[rgb(var(--c-positive))]' : 'text-ink'"
              >
                {{ formatCentsBRL(item.amountCents) }}
              </span>
            </li>
          </ul>
        </section>
      </div>
    </template>
  </div>
</template>
