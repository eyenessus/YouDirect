<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  formatDateTimeBR,
  maintenanceRequestCategories,
  maintenanceRequestCategoryLabels,
  maintenanceRequestStatusLabels,
  type MaintenanceRequest,
  type MaintenanceRequestCategory,
} from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { ApiRequestError, uploadDriverFile } from '@/lib/api';
import { useToastStore } from '@/stores/ui';
import { portalGet, portalPost, usePortal } from './usePortal';

const portal = usePortal();
const toasts = useToastStore();
const requests = ref<MaintenanceRequest[]>([]);
const saving = ref(false);
const uploading = ref(false);
const error = ref<string | null>(null);
const photos = ref<Array<{ id: string; url: string }>>([]);
const form = reactive({ category: 'MECHANICAL' as MaintenanceRequestCategory, description: '', vehicleStopped: false });

const active = computed(() => portal.state.rentals.find((r) => r.status === 'ACTIVE') ?? null);
const categoryOptions = maintenanceRequestCategories.map((c) => ({ value: c, label: maintenanceRequestCategoryLabels[c] }));
const tone = { OPEN: 'amber', SCHEDULED: 'blue', DONE: 'green', REJECTED: 'slate' } as const;

async function load() {
  requests.value = (await portalGet<{ data: MaintenanceRequest[] }>('/driver/maintenance-requests')).data;
}

async function onPhoto(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  uploading.value = true;
  try {
    const up = await uploadDriverFile(file, 'MAINTENANCE_REQUEST_PHOTO');
    photos.value.push({ id: up.id, url: up.url });
  } catch (err) {
    toasts.error('Não foi possível enviar a foto', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

async function submit() {
  if (!active.value) return;
  if (form.description.trim().length < 5) {
    error.value = 'Descreva o problema';
    return;
  }
  error.value = null;
  saving.value = true;
  try {
    await portalPost('/driver/maintenance-requests', {
      rentalId: active.value.id,
      category: form.category,
      description: form.description,
      vehicleStopped: form.vehicleStopped,
      photoFileIds: photos.value.map((p) => p.id),
    });
    toasts.success('Pedido enviado à locadora');
    form.description = '';
    form.vehicleStopped = false;
    photos.value = [];
    await load();
  } catch (err) {
    toasts.error('Não foi possível enviar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <h1 class="text-xl font-bold text-ink">Manutenção</h1>

    <section v-if="active" class="fo-card space-y-4 p-5" aria-label="Novo pedido">
      <p class="text-[15px] text-ink-soft">
        Problema com o {{ active.vehicle.plate }}? Conte o que aconteceu e a locadora agenda a oficina.
      </p>
      <FormField v-slot="field" label="O que aconteceu?" required>
        <AppSelect :id="field.id" v-model="form.category" :options="categoryOptions" />
      </FormField>
      <FormField v-slot="field" label="Descrição" required :error="error ?? undefined">
        <AppTextarea :id="field.id" v-model="form.description" :rows="4" placeholder="Ex.: barulho no freio dianteiro ao frear" />
      </FormField>
      <AppCheckbox v-model="form.vehicleStopped" label="O carro está parado / não dá para rodar" />
      <div>
        <label class="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold text-brand-600">
          <input type="file" accept="image/*" capture="environment" class="sr-only" :disabled="uploading || photos.length >= 6" @change="onPhoto" />
          {{ uploading ? 'Enviando foto…' : '+ Adicionar foto' }}
        </label>
        <div v-if="photos.length" class="mt-2 flex flex-wrap gap-2">
          <img v-for="p in photos" :key="p.id" :src="p.url" alt="Foto do problema" class="size-16 rounded-control object-cover" />
        </div>
      </div>
      <AppButton block :loading="saving" @click="submit">Enviar pedido</AppButton>
    </section>
    <p v-else class="fo-card p-5 text-[15px] text-ink-muted">Pedidos de manutenção ficam disponíveis durante uma locação ativa.</p>

    <section v-if="requests.length" class="space-y-2" aria-label="Meus pedidos">
      <h2 class="text-lg font-bold text-ink">Meus pedidos</h2>
      <article v-for="r in requests" :key="r.id" class="fo-card p-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <p class="font-semibold text-ink">{{ maintenanceRequestCategoryLabels[r.category] }}</p>
            <p class="text-sm text-ink-muted">{{ formatDateTimeBR(r.createdAt) }} · {{ r.vehicle.plate }}</p>
          </div>
          <StatusBadge :label="maintenanceRequestStatusLabels[r.status]" :tone="tone[r.status]" :solid="false" />
        </div>
        <p class="mt-2 whitespace-pre-line text-[15px] text-ink-soft">{{ r.description }}</p>
        <p v-if="r.responseNote" class="mt-2 rounded-control bg-surface-muted px-3 py-2 text-sm text-ink">
          <strong>Locadora:</strong> {{ r.responseNote }}
        </p>
      </article>
    </section>
  </div>
</template>
