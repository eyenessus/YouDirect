<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { FileText } from 'lucide-vue-next';
import { fiscalNoteStatusLabels, formatCentsBRL, formatIsoDateBR, type FiscalNote, type PendingFiscalPayment } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppTabs, { type TabItem } from '@/components/ui/AppTabs.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/**
 * Notas de serviço: o YuDirect não emite a nota. Aqui você vê os recebimentos que ainda não têm nota,
 * baixa o recibo, exporta a lista para o contador e registra o número da nota emitida na prefeitura.
 */
const auth = useAuthStore();
const toasts = useToastStore();
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const monthStart = `${today.slice(0, 8)}01`;

const tab = ref<'PENDING' | 'ISSUED'>('PENDING');
const range = reactive({ from: monthStart, to: today });
const pending = ref<PendingFiscalPayment[]>([]);
const totalCents = ref(0);
const notes = ref<FiscalNote[]>([]);
const loading = ref(true);
const registering = ref<string | null>(null);
const form = reactive({ number: '', issuedOn: today, url: '' });
const cancelId = ref<string | null>(null);
const cancelReason = ref('');
const busy = ref(false);

const tabs: TabItem[] = [
  { key: 'PENDING', label: 'Sem nota' },
  { key: 'ISSUED', label: 'Notas registradas' },
];
const canWrite = computed(() => auth.allows('finance', 'create'));
const fail = (title: string, err: unknown) => toasts.error(title, err instanceof ApiRequestError ? err.message : undefined);

async function load() {
  loading.value = true;
  try {
    const query = { from: range.from, to: range.to };
    if (tab.value === 'PENDING') {
      const res = await api.get<{ data: PendingFiscalPayment[]; totalCents: number }>('/fiscal/pending', { query });
      pending.value = res.data;
      totalCents.value = res.totalCents;
    } else {
      notes.value = (await api.get<{ data: FiscalNote[] }>('/fiscal/notes', { query })).data;
    }
  } catch (err) {
    fail('Não foi possível carregar', err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch([tab, () => range.from, () => range.to], load);

function startRegister(paymentId: string) {
  registering.value = paymentId;
  Object.assign(form, { number: '', issuedOn: today, url: '' });
}

async function register() {
  if (!registering.value) return;
  busy.value = true;
  try {
    await api.post('/fiscal/notes', { paymentId: registering.value, number: form.number, issuedOn: form.issuedOn, url: form.url || undefined });
    toasts.success('Nota registrada');
    registering.value = null;
    await load();
  } catch (err) {
    fail('Não foi possível registrar a nota', err);
  } finally {
    busy.value = false;
  }
}

async function cancelNote() {
  if (!cancelId.value) return;
  busy.value = true;
  try {
    await api.post(`/fiscal/notes/${cancelId.value}/cancel`, { reason: cancelReason.value });
    toasts.success('Nota cancelada');
    cancelId.value = null;
    cancelReason.value = '';
    await load();
  } catch (err) {
    fail('Não foi possível cancelar', err);
  } finally {
    busy.value = false;
  }
}

const receipt = (paymentId: string) => downloadFile(`/payments/${paymentId}/receipt.pdf`, 'recibo.pdf').catch((err) => fail('Não foi possível gerar o recibo', err));
const exportCsv = () => downloadFile('/fiscal/pending.csv', 'recebimentos-sem-nota.csv', { from: range.from, to: range.to }).catch((err) => fail('Não foi possível exportar', err));
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Financeiro"
      title="Notas fiscais e recibos"
      subtitle="O YuDirect não emite nota fiscal. Aqui você controla o que ainda está sem nota, baixa o recibo e registra a nota emitida na prefeitura."
    />

    <div class="mb-5 flex flex-wrap items-end gap-4">
      <AppTabs v-model="tab" :items="tabs" />
      <label class="text-sm text-ink-soft">De <AppInput v-model="range.from" type="date" class="mt-1" /></label>
      <label class="text-sm text-ink-soft">Até <AppInput v-model="range.to" type="date" class="mt-1" /></label>
      <AppButton v-if="tab === 'PENDING'" variant="secondary" @click="exportCsv">Exportar para o contador (CSV)</AppButton>
    </div>

    <section v-if="tab === 'PENDING'" class="fo-card overflow-x-auto">
      <p v-if="loading" class="p-8 text-ink-muted" role="status">Carregando...</p>
      <EmptyState v-else-if="pending.length === 0" :icon="FileText" title="Tudo com nota" message="Nenhum recebimento de aluguel ou km excedente sem nota no período." />
      <template v-else>
        <p class="px-7 pt-6 text-[15px] text-ink-soft">{{ pending.length }} recebimento(s) sem nota, somando <strong class="text-ink">{{ formatCentsBRL(totalCents) }}</strong>.</p>
        <table class="mt-3 w-full text-left text-[15px]">
          <thead class="border-y border-line text-sm text-ink-muted">
            <tr>
              <th class="px-5 py-3 font-semibold">Pago em</th>
              <th class="px-5 py-3 font-semibold">Motorista</th>
              <th class="px-5 py-3 font-semibold">Referente a</th>
              <th class="px-5 py-3 font-semibold">Forma</th>
              <th class="px-5 py-3 font-semibold">Valor</th>
              <th class="px-5 py-3 font-semibold"><span class="sr-only">Ações</span></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="p in pending" :key="p.paymentId">
              <tr class="border-b border-line">
                <td class="px-5 py-3">{{ formatIsoDateBR(p.paidAt) }}</td>
                <td class="px-5 py-3">{{ p.driverName ?? '—' }}</td>
                <td class="px-5 py-3">{{ p.description }}</td>
                <td class="px-5 py-3">{{ p.method }}</td>
                <td class="px-5 py-3 tabular font-semibold">{{ formatCentsBRL(p.amountCents) }}</td>
                <td class="space-x-3 px-5 py-3 text-right">
                  <button type="button" class="text-sm font-semibold text-brand-600 hover:underline" @click="receipt(p.paymentId)">Recibo</button>
                  <button v-if="canWrite" type="button" class="text-sm font-semibold text-brand-600 hover:underline" @click="startRegister(p.paymentId)">Registrar nota</button>
                </td>
              </tr>
              <tr v-if="registering === p.paymentId" class="border-b border-line bg-surface-muted">
                <td colspan="6" class="px-5 py-4">
                  <form class="grid gap-4 sm:grid-cols-4" novalidate @submit.prevent="register">
                    <FormField v-slot="field" label="Número da nota" required><AppInput :id="field.id" v-model="form.number" /></FormField>
                    <FormField v-slot="field" label="Emitida em" required><AppInput :id="field.id" v-model="form.issuedOn" type="date" /></FormField>
                    <FormField v-slot="field" label="Link da nota"><AppInput :id="field.id" v-model="form.url" placeholder="https://..." /></FormField>
                    <div class="flex items-end gap-3">
                      <AppButton type="submit" :loading="busy" :disabled="!form.number">Salvar</AppButton>
                      <AppButton variant="secondary" :disabled="busy" @click="registering = null">Cancelar</AppButton>
                    </div>
                  </form>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </template>
    </section>

    <section v-else class="fo-card overflow-x-auto">
      <p v-if="loading" class="p-8 text-ink-muted" role="status">Carregando...</p>
      <EmptyState v-else-if="notes.length === 0" :icon="FileText" title="Nenhuma nota registrada" message="Registre o número das notas emitidas para acompanhar o que já foi faturado." />
      <table v-else class="w-full text-left text-[15px]">
        <thead class="border-b border-line text-sm text-ink-muted">
          <tr>
            <th class="px-5 py-3 font-semibold">Nota</th>
            <th class="px-5 py-3 font-semibold">Emitida em</th>
            <th class="px-5 py-3 font-semibold">Motorista</th>
            <th class="px-5 py-3 font-semibold">Referente a</th>
            <th class="px-5 py-3 font-semibold">Valor</th>
            <th class="px-5 py-3 font-semibold">Situação</th>
            <th class="px-5 py-3 font-semibold"><span class="sr-only">Ações</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="n in notes" :key="n.id" class="border-b border-line last:border-0">
            <td class="px-5 py-3 font-semibold">
              <a v-if="n.url" :href="n.url" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:underline">{{ n.number }}</a>
              <span v-else>{{ n.number }}</span>
            </td>
            <td class="px-5 py-3">{{ formatIsoDateBR(n.issuedOn) }}</td>
            <td class="px-5 py-3">{{ n.driverName ?? '—' }}</td>
            <td class="px-5 py-3">{{ n.description }}</td>
            <td class="px-5 py-3 tabular">{{ formatCentsBRL(n.amountCents) }}</td>
            <td class="px-5 py-3">
              <StatusBadge :label="fiscalNoteStatusLabels[n.status]" :tone="n.status === 'ISSUED' ? 'green' : 'slate'" />
              <span v-if="n.canceledReason" class="mt-1 block text-xs text-ink-muted">{{ n.canceledReason }}</span>
            </td>
            <td class="px-5 py-3 text-right">
              <button v-if="canWrite && n.status === 'ISSUED'" type="button" class="text-sm font-semibold text-[rgb(var(--c-negative))] hover:underline" @click="cancelId = n.id">Cancelar nota</button>
            </td>
          </tr>
        </tbody>
      </table>
      <form v-if="cancelId" class="flex flex-wrap items-end gap-4 border-t border-line p-5" novalidate @submit.prevent="cancelNote">
        <FormField v-slot="field" label="Motivo do cancelamento" required class="min-w-72 flex-1"><AppInput :id="field.id" v-model="cancelReason" /></FormField>
        <AppButton type="submit" :loading="busy" :disabled="cancelReason.trim().length < 3">Confirmar cancelamento</AppButton>
        <AppButton variant="secondary" :disabled="busy" @click="cancelId = null">Voltar</AppButton>
      </form>
    </section>
  </div>
</template>
