<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { CalendarCheck, Download, ExternalLink, Eye, FileText, Trash2, Wrench } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  maintenanceStatusLabels,
  maintenanceTypeLabels,
  paymentMethodLabels,
  type MaintenanceOrder,
  type MaintenanceSummary,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import DataTable, { type Column } from '@/components/ui/DataTable.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import ActionMenu, { type ActionItem } from '@/components/ui/ActionMenu.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppModal from '@/components/ui/AppModal.vue';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

interface HistoryResponse {
  vehicle: { id: string; plate: string; brand: string; model: string; year: number | null };
  summary: MaintenanceSummary;
  data: MaintenanceOrder[];
}

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();

const vehicleId = route.params.vehicleId as string;
const history = ref<HistoryResponse | null>(null);
const loading = ref(true);
const downloading = ref(false);
const detail = ref<MaintenanceOrder | null>(null);
const attachmentsFor = ref<MaintenanceOrder | null>(null);
const confirmTarget = ref<MaintenanceOrder | null>(null);
const deleting = ref(false);

const columns: Column[] = [
  { key: 'number', label: 'Nº OS' },
  { key: 'description', label: 'Descrição' },
  { key: 'type', label: 'Tipo' },
  { key: 'date', label: 'Data' },
  { key: 'parts', label: 'Peças' },
  { key: 'total', label: 'Custo Total' },
  { key: 'attachments', label: 'Anexos' },
  { key: 'status', label: 'Status' },
  { key: 'actions', label: 'Ações', width: '80px' },
];

function actionsFor(order: MaintenanceOrder): ActionItem[] {
  return [
    { key: 'view', label: 'Ver detalhes', icon: Eye },
    {
      key: 'cancel',
      label: 'Cancelar OS',
      icon: CalendarCheck,
      disabled: order.status === 'CANCELED' || !auth.allows('maintenance', 'update'),
    },
    {
      key: 'delete',
      label: 'Excluir',
      icon: Trash2,
      danger: true,
      disabled: !auth.allows('maintenance', 'delete'),
    },
  ];
}

async function load() {
  loading.value = true;
  try {
    history.value = await api.get<HistoryResponse>(`/vehicles/${vehicleId}/maintenance`);
  } catch {
    toasts.error('Veículo não encontrado');
    router.replace('/dashboard/maintenance');
  } finally {
    loading.value = false;
  }
}

async function onAction(key: string, order: MaintenanceOrder) {
  if (key === 'view') detail.value = order;
  else if (key === 'delete') confirmTarget.value = order;
  else if (key === 'cancel') {
    try {
      await api.post(`/maintenance/${order.id}/cancel`);
      toasts.success('OS cancelada', 'O lançamento bancário foi estornado.');
      await load();
    } catch (err) {
      toasts.error('Não foi possível cancelar', err instanceof ApiRequestError ? err.message : undefined);
    }
  }
}

async function confirmDelete() {
  if (!confirmTarget.value) return;
  deleting.value = true;
  try {
    await api.delete(`/maintenance/${confirmTarget.value.id}`);
    toasts.success('OS excluída', 'O lançamento bancário foi estornado.');
    confirmTarget.value = null;
    await load();
  } catch (err) {
    toasts.error('Não foi possível excluir', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    deleting.value = false;
  }
}

async function download() {
  downloading.value = true;
  try {
    await downloadFile(
      `/vehicles/${vehicleId}/maintenance/report.pdf`,
      `manutencoes-${history.value?.vehicle.plate ?? 'veiculo'}.pdf`,
    );
  } catch (err) {
    toasts.error(
      'Não foi possível gerar o relatório',
      err instanceof ApiRequestError ? err.message : undefined,
    );
  } finally {
    downloading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="MANUTENÇÃO"
      :title="
        history ? `${history.vehicle.plate} — ${history.vehicle.brand} ${history.vehicle.model}` : 'Histórico'
      "
      :subtitle="history?.vehicle.year ? `${history.vehicle.year} · Histórico de manutenções` : 'Histórico de manutenções'"
      back-to="/dashboard/maintenance"
    >
      <template #actions>
        <AppButton
          v-if="auth.allows('maintenance', 'export')"
          variant="secondary"
          :loading="downloading"
          @click="download"
        >
          <template #icon><Download class="size-4" /></template>
          Baixar relatório
        </AppButton>
        <AppButton
          v-if="auth.allows('maintenance', 'create')"
          @click="router.push(`/dashboard/maintenance/${vehicleId}/new`)"
        >
          <template #icon><span class="text-lg leading-none">+</span></template>
          Nova Manutenção
        </AppButton>
      </template>
    </PageHeader>

    <div v-if="history" class="grid gap-5 sm:grid-cols-3">
      <div class="fo-card flex items-center gap-4 p-6">
        <Wrench class="size-7 text-brand-500" aria-hidden="true" />
        <div>
          <p class="text-[15px] text-ink-soft">Total de OS</p>
          <p class="mt-1 text-[30px] font-bold leading-none tabular text-ink">
            {{ history.summary.orderCount }}
          </p>
        </div>
      </div>
      <div class="fo-card flex items-center gap-4 p-6">
        <span class="text-2xl font-bold text-[rgb(var(--c-negative))]">$</span>
        <div>
          <p class="text-[15px] text-ink-soft">Custo Total</p>
          <p class="mt-1 text-[30px] font-bold leading-none tabular text-ink">
            {{ formatCentsBRL(history.summary.totalCents) }}
          </p>
        </div>
      </div>
      <div class="fo-card flex items-center gap-4 p-6">
        <CalendarCheck class="size-7 text-[rgb(var(--c-positive))]" aria-hidden="true" />
        <div>
          <p class="text-[15px] text-ink-soft">Concluídas</p>
          <p class="mt-1 text-[30px] font-bold leading-none tabular text-ink">
            {{ history.summary.completedCount }}
          </p>
        </div>
      </div>
    </div>

    <section class="fo-card overflow-hidden">
      <h2 class="px-6 pb-2 pt-6 text-xl font-bold text-ink">Histórico de Manutenções</h2>
      <DataTable
        :columns="columns"
        :rows="history?.data ?? []"
        :loading="loading"
        caption="Ordens de serviço do veículo"
        empty-message="Nenhuma manutenção registrada para este veículo."
      >
        <template #cell-number="{ row }">
          <span class="font-mono text-sm text-ink-soft">{{ row.orderNumber }}</span>
        </template>
        <template #cell-description="{ row }">
          <span class="line-clamp-1 font-medium text-ink">{{ row.description }}</span>
        </template>
        <template #cell-type="{ row }">
          <span class="inline-flex rounded-full border border-line px-3 py-1 text-xs font-semibold text-ink-soft">
            {{ maintenanceTypeLabels[row.type] }}
          </span>
        </template>
        <template #cell-date="{ row }">
          <span class="tabular">{{ formatIsoDateBR(row.performedAt) }}</span>
        </template>
        <template #cell-parts="{ row }">
          {{ row.items.length }} {{ row.items.length === 1 ? 'peça' : 'peças' }}
        </template>
        <template #cell-total="{ row }">
          <span class="font-semibold tabular">{{ formatCentsBRL(row.totalCents) }}</span>
        </template>
        <template #cell-attachments="{ row }">
          <button
            v-if="row.invoice"
            type="button"
            class="inline-flex items-center gap-1.5 text-ink-soft transition-colors hover:text-brand-600"
            :aria-label="`Anexos da OS ${row.orderNumber}`"
            @click="attachmentsFor = row"
          >
            <FileText class="size-[18px]" />
            <span class="tabular">1</span>
          </button>
          <span v-else class="text-ink-muted">—</span>
        </template>
        <template #cell-status="{ row }">
          <StatusBadge
            :label="maintenanceStatusLabels[row.status]"
            :tone="statusTone.maintenance[row.status]"
          />
        </template>
        <template #cell-actions="{ row }">
          <ActionMenu
            :items="actionsFor(row)"
            :label="`Ações da OS ${row.orderNumber}`"
            @select="onAction($event, row)"
          />
        </template>
      </DataTable>
    </section>

    <!-- Popover de anexos -->
    <AppModal
      :open="attachmentsFor !== null"
      :title="`Anexos da OS ${attachmentsFor?.orderNumber ?? ''}`"
      size="sm"
      @close="attachmentsFor = null"
    >
      <p class="text-[15px] font-medium text-ink">{{ attachmentsFor?.invoice?.label }}</p>
      <a
        v-if="attachmentsFor?.invoice"
        :href="attachmentsFor.invoice.url"
        target="_blank"
        rel="noopener"
        class="mt-3 inline-flex items-center gap-2 text-[15px] font-medium text-brand-600 hover:underline"
      >
        <FileText class="size-4" /> Visualizar nota fiscal
        <ExternalLink class="size-3.5" />
      </a>
    </AppModal>

    <!-- Detalhe da OS -->
    <AppModal
      :open="detail !== null"
      :title="`OS ${detail?.orderNumber ?? ''}`"
      :description="detail?.description"
      size="lg"
      @close="detail = null"
    >
      <template v-if="detail">
        <dl class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          <div>
            <dt class="text-sm text-ink-muted">Tipo</dt>
            <dd class="mt-0.5 font-semibold text-ink">{{ maintenanceTypeLabels[detail.type] }}</dd>
          </div>
          <div>
            <dt class="text-sm text-ink-muted">Situação</dt>
            <dd class="mt-0.5 font-semibold text-ink">{{ maintenanceStatusLabels[detail.status] }}</dd>
          </div>
          <div>
            <dt class="text-sm text-ink-muted">Abertura</dt>
            <dd class="mt-0.5 font-semibold tabular text-ink">{{ formatIsoDateBR(detail.openedAt) }}</dd>
          </div>
          <div>
            <dt class="text-sm text-ink-muted">Execução</dt>
            <dd class="mt-0.5 font-semibold tabular text-ink">{{ formatIsoDateBR(detail.performedAt) }}</dd>
          </div>
          <div>
            <dt class="text-sm text-ink-muted">Quilometragem</dt>
            <dd class="mt-0.5 font-semibold tabular text-ink">
              {{ detail.mileageKm !== null ? `${detail.mileageKm.toLocaleString('pt-BR')} km` : '—' }}
            </dd>
          </div>
          <div>
            <dt class="text-sm text-ink-muted">Pagamento</dt>
            <dd class="mt-0.5 font-semibold text-ink">
              {{ paymentMethodLabels[detail.paymentMethod] }}
              <span v-if="detail.bankAccount" class="font-normal text-ink-muted">
                · {{ detail.bankAccount.name }}
              </span>
            </dd>
          </div>
        </dl>

        <h3 class="mb-3 mt-7 text-lg font-bold text-ink">Peças e itens</h3>
        <p v-if="detail.items.length === 0" class="text-[15px] text-ink-muted">
          Nenhuma peça registrada nesta OS.
        </p>
        <table v-else class="fo-table text-sm">
          <thead>
            <tr>
              <th scope="col">Peça</th>
              <th scope="col">Qtd</th>
              <th scope="col" class="text-right">Unitário</th>
              <th scope="col" class="text-right">Subtotal</th>
              <th scope="col">Fornecedor</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in detail.items" :key="item.name">
              <td>{{ item.name }}</td>
              <td class="tabular">{{ item.quantity }}</td>
              <td class="text-right tabular">{{ formatCentsBRL(item.unitCostCents) }}</td>
              <td class="text-right tabular">{{ formatCentsBRL(item.subtotalCents) }}</td>
              <td>{{ item.supplier ?? '—' }}</td>
            </tr>
          </tbody>
        </table>

        <div class="mt-6 space-y-2 rounded-card bg-surface-muted p-5 text-[15px]">
          <div class="flex justify-between">
            <span class="text-ink-soft">Custo das peças:</span>
            <span class="tabular text-ink">{{ formatCentsBRL(detail.partsCostCents) }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-ink-soft">Mão de obra:</span>
            <span class="tabular text-ink">{{ formatCentsBRL(detail.laborCostCents) }}</span>
          </div>
          <div class="flex justify-between border-t border-line pt-2 text-[17px] font-bold">
            <span class="text-ink">Total:</span>
            <span class="tabular text-[rgb(var(--c-positive))]">{{ formatCentsBRL(detail.totalCents) }}</span>
          </div>
        </div>
      </template>
    </AppModal>

    <ConfirmDialog
      :open="confirmTarget !== null"
      title="Excluir ordem de serviço"
      :message="`Excluir a OS ${confirmTarget?.orderNumber ?? ''}? O lançamento bancário correspondente será estornado — o extrato não é apagado.`"
      confirm-label="Excluir"
      danger
      :loading="deleting"
      @cancel="confirmTarget = null"
      @confirm="confirmDelete"
    />
  </div>
</template>
