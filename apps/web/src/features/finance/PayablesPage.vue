<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { DollarSign, Trash2 } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  maskCnpj,
  payableStatusLabels,
  payableStatuses,
  type ExpenseCategory,
  type Payable,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import DataTable, { type Column } from '@/components/ui/DataTable.vue';
import SearchInput from '@/components/ui/SearchInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppButton from '@/components/ui/AppButton.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import ActionMenu, { type ActionItem } from '@/components/ui/ActionMenu.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import FormField from '@/components/ui/FormField.vue';
import RegisterPaymentModal from './RegisterPaymentModal.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();

const columns: Column[] = [
  { key: 'description', label: 'Descrição', width: '38.1%' },
  { key: 'category', label: 'Categoria', width: '11.7%' },
  { key: 'amount', label: 'Valor', width: '10.3%' },
  { key: 'due', label: 'Vencimento', width: '10.1%' },
  { key: 'supplier', label: 'Fornecedor', width: '15.4%' },
  { key: 'status', label: 'Status', width: '8.1%' },
  { key: 'actions', label: 'Ações', width: '6.3%' },
];

const rows = ref<Payable[]>([]);
const categories = ref<ExpenseCategory[]>([]);
const total = ref(0);
const loading = ref(true);
const filters = ref({ q: '', status: '', categoryId: '', sort: 'createdAt' });
const payTarget = ref<Payable | null>(null);
const confirmTarget = ref<Payable | null>(null);
const deleting = ref(false);

const statusOptions = [
  { value: '', label: 'Todos os status' },
  ...payableStatuses.map((s) => ({ value: s, label: payableStatusLabels[s] })),
];
const sortOptions = [
  { value: 'createdAt', label: 'Data de Criação' },
  { value: 'dueDate', label: 'Vencimento' },
  { value: 'amount', label: 'Valor' },
  { value: 'description', label: 'Descrição' },
];

function actionsFor(payable: Payable): ActionItem[] {
  const items: ActionItem[] = [];
  if (auth.allows('finance', 'pay') && payable.remainingCents > 0) {
    items.push({ key: 'pay', label: 'Registrar pagamento', icon: DollarSign });
  }
  if (auth.allows('finance', 'delete')) {
    items.push({ key: 'delete', label: 'Excluir', icon: Trash2, danger: true });
  }
  return items;
}

async function load() {
  loading.value = true;
  try {
    await api.post('/finance/refresh-statuses').catch(() => undefined);
    const [payables, cats] = await Promise.all([
      api.get<{ data: Payable[]; page: { total?: number } }>('/payables', {
        query: {
          q: filters.value.q || undefined,
          status: filters.value.status || undefined,
          categoryId: filters.value.categoryId || undefined,
          sort: filters.value.sort,
          limit: 50,
        },
      }),
      api.get<{ data: ExpenseCategory[] }>('/expense-categories'),
    ]);
    rows.value = payables.data;
    total.value = payables.page.total ?? payables.data.length;
    categories.value = cats.data;
  } catch {
    toasts.error('Falha ao carregar contas a pagar');
  } finally {
    loading.value = false;
  }
}

function onAction(key: string, payable: Payable) {
  if (key === 'pay') payTarget.value = payable;
  else confirmTarget.value = payable;
}

async function confirmDelete() {
  if (!confirmTarget.value) return;
  deleting.value = true;
  try {
    const res = await api.delete<{ reversed: boolean }>(`/payables/${confirmTarget.value.id}`);
    toasts.success(
      res.reversed ? 'Conta estornada' : 'Conta excluída',
      res.reversed ? 'O pagamento foi estornado no extrato — o histórico foi preservado.' : undefined,
    );
    confirmTarget.value = null;
    await load();
  } catch (err) {
    toasts.error('Não foi possível excluir', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    deleting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="FINANCEIRO"
      title="Contas a Pagar"
      subtitle="Visualize e gerencie todas as contas a pagar"
    >
      <template #actions>
        <AppButton
          v-if="auth.allows('finance', 'create')"
          @click="router.push('/dashboard/finance/accounts-payable/new')"
        >
          <template #icon><span class="text-lg leading-none">+</span></template>
          Nova Conta a Pagar
        </AppButton>
      </template>
    </PageHeader>

    <section class="fo-card overflow-hidden">
      <div class="p-6">
        <SearchInput
          v-model="filters.q"
          placeholder="Buscar por descrição ou fornecedor..."
          label="Buscar contas a pagar"
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
          <FormField v-slot="field" label="Categoria">
            <AppSelect
              :id="field.id"
              v-model="filters.categoryId"
              :options="[
                { value: '', label: 'Todas as categorias' },
                ...categories.map((c) => ({ value: c.id, label: c.label })),
              ]"
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
        caption="Contas a pagar"
        empty-message="Nenhuma conta a pagar encontrada."
      >
        <template #cell-description="{ row }">
          <span class="block font-semibold text-ink">{{ row.description }}</span>
          <span v-if="row.vehicle" class="mt-0.5 block text-sm text-ink-muted">
            Veículo: {{ row.vehicle.plate }}
          </span>
        </template>
        <template #cell-category="{ row }">{{ row.category?.label ?? '—' }}</template>
        <template #cell-amount="{ row }">
          <span class="font-semibold tabular">{{ formatCentsBRL(row.amountCents) }}</span>
        </template>
        <template #cell-due="{ row }">
          <span class="tabular">{{ formatIsoDateBR(row.dueDate) }}</span>
        </template>
        <template #cell-supplier="{ row }">
          <!-- O CNPJ fica no title para não poluir a coluna, como na referência. -->
          <span class="block" :title="row.supplierTaxId ? maskCnpj(row.supplierTaxId) : undefined">
            {{ row.supplierName ?? '—' }}
          </span>
        </template>
        <template #cell-status="{ row }">
          <StatusBadge :label="payableStatusLabels[row.status]" :tone="statusTone.payable[row.status]" />
        </template>
        <template #cell-actions="{ row }">
          <ActionMenu
            v-if="actionsFor(row).length > 0"
            :items="actionsFor(row)"
            :label="`Ações de ${row.description}`"
            @select="onAction($event, row)"
          />
        </template>
        <template #empty-action>
          <AppButton
            v-if="auth.allows('finance', 'create')"
            @click="router.push('/dashboard/finance/accounts-payable/new')"
          >
            Nova conta a pagar
          </AppButton>
        </template>
      </DataTable>

      <p v-if="!loading && rows.length > 0" class="border-t border-line px-6 py-4 text-sm text-ink-muted">
        Mostrando {{ rows.length }} de {{ total }} contas
      </p>
    </section>

    <RegisterPaymentModal
      :open="payTarget !== null"
      kind="payable"
      :target="
        payTarget
          ? { id: payTarget.id, description: payTarget.description, remainingCents: payTarget.remainingCents }
          : null
      "
      @close="payTarget = null"
      @saved="load"
    />

    <ConfirmDialog
      :open="confirmTarget !== null"
      title="Excluir conta a pagar"
      :message="
        (confirmTarget?.paidAmountCents ?? 0) > 0
          ? 'Esta conta já possui pagamento registrado. A exclusão gera um estorno no extrato e marca a conta como cancelada — nada é apagado do histórico.'
          : 'Tem certeza que deseja excluir esta conta a pagar?'
      "
      confirm-label="Excluir"
      danger
      :loading="deleting"
      @cancel="confirmTarget = null"
      @confirm="confirmDelete"
    />
  </div>
</template>
