<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ShieldCheck } from 'lucide-vue-next';
import { formatCentsBRL, type CreditIntegrationStatus, type CreditSettings } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppInput from '@/components/ui/AppInput.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

/**
 * Configuração da Serasa (dono/administrador). As credenciais ficam só no
 * servidor (variáveis de ambiente); aqui se liga a consulta, informa o
 * valor contratado e define limites, reaproveitamento e prazo de guarda.
 */
const toasts = useToastStore();
const status = ref<CreditIntegrationStatus | null>(null);
const form = ref<CreditSettings | null>(null);
const costCents = ref(0);
const hasCost = ref(false);
const hasLimit = ref(true);
const saving = ref(false);
const testing = ref(false);

async function load() {
  status.value = await api.get<CreditIntegrationStatus>('/credit/status');
  form.value = { ...status.value.settings };
  hasCost.value = status.value.settings.costPerQueryCents !== null;
  costCents.value = status.value.settings.costPerQueryCents ?? 0;
  hasLimit.value = status.value.settings.monthlyLimit !== null;
}

async function save() {
  if (!form.value) return;
  saving.value = true;
  try {
    await api.put('/credit/settings', {
      enabled: form.value.enabled,
      costPerQueryCents: hasCost.value ? Number(costCents.value) : null,
      monthlyLimit: hasLimit.value ? Number(form.value.monthlyLimit ?? 50) : null,
      reuseDays: Number(form.value.reuseDays),
      retentionDays: Number(form.value.retentionDays),
    });
    toasts.success('Configuração da Serasa salva');
    await load();
  } catch (err) {
    toasts.error('Não foi possível salvar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    saving.value = false;
  }
}

async function testAuth() {
  testing.value = true;
  try {
    const res = await api.post<{ ok: boolean; message: string }>('/credit/test-auth', {});
    if (res.ok) toasts.success('Credencial válida', res.message);
    else toasts.error('Credencial recusada', res.message);
  } catch (err) {
    toasts.error('Não foi possível testar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    testing.value = false;
  }
}

onMounted(() => load().catch(() => (status.value = null)));
</script>

<template>
  <section class="fo-card p-7 xl:col-span-2" aria-label="Análise de crédito">
    <h2 class="mb-2 flex items-center gap-2.5 text-xl font-bold text-ink">
      <ShieldCheck class="size-5 text-ink-soft" aria-hidden="true" /> Análise de crédito (Serasa)
    </h2>
    <p class="mb-4 text-[15px] text-ink-muted">
      Consulta o Relatório Básico PF do motorista (score e anotações negativas) antes da locação. Cada consulta é paga, exige
      finalidade e fica na auditoria. A decisão é sempre de uma pessoa.
    </p>
    <template v-if="status && form">
      <ul class="mb-4 space-y-1 text-sm">
        <li :class="status.connected ? 'text-[rgb(var(--c-positive))]' : 'text-ink-soft'">{{ status.message }}</li>
        <li class="text-ink-soft">
          Relatório: {{ status.reportName }}<span v-if="status.optionalFeatures.length"> · features {{ status.optionalFeatures.join(', ') }}</span
          ><span v-if="status.scoreModel"> · score {{ status.scoreModel }}</span>
        </li>
        <li class="text-ink-soft">
          Este mês: {{ status.usage.billable }} consulta(s) cobrável(is)<span v-if="status.usage.limit !== null"> de {{ status.usage.limit }}</span>
          <span v-if="status.usage.estimatedCostCents !== null"> · estimado {{ formatCentsBRL(status.usage.estimatedCostCents) }}</span>
          <span v-if="status.usage.uncertain" class="text-[rgb(var(--c-negative))]"> · {{ status.usage.uncertain }} com resultado incerto (confira o extrato da Serasa)</span>
        </li>
      </ul>

      <AppCheckbox v-model="form.enabled" label="Permitir consultas à Serasa" class="mb-4" :disabled="!status.connected && !form.enabled" />
      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div class="space-y-2 text-sm text-ink-soft">
          <AppCheckbox v-model="hasCost" label="Informar valor por consulta" />
          <CurrencyInput v-if="hasCost" v-model="costCents" />
        </div>
        <div class="space-y-2 text-sm text-ink-soft">
          <AppCheckbox v-model="hasLimit" label="Limite mensal de consultas" />
          <AppInput v-if="hasLimit" v-model="form.monthlyLimit" type="number" inputmode="numeric" />
        </div>
        <label class="text-sm text-ink-soft">
          Reaproveitar consulta por (dias)
          <AppInput v-model="form.reuseDays" type="number" inputmode="numeric" class="mt-1" />
        </label>
        <label class="text-sm text-ink-soft">
          Guardar o relatório por (dias)
          <AppInput v-model="form.retentionDays" type="number" inputmode="numeric" class="mt-1" />
        </label>
      </div>
      <p class="mt-3 text-sm text-ink-muted">
        Depois do prazo de guarda o conteúdo do relatório é apagado; ficam a data, a finalidade, quem consultou e a decisão.
      </p>
      <div class="mt-4 flex flex-wrap justify-end gap-3">
        <RouterLink to="/dashboard/credit-checks" class="self-center text-[15px] font-semibold text-brand-600 hover:underline">Histórico e consumo</RouterLink>
        <AppButton variant="secondary" :loading="testing" :disabled="!status.connected" @click="testAuth">Testar credencial</AppButton>
        <AppButton :loading="saving" @click="save">Salvar</AppButton>
      </div>
    </template>
    <p v-else class="text-[15px] text-ink-soft">Carregando…</p>
  </section>
</template>
