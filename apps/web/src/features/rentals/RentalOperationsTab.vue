<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { FileSignature, Gauge, Wallet } from 'lucide-vue-next';
import {
  contractSignatureStatusLabels,
  formatCentsBRL,
  formatDateTimeBR,
  formatIsoDateBR,
  formatKm,
  type ContractSignature,
  type DepositSettlementPreview,
  type RentalKmSummary,
} from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/** Contrato com assinatura digital, franquia de km e fechamento da caução da locação. */
const props = defineProps<{ rentalId: string; rentalNumber: string }>();
const auth = useAuthStore();
const toasts = useToastStore();

const km = ref<RentalKmSummary | null>(null);
const kmForm = reactive({ weeklyFranchiseKm: '', extraKmPriceCents: 0, startOdometerKm: '' });
const signature = ref<ContractSignature | null>(null);
const signatureProvider = ref<{ connected: boolean; message: string } | null>(null);
const deposit = ref<DepositSettlementPreview | null>(null);
const busy = ref<string | null>(null);
const confirmSettle = ref(false);

async function load() {
  const [k, s, d] = await Promise.allSettled([
    api.get<RentalKmSummary>(`/rentals/${props.rentalId}/km-summary`),
    api.get<{ signature: ContractSignature | null; provider: { connected: boolean; message: string } }>(`/rentals/${props.rentalId}/signature`),
    auth.allows('finance', 'read') ? api.get<DepositSettlementPreview>(`/rentals/${props.rentalId}/deposit-settlement`) : Promise.reject(new Error('sem permissão')),
  ]);
  if (k.status === 'fulfilled') {
    km.value = k.value;
    kmForm.weeklyFranchiseKm = k.value.policy?.weeklyFranchiseKm ? String(k.value.policy.weeklyFranchiseKm) : '';
    kmForm.extraKmPriceCents = k.value.policy?.extraKmPriceCents ?? 0;
    kmForm.startOdometerKm = k.value.policy?.startOdometerKm != null ? String(k.value.policy.startOdometerKm) : '';
  }
  if (s.status === 'fulfilled') {
    signature.value = s.value.signature;
    signatureProvider.value = s.value.provider;
  }
  if (d.status === 'fulfilled') deposit.value = d.value;
}

async function run<T>(key: string, fn: () => Promise<T>, ok: string) {
  busy.value = key;
  try {
    await fn();
    toasts.success(ok);
    await load();
  } catch (err) {
    toasts.error('Não foi possível concluir', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    busy.value = null;
  }
}

const saveKm = () =>
  run(
    'km',
    () =>
      api.put(`/rentals/${props.rentalId}/km-policy`, {
        weeklyFranchiseKm: kmForm.weeklyFranchiseKm ? Number(kmForm.weeklyFranchiseKm) : null,
        extraKmPriceCents: kmForm.extraKmPriceCents,
        startOdometerKm: kmForm.startOdometerKm ? Number(kmForm.startOdometerKm) : null,
      }),
    'Franquia de km salva',
  );
const sendSignature = () => run('sign', () => api.post(`/rentals/${props.rentalId}/signature`), 'Contrato enviado para assinatura');
const syncSignature = () => run('sync', () => api.post(`/rentals/${props.rentalId}/signature/sync`), 'Situação atualizada');
const cancelSignature = () => run('cancel', () => api.delete(`/rentals/${props.rentalId}/signature`), 'Assinatura cancelada');
const settle = () =>
  run('settle', async () => {
    await api.post(`/rentals/${props.rentalId}/deposit-settlement`, {});
    confirmSettle.value = false;
  }, 'Caução fechada');

async function copyLink() {
  if (!signature.value?.signUrl) return;
  await navigator.clipboard.writeText(signature.value.signUrl).catch(() => undefined);
  toasts.success('Link de assinatura copiado');
}

async function downloadPdf() {
  try {
    await downloadFile(`/rentals/${props.rentalId}/contract.pdf`, `contrato-${props.rentalNumber}.pdf`);
  } catch (err) {
    toasts.error('Não foi possível gerar o PDF', err instanceof ApiRequestError ? err.message : undefined);
  }
}

onMounted(load);
</script>

<template>
  <div class="grid gap-6 xl:grid-cols-2">
    <!-- Contrato -->
    <section class="fo-card p-7" aria-label="Contrato e assinatura">
      <h2 class="mb-2 flex items-center gap-2.5 text-xl font-bold text-ink"><FileSignature class="size-5 text-ink-soft" aria-hidden="true" /> Contrato e assinatura</h2>
      <p class="mb-5 text-[15px] text-ink-muted">
        Contrato gerado com os dados da locação. A assinatura digital pede selfie e foto da CNH; com CPF cadastrado, a selfie é comparada à base do governo.
      </p>
      <div v-if="signature" class="mb-4 space-y-2 rounded-control bg-surface-muted p-4 text-[15px]">
        <div class="flex items-center justify-between gap-3">
          <span class="font-semibold text-ink">Assinatura digital</span>
          <StatusBadge :label="contractSignatureStatusLabels[signature.status]" :tone="signature.status === 'SIGNED' ? 'green' : signature.status === 'SENT' ? 'amber' : 'slate'" :solid="false" />
        </div>
        <p class="text-sm text-ink-muted">
          Selfie {{ signature.identity.selfie ? 'exigida' : '—' }} · CNH {{ signature.identity.document ? 'exigida' : '—' }}{{ signature.identity.validationType ? ` · ${signature.identity.validationType === 'face-match-and-datavalid' ? 'selfie comparada à base do governo (CPF)' : 'prova de vida'}` : '' }}
        </p>
        <p v-if="signature.signedAt" class="text-sm text-ink">Assinado em {{ formatDateTimeBR(signature.signedAt) }}</p>
        <a v-if="signature.signedFile" :href="signature.signedFile.url" target="_blank" rel="noopener" class="text-sm font-semibold text-brand-600 hover:underline">Baixar contrato assinado</a>
        <div v-if="signature.status === 'SENT'" class="flex flex-wrap gap-2 pt-1">
          <AppButton size="sm" variant="secondary" @click="copyLink">Copiar link para o motorista</AppButton>
          <AppButton size="sm" variant="ghost" :loading="busy === 'sync'" @click="syncSignature">Verificar agora</AppButton>
          <AppButton v-if="auth.allows('rentals', 'update')" size="sm" variant="ghost" :loading="busy === 'cancel'" @click="cancelSignature">Cancelar</AppButton>
        </div>
      </div>
      <p v-if="signatureProvider && !signatureProvider.connected" class="mb-4 text-sm text-ink-soft">{{ signatureProvider.message }}</p>
      <div class="flex flex-wrap gap-3">
        <AppButton variant="secondary" @click="downloadPdf">Baixar contrato (PDF)</AppButton>
        <AppButton
          v-if="auth.allows('rentals', 'update') && signatureProvider?.connected && signature?.status !== 'SIGNED' && signature?.status !== 'SENT'"
          :loading="busy === 'sign'"
          @click="sendSignature"
        >
          Enviar para assinatura digital
        </AppButton>
      </div>
    </section>

    <!-- KM -->
    <section class="fo-card p-7" aria-label="Franquia de km">
      <h2 class="mb-2 flex items-center gap-2.5 text-xl font-bold text-ink"><Gauge class="size-5 text-ink-soft" aria-hidden="true" /> Franquia de km</h2>
      <p class="mb-5 text-[15px] text-ink-muted">O km excedente é lançado sozinho quando uma vistoria com hodômetro é aprovada.</p>
      <dl v-if="km" class="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div><dt class="text-sm text-ink-muted">Rodados</dt><dd class="font-semibold tabular text-ink">{{ formatKm(km.drivenKm) }}</dd></div>
        <div><dt class="text-sm text-ink-muted">Franquia até agora</dt><dd class="font-semibold tabular text-ink">{{ km.allowedKm !== null ? formatKm(km.allowedKm) : 'Livre' }}</dd></div>
        <div><dt class="text-sm text-ink-muted">Cobrados</dt><dd class="font-semibold tabular text-ink">{{ formatKm(km.chargedKm) }}</dd></div>
        <div><dt class="text-sm text-ink-muted">Valor</dt><dd class="font-semibold tabular text-ink">{{ formatCentsBRL(km.chargedCents) }}</dd></div>
      </dl>
      <p v-if="km?.lastReadingAt" class="mb-4 text-sm text-ink-muted">Última leitura: {{ formatKm(km.lastOdometerKm) }} em {{ formatIsoDateBR(km.lastReadingAt) }}</p>
      <div v-if="auth.allows('rentals', 'update')" class="grid gap-4 sm:grid-cols-3">
        <FormField v-slot="field" label="KM por semana" hint="Vazio = km livre">
          <AppInput :id="field.id" v-model="kmForm.weeklyFranchiseKm" type="number" inputmode="numeric" />
        </FormField>
        <FormField v-slot="field" label="Preço do km extra">
          <CurrencyInput :id="field.id" v-model="kmForm.extraKmPriceCents" />
        </FormField>
        <FormField v-slot="field" label="Hodômetro na entrega" hint="Vazio = 1ª vistoria">
          <AppInput :id="field.id" v-model="kmForm.startOdometerKm" type="number" inputmode="numeric" />
        </FormField>
        <div class="sm:col-span-3 flex justify-end">
          <AppButton :loading="busy === 'km'" @click="saveKm">Salvar franquia</AppButton>
        </div>
      </div>
    </section>

    <!-- Caução -->
    <section v-if="deposit" class="fo-card p-7 xl:col-span-2" aria-label="Caução">
      <h2 class="mb-2 flex items-center gap-2.5 text-xl font-bold text-ink"><Wallet class="size-5 text-ink-soft" aria-hidden="true" /> Caução</h2>
      <p class="mb-5 text-[15px] text-ink-muted">No fim do contrato, a caução quita o que ficou em aberto (aluguel, multas, avarias, km) e o restante é devolvido.</p>
      <dl class="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div><dt class="text-sm text-ink-muted">Caução recebida</dt><dd class="font-semibold tabular text-ink">{{ formatCentsBRL(deposit.depositHeldCents) }}</dd></div>
        <div><dt class="text-sm text-ink-muted">Compensado</dt><dd class="font-semibold tabular text-ink">{{ formatCentsBRL(deposit.appliedCents) }}</dd></div>
        <div><dt class="text-sm text-ink-muted">A devolver</dt><dd class="font-semibold tabular text-[rgb(var(--c-positive))]">{{ formatCentsBRL(deposit.refundCents) }}</dd></div>
        <div><dt class="text-sm text-ink-muted">Em aberto além da caução</dt><dd class="font-semibold tabular" :class="deposit.uncoveredCents ? 'text-[rgb(var(--c-negative))]' : 'text-ink'">{{ formatCentsBRL(deposit.uncoveredCents) }}</dd></div>
      </dl>
      <ul v-if="deposit.debts.length && !deposit.settled" class="mb-5 divide-y divide-line rounded-control border border-line">
        <li v-for="d in deposit.debts" :key="d.receivableId" class="flex justify-between gap-3 px-4 py-2 text-[15px]">
          <span>{{ d.description }} <span class="text-ink-muted">· vence {{ formatIsoDateBR(d.dueDate) }}</span></span>
          <span class="tabular">{{ formatCentsBRL(d.appliedCents) }} de {{ formatCentsBRL(d.remainingCents) }}</span>
        </li>
      </ul>
      <p v-if="deposit.settled" class="text-[15px] text-ink">Fechada em {{ formatDateTimeBR(deposit.settled.at) }}.</p>
      <p v-else-if="deposit.blockedReason" class="text-[15px] text-ink-soft">{{ deposit.blockedReason }}</p>
      <AppButton v-if="deposit.canSettle && auth.allows('finance', 'pay')" :loading="busy === 'settle'" @click="confirmSettle = true">Fechar caução</AppButton>
    </section>

    <ConfirmDialog
      :open="confirmSettle"
      title="Fechar caução"
      :message="`Compensar ${formatCentsBRL(deposit?.appliedCents ?? 0)} das contas em aberto e registrar a devolução de ${formatCentsBRL(deposit?.refundCents ?? 0)} ao motorista? Não dá para desfazer pelo sistema.`"
      confirm-label="Fechar caução"
      :loading="busy === 'settle'"
      @cancel="confirmSettle = false"
      @confirm="settle"
    />
  </div>
</template>
