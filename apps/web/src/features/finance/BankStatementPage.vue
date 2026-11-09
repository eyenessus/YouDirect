<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Download } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  transactionOriginLabels,
  type Statement,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

const route = useRoute();
const auth = useAuthStore();
const toasts = useToastStore();

const accountId = route.params.id as string;
const statement = ref<Statement | null>(null);
const loading = ref(true);
const exporting = ref(false);

const now = new Date();
const first = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
const range = ref({ from: first, to: last });

async function load() {
  loading.value = true;
  try {
    statement.value = await api.get<Statement>(`/bank-accounts/${accountId}/statement`, {
      query: { from: range.value.from, to: range.value.to },
    });
  } catch (err) {
    toasts.error('Falha ao carregar o extrato', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    loading.value = false;
  }
}

async function exportCsv() {
  exporting.value = true;
  try {
    await downloadFile(`/bank-accounts/${accountId}/statement.csv`, 'extrato.csv', {
      from: range.value.from,
      to: range.value.to,
    });
  } catch (err) {
    toasts.error('Não foi possível exportar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    exporting.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="FINANCEIRO"
      :title="`Extrato — ${statement?.account.name ?? ''}`"
      subtitle="Entradas, saídas e saldo acumulado da conta."
      back-to="/dashboard/finance/bank-accounts"
    >
      <template #actions>
        <AppButton
          v-if="auth.allows('finance', 'export')"
          variant="secondary"
          :loading="exporting"
          @click="exportCsv"
        >
          <template #icon><Download class="size-4" /></template>
          Exportar CSV
        </AppButton>
      </template>
    </PageHeader>

    <section class="fo-card p-6">
      <div class="grid items-end gap-5 sm:grid-cols-[1fr_1fr_auto]">
        <FormField v-slot="field" label="De">
          <AppInput :id="field.id" v-model="range.from" type="date" />
        </FormField>
        <FormField v-slot="field" label="Até">
          <AppInput :id="field.id" v-model="range.to" type="date" />
        </FormField>
        <AppButton @click="load">Filtrar</AppButton>
      </div>
    </section>

    <AppSkeleton v-if="loading" variant="cards" :rows="4" />

    <template v-else-if="statement">
      <div class="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <div class="fo-card p-6">
          <p class="text-[15px] text-ink-soft">Saldo inicial do período</p>
          <p class="mt-3 text-[30px] font-bold tabular text-ink">
            {{ formatCentsBRL(statement.openingBalanceCents) }}
          </p>
        </div>
        <div class="fo-card p-6">
          <p class="text-[15px] text-ink-soft">Entradas</p>
          <p class="mt-3 text-[30px] font-bold tabular text-[rgb(var(--c-positive))]">
            {{ formatCentsBRL(statement.inflowCents) }}
          </p>
        </div>
        <div class="fo-card p-6">
          <p class="text-[15px] text-ink-soft">Saídas</p>
          <p class="mt-3 text-[30px] font-bold tabular text-[rgb(var(--c-negative))]">
            {{ formatCentsBRL(statement.outflowCents) }}
          </p>
        </div>
        <div class="fo-card p-6">
          <p class="text-[15px] text-ink-soft">Saldo final</p>
          <p class="mt-3 text-[30px] font-bold tabular text-ink">
            {{ formatCentsBRL(statement.closingBalanceCents) }}
          </p>
        </div>
      </div>

      <section class="fo-card overflow-hidden">
        <h2 class="px-6 pb-3 pt-6 text-[22px] font-bold text-ink">Movimentações</h2>

        <EmptyState
          v-if="statement.transactions.length === 0"
          message="Nenhuma movimentação no período selecionado."
        />

        <div v-else class="fo-scroll-x">
          <table class="fo-table">
            <caption class="sr-only">Movimentações da conta no período</caption>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Descrição</th>
                <th scope="col">Origem</th>
                <th scope="col" class="text-right">Entrada</th>
                <th scope="col" class="text-right">Saída</th>
                <th scope="col" class="text-right">Saldo</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in statement.transactions" :key="row.id">
                <td class="tabular whitespace-nowrap">{{ formatIsoDateBR(row.occurredAt) }}</td>
                <td>
                  {{ row.description }}
                  <span v-if="row.reversed" class="ml-2 text-xs text-ink-muted">(estornado)</span>
                </td>
                <td class="text-ink-muted">{{ transactionOriginLabels[row.origin] }}</td>
                <td class="text-right tabular text-[rgb(var(--c-positive))]">
                  {{ row.direction === 'IN' ? formatCentsBRL(row.amountCents) : '–' }}
                </td>
                <td class="text-right tabular text-[rgb(var(--c-negative))]">
                  {{ row.direction === 'OUT' ? formatCentsBRL(row.amountCents) : '–' }}
                </td>
                <td class="text-right tabular font-semibold">
                  {{ formatCentsBRL(row.runningBalanceCents) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
