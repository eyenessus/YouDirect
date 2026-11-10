<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {
  AlertTriangle,
  CheckCheck,
  Clock,
  Eye,
  ImageOff,
  Inbox,
  MessageCircle,
  RefreshCw,
  Send,
  XCircle,
} from 'lucide-vue-next';
import {
  formatDateTimeBR,
  messageKindLabels,
  messageKinds,
  messageStatusLabels,
  messageStatuses,
  type MessageStatus,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import AppTabs, { type TabItem } from '@/components/ui/AppTabs.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import DataTable, { type Column } from '@/components/ui/DataTable.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import FormField from '@/components/ui/FormField.vue';
import MetricCard from '@/components/ui/MetricCard.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { statusTone } from '@/lib/status';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/* ------------------------------------------------------------------ *
 * Mensagens WhatsApp — visibilidade operacional da coleta de vistoria
 * via Whaply (plano §10). Não replica o inbox do Whaply: mostra o que o
 * YuDirect precisa para agir (estado real, falhas, fotos, custos).
 * ------------------------------------------------------------------ */

interface MessageRow {
  id: string;
  kind: keyof typeof messageKindLabels;
  kindLabel: string;
  status: MessageStatus;
  statusLabel: string;
  templateName: string | null;
  category: string | null;
  recipientName: string | null;
  phone: string;
  inspection: {
    id: string;
    vehicleId: string;
    status: string;
    collectionStatus: string | null;
    collectionStatusLabel: string | null;
    photosReceived: number;
    photosRequired: number | null;
  } | null;
  vehicle: { plate: string; label: string } | null;
  attempts: number;
  wamid: string | null;
  lastError: { code: string; message: string; source: string; at: string } | null;
  needsAction: boolean;
  manual: boolean;
  createdAt: string;
  lastEventAt: string | null;
}

interface MessageDetail extends MessageRow {
  idempotencyKey: string;
  correlationId: string;
  whaplyRequestId: string | null;
  events: Array<{ at: string; type: string; status: string | null; source: string; detail: string | null }>;
  related: MessageRow[];
}

interface Summary {
  channel: { connected: boolean; message: string };
  messages: Record<'total' | 'processing' | 'sent' | 'delivered' | 'read' | 'failed' | 'retrying' | 'canceled', number>;
  collections: Record<'responded' | 'incomplete' | 'complete' | 'blocked' | 'expired' | 'failed' | 'awaitingApproval' | 'unmatchedPhotos', number>;
}

interface CostRow {
  month: string;
  category: string;
  billable: boolean | null;
  delivered: number;
  rate: { amount: number; currency: string; source: string; effectiveFrom: string } | null;
  estimated: number | null;
}

const route = useRoute();
const auth = useAuthStore();
const toasts = useToastStore();

const tab = ref<string>((route.query.tab as string) || 'overview');
const summary = ref<Summary | null>(null);
const rows = ref<MessageRow[]>([]);
const loadingRows = ref(false);
const detail = ref<MessageDetail | null>(null);
const confirmResend = ref<MessageRow | null>(null);
const busy = ref(false);

const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const filters = ref({
  from: iso(new Date(today.getTime() - 30 * 86400_000)),
  to: iso(today),
  status: '',
  kind: '',
  q: '',
  needsAction: false,
});

const tabs = computed<TabItem[]>(() => [
  { key: 'overview', label: 'Visão geral' },
  { key: 'history', label: 'Histórico' },
  { key: 'costs', label: 'Custos' },
  { key: 'unmatched', label: 'Fotos sem vínculo', badge: summary.value?.collections.unmatchedPhotos || undefined },
]);

const statusOptions = [{ value: '', label: 'Todos' }, ...messageStatuses.map((s) => ({ value: s, label: messageStatusLabels[s] }))];
const kindOptions = [{ value: '', label: 'Todos' }, ...messageKinds.map((k) => ({ value: k, label: messageKindLabels[k] }))];

const columns: Column[] = [
  { key: 'createdAt', label: 'Data', width: '150px' },
  { key: 'recipient', label: 'Cliente' },
  { key: 'vehicle', label: 'Veículo / vistoria' },
  { key: 'kind', label: 'Tipo' },
  { key: 'status', label: 'Envio' },
  { key: 'photos', label: 'Fotos' },
  { key: 'error', label: 'Último erro' },
  { key: 'actions', label: 'Ações', srOnly: true, width: '120px' },
];

async function loadSummary() {
  try {
    summary.value = await api.get<Summary>('/messaging/summary', { query: { from: filters.value.from, to: filters.value.to } });
  } catch {
    toasts.error('Não foi possível carregar o resumo');
  }
}

async function loadRows() {
  loadingRows.value = true;
  try {
    const res = await api.get<{ data: MessageRow[] }>('/messaging/messages', {
      query: {
        from: filters.value.from || undefined,
        to: filters.value.to || undefined,
        status: filters.value.status || undefined,
        kind: filters.value.kind || undefined,
        q: filters.value.q || undefined,
        needsAction: filters.value.needsAction ? 'true' : undefined,
        limit: 100,
      },
    });
    rows.value = res.data;
  } catch {
    toasts.error('Não foi possível carregar o histórico');
  } finally {
    loadingRows.value = false;
  }
}

async function openDetail(id: string) {
  try {
    detail.value = await api.get<MessageDetail>(`/messaging/messages/${id}`);
  } catch {
    toasts.error('Mensagem não encontrada');
  }
}

async function resend() {
  if (!confirmResend.value) return;
  busy.value = true;
  try {
    await api.post(`/messaging/messages/${confirmResend.value.id}/resend`, { confirm: true });
    toasts.success('Reenvio registrado', 'Será enviado pelo Whaply em instantes.');
    confirmResend.value = null;
    await Promise.all([loadRows(), loadSummary()]);
  } catch (err) {
    toasts.error('Não foi possível reenviar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    busy.value = false;
  }
}

async function retry(row: MessageRow) {
  try {
    await api.post(`/messaging/messages/${row.id}/retry`);
    toasts.success('Reprocessamento agendado');
    await loadRows();
  } catch (err) {
    toasts.error('Não foi possível reprocessar', err instanceof ApiRequestError ? err.message : undefined);
  }
}

/* ------------------------------ custos ---------------------------- */
const costs = ref<{ disclaimer: string; data: CostRow[]; rates: Array<{ id: string; category: string; currency: string; amount: number; effectiveFrom: string; source: string }> } | null>(null);
const rateForm = ref({ category: 'UTILITY', currency: 'BRL', amount: '', effectiveFrom: iso(today), source: '' });
const categoryOptions = ['UTILITY', 'MARKETING', 'AUTHENTICATION', 'SERVICE'].map((c) => ({ value: c, label: c }));
const currencyOptions = [{ value: 'BRL', label: 'BRL' }, { value: 'USD', label: 'USD' }];

async function loadCosts() {
  try {
    costs.value = await api.get('/messaging/costs', { query: { months: 6 } });
  } catch {
    toasts.error('Não foi possível carregar os custos');
  }
}

async function saveRate() {
  try {
    await api.post('/messaging/rates', { ...rateForm.value, amount: Number(rateForm.value.amount.replace(',', '.')) });
    toasts.success('Tarifa de referência registrada');
    rateForm.value.amount = '';
    rateForm.value.source = '';
    await loadCosts();
  } catch (err) {
    toasts.error('Tarifa inválida', err instanceof ApiRequestError ? err.message : undefined);
  }
}

function money(value: number | null, currency: string | undefined) {
  if (value === null || !currency) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

/* ------------------------- fotos sem vínculo ---------------------- */
const unmatched = ref<Array<{ id: string; url: string; reason: string; receivedAt: string }>>([]);
const assignable = ref<{ data: Array<{ id: string; label: string }>; slots: Array<{ code: string; label: string }> } | null>(null);
const assignForm = ref<Record<string, { inspectionId: string; slotCode: string }>>({});

async function loadUnmatched() {
  try {
    const [list, options] = await Promise.all([
      api.get<{ data: typeof unmatched.value }>('/messaging/unmatched-media'),
      api.get<NonNullable<typeof assignable.value>>('/messaging/assignable-inspections'),
    ]);
    unmatched.value = list.data;
    assignable.value = options;
    for (const item of list.data) assignForm.value[item.id] ??= { inspectionId: '', slotCode: '' };
  } catch {
    toasts.error('Não foi possível carregar as fotos sem vínculo');
  }
}

async function assign(id: string) {
  const form = assignForm.value[id];
  if (!form?.inspectionId || !form.slotCode) return toasts.error('Escolha a vistoria e o ângulo');
  try {
    await api.post(`/messaging/unmatched-media/${id}/assign`, form);
    toasts.success('Foto atribuída à vistoria');
    await Promise.all([loadUnmatched(), loadSummary()]);
  } catch (err) {
    toasts.error('Não foi possível atribuir', err instanceof ApiRequestError ? err.message : undefined);
  }
}

async function discard(id: string) {
  try {
    await api.post(`/messaging/unmatched-media/${id}/discard`);
    toasts.success('Foto descartada');
    await Promise.all([loadUnmatched(), loadSummary()]);
  } catch (err) {
    toasts.error('Não foi possível descartar', err instanceof ApiRequestError ? err.message : undefined);
  }
}

const sourceLabels: Record<string, string> = {
  YUDIRECT: 'YuDirect',
  TRANSPORT: 'Comunicação',
  WHAPLY: 'Whaply',
  META: 'Meta',
  SYSTEM: 'Sistema',
};

function refresh() {
  void loadSummary();
  if (tab.value === 'history') void loadRows();
  if (tab.value === 'costs') void loadCosts();
  if (tab.value === 'unmatched') void loadUnmatched();
}

watch(tab, refresh);
onMounted(async () => {
  refresh();
  if (route.query.message) await openDetail(String(route.query.message));
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="NOTIFICAÇÕES"
      title="Mensagens WhatsApp"
      subtitle="Solicitações de vistoria enviadas pelo WhatsApp oficial da locadora, estado real de entrega e fotos recebidas"
    >
      <template #actions>
        <AppButton variant="secondary" @click="refresh">
          <template #icon><RefreshCw class="size-4" /></template>
          Atualizar
        </AppButton>
      </template>
    </PageHeader>

    <div
      v-if="summary && !summary.channel.connected"
      role="status"
      class="flex items-start gap-3 rounded-card border border-[rgb(var(--c-warning)/0.3)] bg-[rgb(var(--c-warning)/0.08)] p-4"
    >
      <AlertTriangle class="mt-0.5 size-5 shrink-0 text-[rgb(var(--c-warning))]" aria-hidden="true" />
      <div>
        <p class="text-[15px] font-semibold text-ink">Canal do WhatsApp (Whaply) não conectado</p>
        <p class="mt-1 text-sm text-ink-soft">{{ summary.channel.message }}</p>
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-4">
      <AppTabs v-model="tab" :items="tabs" />
      <div class="flex flex-wrap items-end gap-3">
        <FormField v-slot="field" label="De">
          <AppInput :id="field.id" v-model="filters.from" type="date" @change="refresh" />
        </FormField>
        <FormField v-slot="field" label="Até">
          <AppInput :id="field.id" v-model="filters.to" type="date" @change="refresh" />
        </FormField>
      </div>
    </div>

    <!-- ----------------------------- visão geral --------------------------- -->
    <template v-if="tab === 'overview'">
      <AppSkeleton v-if="!summary" variant="cards" :rows="4" />
      <template v-else>
        <h2 class="text-lg font-bold text-ink">Envio das mensagens</h2>
        <div class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Solicitações de mensagem" :value="String(summary.messages.total)" :icon="MessageCircle" />
          <MetricCard label="Em processamento" :value="String(summary.messages.processing)" :icon="Clock" icon-tone="amber" />
          <MetricCard label="Enviadas" :value="String(summary.messages.sent)" :icon="Send" />
          <MetricCard label="Entregues" :value="String(summary.messages.delivered)" :icon="CheckCheck" icon-tone="green" />
          <MetricCard label="Lidas" :value="String(summary.messages.read)" :icon="Eye" icon-tone="green" footnote="Quando o cliente permite confirmação de leitura" />
          <MetricCard label="Com falha" :value="String(summary.messages.failed)" :icon="XCircle" icon-tone="amber" value-tone="negative" />
          <MetricCard label="Aguardando nova tentativa" :value="String(summary.messages.retrying)" :icon="RefreshCw" icon-tone="amber" />
          <MetricCard label="Clientes que responderam" :value="String(summary.collections.responded)" :icon="Inbox" icon-tone="purple" />
        </div>
        <h2 class="pt-2 text-lg font-bold text-ink">Coleta de fotos</h2>
        <div class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Fotos incompletas" :value="String(summary.collections.incomplete)" icon-tone="amber" :icon="ImageOff" />
          <MetricCard label="Fotos completas" :value="String(summary.collections.complete)" icon-tone="green" :icon="CheckCheck" />
          <MetricCard label="Aguardando aprovação" :value="String(summary.collections.awaitingApproval)" :icon="Clock" />
          <MetricCard
            label="Bloqueadas / expiradas / falhas"
            :value="`${summary.collections.blocked} / ${summary.collections.expired} / ${summary.collections.failed}`"
            icon-tone="amber"
            :icon="AlertTriangle"
          />
        </div>
      </template>
    </template>

    <!-- ------------------------------ histórico ----------------------------- -->
    <section v-else-if="tab === 'history'" class="fo-card">
      <div class="grid gap-4 p-6 md:grid-cols-2 xl:grid-cols-5">
        <FormField v-slot="field" label="Cliente ou placa">
          <AppInput :id="field.id" v-model="filters.q" placeholder="Buscar" @keyup.enter="loadRows" @blur="loadRows" />
        </FormField>
        <FormField v-slot="field" label="Status do envio">
          <AppSelect :id="field.id" v-model="filters.status" :options="statusOptions" @update:model-value="loadRows" />
        </FormField>
        <FormField v-slot="field" label="Tipo">
          <AppSelect :id="field.id" v-model="filters.kind" :options="kindOptions" @update:model-value="loadRows" />
        </FormField>
        <label class="flex items-center gap-2 self-end pb-3 text-[15px] text-ink-soft">
          <input v-model="filters.needsAction" type="checkbox" class="size-[18px] rounded border-line" @change="loadRows" />
          Requer ação manual
        </label>
      </div>
      <DataTable :columns="columns" :rows="rows" :loading="loadingRows" caption="Histórico de mensagens WhatsApp" empty-message="Nenhuma mensagem no período.">
        <template #cell-createdAt="{ row }">
          <span class="tabular">{{ formatDateTimeBR(row.createdAt) }}</span>
        </template>
        <template #cell-recipient="{ row }">
          <span class="font-semibold text-ink">{{ row.recipientName ?? '—' }}</span>
          <span class="block text-sm text-ink-muted tabular">{{ row.phone }}</span>
        </template>
        <template #cell-vehicle="{ row }">
          <RouterLink
            v-if="row.inspection && row.vehicle"
            :to="`/dashboard/inspections/${row.inspection.vehicleId}`"
            class="font-semibold text-brand-600 hover:underline"
          >
            {{ row.vehicle.plate }}
          </RouterLink>
          <span v-else>—</span>
          <span v-if="row.inspection?.collectionStatusLabel" class="block text-sm text-ink-muted">
            {{ row.inspection.collectionStatusLabel }}
          </span>
        </template>
        <template #cell-kind="{ row }">
          {{ row.kindLabel }}
          <span v-if="row.manual" class="block text-xs text-ink-muted">reenvio manual</span>
        </template>
        <template #cell-status="{ row }">
          <StatusBadge :label="row.statusLabel" :tone="statusTone.message[row.status]" :solid="false" />
        </template>
        <template #cell-photos="{ row }">
          <span v-if="row.inspection?.photosRequired" class="tabular">
            {{ row.inspection.photosReceived }}/{{ row.inspection.photosRequired }}
          </span>
          <span v-else>—</span>
        </template>
        <template #cell-error="{ row }">
          <span v-if="row.lastError" class="text-sm text-[rgb(var(--c-negative))]">
            {{ sourceLabels[row.lastError.source] ?? row.lastError.source }} · {{ row.lastError.code }}
          </span>
          <span v-else>—</span>
        </template>
        <template #cell-actions="{ row }">
          <div class="flex justify-end gap-1">
            <AppButton size="sm" variant="ghost" :aria-label="`Detalhes da mensagem para ${row.recipientName}`" @click="openDetail(row.id)">
              Detalhes
            </AppButton>
          </div>
        </template>
      </DataTable>
    </section>

    <!-- -------------------------------- custos ------------------------------ -->
    <template v-else-if="tab === 'costs'">
      <div class="rounded-card border border-line bg-surface-muted p-4 text-sm leading-relaxed text-ink-soft" role="note">
        {{ costs?.disclaimer ?? 'Carregando…' }}
      </div>
      <section class="fo-card">
        <h2 class="px-6 pt-6 text-lg font-bold text-ink">Mensagens entregues por categoria</h2>
        <DataTable
          :columns="[
            { key: 'month', label: 'Mês' },
            { key: 'category', label: 'Categoria' },
            { key: 'billable', label: 'Cobrável (Meta)' },
            { key: 'delivered', label: 'Entregues' },
            { key: 'rate', label: 'Tarifa de referência' },
            { key: 'estimated', label: 'Custo estimado' },
          ]"
          :rows="(costs?.data ?? []).map((r, i) => ({ ...r, id: String(i) }))"
          :loading="!costs"
          empty-message="Nenhuma mensagem entregue nos últimos 6 meses."
        >
          <template #cell-month="{ row }"><span class="tabular">{{ row.month }}</span></template>
          <template #cell-category="{ row }">{{ row.category }}</template>
          <template #cell-billable="{ row }">{{ row.billable === true ? 'Sim' : row.billable === false ? 'Não' : 'Sem informação' }}</template>
          <template #cell-delivered="{ row }"><span class="tabular">{{ row.delivered }}</span></template>
          <template #cell-rate="{ row }">
            <span v-if="row.rate" class="tabular">{{ money(row.rate.amount, row.rate.currency) }}</span>
            <span v-else class="text-ink-muted">Sem tarifa cadastrada</span>
          </template>
          <template #cell-estimated="{ row }">
            <span class="tabular font-semibold">{{ money(row.estimated, row.rate?.currency) }}</span>
            <span class="block text-xs text-ink-muted">estimativa</span>
          </template>
        </DataTable>
      </section>

      <section v-if="auth.allows('notifications', 'update')" class="fo-card p-6">
        <h2 class="text-lg font-bold text-ink">Registrar tarifa de referência</h2>
        <p class="mt-1 text-sm text-ink-muted">
          Use a tabela oficial vigente da Meta para o Brasil e informe a fonte. A tarifa vale a partir da data indicada.
        </p>
        <div class="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <FormField v-slot="field" label="Categoria">
            <AppSelect :id="field.id" v-model="rateForm.category" :options="categoryOptions" />
          </FormField>
          <FormField v-slot="field" label="Moeda">
            <AppSelect :id="field.id" v-model="rateForm.currency" :options="currencyOptions" />
          </FormField>
          <FormField v-slot="field" label="Valor por mensagem">
            <AppInput :id="field.id" v-model="rateForm.amount" inputmode="decimal" placeholder="0,0000" />
          </FormField>
          <FormField v-slot="field" label="Vigente desde">
            <AppInput :id="field.id" v-model="rateForm.effectiveFrom" type="date" />
          </FormField>
          <FormField v-slot="field" label="Fonte">
            <AppInput :id="field.id" v-model="rateForm.source" placeholder="URL ou documento" />
          </FormField>
        </div>
        <AppButton class="mt-5" @click="saveRate">Registrar tarifa</AppButton>
        <ul v-if="costs?.rates.length" class="mt-6 space-y-1 text-sm text-ink-soft">
          <li v-for="r in costs.rates" :key="r.id">
            {{ r.category }} · {{ money(r.amount, r.currency) }} desde {{ r.effectiveFrom }} — {{ r.source }}
          </li>
        </ul>
      </section>
    </template>

    <!-- --------------------------- fotos sem vínculo ------------------------ -->
    <template v-else-if="tab === 'unmatched'">
      <EmptyState v-if="unmatched.length === 0" :icon="ImageOff" message="Nenhuma foto aguardando atribuição." />
      <div v-else class="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        <article v-for="item in unmatched" :key="item.id" class="fo-card overflow-hidden">
          <img :src="item.url" :alt="`Foto recebida em ${formatDateTimeBR(item.receivedAt)}`" class="aspect-[4/3] w-full object-cover" />
          <div class="space-y-3 p-5">
            <p class="text-sm text-ink-muted">{{ formatDateTimeBR(item.receivedAt) }} · {{ item.reason }}</p>
            <template v-if="auth.allows('inspections', 'review') && assignForm[item.id]">
              <FormField v-slot="field" label="Vistoria">
                <AppSelect
                  :id="field.id"
                  v-model="assignForm[item.id]!.inspectionId"
                  placeholder="Selecione"
                  :options="(assignable?.data ?? []).map((i) => ({ value: i.id, label: i.label }))"
                />
              </FormField>
              <FormField v-slot="field" label="Ângulo">
                <AppSelect
                  :id="field.id"
                  v-model="assignForm[item.id]!.slotCode"
                  placeholder="Selecione"
                  :options="(assignable?.slots ?? []).map((s) => ({ value: s.code, label: s.label }))"
                />
              </FormField>
              <div class="flex gap-3">
                <AppButton size="sm" @click="assign(item.id)">Atribuir</AppButton>
                <AppButton size="sm" variant="danger-outline" @click="discard(item.id)">Descartar</AppButton>
              </div>
            </template>
          </div>
        </article>
      </div>
    </template>

    <!-- ---------------------------- detalhe ------------------------------- -->
    <AppModal :open="detail !== null" title="Detalhes da comunicação" size="lg" @close="detail = null">
      <template v-if="detail">
        <dl class="grid gap-x-6 gap-y-3 text-[15px] sm:grid-cols-2">
          <div><dt class="text-ink-muted">Cliente</dt><dd class="font-semibold text-ink">{{ detail.recipientName }} · {{ detail.phone }}</dd></div>
          <div><dt class="text-ink-muted">Tipo / template</dt><dd class="font-semibold text-ink">{{ detail.kindLabel }} · {{ detail.templateName ?? '—' }}</dd></div>
          <div><dt class="text-ink-muted">Estado</dt><dd><StatusBadge :label="detail.statusLabel" :tone="statusTone.message[detail.status]" :solid="false" /></dd></div>
          <div><dt class="text-ink-muted">Tentativas</dt><dd class="font-semibold tabular text-ink">{{ detail.attempts }}</dd></div>
          <div class="sm:col-span-2"><dt class="text-ink-muted">Correlação</dt><dd class="break-all font-mono text-xs text-ink-soft">{{ detail.correlationId }} · {{ detail.idempotencyKey }}</dd></div>
          <div v-if="detail.lastError" class="sm:col-span-2">
            <dt class="text-ink-muted">Último erro</dt>
            <dd class="text-[rgb(var(--c-negative))]">{{ sourceLabels[detail.lastError.source] }} · {{ detail.lastError.code }} — {{ detail.lastError.message }}</dd>
          </div>
        </dl>

        <h3 class="mt-6 text-base font-bold text-ink">Linha do tempo</h3>
        <ol class="mt-3 space-y-2 border-l border-line pl-4">
          <li v-for="(e, i) in detail.events" :key="i" class="text-sm">
            <span class="tabular text-ink-muted">{{ formatDateTimeBR(e.at) }}</span>
            <span class="ml-2 font-semibold text-ink">{{ e.type }}</span>
            <span class="ml-2 text-ink-muted">({{ sourceLabels[e.source] ?? e.source }})</span>
            <span v-if="e.detail" class="block text-ink-soft">{{ e.detail }}</span>
          </li>
        </ol>

        <div class="mt-6 flex flex-wrap gap-3">
          <RouterLink
            v-if="detail.inspection"
            :to="`/dashboard/inspections/${detail.inspection.vehicleId}`"
            class="inline-flex items-center rounded-control border border-line px-4 py-2 text-[15px] font-medium text-ink hover:bg-surface-muted"
          >
            Abrir vistoria
          </RouterLink>
          <AppButton
            v-if="auth.allows('notifications', 'dispatch') && detail.status === 'FAILED' && detail.lastError?.source === 'TRANSPORT'"
            variant="secondary"
            @click="retry(detail); detail = null"
          >
            Reprocessar (mesma solicitação)
          </AppButton>
          <AppButton
            v-if="auth.allows('notifications', 'dispatch') && detail.kind !== 'SESSION_PROMPT' && ['FAILED', 'CANCELED'].includes(detail.status)"
            @click="confirmResend = detail; detail = null"
          >
            Reenviar
          </AppButton>
        </div>
      </template>
    </AppModal>

    <ConfirmDialog
      :open="confirmResend !== null"
      title="Reenviar solicitação"
      message="Um NOVO envio será feito ao cliente pelo WhatsApp (pode gerar cobrança da Meta). Confirme apenas se o envio anterior realmente falhou."
      confirm-label="Reenviar"
      :loading="busy"
      @confirm="resend"
      @cancel="confirmResend = null"
    />
  </div>
</template>
