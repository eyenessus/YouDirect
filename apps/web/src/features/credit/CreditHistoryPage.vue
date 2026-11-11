<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  creditCheckStatusLabels,
  creditCheckStatuses,
  creditDecisionLabels,
  creditPurposeLabels,
  creditPurposes,
  formatCentsBRL,
  formatDateTimeBR,
  type CreditCheck,
  type CreditCheckStatus,
  type CreditUsageReport,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import StatusBadge, { type BadgeTone } from '@/components/ui/StatusBadge.vue';
import { api } from '@/lib/api';

/** Histórico das consultas à Serasa (sem o conteúdo dos relatórios) e consumo por mês. */
const checks = ref<CreditCheck[]>([]);
const usage = ref<CreditUsageReport | null>(null);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);

const status = ref('');
const purpose = ref('');
const from = ref('');
const to = ref('');

const statusOptions = [{ value: '', label: 'Todos os status' }, ...creditCheckStatuses.map((s) => ({ value: s, label: creditCheckStatusLabels[s] }))];
const purposeOptions = [{ value: '', label: 'Todas as finalidades' }, ...creditPurposes.map((p) => ({ value: p, label: creditPurposeLabels[p] }))];
const tone: Record<CreditCheckStatus, BadgeTone> = { PENDING: 'blue', COMPLETED: 'green', NOT_AVAILABLE: 'amber', FAILED: 'slate', UNCERTAIN: 'red' };
const billableLabel = { YES: 'Cobrada', NO: 'Não cobrada', UNKNOWN: 'Verificar' } as const;

function query(cursor?: string) {
  const params = new URLSearchParams({ limit: '30' });
  if (status.value) params.set('status', status.value);
  if (purpose.value) params.set('purpose', purpose.value);
  if (from.value) params.set('from', from.value);
  if (to.value) params.set('to', to.value);
  if (cursor) params.set('cursor', cursor);
  return `/credit-checks?${params.toString()}`;
}

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ data: CreditCheck[]; page: { nextCursor: string | null } }>(query());
    checks.value = res.data;
    nextCursor.value = res.page.nextCursor;
  } finally {
    loading.value = false;
  }
}

async function more() {
  if (!nextCursor.value) return;
  loadingMore.value = true;
  try {
    const res = await api.get<{ data: CreditCheck[]; page: { nextCursor: string | null } }>(query(nextCursor.value));
    checks.value.push(...res.data);
    nextCursor.value = res.page.nextCursor;
  } finally {
    loadingMore.value = false;
  }
}

onMounted(async () => {
  await load();
  usage.value = await api.get<CreditUsageReport>('/credit/usage?months=6').catch(() => null);
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader eyebrow="MOTORISTAS" title="Análise de crédito" subtitle="Consultas à Serasa: quem consultou, quando, para quê e o resultado operacional" />

    <section v-if="usage" class="fo-card p-6" aria-label="Consumo">
      <h2 class="mb-3 text-lg font-bold text-ink">Consumo por mês</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-[15px]">
          <thead class="text-left text-sm text-ink-muted">
            <tr>
              <th class="py-2 pr-4 font-medium">Mês</th>
              <th class="py-2 pr-4 text-right font-medium">Consultas</th>
              <th class="py-2 pr-4 text-right font-medium">Cobráveis</th>
              <th class="py-2 pr-4 text-right font-medium">Não cobradas</th>
              <th class="py-2 pr-4 text-right font-medium">Incertas</th>
              <th class="py-2 pr-4 text-right font-medium">Reaproveitadas</th>
              <th class="py-2 text-right font-medium">Custo estimado</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-line tabular">
            <tr v-for="m in usage.months" :key="m.month">
              <td class="py-2 pr-4 text-ink">{{ m.month.split('-').reverse().join('/') }}</td>
              <td class="py-2 pr-4 text-right">{{ m.total }}</td>
              <td class="py-2 pr-4 text-right">{{ m.billable }}</td>
              <td class="py-2 pr-4 text-right">{{ m.notBilled }}</td>
              <td class="py-2 pr-4 text-right" :class="m.uncertain ? 'text-[rgb(var(--c-negative))]' : ''">{{ m.uncertain }}</td>
              <td class="py-2 pr-4 text-right">{{ m.reused }}</td>
              <td class="py-2 text-right">{{ m.estimatedCostCents === null ? 'Informe o valor no Perfil' : formatCentsBRL(m.estimatedCostCents) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="usage.byUser.length" class="mt-3 text-sm text-ink-muted">
        Por usuário (6 meses): {{ usage.byUser.map((u) => `${u.name} (${u.total})`).join(' · ') }}
      </p>
    </section>

    <section class="fo-card overflow-hidden">
      <form class="grid gap-3 p-6 md:grid-cols-[1fr_1fr_160px_160px_auto] md:items-end" @submit.prevent="load">
        <AppSelect v-model="status" :options="statusOptions" aria-label="Filtrar por status" />
        <AppSelect v-model="purpose" :options="purposeOptions" aria-label="Filtrar por finalidade" />
        <AppInput v-model="from" type="date" aria-label="De" />
        <AppInput v-model="to" type="date" aria-label="Até" />
        <AppButton type="submit" variant="secondary">Filtrar</AppButton>
      </form>
      <p v-if="loading" class="px-6 pb-6 text-ink-muted">Carregando…</p>
      <p v-else-if="checks.length === 0" class="px-6 pb-6 text-ink-muted">Nenhuma consulta.</p>
      <ul v-else class="divide-y divide-line">
        <li v-for="c in checks" :key="c.id" class="grid gap-2 px-6 py-4 lg:grid-cols-[1.3fr_1.2fr_auto] lg:items-center">
          <div>
            <RouterLink :to="`/dashboard/drivers/${c.driverId}`" class="font-semibold text-ink hover:underline">{{ c.driverName ?? 'Motorista' }}</RouterLink>
            <p class="text-sm text-ink-muted">{{ formatDateTimeBR(c.requestedAt) }} · {{ c.requestedBy?.name }} · {{ c.environment === 'producao' ? 'produção' : 'homologação' }}</p>
          </div>
          <div class="text-sm text-ink-soft">
            <p>{{ creditPurposeLabels[c.purpose] }} — “{{ c.justification }}”</p>
            <p v-if="c.message" class="text-ink-muted">{{ c.message }}</p>
            <p v-if="c.review">Decisão: <strong class="text-ink">{{ creditDecisionLabels[c.review.decision] }}</strong> ({{ c.review.reviewedBy }})</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <StatusBadge :label="creditCheckStatusLabels[c.status]" :tone="tone[c.status]" :solid="false" />
            <span class="text-sm text-ink-muted">{{ billableLabel[c.billable] }}</span>
          </div>
        </li>
      </ul>
      <div v-if="nextCursor" class="p-6 pt-0"><AppButton variant="secondary" :loading="loadingMore" @click="more">Carregar mais</AppButton></div>
    </section>
  </div>
</template>
