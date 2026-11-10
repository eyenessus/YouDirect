<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Ban, Building2, Car, FileText, Gavel, HandCoins, History, MessageCircle, Pencil, RefreshCw, Stamp, User } from 'lucide-vue-next';
import {
  businessDate,
  canTransitionFine,
  fineAppealInstanceLabels,
  fineAppealInstances,
  fineAppealStatusLabels,
  fineGravityLabels,
  fineIndicationStatusLabels,
  fineMatchConfidenceLabels,
  formatCentsBRL,
  formatDateTimeBR,
  formatIsoDateBR,
  receivableStatusLabels,
  trafficFineStatusLabels,
  type FineAppealInstance,
  type FineNotifyResult,
  type ReceivableStatus,
  type TrafficFine,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import FileDropzone from '@/components/ui/FileDropzone.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError, type UploadedFileResponse } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { fineDeadlineTone, statusTone } from '@/lib/status';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();
const today = businessDate();

const fine = ref<TrafficFine | null>(null);
const loading = ref(true);
const busy = ref(false);

type ModalKind = 'identify' | 'indicate' | 'charge' | 'contest' | 'appeal' | 'liable' | 'cancel' | 'notify' | null;
const modal = ref<ModalKind>(null);
const form = reactive({
  driverId: '',
  rentalId: '',
  protocol: '',
  indicatedAt: today,
  proofFileId: '' as string,
  amountCents: 0,
  dueDate: '',
  instance: 'DEFESA_PREVIA' as FineAppealInstance,
  filedAt: today,
  result: 'DENIED' as 'GRANTED' | 'DENIED',
  reason: '',
});
const drivers = ref<Array<{ id: string; fullName: string }>>([]);
const notifyResult = ref<FineNotifyResult | null>(null);

const actionHistoryLabels: Record<string, string> = {
  created: 'Multa cadastrada',
  matched: 'Identificação automática',
  updated: 'Dados alterados',
  identified: 'Motorista definido',
  indicated: 'Condutor indicado ao órgão',
  charged: 'Cobrada do motorista',
  paid: 'Paga pelo motorista',
  payment_reversed: 'Pagamento estornado',
  contested: 'Recurso registrado',
  appeal_granted: 'Recurso deferido',
  appeal_denied: 'Recurso indeferido',
  company_liable: 'Assumida pela empresa',
  canceled: 'Multa cancelada',
  driver_notified: 'Motorista avisado',
  indication_missed: 'Prazo de indicação perdido',
};

const can = (to: Parameters<typeof canTransitionFine>[1]) => (fine.value ? canTransitionFine(fine.value.status, to) : false);
const deadlineBadge = computed(() => (fine.value ? fineDeadlineTone(fine.value, today) : null));
const canIdentify = computed(() => auth.allows('fines', 'update') && fine.value !== null && ['RECEIVED', 'DRIVER_IDENTIFIED'].includes(fine.value.status));
const needsDecision = computed(
  () => fine.value !== null && fine.value.status === 'RECEIVED' && ['MEDIUM', 'AMBIGUOUS', 'NONE'].includes(fine.value.match.confidence),
);

async function load() {
  try {
    fine.value = await api.get<TrafficFine>(`/traffic-fines/${route.params.id}`);
  } catch {
    toasts.error('Multa não encontrada');
    void router.replace('/dashboard/fines');
  } finally {
    loading.value = false;
  }
}

async function open(kind: Exclude<ModalKind, null>) {
  if (!fine.value) return;
  form.reason = '';
  form.protocol = '';
  form.proofFileId = '';
  form.indicatedAt = today;
  form.filedAt = today;
  form.amountCents = fine.value.chargeAmountCents;
  form.dueDate = '';
  form.driverId = fine.value.match.driver?.id ?? '';
  form.rentalId = fine.value.match.rental?.id ?? '';
  modal.value = kind;
  if (kind === 'identify' && drivers.value.length === 0) {
    try {
      drivers.value = (await api.get<{ data: Array<{ id: string; fullName: string }> }>('/drivers', { query: { limit: 100 } })).data;
    } catch {
      /* lista de motoristas é opcional: as candidatas continuam disponíveis */
    }
  }
  if (kind === 'notify') await notify();
}

function pickCandidate(c: TrafficFine['match']['candidates'][number]) {
  form.driverId = c.driverId;
  form.rentalId = c.rentalId;
}

async function run(path: string, body: Record<string, unknown>, success: string) {
  if (!fine.value) return;
  busy.value = true;
  try {
    const res = await api.post<TrafficFine | { fine: TrafficFine }>(`/traffic-fines/${fine.value.id}/${path}`, {
      ...body,
      version: fine.value.version,
    });
    fine.value = 'fine' in res ? res.fine : res;
    modal.value = null;
    toasts.success(success);
  } catch (err) {
    toasts.error('Não foi possível concluir', err instanceof ApiRequestError ? err.message : undefined);
    if (err instanceof ApiRequestError && err.status === 409) await load();
  } finally {
    busy.value = false;
  }
}

async function notify() {
  if (!fine.value) return;
  busy.value = true;
  notifyResult.value = null;
  try {
    notifyResult.value = await api.post<FineNotifyResult>(`/traffic-fines/${fine.value.id}/notify-driver`);
    if (notifyResult.value.delivered) toasts.success('Mensagem enviada ao motorista');
    await load();
  } catch (err) {
    modal.value = null;
    toasts.error('Não foi possível avisar o motorista', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    busy.value = false;
  }
}

const driverOptions = computed(() => drivers.value.map((d) => ({ value: d.id, label: d.fullName })));
const instanceOptions = fineAppealInstances.map((i) => ({ value: i, label: fineAppealInstanceLabels[i] }));

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <AppSkeleton v-if="loading" variant="block" />

    <template v-else-if="fine">
      <PageHeader
        eyebrow="MULTAS"
        :title="`Multa ${fine.fineNumber}`"
        :subtitle="`AIT ${fine.aitNumber} · ${fine.authority.name}`"
        back-to="/dashboard/fines"
      >
        <template #actions>
          <StatusBadge v-if="deadlineBadge" :label="deadlineBadge.label" :tone="deadlineBadge.tone" />
          <StatusBadge :label="trafficFineStatusLabels[fine.status]" :tone="statusTone.fine[fine.status]" :solid="false" />
        </template>
      </PageHeader>

      <!-- Ações disponíveis no estado atual -->
      <section class="fo-card flex flex-wrap gap-3 p-5" aria-label="Ações da multa">
        <AppButton v-if="canIdentify" variant="secondary" @click="open('identify')">
          <template #icon><User class="size-4" /></template>
          {{ fine.match.driver ? 'Trocar motorista' : 'Identificar motorista' }}
        </AppButton>
        <AppButton v-if="canIdentify" variant="ghost" :loading="busy && modal === null" @click="run('rematch', {}, 'Identificação refeita')">
          <template #icon><RefreshCw class="size-4" /></template>
          Refazer identificação
        </AppButton>
        <AppButton v-if="auth.allows('fines', 'update') && can('INDICATED') && fine.match.driver" variant="secondary" @click="open('indicate')">
          <template #icon><Stamp class="size-4" /></template>
          Registrar indicação
        </AppButton>
        <AppButton v-if="auth.allows('fines', 'pay') && can('CHARGED') && fine.match.driver && !fine.receivable" @click="open('charge')">
          <template #icon><HandCoins class="size-4" /></template>
          Cobrar do motorista
        </AppButton>
        <AppButton v-if="auth.allows('fines', 'update') && fine.match.driver && fine.status !== 'CANCELED'" variant="secondary" @click="open('notify')">
          <template #icon><MessageCircle class="size-4" /></template>
          Avisar motorista
        </AppButton>
        <AppButton v-if="auth.allows('fines', 'update') && can('CONTESTED')" variant="secondary" @click="open('contest')">
          <template #icon><Gavel class="size-4" /></template>
          Registrar recurso
        </AppButton>
        <AppButton v-if="auth.allows('fines', 'update') && fine.status === 'CONTESTED'" @click="open('appeal')">
          <template #icon><Gavel class="size-4" /></template>
          Resultado do recurso
        </AppButton>
        <AppButton v-if="auth.allows('fines', 'update') && can('COMPANY_LIABLE')" variant="ghost" @click="open('liable')">
          <template #icon><Building2 class="size-4" /></template>
          Empresa assume
        </AppButton>
        <AppButton
          v-if="auth.allows('fines', 'update') && fine.status !== 'CANCELED'"
          variant="ghost"
          @click="router.push(`/dashboard/fines/${fine.id}/edit`)"
        >
          <template #icon><Pencil class="size-4" /></template>
          Editar
        </AppButton>
        <AppButton v-if="auth.allows('fines', 'delete') && can('CANCELED')" variant="danger-outline" @click="open('cancel')">
          <template #icon><Ban class="size-4" /></template>
          Cancelar multa
        </AppButton>
      </section>

      <div class="grid gap-6 xl:grid-cols-2">
        <!-- Motorista identificado -->
        <section class="fo-card p-7 xl:col-span-2" :class="needsDecision ? 'ring-2 ring-[rgb(var(--c-warning)/0.5)]' : ''">
          <h2 class="mb-2 flex items-center gap-2.5 text-xl font-bold text-ink">
            <User class="size-5 text-ink-soft" aria-hidden="true" /> Quem estava com o carro
          </h2>
          <p class="mb-5 text-sm text-ink-muted">{{ fineMatchConfidenceLabels[fine.match.confidence] }}</p>
          <dl v-if="fine.match.driver" class="grid gap-x-8 gap-y-5 sm:grid-cols-3">
            <div>
              <dt class="text-[15px] text-ink-muted">Motorista</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">
                <RouterLink :to="`/dashboard/drivers/${fine.match.driver.id}`" class="hover:text-brand-600">{{ fine.match.driver.fullName }}</RouterLink>
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Locação</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">
                <RouterLink v-if="fine.match.rental" :to="`/dashboard/rentals/${fine.match.rental.id}`" class="hover:text-brand-600">
                  {{ fine.match.rental.rentalNumber }}
                </RouterLink>
                <span v-else>—</span>
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Período da locação</dt>
              <dd class="mt-1 text-[17px] tabular text-ink">
                <template v-if="fine.match.rental">
                  {{ formatIsoDateBR(fine.match.rental.startDate) }} até
                  {{ fine.match.rental.endDate ? formatIsoDateBR(fine.match.rental.endDate) : 'hoje' }}
                </template>
                <template v-else>—</template>
              </dd>
            </div>
          </dl>
          <div v-if="fine.status === 'RECEIVED' && fine.match.confidence === 'MEDIUM' && fine.match.driver && canIdentify" class="mt-5">
            <AppButton
              :loading="busy"
              @click="run('identify', { driverId: fine.match.driver.id, rentalId: fine.match.rental?.id }, 'Motorista confirmado')"
            >
              Confirmar {{ fine.match.driver.fullName }}
            </AppButton>
          </div>
          <div v-if="fine.match.candidates.length > 1 && canIdentify && fine.status === 'RECEIVED'" class="mt-4 space-y-2">
            <p class="text-sm font-medium text-ink">Locações no dia da infração — escolha o motorista:</p>
            <div class="flex flex-wrap gap-2">
              <AppButton
                v-for="c in fine.match.candidates"
                :key="c.rentalId"
                variant="secondary"
                :loading="busy"
                @click="run('identify', { driverId: c.driverId, rentalId: c.rentalId }, 'Motorista definido')"
              >
                {{ c.driverName }} · {{ c.rentalNumber }}
              </AppButton>
            </div>
          </div>
          <p v-if="fine.match.confidence === 'NONE' && !fine.match.driver" class="text-[15px] text-ink-soft">
            Nenhuma locação cobre {{ formatIsoDateBR(fine.occurredOn) }}. Se o carro estava com alguém, identifique o motorista; se não,
            a empresa assume a multa.
          </p>
        </section>

        <!-- Infração -->
        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <Car class="size-5 text-ink-soft" aria-hidden="true" /> Infração
          </h2>
          <dl class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <dt class="text-[15px] text-ink-muted">Descrição</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">
                {{ fine.infractionCode ? `${fine.infractionCode} · ` : '' }}{{ fine.infractionDescription }}
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Data e hora</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">{{ formatDateTimeBR(fine.occurredAt) }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Veículo</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">
                <RouterLink :to="`/dashboard/vehicles/${fine.vehicle.id}`" class="hover:text-brand-600">{{ fine.vehicle.plate }}</RouterLink>
                <span class="font-normal text-ink-muted"> · {{ fine.vehicle.brand }} {{ fine.vehicle.model }}</span>
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Local</dt>
              <dd class="mt-1 text-[17px] text-ink">{{ fine.place || '—' }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Gravidade</dt>
              <dd class="mt-1 text-[17px] text-ink">
                {{ fine.gravity ? fineGravityLabels[fine.gravity] : '—' }}{{ fine.points !== null ? ` · ${fine.points} pontos` : '' }}
              </dd>
            </div>
          </dl>
        </section>

        <!-- Valores e prazos -->
        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <FileText class="size-5 text-ink-soft" aria-hidden="true" /> Valores e prazos
          </h2>
          <dl class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <div>
              <dt class="text-[15px] text-ink-muted">Valor da multa</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">{{ formatCentsBRL(fine.amountCents) }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Com desconto</dt>
              <dd class="mt-1 text-[17px] tabular text-ink">
                <template v-if="fine.discountedAmountCents !== null">
                  {{ formatCentsBRL(fine.discountedAmountCents) }} até {{ formatIsoDateBR(fine.discountUntil) }}
                </template>
                <template v-else>—</template>
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Prazo de indicação</dt>
              <dd class="mt-1 text-[17px] tabular text-ink">
                {{ formatIsoDateBR(fine.indicationDeadline) }} · {{ fineIndicationStatusLabels[fine.indication.status] }}
                <span v-if="fine.indication.protocol" class="block text-sm text-ink-muted">Protocolo {{ fine.indication.protocol }}</span>
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Vencimento do boleto</dt>
              <dd class="mt-1 text-[17px] tabular text-ink">{{ formatIsoDateBR(fine.dueDate) }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Cobrança do motorista</dt>
              <dd class="mt-1 text-[17px] tabular text-ink">
                <template v-if="fine.receivable">
                  {{ formatCentsBRL(fine.receivable.grossAmountCents) }} · vence {{ formatIsoDateBR(fine.receivable.dueDate) }}
                  <span class="block text-sm text-ink-muted">
                    {{ receivableStatusLabels[fine.receivable.status as ReceivableStatus] ?? fine.receivable.status }} ·
                    pago {{ formatCentsBRL(fine.receivable.paidAmountCents) }}
                    <RouterLink
                      v-if="auth.allows('finance', 'read')"
                      to="/dashboard/finance/accounts-receivable"
                      class="ml-1 text-brand-600 hover:underline"
                    >
                      ver em Contas a Receber
                    </RouterLink>
                  </span>
                </template>
                <template v-else>Ainda não cobrada · {{ formatCentsBRL(fine.chargeAmountCents) }} hoje</template>
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Recurso</dt>
              <dd class="mt-1 text-[17px] text-ink">
                {{ fineAppealStatusLabels[fine.appeal.status] }}
                <span v-if="fine.appeal.instance" class="block text-sm text-ink-muted">
                  {{ fineAppealInstanceLabels[fine.appeal.instance] }} · {{ formatIsoDateBR(fine.appeal.filedAt) }}
                </span>
              </dd>
            </div>
          </dl>
        </section>

        <!-- Documentos -->
        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <FileText class="size-5 text-ink-soft" aria-hidden="true" /> Documentos e observações
          </h2>
          <dl class="space-y-5">
            <div>
              <dt class="text-[15px] text-ink-muted">Notificação</dt>
              <dd class="mt-1 text-[17px] font-semibold">
                <a v-if="fine.files.notice" :href="fine.files.notice.url" target="_blank" rel="noopener" class="text-brand-600 hover:underline">
                  {{ fine.files.notice.originalName }}
                </a>
                <span v-else class="text-ink">—</span>
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Comprovante da indicação</dt>
              <dd class="mt-1 text-[17px] font-semibold">
                <a v-if="fine.files.proof" :href="fine.files.proof.url" target="_blank" rel="noopener" class="text-brand-600 hover:underline">
                  {{ fine.files.proof.originalName }}
                </a>
                <span v-else class="text-ink">—</span>
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Observações</dt>
              <dd class="mt-1 whitespace-pre-line text-[17px] text-ink">{{ fine.notes || '—' }}</dd>
            </div>
          </dl>
        </section>

        <!-- Histórico -->
        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <History class="size-5 text-ink-soft" aria-hidden="true" /> Histórico
          </h2>
          <ol class="space-y-4 border-l border-line pl-5">
            <li v-for="(h, i) in [...fine.history].reverse()" :key="i" class="relative">
              <span class="absolute -left-[26px] top-1.5 size-2.5 rounded-full bg-brand-500" aria-hidden="true" />
              <p class="font-semibold text-ink">{{ actionHistoryLabels[h.action] ?? h.action }}</p>
              <p v-if="h.detail" class="text-[15px] text-ink-soft">{{ h.detail }}</p>
              <p class="text-sm tabular text-ink-muted">{{ formatDateTimeBR(h.at) }}{{ h.actorName ? ` · ${h.actorName}` : '' }}</p>
            </li>
          </ol>
        </section>
      </div>

      <!-- Identificar -->
      <AppModal :open="modal === 'identify'" title="Identificar motorista" @close="modal = null">
        <div class="space-y-4">
          <div v-if="fine.match.candidates.length" class="space-y-2">
            <p class="text-sm font-medium text-ink">Locações deste veículo no dia:</p>
            <AppButton
              v-for="c in fine.match.candidates"
              :key="c.rentalId"
              :variant="form.rentalId === c.rentalId ? 'primary' : 'secondary'"
              block
              @click="pickCandidate(c)"
            >
              {{ c.driverName }} · {{ c.rentalNumber }}
            </AppButton>
          </div>
          <FormField v-slot="field" label="Ou escolha o motorista">
            <AppSelect
              :id="field.id"
              :model-value="form.driverId"
              :options="driverOptions"
              placeholder="Selecione"
              @update:model-value="(v) => { form.driverId = v ?? ''; form.rentalId = fine?.match.candidates.find((c) => c.driverId === v)?.rentalId ?? ''; }"
            />
          </FormField>
        </div>
        <template #footer>
          <AppButton variant="secondary" @click="modal = null">Fechar</AppButton>
          <AppButton
            :disabled="!form.driverId"
            :loading="busy"
            @click="run('identify', { driverId: form.driverId, rentalId: form.rentalId || undefined }, 'Motorista definido')"
          >
            Salvar
          </AppButton>
        </template>
      </AppModal>

      <!-- Indicação -->
      <AppModal :open="modal === 'indicate'" title="Registrar indicação do condutor" description="Formulário de identificação enviado ao órgão autuador." @close="modal = null">
        <div class="space-y-4">
          <FormField v-slot="field" label="Data da indicação" required>
            <AppInput :id="field.id" v-model="form.indicatedAt" type="date" />
          </FormField>
          <FormField v-slot="field" label="Protocolo">
            <AppInput :id="field.id" v-model="form.protocol" />
          </FormField>
          <FileDropzone
            purpose="TRAFFIC_FINE_PROOF"
            title="Comprovante (opcional)"
            @uploaded="(f: UploadedFileResponse) => (form.proofFileId = f.id)"
          />
        </div>
        <template #footer>
          <AppButton variant="secondary" @click="modal = null">Fechar</AppButton>
          <AppButton
            :loading="busy"
            @click="run('indicate', { indicatedAt: form.indicatedAt, protocol: form.protocol || undefined, proofFileId: form.proofFileId || undefined }, 'Indicação registrada')"
          >
            Salvar
          </AppButton>
        </template>
      </AppModal>

      <!-- Cobrança -->
      <AppModal
        :open="modal === 'charge'"
        title="Cobrar do motorista"
        :description="`Gera uma conta a receber para ${fine.match.driver?.fullName ?? 'o motorista'}. Sem vencimento informado, a cobrança cai no próximo vencimento do aluguel.`"
        @close="modal = null"
      >
        <div class="space-y-4">
          <FormField v-slot="field" label="Valor" hint="Valor com desconto enquanto válido, mais a taxa administrativa">
            <CurrencyInput :id="field.id" v-model="form.amountCents" />
          </FormField>
          <FormField v-slot="field" label="Vencimento" hint="Deixe em branco para usar o próximo vencimento do aluguel">
            <AppInput :id="field.id" v-model="form.dueDate" type="date" />
          </FormField>
        </div>
        <template #footer>
          <AppButton variant="secondary" @click="modal = null">Fechar</AppButton>
          <AppButton
            :disabled="form.amountCents <= 0"
            :loading="busy"
            @click="run('charge', { amountCents: form.amountCents, dueDate: form.dueDate || undefined }, 'Cobrança criada em Contas a Receber')"
          >
            Cobrar
          </AppButton>
        </template>
      </AppModal>

      <!-- Recurso -->
      <AppModal :open="modal === 'contest'" title="Registrar recurso" @close="modal = null">
        <div class="space-y-4">
          <FormField v-slot="field" label="Instância" required>
            <AppSelect :id="field.id" v-model="form.instance" :options="instanceOptions" />
          </FormField>
          <FormField v-slot="field" label="Data do protocolo" required>
            <AppInput :id="field.id" v-model="form.filedAt" type="date" />
          </FormField>
          <FormField v-slot="field" label="Observação">
            <AppTextarea :id="field.id" v-model="form.reason" :rows="3" />
          </FormField>
        </div>
        <template #footer>
          <AppButton variant="secondary" @click="modal = null">Fechar</AppButton>
          <AppButton :loading="busy" @click="run('contest', { instance: form.instance, filedAt: form.filedAt, notes: form.reason || undefined }, 'Recurso registrado')">
            Salvar
          </AppButton>
        </template>
      </AppModal>

      <!-- Resultado do recurso -->
      <AppModal
        :open="modal === 'appeal'"
        title="Resultado do recurso"
        description="Deferido cancela a multa e estorna a cobrança. Indeferido devolve a multa ao andamento anterior."
        @close="modal = null"
      >
        <div class="space-y-4">
          <FormField v-slot="field" label="Resultado" required>
            <AppSelect
              :id="field.id"
              v-model="form.result"
              :options="[
                { value: 'DENIED', label: 'Indeferido' },
                { value: 'GRANTED', label: 'Deferido (multa anulada)' },
              ]"
            />
          </FormField>
          <FormField v-slot="field" label="Observação">
            <AppTextarea :id="field.id" v-model="form.reason" :rows="3" />
          </FormField>
        </div>
        <template #footer>
          <AppButton variant="secondary" @click="modal = null">Fechar</AppButton>
          <AppButton :loading="busy" @click="run('appeal-result', { result: form.result, notes: form.reason || undefined }, 'Resultado registrado')">
            Salvar
          </AppButton>
        </template>
      </AppModal>

      <!-- Empresa assume / Cancelar -->
      <AppModal
        :open="modal === 'liable' || modal === 'cancel'"
        :title="modal === 'cancel' ? 'Cancelar multa' : 'A empresa assume a multa'"
        :description="
          modal === 'cancel'
            ? 'Use quando o auto foi anulado ou cadastrado por engano. Pagamentos já recebidos do motorista são estornados.'
            : 'A multa sai da fila de cobrança e não será repassada ao motorista.'
        "
        @close="modal = null"
      >
        <FormField v-slot="field" label="Motivo" required>
          <AppTextarea :id="field.id" v-model="form.reason" :rows="3" />
        </FormField>
        <template #footer>
          <AppButton variant="secondary" @click="modal = null">Fechar</AppButton>
          <AppButton
            :variant="modal === 'cancel' ? 'danger' : 'primary'"
            :disabled="!form.reason.trim()"
            :loading="busy"
            @click="
              modal === 'cancel'
                ? run('cancel', { reason: form.reason }, 'Multa cancelada')
                : run('company-liable', { reason: form.reason }, 'Multa assumida pela empresa')
            "
          >
            Confirmar
          </AppButton>
        </template>
      </AppModal>

      <!-- Aviso ao motorista -->
      <AppModal :open="modal === 'notify'" title="Avisar motorista" @close="modal = null">
        <AppSkeleton v-if="busy && !notifyResult" variant="block" />
        <div v-else-if="notifyResult" class="space-y-4">
          <p v-if="notifyResult.delivered" class="text-[15px] text-ink">Mensagem enviada pelo WhatsApp.</p>
          <p v-else class="text-[15px] text-ink-soft">
            O envio automático não está disponível. Abra o WhatsApp com a mensagem pronta:
          </p>
          <pre class="whitespace-pre-wrap rounded-control bg-surface-muted p-4 text-sm text-ink">{{ notifyResult.message }}</pre>
        </div>
        <template #footer>
          <AppButton variant="secondary" @click="modal = null">Fechar</AppButton>
          <a
            v-if="notifyResult?.manualLink"
            :href="notifyResult.manualLink"
            target="_blank"
            rel="noopener"
            class="inline-flex items-center rounded-control bg-brand-500 px-4 py-2.5 font-semibold text-white hover:bg-brand-600"
          >
            Abrir WhatsApp
          </a>
        </template>
      </AppModal>
    </template>
  </div>
</template>
