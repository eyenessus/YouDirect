<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { AlertTriangle, ChevronDown, ChevronUp, ClipboardList, Maximize2, MessageCircle, RotateCcw } from 'lucide-vue-next';
import {
  formatIsoDateBR,
  formatKm,
  inspectionStatusLabels,
  inspectionStatuses,
  formatDateTimeBR,
  type CollectionStatus,
  type Inspection,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import RequestInspectionModal from './RequestInspectionModal.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

interface HistoryResponse {
  vehicle: { id: string; plate: string; brand: string; model: string; year: number | null };
  onSchedule: boolean;
  data: Inspection[];
}

const route = useRoute();
const auth = useAuthStore();
const toasts = useToastStore();

const vehicleId = route.params.vehicleId as string;
const history = ref<HistoryResponse | null>(null);
const loading = ref(true);
const expanded = ref<Set<string>>(new Set());
const lightbox = ref<{ url: string; label: string } | null>(null);
const requestOpen = ref(false);

const filters = ref({ from: '', to: '', status: '' });
const statusOptions = [
  { value: '', label: 'Todos' },
  ...inspectionStatuses.map((s) => ({ value: s, label: inspectionStatusLabels[s] })),
];

async function load() {
  loading.value = true;
  try {
    history.value = await api.get<HistoryResponse>(`/vehicles/${vehicleId}/inspections`, {
      query: {
        from: filters.value.from || undefined,
        to: filters.value.to || undefined,
        status: filters.value.status || undefined,
      },
    });
  } catch {
    toasts.error('Não foi possível carregar as vistorias');
  } finally {
    loading.value = false;
  }
}

function toggle(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

async function review(inspection: Inspection, decision: 'APPROVE' | 'REJECT') {
  try {
    await api.post(`/inspections/${inspection.id}/review`, { decision });
    toasts.success(decision === 'APPROVE' ? 'Vistoria aprovada' : 'Vistoria reprovada');
    await load();
  } catch (err) {
    toasts.error('Não foi possível registrar', err instanceof ApiRequestError ? err.message : undefined);
  }
}

/* ----------------------- correção de fotos ------------------------ */
const correction = ref<{ inspection: Inspection; slots: string[]; reason: string } | null>(null);
const correcting = ref(false);

function slotOptions(inspection: Inspection) {
  const base = inspection.photos.map((p) => ({ code: p.slotCode, label: p.slotLabel }));
  return [...base, { code: 'ODOMETER', label: 'Quilometragem' }];
}

function toggleSlot(code: string) {
  if (!correction.value) return;
  const set = new Set(correction.value.slots);
  if (set.has(code)) set.delete(code);
  else set.add(code);
  correction.value.slots = [...set];
}

async function submitCorrection() {
  if (!correction.value) return;
  if (correction.value.slots.length === 0 || correction.value.reason.trim().length < 3) {
    toasts.error('Escolha ao menos um ângulo e descreva o motivo');
    return;
  }
  correcting.value = true;
  try {
    const res = await api.post<{ guided: boolean; link: string | null }>(
      `/inspections/${correction.value.inspection.id}/request-correction`,
      { slots: correction.value.slots, reason: correction.value.reason.trim() },
    );
    toasts.success(
      'Correção solicitada',
      res.guided ? 'O cliente receberá a solicitação pelo WhatsApp.' : 'Envie o link ao cliente manualmente.',
    );
    correction.value = null;
    await load();
  } catch (err) {
    toasts.error('Não foi possível solicitar a correção', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    correcting.value = false;
  }
}

function collectionTone(status: string) {
  return statusTone.collection[status as CollectionStatus] ?? 'slate';
}

function previousEvidence(inspection: Inspection) {
  return (inspection.evidence ?? []).filter((e) => e.superseded || e.late || !e.slotCode);
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="VISTORIAS"
      :title="history ? `${history.vehicle.brand} ${history.vehicle.model}` : 'Vistorias'"
      :subtitle="history ? `${history.vehicle.plate} · ${history.vehicle.year ?? ''}`.trim() : ''"
      back-to="/dashboard/inspections"
    >
      <template #actions>
        <StatusBadge
          v-if="history"
          :label="history.onSchedule ? 'Em dia' : 'Atrasada'"
          :tone="history.onSchedule ? 'green' : 'red'"
        />
        <AppButton v-if="auth.allows('inspections', 'request')" @click="requestOpen = true">
          <template #icon><ClipboardList class="size-4" /></template>
          Solicitar vistoria
        </AppButton>
      </template>
    </PageHeader>

    <section class="fo-card p-6">
      <div class="grid gap-5 lg:grid-cols-3">
        <FormField v-slot="field" label="Data inicial">
          <AppInput :id="field.id" v-model="filters.from" type="date" @blur="load" />
        </FormField>
        <FormField v-slot="field" label="Data final">
          <AppInput :id="field.id" v-model="filters.to" type="date" @blur="load" />
        </FormField>
        <FormField v-slot="field" label="Status">
          <AppSelect
            :id="field.id"
            v-model="filters.status"
            :options="statusOptions"
            @update:model-value="load"
          />
        </FormField>
      </div>
    </section>

    <AppSkeleton v-if="loading" variant="cards" :rows="3" />

    <EmptyState
      v-else-if="(history?.data.length ?? 0) === 0"
      :icon="ClipboardList"
      message="Nenhuma vistoria registrada para este veículo no período selecionado."
    />

    <div v-else class="space-y-4">
      <article v-for="inspection in history?.data ?? []" :key="inspection.id" class="fo-card">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-4 p-6 text-left"
          :aria-expanded="expanded.has(inspection.id)"
          @click="toggle(inspection.id)"
        >
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-3">
              <h2 class="text-[22px] font-bold text-ink">
                Vistoria Manual – {{ formatIsoDateBR(inspection.scheduledAt) }}
              </h2>
              <StatusBadge
                :label="inspectionStatusLabels[inspection.status]"
                :tone="statusTone.inspection[inspection.status]"
              />
              <StatusBadge
                v-if="inspection.collection && inspection.collection.mode === 'WHATSAPP'"
                :label="`WhatsApp · ${inspection.collection.statusLabel}`"
                :tone="collectionTone(inspection.collection.status)"
                :solid="false"
              />
              <StatusBadge
                v-else-if="inspection.collection?.status === 'BLOCKED_NO_CONSENT'"
                label="WhatsApp bloqueado (sem consentimento)"
                tone="amber"
                :solid="false"
              />
            </div>
            <p class="mt-1.5 text-[17px] text-ink-muted">
              Prazo: {{ formatIsoDateBR(inspection.dueDate) }} • {{ inspection.responsibleName }}
            </p>
          </div>
          <component
            :is="expanded.has(inspection.id) ? ChevronUp : ChevronDown"
            class="size-5 shrink-0 text-ink-muted"
            aria-hidden="true"
          />
        </button>

        <div v-if="expanded.has(inspection.id)" class="border-t border-line px-6 pb-6 pt-5">
          <p class="text-[17px] font-semibold text-ink">
            Quilometragem informada na vistoria:
            <span class="font-bold tabular">{{ formatKm(inspection.odometerKm) }}</span>
          </p>
          <p
            v-if="inspection.odometerKm !== null"
            class="mt-2 flex items-center gap-2 text-[15px] text-[rgb(var(--c-warning))]"
          >
            <AlertTriangle class="size-4 shrink-0" aria-hidden="true" />
            Confira se esse valor coincide com a foto do odômetro antes de aprovar a vistoria.
          </p>

          <p v-if="inspection.photos.length === 0" class="mt-5 text-[15px] text-ink-muted">
            Nenhuma foto enviada ainda.
          </p>
          <div v-else class="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <figure v-for="photo in inspection.photos" :key="photo.fileId">
              <figcaption class="mb-2 text-[15px] text-ink-soft">{{ photo.slotLabel }}</figcaption>
              <button
                type="button"
                class="group relative block w-full overflow-hidden rounded-card border border-line"
                @click="lightbox = { url: photo.url, label: photo.slotLabel }"
              >
                <img
                  :src="photo.url"
                  :alt="`${photo.slotLabel} — vistoria de ${formatIsoDateBR(inspection.scheduledAt)}`"
                  class="aspect-[4/3] w-full object-cover"
                  loading="lazy"
                />
                <span
                  class="absolute inset-0 flex items-center justify-center bg-[rgb(var(--overlay)/0.35)] opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <Maximize2 class="size-6 text-white" aria-hidden="true" />
                </span>
              </button>
            </figure>
          </div>

          <div
            v-if="inspection.collection && inspection.collection.mode === 'WHATSAPP'"
            class="mt-6 rounded-card border border-line bg-surface-muted p-4"
          >
            <p class="flex items-center gap-2 text-[15px] font-semibold text-ink">
              <MessageCircle class="size-4" aria-hidden="true" /> Coleta pelo WhatsApp
              <span v-if="inspection.collection.round > 0" class="font-normal text-ink-muted">
                · correção {{ inspection.collection.round }}
              </span>
            </p>
            <p class="mt-1.5 text-sm text-ink-soft">
              <template v-if="inspection.collection.scheduledSendAt && inspection.collection.status === 'SCHEDULED'">
                Disparo agendado para {{ formatDateTimeBR(inspection.collection.scheduledSendAt) }}.
              </template>
              <template v-else>
                Fotos recebidas:
                {{ inspection.collection.requiredSlots.filter((s) => inspection.collection!.receivedSlots.includes(s.code)).length }}
                de {{ inspection.collection.requiredSlots.length }}
                <span v-if="inspection.collection.requireOdometer">
                  · quilometragem {{ inspection.collection.receivedSlots.includes('ODOMETER') ? 'informada' : 'pendente' }}
                </span>
              </template>
            </p>
            <ul class="mt-2 flex flex-wrap gap-2">
              <li v-for="slot in inspection.collection.requiredSlots" :key="slot.code">
                <StatusBadge
                  :label="slot.label"
                  :tone="inspection.collection.receivedSlots.includes(slot.code) ? 'green' : 'slate'"
                  :solid="false"
                />
              </li>
            </ul>
            <p v-if="inspection.collection.failureReason" class="mt-2 text-sm text-[rgb(var(--c-negative))]">
              {{ inspection.collection.failureReason }}
            </p>
          </div>

          <details v-if="previousEvidence(inspection).length > 0" class="mt-5">
            <summary class="cursor-pointer text-[15px] font-medium text-brand-600">
              Histórico de evidências ({{ previousEvidence(inspection).length }})
            </summary>
            <div class="mt-3 grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
              <figure v-for="(e, i) in previousEvidence(inspection)" :key="i">
                <figcaption class="mb-1 text-xs text-ink-muted">
                  {{ e.slotLabel }} · {{ e.superseded ? 'substituída' : e.late ? 'fora do prazo' : 'adicional' }}
                </figcaption>
                <button
                  type="button"
                  class="block w-full overflow-hidden rounded-card border border-line"
                  @click="lightbox = { url: e.url, label: e.slotLabel }"
                >
                  <img :src="e.url" :alt="`${e.slotLabel} (${e.source})`" class="aspect-[4/3] w-full object-cover opacity-80" loading="lazy" />
                </button>
              </figure>
            </div>
          </details>

          <div
            v-if="inspection.status === 'SUBMITTED' && auth.allows('inspections', 'review')"
            class="mt-6 flex flex-wrap gap-3"
          >
            <AppButton @click="review(inspection, 'APPROVE')">Aprovar vistoria</AppButton>
            <AppButton
              variant="secondary"
              @click="correction = { inspection, slots: [], reason: '' }"
            >
              <template #icon><RotateCcw class="size-4" /></template>
              Solicitar correção
            </AppButton>
            <AppButton variant="danger-outline" @click="review(inspection, 'REJECT')">
              Reprovar
            </AppButton>
          </div>

          <div
            v-if="inspection.delivery && inspection.delivery.status !== 'SENT' && inspection.delivery.channel !== 'WHATSAPP'"
            class="mt-6 rounded-card border border-[rgb(var(--c-warning)/0.3)] bg-[rgb(var(--c-warning)/0.08)] p-4"
          >
            <p class="text-[15px] font-semibold text-ink">Link não entregue automaticamente</p>
            <p class="mt-1.5 text-sm leading-relaxed text-ink-soft">
              {{ inspection.delivery.message }}
            </p>
            <a
              v-if="inspection.delivery.manualLink"
              :href="inspection.delivery.manualLink"
              target="_blank"
              rel="noopener"
              class="mt-2 inline-block text-sm font-medium text-brand-600 hover:underline"
            >
              Abrir envio manual
            </a>
          </div>
        </div>
      </article>
    </div>

    <AppModal :open="lightbox !== null" :title="lightbox?.label ?? ''" size="lg" @close="lightbox = null">
      <img v-if="lightbox" :src="lightbox.url" :alt="lightbox.label" class="w-full rounded-card" />
    </AppModal>

    <AppModal
      :open="correction !== null"
      title="Solicitar correção de fotos"
      description="A vistoria volta para coleta apenas com os itens escolhidos. As fotos atuais ficam no histórico."
      @close="correction = null"
    >
      <template v-if="correction">
        <fieldset>
          <legend class="text-[15px] font-semibold text-ink">O que precisa ser reenviado?</legend>
          <div class="mt-3 grid gap-2 sm:grid-cols-2">
            <label
              v-for="slot in slotOptions(correction.inspection)"
              :key="slot.code"
              class="flex items-center gap-2 rounded-control border border-line px-3 py-2 text-[15px]"
            >
              <input
                type="checkbox"
                class="size-[18px] rounded border-line"
                :checked="correction.slots.includes(slot.code)"
                @change="toggleSlot(slot.code)"
              />
              {{ slot.label }}
            </label>
          </div>
        </fieldset>
        <FormField v-slot="field" label="Motivo (enviado ao cliente)" class="mt-5">
          <AppTextarea :id="field.id" v-model="correction.reason" :rows="3" :maxlength="300" placeholder="Ex.: foto da frente escura, placa ilegível" />
        </FormField>
        <div class="mt-6 flex justify-end gap-3">
          <AppButton variant="secondary" @click="correction = null">Cancelar</AppButton>
          <AppButton :loading="correcting" @click="submitCorrection">Solicitar correção</AppButton>
        </div>
      </template>
    </AppModal>

    <RequestInspectionModal
      :open="requestOpen"
      :vehicle="history?.vehicle ?? null"
      @close="requestOpen = false"
      @created="load"
    />
  </div>
</template>
