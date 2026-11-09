<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Camera, Plus, Trash2 } from 'lucide-vue-next';
import { MAX_ACTIVE_PHOTO_SLOTS, type PhotoSlot } from '@frotaone/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

interface SlotsResponse {
  data: PhotoSlot[];
  maxActive: number;
  activeCount: number;
}

interface EditableSlot {
  id?: string;
  code?: string;
  label: string;
  active: boolean;
  isDefault: boolean;
}

const auth = useAuthStore();
const toasts = useToastStore();

const slots = ref<EditableSlot[]>([]);
const loading = ref(true);
const saving = ref(false);
const newLabel = ref('');
const removeIndex = ref<number | null>(null);

const activeCount = computed(() => slots.value.filter((s) => s.active).length);
const canEdit = computed(() => auth.allows('inspections', 'update'));

async function load() {
  loading.value = true;
  try {
    const res = await api.get<SlotsResponse>('/inspection/photo-slots');
    slots.value = res.data.map((s) => ({
      id: s.id,
      code: s.code,
      label: s.label,
      active: s.active,
      isDefault: s.isDefault,
    }));
  } catch {
    toasts.error('Não foi possível carregar a configuração');
  } finally {
    loading.value = false;
  }
}

async function persist() {
  if (!canEdit.value) return;
  saving.value = true;
  try {
    const res = await api.put<SlotsResponse>('/inspection/photo-slots', {
      slots: slots.value.map((s) => ({ id: s.id, code: s.code, label: s.label, active: s.active })),
    });
    slots.value = res.data.map((s) => ({
      id: s.id,
      code: s.code,
      label: s.label,
      active: s.active,
      isDefault: s.isDefault,
    }));
    toasts.success('Configuração salva');
  } catch (err) {
    toasts.error('Não foi possível salvar', err instanceof ApiRequestError ? err.message : undefined);
    await load();
  } finally {
    saving.value = false;
  }
}

function addSlot() {
  const label = newLabel.value.trim();
  if (!label) return;
  if (activeCount.value >= MAX_ACTIVE_PHOTO_SLOTS) {
    toasts.warning(`Máximo de ${MAX_ACTIVE_PHOTO_SLOTS} slots ativos atingido`);
    return;
  }
  slots.value = [...slots.value, { label, active: true, isDefault: false }];
  newLabel.value = '';
  void persist();
}

function confirmRemove() {
  if (removeIndex.value === null) return;
  slots.value = slots.value.filter((_, index) => index !== removeIndex.value);
  removeIndex.value = null;
  void persist();
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="VISTORIAS"
      title="Configuração de fotos"
      subtitle="Defina quais e quantas fotos o motorista deve enviar em cada vistoria"
    />

    <AppSkeleton v-if="loading" variant="table" />

    <section v-else class="fo-card p-7">
      <div class="mb-6 flex flex-wrap items-center gap-4">
        <span
          class="inline-flex items-center gap-2 rounded-full bg-brand-500 px-4 py-1.5 text-sm font-semibold text-white"
        >
          <Camera class="size-4" aria-hidden="true" />
          {{ activeCount }} foto(s) ativa(s)
        </span>
        <span class="text-[15px] text-ink-muted">
          Máximo de {{ MAX_ACTIVE_PHOTO_SLOTS }} slots ativos
        </span>
      </div>

      <ul class="space-y-4">
        <li v-for="(slot, index) in slots" :key="slot.id ?? `new-${index}`" class="rounded-card border border-line p-5">
          <div class="flex flex-wrap items-center gap-4">
            <div class="min-w-[240px] flex-1">
              <AppInput
                v-model="slot.label"
                :aria-label="`Nome do tipo de foto ${index + 1}`"
                :disabled="!canEdit"
                @blur="persist"
              />
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <span
                  v-if="slot.code"
                  class="rounded bg-surface-muted px-2 py-0.5 font-mono text-[11px] uppercase text-ink-muted"
                >
                  {{ slot.code }}
                </span>
                <span
                  v-if="slot.isDefault"
                  class="rounded-full border border-line px-2.5 py-0.5 text-[11px] font-semibold text-ink-soft"
                >
                  Padrão
                </span>
              </div>
            </div>

            <label class="flex cursor-pointer items-center gap-2 text-[15px] text-ink">
              <input
                type="checkbox"
                class="size-[18px] accent-[rgb(var(--c-brand-500))]"
                :checked="slot.active"
                :disabled="!canEdit"
                @change="
                  slot.active = ($event.target as HTMLInputElement).checked;
                  persist();
                "
              />
              Ativo
            </label>

            <button
              type="button"
              class="rounded-lg p-2 text-negative transition-colors hover:bg-[rgb(var(--c-negative)/0.08)] disabled:opacity-40"
              :aria-label="`Remover ${slot.label}`"
              :disabled="!canEdit"
              @click="removeIndex = index"
            >
              <Trash2 class="size-[18px]" />
            </button>
          </div>
        </li>
      </ul>

      <div v-if="canEdit" class="mt-8 border-t border-line pt-6">
        <label for="new-slot" class="fo-label">Adicionar tipo de foto</label>
        <div class="flex flex-wrap gap-3">
          <div class="min-w-[240px] flex-1">
            <AppInput id="new-slot" v-model="newLabel" placeholder="Ex: Pneu frontal esquerdo" />
          </div>
          <AppButton :disabled="!newLabel.trim()" :loading="saving" @click="addSlot">
            <template #icon><Plus class="size-4" /></template>
            Adicionar
          </AppButton>
        </div>
        <p class="fo-hint">O motorista verá exatamente esses tipos de foto no formulário de envio.</p>
      </div>
    </section>

    <ConfirmDialog
      :open="removeIndex !== null"
      title="Remover tipo de foto"
      message="As fotos já enviadas em vistorias anteriores continuam preservadas no histórico. Novos envios deixarão de solicitar este tipo."
      confirm-label="Remover"
      danger
      @cancel="removeIndex = null"
      @confirm="confirmRemove"
    />
  </div>
</template>
