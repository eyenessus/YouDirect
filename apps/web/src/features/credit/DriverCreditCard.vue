<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ShieldCheck } from 'lucide-vue-next';
import {
  creditCheckStatusLabels,
  creditDecisionLabels,
  creditDecisions,
  creditNegativeTypeLabels,
  creditPurposeLabels,
  creditPurposes,
  formatCentsBRL,
  formatDateTimeBR,
  formatIsoDateBR,
  type CreditCheck,
  type CreditCheckResult,
  type CreditCheckStatus,
  type CreditDecision,
  type CreditIntegrationStatus,
  type CreditPurpose,
} from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge, { type BadgeTone } from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/**
 * Análise de crédito do motorista (Serasa). A consulta é paga: pede
 * finalidade, ciência do motorista e confirmação do custo. O resultado
 * apoia a decisão, que é sempre registrada por uma pessoa.
 */
const props = defineProps<{ driverId: string; hasCpf: boolean }>();
const auth = useAuthStore();
const toasts = useToastStore();

const status = ref<CreditIntegrationStatus | null>(null);
const checks = ref<CreditCheck[]>([]);
const loading = ref(true);

const requestOpen = ref(false);
const purpose = ref<CreditPurpose>('PRE_LOCACAO');
const justification = ref('');
const holderInformed = ref(false);
const confirmCost = ref(false);
const forceNew = ref(false);
const sending = ref(false);
const formError = ref<string | null>(null);
let idempotencyKey = '';

const decision = ref<CreditDecision>('APROVADO');
const notes = ref('');
const reviewing = ref(false);

const latest = computed(() => checks.value[0] ?? null);
const withReport = computed(() => checks.value.find((c) => c.report) ?? null);
const canRequest = computed(() => auth.allows('credit', 'request'));
const ready = computed(() => Boolean(status.value?.connected && status.value.settings.enabled && props.hasCpf));

const statusTone: Record<CreditCheckStatus, BadgeTone> = {
  PENDING: 'blue',
  COMPLETED: 'green',
  NOT_AVAILABLE: 'amber',
  FAILED: 'slate',
  UNCERTAIN: 'red',
};
const decisionTone: Record<CreditDecision, BadgeTone> = {
  APROVADO: 'green',
  APROVADO_COM_CAUCAO: 'blue',
  PENDENTE_DOCUMENTOS: 'amber',
  RECUSADO: 'red',
};

const purposeOptions = creditPurposes.map((p) => ({ value: p, label: creditPurposeLabels[p] }));
const decisionOptions = creditDecisions.map((d) => ({ value: d, label: creditDecisionLabels[d] }));

const costText = computed(() => {
  const cost = status.value?.settings.costPerQueryCents;
  return cost === null || cost === undefined ? 'conforme o seu contrato com a Serasa' : `estimado em ${formatCentsBRL(cost)}`;
});

async function load() {
  loading.value = true;
  try {
    const [s, list] = await Promise.all([
      api.get<CreditIntegrationStatus>('/credit/status'),
      api.get<{ data: CreditCheck[] }>(`/drivers/${props.driverId}/credit-checks`),
    ]);
    status.value = s;
    checks.value = list.data;
  } catch {
    status.value = null;
  } finally {
    loading.value = false;
  }
}

function openRequest(newQuery = false) {
  purpose.value = 'PRE_LOCACAO';
  justification.value = '';
  holderInformed.value = false;
  confirmCost.value = false;
  forceNew.value = newQuery;
  formError.value = null;
  idempotencyKey = crypto.randomUUID();
  requestOpen.value = true;
}

async function submit() {
  formError.value = null;
  if (justification.value.trim().length < 10) {
    formError.value = 'Descreva a finalidade (mínimo 10 caracteres).';
    return;
  }
  if (!holderInformed.value || !confirmCost.value) {
    formError.value = 'Confirme os dois itens antes de consultar.';
    return;
  }
  sending.value = true;
  try {
    const res = await api.post<CreditCheckResult>(`/drivers/${props.driverId}/credit-checks`, {
      purpose: purpose.value,
      justification: justification.value.trim(),
      holderInformed: true,
      confirmCost: true,
      forceNew: forceNew.value,
      idempotencyKey,
    });
    requestOpen.value = false;
    if (res.reused) toasts.success('Consulta recente reaproveitada', `Feita em ${formatDateTimeBR(res.check.requestedAt)}, sem novo custo.`);
    else if (res.check.status === 'COMPLETED') toasts.success('Consulta concluída');
    else toasts.error(creditCheckStatusLabels[res.check.status], res.check.message ?? undefined);
    await load();
  } catch (err) {
    formError.value = err instanceof ApiRequestError ? err.message : 'Não foi possível consultar.';
  } finally {
    sending.value = false;
  }
}

async function review(check: CreditCheck) {
  if (notes.value.trim().length < 5) {
    toasts.error('Justifique a decisão', 'Mínimo de 5 caracteres.');
    return;
  }
  reviewing.value = true;
  try {
    await api.post(`/credit-checks/${check.id}/review`, { decision: decision.value, notes: notes.value.trim() });
    notes.value = '';
    toasts.success('Decisão registrada');
    await load();
  } catch (err) {
    toasts.error('Não foi possível registrar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    reviewing.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="fo-card p-7 xl:col-span-2" aria-label="Análise de crédito">
    <div class="mb-2 flex flex-wrap items-center justify-between gap-3">
      <h2 class="flex items-center gap-2.5 text-xl font-bold text-ink">
        <ShieldCheck class="size-5 text-ink-soft" aria-hidden="true" /> Análise de crédito (Serasa)
      </h2>
      <StatusBadge v-if="status" :label="status.environment === 'producao' ? 'Produção' : 'Homologação'" :tone="status.environment === 'producao' ? 'blue' : 'amber'" :solid="false" />
    </div>

    <p v-if="loading" class="text-[15px] text-ink-muted">Carregando…</p>
    <template v-else-if="status">
      <p v-if="!status.connected" class="text-[15px] text-ink-soft">{{ status.message }}</p>
      <p v-else-if="!status.settings.enabled" class="text-[15px] text-ink-soft">
        A consulta está desligada. Um administrador pode ligá-la em Perfil &gt; Análise de crédito.
      </p>
      <p v-else-if="!hasCpf" class="text-[15px] text-ink-soft">Cadastre o CPF do motorista para consultar.</p>

      <!-- Último relatório disponível -->
      <div v-if="withReport?.report" class="mt-4 space-y-5" data-testid="credit-report">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
          <span>Consulta de {{ formatDateTimeBR(withReport.requestedAt) }} · {{ withReport.reportName }}</span>
          <span>· por {{ withReport.requestedBy?.name }}</span>
          <span v-if="withReport.reportExpiresAt">· conteúdo guardado até {{ formatDateTimeBR(withReport.reportExpiresAt) }}</span>
        </div>

        <div class="grid gap-4 sm:grid-cols-3">
          <div class="rounded-control bg-surface-muted p-4">
            <p class="text-sm text-ink-muted">Serasa Score</p>
            <template v-if="withReport.report.score">
              <p class="mt-1 text-3xl font-bold tabular text-ink">{{ withReport.report.score.score }}</p>
              <p class="text-sm text-ink-soft">
                Modelo {{ withReport.report.score.model ?? '—' }}<span v-if="withReport.report.score.range"> · faixa {{ withReport.report.score.range }}</span>
              </p>
              <p v-if="withReport.report.score.defaultRate" class="text-sm text-ink-soft">Probabilidade de inadimplência: {{ withReport.report.score.defaultRate }}</p>
            </template>
            <p v-else class="mt-1 text-[15px] text-ink-soft">Não retornado. {{ withReport.report.scoreMessage ?? '' }}</p>
          </div>
          <div class="rounded-control bg-surface-muted p-4">
            <p class="text-sm text-ink-muted">Anotações negativas</p>
            <p class="mt-1 text-lg font-semibold text-ink">
              {{ withReport.report.hasNegative === true ? 'Há anotações' : withReport.report.hasNegative === false ? 'Nenhuma retornada' : 'Não informado' }}
            </p>
          </div>
          <div class="rounded-control bg-surface-muted p-4">
            <p class="text-sm text-ink-muted">Cadastro na Receita</p>
            <p class="mt-1 text-lg font-semibold text-ink">{{ withReport.report.registrationStatus ?? 'Não informado' }}</p>
            <p v-if="withReport.report.stolenDocumentAlerts" class="text-sm text-[rgb(var(--c-negative))]">
              {{ withReport.report.stolenDocumentAlerts }} alerta(s) de documento roubado
            </p>
          </div>
        </div>

        <ul class="divide-y divide-line rounded-control border border-line">
          <li v-for="g in withReport.report.negatives" :key="g.type" class="p-4">
            <details :open="g.count > 0 && g.count <= 5">
              <summary class="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-[15px]">
                <span class="font-semibold text-ink">{{ creditNegativeTypeLabels[g.type] }}</span>
                <span v-if="g.availability === 'NOT_RETURNED'" class="text-ink-muted">Não incluído no relatório contratado</span>
                <span v-else-if="g.availability === 'ERROR'" class="text-ink-muted">Indisponível: {{ g.message }}</span>
                <span v-else class="tabular" :class="g.count > 0 ? 'text-[rgb(var(--c-negative))]' : 'text-ink-soft'">
                  {{ g.count === 0 ? 'Nenhuma ocorrência retornada' : `${g.count} ocorrência(s) · ${formatCentsBRL(g.balanceCents)}` }}
                </span>
              </summary>
              <ul v-if="g.items.length" class="mt-3 space-y-1 text-sm text-ink-soft">
                <li v-for="(i, idx) in g.items" :key="idx" class="flex flex-wrap justify-between gap-2">
                  <span>{{ formatIsoDateBR(i.date) }} · {{ i.creditor ?? 'Credor não informado' }}<span v-if="i.city"> · {{ i.city }}/{{ i.state }}</span><span v-if="i.subJudice"> · sub judice</span></span>
                  <span class="tabular">{{ i.amountCents !== null ? formatCentsBRL(i.amountCents) : '—' }}</span>
                </li>
              </ul>
            </details>
          </li>
        </ul>

        <p class="text-sm text-ink-muted">
          O score é um indicador estatístico da Serasa, não uma garantia de pagamento. "Nenhuma ocorrência retornada" vale só para as
          fontes incluídas no relatório contratado. A decisão da locação é sua e fica registrada abaixo.
        </p>

        <!-- Decisão humana -->
        <div v-if="withReport.review" class="rounded-control bg-surface-muted p-4 text-[15px]">
          <p class="flex flex-wrap items-center gap-2">
            <StatusBadge :label="creditDecisionLabels[withReport.review.decision]" :tone="decisionTone[withReport.review.decision]" />
            <span class="text-ink-soft">por {{ withReport.review.reviewedBy }} em {{ formatDateTimeBR(withReport.review.reviewedAt) }}</span>
          </p>
          <p class="mt-2 text-ink">{{ withReport.review.notes }}</p>
        </div>
        <div v-if="auth.allows('credit', 'review')" class="grid gap-3 sm:grid-cols-[220px_1fr_auto] sm:items-end">
          <FormField :label="withReport.review ? 'Alterar decisão' : 'Decisão da locação'">
            <AppSelect v-model="decision" :options="decisionOptions" />
          </FormField>
          <FormField label="Justificativa">
            <AppTextarea v-model="notes" :rows="2" placeholder="Ex.: pendência antiga e de baixo valor; caução de 2 semanas." />
          </FormField>
          <AppButton :loading="reviewing" @click="review(withReport)">Registrar</AppButton>
        </div>
      </div>

      <p v-else-if="latest" class="mt-4 text-[15px] text-ink-soft">
        <StatusBadge :label="creditCheckStatusLabels[latest.status]" :tone="statusTone[latest.status]" :solid="false" />
        <span class="ml-2">{{ latest.message ?? (latest.reportPurged ? 'O conteúdo do relatório foi apagado pelo prazo de guarda.' : '') }}</span>
      </p>

      <div v-if="canRequest && ready" class="mt-5 flex flex-wrap gap-3">
        <AppButton @click="openRequest(false)">Consultar Serasa</AppButton>
        <AppButton v-if="withReport" variant="secondary" @click="openRequest(true)">Nova consulta (novo custo)</AppButton>
      </div>

      <details v-if="checks.length" class="mt-5">
        <summary class="cursor-pointer text-[15px] font-semibold text-ink">Histórico de consultas ({{ checks.length }})</summary>
        <ul class="mt-2 divide-y divide-line text-sm">
          <li v-for="c in checks" :key="c.id" class="flex flex-wrap items-center justify-between gap-2 py-2">
            <span class="text-ink-soft">
              {{ formatDateTimeBR(c.requestedAt) }} · {{ creditPurposeLabels[c.purpose] }} · {{ c.requestedBy?.name }}
            </span>
            <StatusBadge :label="creditCheckStatusLabels[c.status]" :tone="statusTone[c.status]" :solid="false" />
          </li>
        </ul>
      </details>
    </template>
    <p v-else class="text-[15px] text-ink-soft">Não foi possível carregar a análise de crédito.</p>

    <AppModal :open="requestOpen" title="Consultar Serasa" description="Relatório Básico PF do motorista" @close="requestOpen = false">
      <form class="space-y-4" @submit.prevent="submit">
        <FormField label="Finalidade" required>
          <AppSelect v-model="purpose" :options="purposeOptions" />
        </FormField>
        <FormField label="Por que a consulta é necessária?" required hint="Fica registrado na auditoria.">
          <AppTextarea v-model="justification" :rows="3" placeholder="Ex.: motorista novo, retirada do carro marcada para sexta." />
        </FormField>
        <AppCheckbox
          v-model="holderInformed"
          boxed
          label="O motorista foi informado da consulta"
          description="A consulta usa a base legal de proteção do crédito (LGPD, art. 7º, X) e só pode ser feita para esta finalidade."
        />
        <AppCheckbox
          v-model="confirmCost"
          boxed
          :label="`Estou ciente do custo (${costText})`"
          :description="forceNew ? 'Esta é uma NOVA consulta: a anterior não será reaproveitada.' : 'Se houver consulta recente dentro da validade, ela é reaproveitada sem novo custo.'"
        />
        <p v-if="formError" role="alert" class="text-[15px] text-[rgb(var(--c-negative))]">{{ formError }}</p>
        <div class="flex justify-end gap-3">
          <AppButton variant="secondary" type="button" @click="requestOpen = false">Cancelar</AppButton>
          <AppButton type="submit" :loading="sending" :disabled="sending">Consultar</AppButton>
        </div>
      </form>
    </AppModal>
  </section>
</template>
