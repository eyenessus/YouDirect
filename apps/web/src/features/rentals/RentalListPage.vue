<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Pencil, Trash2 } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  maskCpf,
  rentalStatusLabels,
  type Rental,
} from '@frotaone/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import DataTable, { type Column } from '@/components/ui/DataTable.vue';
import SearchInput from '@/components/ui/SearchInput.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import ActionMenu, { type ActionItem } from '@/components/ui/ActionMenu.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();

const columns: Column[] = [
  { key: 'number', label: 'Número' },
  { key: 'vehicle', label: 'Veículo' },
  { key: 'driver', label: 'Motorista' },
  { key: 'period', label: 'Período' },
  { key: 'status', label: 'Status' },
  { key: 'amount', label: 'Valor' },
  { key: 'created', label: 'Criado em' },
  { key: 'actions', label: 'Ações', width: '80px' },
];

const rows = ref<Rental[]>([]);
const loading = ref(true);
const query = ref('');
const total = ref(0);
const confirmTarget = ref<Rental | null>(null);
const deleting = ref(false);

const actions: ActionItem[] = [
  { key: 'edit', label: 'Editar', icon: Pencil },
  { key: 'delete', label: 'Excluir', icon: Trash2, danger: true },
];

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ data: Rental[]; page: { total?: number } }>('/rentals', {
      query: { q: query.value || undefined, limit: 50 },
    });
    rows.value = res.data;
    total.value = res.page.total ?? res.data.length;
  } catch (err) {
    toasts.error('Falha ao carregar locações', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    loading.value = false;
  }
}

function onAction(key: string, rental: Rental) {
  if (key === 'edit') router.push(`/dashboard/rentals/${rental.id}/edit`);
  else confirmTarget.value = rental;
}

async function confirmDelete() {
  if (!confirmTarget.value) return;
  deleting.value = true;
  try {
    await api.delete(`/rentals/${confirmTarget.value.id}`);
    toasts.success('Locação cancelada');
    confirmTarget.value = null;
    await load();
  } catch (err) {
    toasts.error(
      'Não foi possível excluir',
      err instanceof ApiRequestError ? err.message : undefined,
    );
  } finally {
    deleting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="LOCAÇÕES"
      title="Consulta de Locações"
      subtitle="Visualize e gerencie todas as locações cadastradas"
    >
      <template #actions>
        <AppButton v-if="auth.allows('rentals', 'create')" @click="router.push('/dashboard/rentals/new')">
          <template #icon><span class="text-lg leading-none">+</span></template>
          Nova Locação
        </AppButton>
      </template>
    </PageHeader>

    <section class="fo-card overflow-hidden">
      <div class="p-6">
        <SearchInput
          v-model="query"
          placeholder="Buscar por número, placa, motorista..."
          label="Buscar locações"
          @search="load"
        />
      </div>

      <DataTable
        :columns="columns"
        :rows="rows"
        :loading="loading"
        caption="Lista de locações"
        empty-message="Nenhuma locação cadastrada."
      >
        <template #cell-number="{ row }">
          <span class="font-semibold text-ink">{{ row.rentalNumber }}</span>
        </template>
        <template #cell-vehicle="{ row }">
          <RouterLink
            :to="`/dashboard/vehicles/${row.vehicle.id}`"
            class="block font-semibold text-ink hover:text-brand-600"
          >
            {{ row.vehicle.plate }}
          </RouterLink>
          <span class="mt-0.5 block text-sm text-ink-muted">
            {{ row.vehicle.brand }} {{ row.vehicle.model }}
          </span>
        </template>
        <template #cell-driver="{ row }">
          <RouterLink
            :to="`/dashboard/drivers/${row.driver.id}`"
            class="block font-semibold text-ink hover:text-brand-600"
          >
            {{ row.driver.fullName }}
          </RouterLink>
          <span class="mt-0.5 block text-sm tabular text-ink-muted">{{ maskCpf(row.driver.cpf) }}</span>
        </template>
        <template #cell-period="{ row }">
          <span class="block tabular">{{ formatIsoDateBR(row.startDate) }}</span>
          <span v-if="row.endDate" class="mt-0.5 block text-sm tabular text-ink-muted">
            até {{ formatIsoDateBR(row.endDate) }}
          </span>
        </template>
        <template #cell-status="{ row }">
          <StatusBadge
            :label="rentalStatusLabels[row.status]"
            :tone="statusTone.rental[row.status]"
            :solid="false"
          />
        </template>
        <template #cell-amount="{ row }">
          <span class="font-semibold tabular">{{ formatCentsBRL(row.periodicAmountCents) }}</span>
        </template>
        <template #cell-created="{ row }">
          <span class="tabular">{{ formatIsoDateBR(row.createdAt) }}</span>
        </template>
        <template #cell-actions="{ row }">
          <ActionMenu
            :items="actions"
            :label="`Ações da locação ${row.rentalNumber}`"
            @select="onAction($event, row)"
          />
        </template>
        <template #empty-action>
          <AppButton v-if="auth.allows('rentals', 'create')" @click="router.push('/dashboard/rentals/new')">
            Cadastrar locação
          </AppButton>
        </template>
      </DataTable>

      <p v-if="!loading && rows.length > 0" class="border-t border-line px-6 py-4 text-sm text-ink-muted">
        Mostrando {{ rows.length }} de {{ total }} locações
      </p>
    </section>

    <ConfirmDialog
      :open="confirmTarget !== null"
      title="Excluir locação"
      :message="`Tem certeza que deseja excluir a locação ${confirmTarget?.rentalNumber ?? ''}? Contratos com recebimentos registrados não podem ser excluídos — encerre-os para preservar o histórico financeiro.`"
      confirm-label="Excluir"
      danger
      :loading="deleting"
      @cancel="confirmTarget = null"
      @confirm="confirmDelete"
    />
  </div>
</template>
