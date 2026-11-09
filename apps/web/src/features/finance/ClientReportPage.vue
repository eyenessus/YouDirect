<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { formatCentsBRL, maskCpf, type ClientReport } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import DataTable, { type Column } from '@/components/ui/DataTable.vue';
import SearchInput from '@/components/ui/SearchInput.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const toasts = useToastStore();

const columns: Column[] = [
  { key: 'name', label: 'Cliente' },
  { key: 'cpf', label: 'CPF' },
  { key: 'paid', label: 'Total Pago' },
  { key: 'open', label: 'Em Aberto' },
  { key: 'rentals', label: 'Locações' },
  { key: 'status', label: 'Status' },
];

const rows = ref<ClientReport['rows']>([]);
const loading = ref(true);
const query = ref('');

async function load() {
  loading.value = true;
  try {
    const res = await api.get<ClientReport>('/reports/by-client', {
      query: { q: query.value || undefined },
    });
    rows.value = res.rows;
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
      title="Relatório por Cliente"
      subtitle="Análise financeira por cliente"
    />

    <div class="max-w-md">
      <SearchInput
        v-model="query"
        placeholder="Buscar por nome ou CPF..."
        label="Buscar clientes"
        @search="load"
      />
    </div>

    <section class="fo-card overflow-hidden pt-6">
      <DataTable
        :columns="columns"
        :rows="rows.map((r) => ({ ...r, id: r.driverId }))"
        :loading="loading"
        caption="Resultado financeiro por cliente"
        empty-message="Nenhum cliente com movimentação financeira."
      >
        <template #cell-name="{ row }">
          <RouterLink
            :to="`/dashboard/drivers/${row.driverId}`"
            class="font-semibold text-ink hover:text-brand-600"
          >
            {{ row.name }}
          </RouterLink>
        </template>
        <template #cell-cpf="{ row }">
          <span class="tabular text-ink-soft">{{ row.cpf ? maskCpf(row.cpf) : '—' }}</span>
        </template>
        <template #cell-paid="{ row }">
          <span class="tabular text-[rgb(var(--c-positive))]">{{ formatCentsBRL(row.paidCents) }}</span>
        </template>
        <template #cell-open="{ row }">
          <span class="tabular text-brand-600">{{ formatCentsBRL(row.openCents) }}</span>
        </template>
        <template #cell-rentals="{ row }">
          <span class="tabular">{{ row.rentals }}</span>
        </template>
        <template #cell-status="{ row }">
          <StatusBadge
            :label="row.status === 'OPEN' ? 'Em Aberto' : 'Quitado'"
            :tone="row.status === 'OPEN' ? 'slate' : 'green'"
            :solid="false"
          />
        </template>
      </DataTable>
    </section>
  </div>
</template>
