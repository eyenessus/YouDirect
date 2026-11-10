<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Car, Eye, Pencil, Receipt, Trash2 } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  formatKm,
  vehicleStatusLabels,
  type TrafficFinesResponse,
  type Vehicle,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import ExportCsvButton from '@/components/ui/ExportCsvButton.vue';
import DataTable, { type Column } from '@/components/ui/DataTable.vue';
import SearchInput from '@/components/ui/SearchInput.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import ActionMenu, { type ActionItem } from '@/components/ui/ActionMenu.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();

const columns: Column[] = [
  { key: 'image', label: 'Imagem', width: '120px' },
  { key: 'plate', label: 'Placa' },
  { key: 'vehicle', label: 'Veículo' },
  { key: 'brand', label: 'Marca' },
  { key: 'color', label: 'Cor' },
  { key: 'km', label: 'KM' },
  { key: 'availability', label: 'Disponibilidade' },
  { key: 'purchase', label: 'Preço da compra' },
  { key: 'created', label: 'Data de Cadastro' },
  { key: 'actions', label: 'Ações', width: '80px' },
];

const rows = ref<Vehicle[]>([]);
const loading = ref(true);
const query = ref('');
const total = ref(0);

const confirmTarget = ref<Vehicle | null>(null);
const deleting = ref(false);

const finesVehicle = ref<Vehicle | null>(null);
const finesResult = ref<TrafficFinesResponse | null>(null);
const finesLoading = ref(false);
const finesError = ref('');

function actionsFor(): ActionItem[] {
  return [
    { key: 'view', label: 'Ver detalhes', icon: Eye },
    { key: 'fines', label: 'Consultar multas', icon: Receipt },
    { key: 'edit', label: 'Editar', icon: Pencil, disabled: !auth.allows('vehicles', 'update') },
    {
      key: 'delete',
      label: 'Excluir',
      icon: Trash2,
      danger: true,
      disabled: !auth.allows('vehicles', 'delete'),
    },
  ];
}

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ data: Vehicle[]; page: { total?: number } }>('/vehicles', {
      query: { q: query.value || undefined, limit: 50 },
    });
    rows.value = res.data;
    total.value = res.page.total ?? res.data.length;
  } catch (err) {
    toasts.error(
      'Falha ao carregar veículos',
      err instanceof ApiRequestError ? err.message : undefined,
    );
  } finally {
    loading.value = false;
  }
}

async function onAction(key: string, vehicle: Vehicle) {
  if (key === 'view') return router.push(`/dashboard/vehicles/${vehicle.id}`);
  if (key === 'edit') return router.push(`/dashboard/vehicles/${vehicle.id}/edit`);
  if (key === 'delete') {
    confirmTarget.value = vehicle;
    return;
  }
  if (key === 'fines') {
    finesVehicle.value = vehicle;
    finesResult.value = null;
    finesError.value = '';
    finesLoading.value = true;
    try {
      finesResult.value = await api.get<TrafficFinesResponse>(
        `/vehicles/${vehicle.id}/traffic-fines`,
      );
    } catch (err) {
      finesError.value =
        err instanceof ApiRequestError ? err.message : 'Não foi possível consultar as multas.';
    } finally {
      finesLoading.value = false;
    }
  }
}

async function confirmDelete() {
  if (!confirmTarget.value) return;
  deleting.value = true;
  try {
    await api.delete(`/vehicles/${confirmTarget.value.id}`);
    toasts.success('Veículo removido', 'O histórico financeiro e de manutenção foi preservado.');
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
      eyebrow="FROTA"
      title="Consulta de Veículos"
      subtitle="Visualize e gerencie sua frota de veículos"
    >
      <template #actions>
        <ExportCsvButton path="/exports/vehicles.csv" filename="veiculos.csv" module="vehicles" />
        <AppButton v-if="auth.allows('vehicles', 'create')" @click="router.push('/dashboard/vehicles/new')">
          <template #icon><span class="text-lg leading-none">+</span></template>
          Novo Veículo
        </AppButton>
      </template>
    </PageHeader>

    <section class="fo-card overflow-hidden">
      <div class="p-6">
        <SearchInput
          v-model="query"
          placeholder="Filtrar por placa, marca, cor..."
          label="Filtrar veículos"
          @search="load"
        />
      </div>

      <DataTable
        :columns="columns"
        :rows="rows"
        :loading="loading"
        caption="Lista de veículos da frota"
        empty-message="Nenhum veículo encontrado. Cadastre o primeiro veículo da frota para começar."
      >
        <template #cell-image="{ row }">
          <img
            v-if="row.photos[0]"
            :src="row.photos[0].url"
            :alt="`Foto do veículo ${row.plate}`"
            class="h-14 w-[88px] rounded object-cover"
            loading="lazy"
          />
          <div
            v-else
            class="flex h-14 w-[88px] items-center justify-center rounded bg-surface-muted"
            aria-hidden="true"
          >
            <Car class="size-5 text-ink-muted" />
          </div>
        </template>
        <template #cell-plate="{ row }">
          <RouterLink
            :to="`/dashboard/vehicles/${row.id}`"
            class="font-semibold text-ink hover:text-brand-600"
          >
            {{ row.plate }}
          </RouterLink>
        </template>
        <template #cell-vehicle="{ row }">{{ row.model }}</template>
        <template #cell-brand="{ row }">{{ row.brand }}</template>
        <template #cell-color="{ row }">{{ row.color ?? '—' }}</template>
        <template #cell-km="{ row }"><span class="tabular">{{ formatKm(row.mileageKm) }}</span></template>
        <template #cell-availability="{ row }">
          <StatusBadge :label="vehicleStatusLabels[row.status]" :tone="statusTone.vehicle[row.status]" />
        </template>
        <template #cell-purchase="{ row }">
          <span class="tabular">
            {{ row.purchaseAmountCents !== null ? formatCentsBRL(row.purchaseAmountCents) : '—' }}
          </span>
        </template>
        <template #cell-created="{ row }">
          <span class="tabular">{{ formatIsoDateBR(row.createdAt) }}</span>
        </template>
        <template #cell-actions="{ row }">
          <ActionMenu
            :items="actionsFor()"
            :label="`Ações do veículo ${row.plate}`"
            @select="onAction($event, row)"
          />
        </template>
        <template #empty-action>
          <AppButton v-if="auth.allows('vehicles', 'create')" @click="router.push('/dashboard/vehicles/new')">
            Cadastrar veículo
          </AppButton>
        </template>
      </DataTable>

      <p v-if="!loading && rows.length > 0" class="border-t border-line px-6 py-4 text-sm text-ink-muted">
        Mostrando {{ rows.length }} de {{ total }} veículos
      </p>
    </section>

    <ConfirmDialog
      :open="confirmTarget !== null"
      title="Excluir veículo"
      :message="`Tem certeza que deseja excluir o veículo ${confirmTarget?.plate ?? ''}? O registro é arquivado — manutenções, vistorias e lançamentos financeiros continuam disponíveis no histórico.`"
      confirm-label="Excluir"
      danger
      :loading="deleting"
      @cancel="confirmTarget = null"
      @confirm="confirmDelete"
    />

    <AppModal
      :open="finesVehicle !== null"
      :title="`Consultar multas — ${finesVehicle?.plate ?? ''}`"
      @close="finesVehicle = null"
    >
      <p v-if="finesLoading" class="text-[15px] text-ink-muted">Consultando o provedor…</p>
      <p v-else-if="finesError" class="text-[15px] text-negative">{{ finesError }}</p>
      <template v-else-if="finesResult">
        <div
          v-if="!finesResult.available"
          class="rounded-card border border-[rgb(var(--c-warning)/0.3)] bg-[rgb(var(--c-warning)/0.08)] p-4"
        >
          <p class="text-[15px] font-semibold text-ink">Consulta indisponível</p>
          <p class="mt-1.5 text-sm leading-relaxed text-ink-soft">{{ finesResult.message }}</p>
        </div>
        <template v-else>
          <p v-if="finesResult.fines.length === 0" class="text-[15px] text-ink-muted">
            Nenhuma multa encontrada no provedor consultado.
          </p>
          <ul v-else class="divide-y divide-line">
            <li v-for="fine in finesResult.fines" :key="fine.code" class="py-3">
              <p class="font-medium text-ink">{{ fine.description }}</p>
              <p class="mt-1 text-sm text-ink-muted">
                {{ fine.code }} · {{ formatCentsBRL(fine.amountCents) }} · {{ fine.status }}
              </p>
            </li>
          </ul>
        </template>
      </template>
      <template #footer>
        <AppButton variant="secondary" @click="finesVehicle = null">Fechar</AppButton>
      </template>
    </AppModal>
  </div>
</template>
