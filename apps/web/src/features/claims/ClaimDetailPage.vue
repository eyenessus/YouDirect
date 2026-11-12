<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import {
  claimFaultLabels,
  claimKindLabels,
  claimStatusLabels,
  claimTransitions,
  formatCentsBRL,
  formatDateTimeBR,
  formatIsoDateBR,
  type Claim,
  type ClaimStatus,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge, { type BadgeTone } from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

const route = useRoute();
const auth = useAuthStore();
const toasts = useToastStore();
const claim = ref<Claim | null>(null);
const loading = ref(true);
const busy = ref(false);
const charge = reactive({ amountCents: 0, dueDate: '' });
const finalCost = ref(0);

const id = computed(() => route.params.id as string);
const tones: Record<ClaimStatus, BadgeTone> = { OPEN: 'amber', IN_ANALYSIS: 'blue', IN_REPAIR: 'blue', CLOSED: 'green', CANCELED: 'slate' };
const nextStatuses = computed(() => (claim.value ? claimTransitions[claim.value.status] : []));
const editable = computed(() => claim.value && claim.value.status !== 'CLOSED' && claim.value.status !== 'CANCELED');
const canCharge = computed(
  () => auth.allows('claims', 'pay') && claim.value && !claim.value.receivable && claim.value.driver && claim.value.fault !== 'THIRD_PARTY' && claim.value.status !== 'CANCELED',
);

function apply(next: Claim) {
  claim.value = next;
  charge.amountCents = next.deductibleCents ?? 0;
  finalCost.value = next.finalCostCents ?? 0;
}

async function load() {
  loading.value = true;
  try {
    apply(await api.get<Claim>(`/claims/${id.value}`));
  } catch (err) {
    toasts.error('Sinistro não encontrado', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function run(action: () => Promise<void>, done: string) {
  busy.value = true;
  try {
    await action();
    toasts.success(done);
  } catch (err) {
    toasts.error('Não foi possível concluir', err instanceof ApiRequestError ? err.message : undefined);
    await load();
  } finally {
    busy.value = false;
  }
}

const changeStatus = (status: ClaimStatus) =>
  run(async () => apply(await api.post<Claim>(`/claims/${id.value}/status`, { version: claim.value!.version, status })), 'Situação atualizada');

const saveCost = () =>
  run(async () => apply(await api.patch<Claim>(`/claims/${id.value}`, { version: claim.value!.version, finalCostCents: finalCost.value || null })), 'Custo final salvo');

const markDriverFault = () =>
  run(async () => apply(await api.patch<Claim>(`/claims/${id.value}`, { version: claim.value!.version, fault: 'DRIVER' })), 'Culpa registrada como do motorista');

const chargeDriver = () =>
  run(async () => {
    const res = await api.post<{ claim: Claim; alreadyCharged: boolean }>(`/claims/${id.value}/charge`, {
      version: claim.value!.version,
      amountCents: charge.amountCents || undefined,
      dueDate: charge.dueDate || undefined,
    });
    apply(res.claim);
  }, 'Franquia lançada em Contas a Receber');
</script>

<template>
  <div>
    <p v-if="loading" class="text-ink-muted" role="status">Carregando...</p>
    <template v-else-if="claim">
      <PageHeader
        eyebrow="Sinistros"
        :title="claim.claimNumber"
        :subtitle="`${claimKindLabels[claim.kind]} em ${formatIsoDateBR(claim.occurredOn)} · ${claim.vehicle.plate} ${claim.vehicle.label}`"
        show-back
        back-to="/dashboard/claims"
      />

      <div class="grid gap-6 xl:grid-cols-3">
        <div class="space-y-6 xl:col-span-2">
          <section class="fo-card p-7">
            <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 class="text-xl font-bold text-ink">Situação</h2>
              <StatusBadge :label="claimStatusLabels[claim.status]" :tone="tones[claim.status]" />
            </div>
            <div v-if="auth.allows('claims', 'update') && nextStatuses.length" class="flex flex-wrap gap-2">
              <AppButton
                v-for="s in nextStatuses"
                :key="s"
                :variant="s === 'CANCELED' ? 'secondary' : 'primary'"
                :disabled="busy"
                @click="changeStatus(s)"
              >
                {{ s === 'CANCELED' ? 'Cancelar sinistro' : `Passar para: ${claimStatusLabels[s]}` }}
              </AppButton>
            </div>
            <dl class="mt-6 grid gap-4 text-[15px] sm:grid-cols-2">
              <div>
<dt class="text-ink-muted">Motorista</dt><dd class="font-medium text-ink">
                <RouterLink v-if="claim.driver" :to="`/dashboard/drivers/${claim.driver.id}`" class="text-brand-600 hover:underline">{{ claim.driver.fullName }}</RouterLink>
                <span v-else>Sem locação na data</span>
              </dd>
</div>
              <div><dt class="text-ink-muted">Locação</dt><dd class="font-medium text-ink">{{ claim.rental?.rentalNumber ?? '—' }}</dd></div>
              <div><dt class="text-ink-muted">Culpa</dt><dd class="font-medium text-ink">{{ claimFaultLabels[claim.fault] }}</dd></div>
              <div><dt class="text-ink-muted">Local</dt><dd class="font-medium text-ink">{{ claim.location ?? '—' }}</dd></div>
              <div><dt class="text-ink-muted">B.O.</dt><dd class="font-medium text-ink">{{ claim.policeReportNumber ?? '—' }}</dd></div>
              <div><dt class="text-ink-muted">Protocolo da seguradora</dt><dd class="font-medium text-ink">{{ claim.insurerClaimNumber ?? '—' }}</dd></div>
              <div><dt class="text-ink-muted">Franquia</dt><dd class="font-medium text-ink">{{ claim.deductibleCents ? formatCentsBRL(claim.deductibleCents) : '—' }}</dd></div>
              <div><dt class="text-ink-muted">Custo estimado</dt><dd class="font-medium text-ink">{{ claim.estimatedCostCents ? formatCentsBRL(claim.estimatedCostCents) : '—' }}</dd></div>
            </dl>
            <p class="mt-5 whitespace-pre-line text-[15px] text-ink-soft">{{ claim.description }}</p>
            <ul v-if="claim.files.length" class="mt-5 flex flex-wrap gap-3 text-sm">
              <li v-for="f in claim.files" :key="f.id">
                <a :href="f.url" target="_blank" rel="noopener" class="text-brand-600 hover:underline">{{ f.originalName }}</a>
              </li>
            </ul>
          </section>

          <section class="fo-card p-7">
            <h2 class="mb-4 text-xl font-bold text-ink">Histórico</h2>
            <ol class="space-y-3 text-[15px]">
              <li v-for="(h, i) in [...claim.history].reverse()" :key="i" class="flex flex-wrap gap-x-3">
                <span class="text-ink-muted">{{ formatDateTimeBR(h.at) }}</span>
                <span class="text-ink">{{ h.detail ?? h.action }}</span>
              </li>
            </ol>
          </section>
        </div>

        <div class="space-y-6">
          <section v-if="editable && auth.allows('claims', 'update')" class="fo-card p-7">
            <h2 class="mb-4 text-xl font-bold text-ink">Custo final do reparo</h2>
            <FormField v-slot="field" label="Valor">
              <CurrencyInput :id="field.id" v-model="finalCost" />
            </FormField>
            <div class="mt-4 flex justify-end"><AppButton :disabled="busy" @click="saveCost">Salvar</AppButton></div>
          </section>

          <section class="fo-card p-7">
            <h2 class="mb-4 text-xl font-bold text-ink">Franquia do motorista</h2>
            <template v-if="claim.receivable">
              <p class="text-[15px] text-ink-soft">
                Cobrança de <strong>{{ formatCentsBRL(claim.receivable.grossAmountCents) }}</strong> lançada em Contas a Receber
                ({{ claim.receivable.status === 'PAID' ? 'paga' : 'em aberto' }}).
              </p>
              <RouterLink to="/dashboard/finance/accounts-receivable" class="mt-3 inline-block text-sm font-semibold text-brand-600 hover:underline">Ver Contas a Receber</RouterLink>
            </template>
            <template v-else-if="canCharge">
              <p class="mb-4 text-[15px] text-ink-muted">Gera uma conta a receber para o motorista, que também aparece na Área do Motorista.</p>
              <FormField v-slot="field" label="Valor da franquia">
                <CurrencyInput :id="field.id" v-model="charge.amountCents" />
              </FormField>
              <FormField v-slot="field" label="Vencimento (padrão: 7 dias)" class="mt-4">
                <AppInput :id="field.id" v-model="charge.dueDate" type="date" />
              </FormField>
              <div class="mt-4 flex justify-end"><AppButton :disabled="busy" @click="chargeDriver">Cobrar motorista</AppButton></div>
            </template>
            <template v-else>
              <p class="text-[15px] text-ink-muted">
                {{ !claim.driver ? 'Sem motorista vinculado, não há a quem cobrar.' : claim.fault === 'THIRD_PARTY' ? 'A culpa é de terceiro: o motorista não é cobrado.' : 'Sem permissão para cobrar.' }}
              </p>
              <AppButton v-if="claim.fault === 'THIRD_PARTY' && editable && auth.allows('claims', 'update')" variant="secondary" class="mt-3" :disabled="busy" @click="markDriverFault">
                Registrar culpa do motorista
              </AppButton>
            </template>
            <AppButton v-if="claim.fault === 'UNDETERMINED' && editable && auth.allows('claims', 'update') && !claim.receivable" variant="secondary" class="mt-3" :disabled="busy" @click="markDriverFault">
              Registrar culpa do motorista
            </AppButton>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>
