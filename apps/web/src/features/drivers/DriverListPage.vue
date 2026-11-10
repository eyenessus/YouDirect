<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Eye, Pencil, Trash2 } from 'lucide-vue-next';
import { driverStatusLabels, maskCpf, maskPhone, type Driver } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import ExportCsvButton from '@/components/ui/ExportCsvButton.vue';
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
  { key: 'name', label: 'Nome' },
  { key: 'cpf', label: 'CPF' },
  { key: 'phone', label: 'Telefone' },
  { key: 'email', label: 'Email' },
  { key: 'city', label: 'Cidade' },
  { key: 'status', label: 'Status' },
  { key: 'actions', label: 'Ações', width: '80px' },
];

const rows = ref<Driver[]>([]);
const loading = ref(true);
const query = ref('');
const total = ref(0);
const confirmTarget = ref<Driver | null>(null);
const deleting = ref(false);

const actions: ActionItem[] = [
  { key: 'view', label: 'Ver detalhes', icon: Eye },
  { key: 'edit', label: 'Editar', icon: Pencil },
  { key: 'delete', label: 'Excluir', icon: Trash2, danger: true },
];

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ data: Driver[]; page: { total?: number } }>('/drivers', {
      query: { q: query.value || undefined, limit: 50 },
    });
    rows.value = res.data;
    total.value = res.page.total ?? res.data.length;
  } catch (err) {
    toasts.error(
      'Falha ao carregar motoristas',
      err instanceof ApiRequestError ? err.message : undefined,
    );
  } finally {
    loading.value = false;
  }
}

function onAction(key: string, driver: Driver) {
  if (key === 'view') router.push(`/dashboard/drivers/${driver.id}`);
  else if (key === 'edit') router.push(`/dashboard/drivers/${driver.id}/edit`);
  else confirmTarget.value = driver;
}

async function confirmDelete() {
  if (!confirmTarget.value) return;
  deleting.value = true;
  try {
    await api.delete(`/drivers/${confirmTarget.value.id}`);
    toasts.success('Motorista removido');
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
      eyebrow="FROTA"
      title="Consulta de Motoristas"
      subtitle="Visualize e gerencie os motoristas cadastrados"
    >
      <template #actions>
        <ExportCsvButton path="/exports/drivers.csv" filename="motoristas.csv" module="drivers" />
        <AppButton v-if="auth.allows('drivers', 'create')" @click="router.push('/dashboard/drivers/new')">
          <template #icon><span class="text-lg leading-none">+</span></template>
          Novo Motorista
        </AppButton>
      </template>
    </PageHeader>

    <section class="fo-card overflow-hidden">
      <div class="p-6">
        <SearchInput
          v-model="query"
          placeholder="Buscar por nome, CPF, email ou telefone..."
          label="Buscar motoristas"
          @search="load"
        />
      </div>

      <DataTable
        :columns="columns"
        :rows="rows"
        :loading="loading"
        caption="Lista de motoristas"
        empty-message="Nenhum motorista encontrado."
      >
        <template #cell-name="{ row }">
          <RouterLink
            :to="`/dashboard/drivers/${row.id}`"
            class="font-semibold text-ink hover:text-brand-600"
          >
            {{ row.fullName }}
          </RouterLink>
        </template>
        <template #cell-cpf="{ row }"><span class="tabular">{{ maskCpf(row.cpf) }}</span></template>
        <template #cell-phone="{ row }"><span class="tabular">{{ maskPhone(row.phone) }}</span></template>
        <template #cell-email="{ row }">{{ row.email ?? '—' }}</template>
        <template #cell-city="{ row }">{{ row.address.city ?? '—' }}</template>
        <template #cell-status="{ row }">
          <StatusBadge
            :label="driverStatusLabels[row.status]"
            :tone="statusTone.driver[row.status]"
            :solid="false"
          />
        </template>
        <template #cell-actions="{ row }">
          <ActionMenu
            :items="actions"
            :label="`Ações de ${row.fullName}`"
            @select="onAction($event, row)"
          />
        </template>
        <template #empty-action>
          <AppButton v-if="auth.allows('drivers', 'create')" @click="router.push('/dashboard/drivers/new')">
            Cadastrar motorista
          </AppButton>
        </template>
      </DataTable>

      <p v-if="!loading && rows.length > 0" class="border-t border-line px-6 py-4 text-sm text-ink-muted">
        Mostrando {{ rows.length }} de {{ total }} motoristas
      </p>
    </section>

    <ConfirmDialog
      :open="confirmTarget !== null"
      title="Excluir motorista"
      :message="`Tem certeza que deseja excluir ${confirmTarget?.fullName ?? ''}? O cadastro é arquivado e o histórico de locações é preservado.`"
      confirm-label="Excluir"
      danger
      :loading="deleting"
      @cancel="confirmTarget = null"
      @confirm="confirmDelete"
    />
  </div>
</template>
