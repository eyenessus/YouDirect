<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { AlarmClock, FileWarning, HandCoins, Receipt } from 'lucide-vue-next';
import {
  businessDate,
  formatCentsBRL,
  formatDateTimeBR,
  trafficFineStatusLabels,
  trafficFineStatuses,
  type TrafficFine,
  type TrafficFineSummary,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import DataTable, { type Column } from '@/components/ui/DataTable.vue';
import SearchInput from '@/components/ui/SearchInput.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import MetricCard from '@/components/ui/MetricCard.vue';
import ExportCsvButton from '@/components/ui/ExportCsvButton.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { fineDeadlineTone, statusTone } from '@/lib/status';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();
const today = businessDate();

const columns: Column[] = [
  { key: 'fine', label: 'Multa' },
  { key: 'vehicle', label: 'Veículo' },
  { key: 'occurred', label: 'Data da infração' },
  { key: 'driver', label: 'Motorista' },
  { key: 'amount', label: 'Valor' },
  { key: 'status', label: 'Status' },
];

const rows = ref<TrafficFine[]>([]);
const summary = ref<TrafficFineSummary | null>(null);
const loading = ref(true);
const query = ref('');
const total = ref(0);
const status = ref<string>((route.query.status as string) ?? '');
const deadline = ref<string>((route.query.deadline as string) ?? '');

const statusOptions = [
  { value: '', label: 'Todos os status' },
  { value: 'open', label: 'Em andamento' },
  ...trafficFineStatuses.map((s) => ({ value: s, label: trafficFineStatusLabels[s] })),
];
const deadlineOptions = [
  { value: '', label: 'Qualquer prazo' },
  { value: 'overdue', label: 'Indicação vencida' },
  { value: 'soon', label: 'Indicar em até 7 dias' },
];

const filters = computed(() => ({
  q: query.value || undefined,
  status: status.value && status.value !== 'open' ? status.value : undefined,
  openOnly: status.value === 'open' ? 'true' : undefined,
  deadline: deadline.value || undefined,
}));
const exportPath = computed(() => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters.value)) if (v) params.set(k, v);
  const qs = params.toString();
  return `/traffic-fines/export.csv${qs ? `?${qs}` : ''}`;
});

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ data: TrafficFine[]; summary: TrafficFineSummary; page: { total?: number } }>(
      '/traffic-fines',
      { query: { ...filters.value, limit: 100 } },
    );
    rows.value = res.data;
    summary.value = res.summary;
    total.value = res.page.total ?? res.data.length;
  } catch (err) {
    toasts.error('Falha ao carregar multas', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    loading.value = false;
  }
}

function quickFilter(next: { status?: string; deadline?: string }) {
  status.value = next.status ?? '';
  deadline.value = next.deadline ?? '';
  void load();
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader eyebrow="MULTAS" title="Multas de Trânsito" subtitle="Identifique o motorista, cumpra os prazos e repasse o valor">
      <template #actions>
        <ExportCsvButton :path="exportPath" filename="multas.csv" module="fines" />
        <AppButton v-if="auth.allows('fines', 'create')" @click="router.push('/dashboard/fines/new')">
          <template #icon><span class="text-lg leading-none">+</span></template>
          Nova Multa
        </AppButton>
      </template>
    </PageHeader>

    <div v-if="summary" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <button type="button" class="text-left" @click="quickFilter({ status: 'open' })">
        <MetricCard
          label="Em andamento"
          :value="String(summary.openCount)"
          :footnote="`${formatCentsBRL(summary.openAmountCents)} em multas`"
          :icon="Receipt"
          icon-tone="blue"
        />
      </button>
      <button type="button" class="text-left" @click="quickFilter({ deadline: 'overdue' })">
        <MetricCard
          label="Indicação vencida"
          :value="String(summary.indicationOverdueCount)"
          footnote="Risco de multa NIC"
          :icon="FileWarning"
          icon-tone="amber"
        />
      </button>
      <button type="button" class="text-left" @click="quickFilter({ deadline: 'soon' })">
        <MetricCard
          label="Indicar em até 7 dias"
          :value="String(summary.indicationDueSoonCount)"
          footnote="Prazos próximos"
          :icon="AlarmClock"
          icon-tone="purple"
        />
      </button>
      <button type="button" class="text-left" @click="quickFilter({})">
        <MetricCard
          label="Prontas para cobrar"
          :value="String(summary.toChargeCount)"
          footnote="Motorista identificado"
          :icon="HandCoins"
          icon-tone="green"
        />
      </button>
    </div>

    <section class="fo-card overflow-hidden">
      <div class="grid gap-4 p-6 lg:grid-cols-[1fr_220px_220px]">
        <SearchInput v-model="query" placeholder="Buscar por AIT, placa, motorista, infração..." label="Buscar multas" @search="load" />
        <AppSelect v-model="status" :options="statusOptions" aria-label="Filtrar por status" @update:model-value="load" />
        <AppSelect v-model="deadline" :options="deadlineOptions" aria-label="Filtrar por prazo" @update:model-value="load" />
      </div>

      <DataTable
        :columns="columns"
        :rows="rows"
        :loading="loading"
        caption="Lista de multas"
        empty-message="Nenhuma multa encontrada."
      >
        <template #cell-fine="{ row }">
          <RouterLink :to="`/dashboard/fines/${row.id}`" class="block font-semibold text-ink hover:text-brand-600">
            {{ row.fineNumber }}
          </RouterLink>
          <span class="mt-0.5 block max-w-[280px] truncate text-sm text-ink-muted" :title="row.infractionDescription">
            AIT {{ row.aitNumber }} · {{ row.infractionDescription }}
          </span>
        </template>
        <template #cell-vehicle="{ row }">
          <span class="block font-semibold text-ink">{{ row.vehicle.plate }}</span>
          <span class="mt-0.5 block text-sm text-ink-muted">{{ row.vehicle.brand }} {{ row.vehicle.model }}</span>
        </template>
        <template #cell-occurred="{ row }">
          <span class="tabular">{{ formatDateTimeBR(row.occurredAt) }}</span>
        </template>
        <template #cell-driver="{ row }">
          <RouterLink
            v-if="row.match.driver"
            :to="`/dashboard/drivers/${row.match.driver.id}`"
            class="block font-semibold text-ink hover:text-brand-600"
          >
            {{ row.match.driver.fullName }}
          </RouterLink>
          <span v-else class="text-sm font-medium text-[rgb(var(--c-warning))]">A identificar</span>
          <span v-if="row.match.rental" class="mt-0.5 block text-sm text-ink-muted">{{ row.match.rental.rentalNumber }}</span>
        </template>
        <template #cell-amount="{ row }">
          <span class="font-semibold tabular">{{ formatCentsBRL(row.amountCents) }}</span>
        </template>
        <template #cell-status="{ row }">
          <div class="flex flex-col items-start gap-1.5">
            <StatusBadge :label="trafficFineStatusLabels[row.status]" :tone="statusTone.fine[row.status]" :solid="false" />
            <StatusBadge
              v-if="fineDeadlineTone(row, today)"
              :label="fineDeadlineTone(row, today)!.label"
              :tone="fineDeadlineTone(row, today)!.tone"
            />
          </div>
        </template>
        <template #empty-action>
          <AppButton v-if="auth.allows('fines', 'create')" @click="router.push('/dashboard/fines/new')">Cadastrar multa</AppButton>
        </template>
      </DataTable>

      <p v-if="!loading && rows.length > 0" class="border-t border-line px-6 py-4 text-sm text-ink-muted">
        Mostrando {{ rows.length }} de {{ total }} multas
      </p>
    </section>
  </div>
</template>
