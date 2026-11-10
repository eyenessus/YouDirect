<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ScrollText } from 'lucide-vue-next';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';

/** Trilha de auditoria da organização (somente proprietário/administrador). */
interface AuditRow {
  id: string;
  occurredAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { id: string; name: string } | null;
  before: unknown;
  after: unknown;
}

const ENTITY_LABELS: Record<string, string> = {
  vehicle: 'Veículo',
  driver: 'Motorista',
  rental: 'Locação',
  inspection: 'Vistoria',
  maintenanceOrder: 'Manutenção',
  payable: 'Conta a pagar',
  receivable: 'Conta a receber',
  bankAccount: 'Conta bancária',
  bankTransaction: 'Lançamento',
  invitation: 'Convite',
  membership: 'Colaborador',
  user: 'Usuário',
  messageDispatch: 'Disparo',
};

const ACTION_LABELS: Record<string, string> = {
  created: 'criado',
  updated: 'alterado',
  deleted: 'excluído',
  canceled: 'cancelado',
  closed: 'encerrado',
  completed: 'concluído',
  reversed: 'estornado',
  payment: 'pagamento registrado',
  accepted: 'aceito',
  resent: 'reenviado',
  removed: 'removido',
  permissions_updated: 'permissões alteradas',
  role_updated: 'papel alterado',
  password_changed: 'senha alterada',
  password_reset: 'senha redefinida',
  rescheduled: 'reagendada',
  anonymized: 'anonimizado (LGPD)',
  data_exported: 'dados exportados (LGPD)',
  csv: 'exportação CSV',
  manual: 'lançamento manual',
  archived: 'arquivado',
};

function describe(row: AuditRow): string {
  const verb = row.action.split('.').slice(1).join('.');
  const entity = ENTITY_LABELS[row.entityType] ?? row.entityType;
  return `${entity} — ${ACTION_LABELS[verb] ?? verb.replace(/_/g, ' ')}`;
}

const rows = ref<AuditRow[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
const expanded = ref<Set<string>>(new Set());
const filters = reactive({ entityType: '', from: '', to: '' });

const entityOptions = [
  { value: '', label: 'Todos' },
  ...Object.entries(ENTITY_LABELS).map(([value, label]) => ({ value, label })),
];

async function load(more = false) {
  if (more) loadingMore.value = true;
  else {
    loading.value = true;
    error.value = '';
  }
  try {
    const res = await api.get<{ data: AuditRow[]; page: { nextCursor: string | null } }>('/audit-logs', {
      query: {
        entityType: filters.entityType || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        cursor: more ? (nextCursor.value ?? undefined) : undefined,
        limit: 50,
      },
    });
    rows.value = more ? [...rows.value, ...res.data] : res.data;
    nextCursor.value = res.page.nextCursor;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Não foi possível carregar a auditoria.';
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function toggle(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

const hasDetail = (row: AuditRow) => row.before !== null || row.after !== null;

onMounted(() => load());
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="ORGANIZAÇÃO"
      title="Auditoria"
      subtitle="Quem fez o quê e quando. Os registros são guardados por 5 anos."
    />

    <section class="fo-card grid gap-4 p-6 sm:grid-cols-4 sm:items-end">
      <FormField v-slot="field" label="Tipo">
        <AppSelect :id="field.id" v-model="filters.entityType" :options="entityOptions" />
      </FormField>
      <FormField v-slot="field" label="De">
        <AppInput :id="field.id" v-model="filters.from" type="date" />
      </FormField>
      <FormField v-slot="field" label="Até">
        <AppInput :id="field.id" v-model="filters.to" type="date" />
      </FormField>
      <AppButton @click="load()">Filtrar</AppButton>
    </section>

    <AppSkeleton v-if="loading" variant="table" />

    <section v-else-if="error" class="fo-card p-8 text-center" role="alert">
      <p class="font-semibold text-ink">{{ error }}</p>
      <AppButton class="mt-4" variant="secondary" @click="load()">Tentar de novo</AppButton>
    </section>

    <section v-else class="fo-card overflow-hidden">
      <EmptyState v-if="rows.length === 0" :icon="ScrollText" message="Nenhum registro no período." />
      <ul v-else class="divide-y divide-line">
        <li v-for="row in rows" :key="row.id" class="p-5">
          <div class="flex flex-wrap items-baseline justify-between gap-3">
            <p class="font-semibold text-ink">{{ describe(row) }}</p>
            <time class="text-sm tabular text-ink-muted" :datetime="row.occurredAt">
              {{ new Date(row.occurredAt).toLocaleString('pt-BR') }}
            </time>
          </div>
          <p class="mt-1 text-sm text-ink-muted">
            {{ row.actor ? row.actor.name : 'Sistema' }}
            <span v-if="row.entityId" class="tabular"> · #{{ row.entityId.slice(-6) }}</span>
          </p>
          <button
            v-if="hasDetail(row)"
            type="button"
            class="mt-2 text-sm font-medium text-brand-600 hover:underline"
            :aria-expanded="expanded.has(row.id)"
            @click="toggle(row.id)"
          >
            {{ expanded.has(row.id) ? 'Ocultar detalhes' : 'Ver detalhes' }}
          </button>
          <div v-if="expanded.has(row.id)" class="mt-3 grid gap-3 lg:grid-cols-2">
            <div v-if="row.before !== null">
              <p class="fo-label">Antes</p>
              <pre class="max-h-72 overflow-auto rounded-control bg-surface-muted p-3 text-xs text-ink-soft">{{ JSON.stringify(row.before, null, 2) }}</pre>
            </div>
            <div v-if="row.after !== null">
              <p class="fo-label">Depois</p>
              <pre class="max-h-72 overflow-auto rounded-control bg-surface-muted p-3 text-xs text-ink-soft">{{ JSON.stringify(row.after, null, 2) }}</pre>
            </div>
          </div>
        </li>
      </ul>
      <div v-if="nextCursor" class="border-t border-line p-4 text-center">
        <AppButton variant="secondary" :loading="loadingMore" @click="load(true)">Carregar mais</AppButton>
      </div>
    </section>
  </div>
</template>
