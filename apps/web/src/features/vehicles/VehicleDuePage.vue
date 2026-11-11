<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { CalendarClock } from 'lucide-vue-next';
import { formatIsoDateBR, vehicleDueKindLabels, type VehicleDueItem } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppTabs, { type TabItem } from '@/components/ui/AppTabs.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

/** Vencimentos de IPVA, licenciamento e seguro da frota, dos mais urgentes para os mais distantes. */
const toasts = useToastStore();
const items = ref<VehicleDueItem[]>([]);
const loading = ref(true);
const kind = ref<'ALL' | 'IPVA' | 'LICENSING' | 'INSURANCE'>('ALL');
const withinDays = ref('60');

const kindTabs: TabItem[] = [
  { key: 'ALL', label: 'Todos' },
  { key: 'IPVA', label: vehicleDueKindLabels.IPVA },
  { key: 'LICENSING', label: vehicleDueKindLabels.LICENSING },
  { key: 'INSURANCE', label: vehicleDueKindLabels.INSURANCE },
];
const windowTabs: TabItem[] = [
  { key: '30', label: '30 dias' },
  { key: '60', label: '60 dias' },
  { key: '90', label: '90 dias' },
];

async function load() {
  loading.value = true;
  try {
    const query = new URLSearchParams({ withinDays: withinDays.value });
    if (kind.value !== 'ALL') query.set('kind', kind.value);
    items.value = (await api.get<{ data: VehicleDueItem[] }>(`/vehicles/due?${query}`)).data;
  } catch (err) {
    toasts.error('Não foi possível carregar os vencimentos', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch([kind, withinDays], load);

const overdue = computed(() => items.value.filter((i) => i.status === 'OVERDUE').length);

function whenLabel(item: VehicleDueItem): string {
  if (item.daysLeft < 0) return `Venceu há ${-item.daysLeft} dia(s)`;
  if (item.daysLeft === 0) return 'Vence hoje';
  return `Em ${item.daysLeft} dia(s)`;
}
function tone(item: VehicleDueItem) {
  return item.status === 'OVERDUE' || item.daysLeft <= 7 ? 'red' : item.status === 'SOON' ? 'amber' : 'green';
}
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Veículos"
      title="Vencimentos da frota"
      subtitle="IPVA, licenciamento e seguro dos veículos, com alerta automático em 30, 15 e 7 dias, no dia e depois de vencer."
    />

    <div class="mb-5 flex flex-wrap items-center gap-3">
      <AppTabs v-model="kind" :items="kindTabs" />
      <AppTabs v-model="withinDays" :items="windowTabs" />
      <p v-if="overdue > 0" class="text-sm font-semibold text-[rgb(var(--c-negative))]" role="status">
        {{ overdue }} vencimento(s) em atraso
      </p>
    </div>

    <div class="fo-card overflow-x-auto">
      <p v-if="loading" class="p-8 text-ink-muted" role="status">Carregando...</p>
      <EmptyState
        v-else-if="items.length === 0"
        :icon="CalendarClock"
        title="Nada vencendo"
        message="Nenhum vencimento dentro do prazo escolhido. Informe as datas de IPVA, licenciamento e seguro no cadastro de cada veículo."
      />
      <table v-else class="w-full text-left text-[15px]">
        <thead class="border-b border-line text-sm text-ink-muted">
          <tr>
            <th class="px-5 py-3 font-semibold">Veículo</th>
            <th class="px-5 py-3 font-semibold">Item</th>
            <th class="px-5 py-3 font-semibold">Vencimento</th>
            <th class="px-5 py-3 font-semibold">Situação</th>
            <th class="px-5 py-3 font-semibold"><span class="sr-only">Ação</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="`${item.vehicleId}-${item.kind}`" class="border-b border-line last:border-0">
            <td class="px-5 py-3">
              <span class="font-semibold text-ink">{{ item.plate }}</span>
              <span class="ml-2 text-ink-muted">{{ item.label }}</span>
            </td>
            <td class="px-5 py-3">{{ vehicleDueKindLabels[item.kind] }}</td>
            <td class="px-5 py-3">{{ formatIsoDateBR(item.dueDate) }}</td>
            <td class="px-5 py-3"><StatusBadge :label="whenLabel(item)" :tone="tone(item)" /></td>
            <td class="px-5 py-3 text-right">
              <RouterLink :to="`/dashboard/vehicles/${item.vehicleId}/edit`" class="text-sm font-semibold text-brand-600 hover:underline">
                Atualizar data
              </RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
