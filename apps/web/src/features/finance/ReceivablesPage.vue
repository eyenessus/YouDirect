<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { DollarSign } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  maskCpf,
  paymentMethodLabels,
  paymentMethods,
  receivableStatusLabels,
  receivableStatuses,
  type Receivable,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import ExportCsvButton from '@/components/ui/ExportCsvButton.vue';
import DataTable, { type Column } from '@/components/ui/DataTable.vue';
import SearchInput from '@/components/ui/SearchInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import ActionMenu, { type ActionItem } from '@/components/ui/ActionMenu.vue';
import FormField from '@/components/ui/FormField.vue';
import RegisterPaymentModal from './RegisterPaymentModal.vue';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

const auth = useAuthStore();
const toasts = useToastStore();

const columns: Column[] = [
  { key: 'client', label: 'Cliente' },
  { key: 'description', label: 'Descrição' },
  { key: 'gross', label: 'Valor Total' },
  { key: 'remaining', label: 'Valor Pendente' },
  { key: 'due', label: 'Vencimento' },
  { key: 'status', label: 'Status' },
  { key: 'actions', label: 'Ações', width: '80px' },
];

const rows = ref<Receivable[]>([]);
const totalPendingCents = ref(0);
const total = ref(0);
const loading = ref(true);
const filters = ref({ q: '', status: '', paymentMethod: '', sort: 'createdAt' });
const payTarget = ref<Receivable | null>(null);

const statusOptions = [
  { value: '', label: 'Todos os status' },
  ...receivableStatuses.map((s) => ({ value: s, label: receivableStatusLabels[s] })),
];
const methodOptions = [
  { value: '', label: 'Todos os métodos' },
  ...paymentMethods.map((m) => ({ value: m, label: paymentMethodLabels[m] })),
];
const sortOptions = [
  { value: 'createdAt', label: 'Data de Criação' },
  { value: 'dueDate', label: 'Vencimento' },
  { value: 'amount', label: 'Valor' },
  { value: 'client', label: 'Cliente' },
];

const actions: ActionItem[] = [{ key: 'pay', label: 'Pagar', icon: DollarSign }];

async function load() {
  loading.value = true;
  try {
    // Garante que os status vencidos estejam atualizados ao abrir a tela.
    await api.post('/finance/refresh-statuses').catch(() => undefined);
    const res = await api.get<{
      data: Receivable[];
      totalPendingCents: number;
      page: { total?: number };
    }>('/receivables', {
      query: {
        q: filters.value.q || undefined,
        status: filters.value.status || undefined,
        paymentMethod: filters.value.paymentMethod || undefined,
        sort: filters.value.sort,
        limit: 50,
      },
    });
    rows.value = res.data;
    totalPendingCents.value = res.totalPendingCents;
    total.value = res.page.total ?? res.data.length;
  } catch {
    toasts.error('Falha ao carregar contas a receber');
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
      title="Contas a Receber"
      subtitle="Visualize e gerencie todas as contas a receber"
    >
      <template #actions>
        <ExportCsvButton path="/exports/receivables.csv" filename="contas-a-receber.csv" module="finance" />
      </template>
    </PageHeader>

    <section class="fo-card overflow-hidden">
      <div class="p-6">
        <div
          class="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-card border border-line bg-surface-muted/60 px-6 py-5"
        >
          <span class="text-[17px] text-ink-soft">Valor Pendente Total</span>
          <span class="text-[26px] font-bold tabular text-brand-600">
            {{ formatCentsBRL(totalPendingCents) }}
          </span>
        </div>

        <SearchInput
          v-model="filters.q"
          placeholder="Buscar por descrição, cliente ou contrato..."
          label="Buscar contas a receber"
          @search="load"
        />

        <div class="mt-6 grid gap-5 lg:grid-cols-3">
          <FormField v-slot="field" label="Status">
            <AppSelect
              :id="field.id"
              v-model="filters.status"
              :options="statusOptions"
              @update:model-value="load"
            />
          </FormField>
          <FormField v-slot="field" label="Método de Pagamento">
            <AppSelect
              :id="field.id"
              v-model="filters.paymentMethod"
              :options="methodOptions"
              @update:model-value="load"
            />
          </FormField>
          <FormField v-slot="field" label="Ordenar por">
            <AppSelect
              :id="field.id"
              v-model="filters.sort"
              :options="sortOptions"
              @update:model-value="load"
            />
          </FormField>
        </div>
      </div>

      <DataTable
        :columns="columns"
        :rows="rows"
        :loading="loading"
        caption="Contas a receber"
        empty-message="Nenhuma conta a receber encontrada."
      >
        <template #cell-client="{ row }">
          <RouterLink
            :to="`/dashboard/drivers/${row.driver.id}`"
            class="block font-semibold text-ink hover:text-brand-600"
          >
            {{ row.driver.fullName }}
          </RouterLink>
          <span class="mt-0.5 block text-sm tabular text-ink-muted">{{ maskCpf(row.driver.cpf) }}</span>
        </template>
        <template #cell-description="{ row }">
          <span class="block text-ink">{{ row.description }}</span>
          <span v-if="row.rental" class="mt-0.5 block text-sm text-ink-muted">
            Contrato: {{ row.rental.rentalNumber }}
          </span>
        </template>
        <template #cell-gross="{ row }">
          <span class="tabular">{{ formatCentsBRL(row.grossAmountCents) }}</span>
        </template>
        <template #cell-remaining="{ row }">
          <span class="font-semibold tabular">{{ formatCentsBRL(row.remainingCents) }}</span>
        </template>
        <template #cell-due="{ row }">
          <span class="block tabular">{{ formatIsoDateBR(row.dueDate) }}</span>
          <span v-if="row.status === 'OVERDUE'" class="mt-0.5 block text-sm text-[rgb(var(--c-negative))]">
            Vencida
          </span>
        </template>
        <template #cell-status="{ row }">
          <StatusBadge
            :label="receivableStatusLabels[row.status]"
            :tone="statusTone.receivable[row.status]"
          />
        </template>
        <template #cell-actions="{ row }">
          <ActionMenu
            v-if="auth.allows('finance', 'pay') && row.remainingCents > 0"
            :items="actions"
            :label="`Ações de ${row.description}`"
            @select="payTarget = row"
          />
        </template>
      </DataTable>

      <p v-if="!loading && rows.length > 0" class="border-t border-line px-6 py-4 text-sm text-ink-muted">
        Mostrando {{ rows.length }} de {{ total }} contas
      </p>
    </section>

    <RegisterPaymentModal
      :open="payTarget !== null"
      kind="receivable"
      :target="
        payTarget
          ? {
              id: payTarget.id,
              description: `${payTarget.driver.fullName} · ${payTarget.description}`,
              remainingCents: payTarget.remainingCents,
            }
          : null
      "
      @close="payTarget = null"
      @saved="load"
    />
  </div>
</template>
