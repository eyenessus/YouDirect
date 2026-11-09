<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { Camera, CheckCircle2, Loader2 } from 'lucide-vue-next';
import { formatIsoDateBR, type PublicInspection } from '@frotaone/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';

/**
 * [I/R] Formulário público de vistoria — não existe captura de
 * referência. Construído mobile-first com os mesmos tokens visuais e
 * protegido por token de uso único com validade (ver ASSUMPTIONS A-UI-02).
 */
const route = useRoute();
const token = String(route.params.token ?? '');

const data = ref<PublicInspection | null>(null);
const loading = ref(true);
const loadError = ref('');
const submitted = ref(false);
const submitting = ref(false);
const submitError = ref('');

const odometerKm = ref('');
const notes = ref('');
const photos = ref<Record<string, { fileId: string; preview: string; uploading: boolean }>>({});

const allUploaded = computed(
  () =>
    (data.value?.slots ?? []).length > 0 &&
    (data.value?.slots ?? []).every((slot) => photos.value[slot.code]?.fileId),
);

onMounted(async () => {
  try {
    data.value = await api.get<PublicInspection>(`/inspection-public/${token}`);
  } catch (err) {
    loadError.value =
      err instanceof ApiRequestError ? err.message : 'Link de vistoria inválido ou expirado.';
  } finally {
    loading.value = false;
  }
});

async function upload(slotCode: string, event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  photos.value = {
    ...photos.value,
    [slotCode]: { fileId: '', preview: URL.createObjectURL(file), uploading: true },
  };
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await api.post<{ fileId: string }>(`/inspection-public/${token}/photos`, form);
    photos.value = {
      ...photos.value,
      [slotCode]: { fileId: res.fileId, preview: photos.value[slotCode]!.preview, uploading: false },
    };
  } catch (err) {
    const next = { ...photos.value };
    delete next[slotCode];
    photos.value = next;
    submitError.value =
      err instanceof ApiRequestError ? err.message : 'Não foi possível enviar a foto.';
  }
}

async function submit() {
  submitError.value = '';
  submitting.value = true;
  try {
    await api.post(`/inspection-public/${token}/submit`, {
      odometerKm: Number(odometerKm.value || 0),
      notes: notes.value || undefined,
      photos: Object.entries(photos.value)
        .filter(([, value]) => value.fileId)
        .map(([slotCode, value]) => ({ slotCode, fileId: value.fileId })),
    });
    submitted.value = true;
  } catch (err) {
    submitError.value =
      err instanceof ApiRequestError ? err.message : 'Não foi possível concluir a vistoria.';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-canvas">
    <header class="bg-sidebar px-5 py-5 text-white">
      <div class="mx-auto flex max-w-2xl items-center gap-3">
        <span class="flex size-10 items-center justify-center rounded-xl bg-sidebar-active">
          <img src="/brand/frotaone-mark-white.png" alt="" class="size-6 object-contain" />
        </span>
        <div>
          <p class="text-lg font-bold leading-tight">FrotaOne</p>
          <p class="text-sm text-white/75">{{ data?.organizationName ?? 'Vistoria de veículo' }}</p>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-2xl px-5 py-8">
      <p v-if="loading" class="text-[15px] text-ink-muted">Carregando…</p>

      <div v-else-if="loadError" class="fo-card p-7">
        <h1 class="text-2xl font-bold text-ink">Link indisponível</h1>
        <p class="mt-2 text-[15px] leading-relaxed text-ink-muted">{{ loadError }}</p>
      </div>

      <div v-else-if="submitted" class="fo-card p-8 text-center">
        <CheckCircle2 class="mx-auto size-14 text-[rgb(var(--c-positive))]" aria-hidden="true" />
        <h1 class="mt-5 text-2xl font-bold text-ink">Vistoria enviada!</h1>
        <p class="mt-2 text-[15px] leading-relaxed text-ink-muted">
          Obrigado. A locadora vai conferir as fotos e a quilometragem informada.
        </p>
      </div>

      <template v-else-if="data">
        <h1 class="text-[26px] font-bold leading-tight text-ink">Vistoria do veículo</h1>
        <p class="mt-2 text-[17px] text-ink-soft">
          {{ data.vehicle.brand }} {{ data.vehicle.model }} {{ data.vehicle.year ?? '' }} ·
          <strong>{{ data.vehicle.plate }}</strong>
        </p>
        <p class="mt-1 text-[15px] text-ink-muted">
          Responsável: {{ data.responsibleName }} · Agendada para
          {{ formatIsoDateBR(data.scheduledAt) }}
        </p>

        <section class="fo-card mt-7 p-6">
          <FormField
            v-slot="field"
            label="Quilometragem atual (km)"
            required
            hint="Informe o número que aparece no painel do veículo."
          >
            <AppInput
              :id="field.id"
              v-model="odometerKm"
              type="number"
              min="0"
              inputmode="numeric"
              placeholder="Ex: 181652"
            />
          </FormField>
        </section>

        <section class="fo-card mt-5 p-6">
          <h2 class="mb-1 text-lg font-bold text-ink">Fotos solicitadas</h2>
          <p class="mb-5 text-[15px] text-ink-muted">
            Envie todas as {{ data.slots.length }} fotos abaixo.
          </p>

          <div class="grid gap-4 sm:grid-cols-2">
            <div v-for="slot in data.slots" :key="slot.code">
              <p class="fo-label">{{ slot.label }}</p>
              <label
                class="relative flex aspect-[4/3] cursor-pointer items-center justify-center overflow-hidden rounded-card border-2 border-dashed border-line bg-surface-muted/40 transition-colors hover:border-brand-400"
              >
                <img
                  v-if="photos[slot.code]?.preview"
                  :src="photos[slot.code]!.preview"
                  :alt="slot.label"
                  class="size-full object-cover"
                />
                <span v-else class="flex flex-col items-center gap-2 text-ink-muted">
                  <Camera class="size-7" aria-hidden="true" />
                  <span class="text-sm">Tirar/enviar foto</span>
                </span>
                <span
                  v-if="photos[slot.code]?.uploading"
                  class="absolute inset-0 flex items-center justify-center bg-[rgb(var(--overlay)/0.5)]"
                >
                  <Loader2 class="size-7 animate-spin text-white" />
                </span>
                <span
                  v-else-if="photos[slot.code]?.fileId"
                  class="absolute right-2 top-2 rounded-full bg-[rgb(var(--c-positive))] p-1"
                >
                  <CheckCircle2 class="size-4 text-white" />
                </span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  class="sr-only"
                  :aria-label="`Enviar foto: ${slot.label}`"
                  @change="upload(slot.code, $event)"
                />
              </label>
            </div>
          </div>
        </section>

        <section class="fo-card mt-5 p-6">
          <FormField v-slot="field" label="Observações (opcional)">
            <AppTextarea
              :id="field.id"
              v-model="notes"
              :rows="3"
              placeholder="Algum detalhe que a locadora precise saber?"
            />
          </FormField>
        </section>

        <p v-if="submitError" class="mt-5 text-sm text-negative" role="alert">{{ submitError }}</p>

        <AppButton
          class="mt-6"
          block
          size="lg"
          :loading="submitting"
          :disabled="!allUploaded || !odometerKm"
          @click="submit"
        >
          Enviar vistoria
        </AppButton>
        <p v-if="!allUploaded" class="mt-3 text-center text-sm text-ink-muted">
          Envie todas as fotos solicitadas para concluir.
        </p>
      </template>
    </main>
  </div>
</template>
