<script setup lang="ts">
import { ref } from 'vue';
import { TrendingDown } from 'lucide-vue-next';
import { formatCentsBRL, type FipeListItem, type Vehicle, type VehicleFipe } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/** Valor de mercado do veículo na tabela FIPE: vínculo, atualização e histórico mensal. */
const props = defineProps<{ vehicleId: string; fipe: VehicleFipe | null | undefined }>();
const emit = defineEmits<{ saved: [VehicleFipe | null] }>();
const auth = useAuthStore();
const toasts = useToastStore();

const editing = ref(false);
const busy = ref(false);
const brands = ref<FipeListItem[]>([]);
const models = ref<FipeListItem[]>([]);
const years = ref<FipeListItem[]>([]);
const form = ref({ brandId: '', modelId: '', yearId: '' });

const opts = (list: FipeListItem[]) => list.map((i) => ({ value: i.code, label: i.name }));
const fail = (title: string, err: unknown) => toasts.error(title, err instanceof ApiRequestError ? err.message : undefined);

async function startEdit() {
  editing.value = true;
  if (brands.value.length === 0) {
    try {
      brands.value = (await api.get<{ data: FipeListItem[] }>('/fipe/brands')).data;
    } catch (err) {
      fail('Não foi possível carregar as marcas da FIPE', err);
      editing.value = false;
    }
  }
}
async function pickBrand(id: string) {
  form.value = { brandId: id, modelId: '', yearId: '' };
  models.value = [];
  years.value = [];
  try {
    models.value = (await api.get<{ data: FipeListItem[] }>(`/fipe/brands/${id}/models`)).data;
  } catch (err) {
    fail('Não foi possível carregar os modelos', err);
  }
}
async function pickModel(id: string) {
  form.value = { ...form.value, modelId: id, yearId: '' };
  years.value = [];
  try {
    years.value = (await api.get<{ data: FipeListItem[] }>(`/fipe/brands/${form.value.brandId}/models/${id}/years`)).data;
  } catch (err) {
    fail('Não foi possível carregar os anos', err);
  }
}

async function run(action: () => Promise<Vehicle | null>, done: string) {
  busy.value = true;
  try {
    const vehicle = await action();
    emit('saved', vehicle?.fipe ?? null);
    toasts.success(done);
    editing.value = false;
  } catch (err) {
    fail('Não foi possível concluir', err);
  } finally {
    busy.value = false;
  }
}
const link = () => run(() => api.post<Vehicle>(`/vehicles/${props.vehicleId}/fipe`, form.value), 'Valor da FIPE vinculado');
const refresh = () => run(() => api.post<Vehicle>(`/vehicles/${props.vehicleId}/fipe/refresh`, {}), 'Valor da FIPE atualizado');
const unlink = () =>
  run(async () => {
    await api.delete(`/vehicles/${props.vehicleId}/fipe`);
    return null;
  }, 'Vínculo com a FIPE removido');
</script>

<template>
  <section class="fo-card p-7" aria-label="Valor de mercado (FIPE)">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 class="flex items-center gap-2.5 text-xl font-bold text-ink"><TrendingDown class="size-5 text-ink-soft" aria-hidden="true" /> Valor de mercado (FIPE)</h2>
      <div v-if="auth.allows('vehicles', 'update') && !editing" class="flex gap-3">
        <AppButton v-if="fipe" variant="secondary" :disabled="busy" @click="refresh">Atualizar</AppButton>
        <AppButton variant="secondary" @click="startEdit">{{ fipe ? 'Trocar vínculo' : 'Vincular à FIPE' }}</AppButton>
      </div>
    </div>

    <template v-if="fipe && !editing">
      <p class="text-3xl font-bold tabular text-ink">{{ formatCentsBRL(fipe.priceCents) }}</p>
      <p class="mt-1 text-[15px] text-ink-soft">{{ fipe.brandName }} {{ fipe.modelName }} · {{ fipe.modelYear }} · {{ fipe.fuel }}</p>
      <p class="text-sm text-ink-muted">Código FIPE {{ fipe.codeFipe }} · referência {{ fipe.referenceMonth }}</p>
      <ul v-if="fipe.history.length > 1" class="mt-4 divide-y divide-line text-[15px]">
        <li v-for="h in [...fipe.history].reverse()" :key="h.referenceMonth" class="flex justify-between py-2">
          <span class="text-ink-soft">{{ h.referenceMonth }}</span>
          <span class="tabular font-semibold text-ink">{{ formatCentsBRL(h.priceCents) }}</span>
        </li>
      </ul>
      <button v-if="auth.allows('vehicles', 'update')" type="button" class="mt-4 text-sm font-semibold text-[rgb(var(--c-negative))] hover:underline" @click="unlink">Remover vínculo</button>
    </template>
    <p v-else-if="!editing" class="text-[15px] text-ink-muted">Vincule o veículo à tabela FIPE para acompanhar o valor de mercado e a desvalorização.</p>

    <form v-if="editing" class="grid gap-5 sm:grid-cols-3" novalidate @submit.prevent="link">
      <FormField v-slot="field" label="Marca" required>
        <AppSelect :id="field.id" :model-value="form.brandId" placeholder="Marca" :options="opts(brands)" @update:model-value="pickBrand" />
      </FormField>
      <FormField v-slot="field" label="Modelo" required>
        <AppSelect :id="field.id" :model-value="form.modelId" placeholder="Modelo" :disabled="models.length === 0" :options="opts(models)" @update:model-value="pickModel" />
      </FormField>
      <FormField v-slot="field" label="Ano e combustível" required>
        <AppSelect :id="field.id" v-model="form.yearId" placeholder="Ano" :disabled="years.length === 0" :options="opts(years)" />
      </FormField>
      <div class="flex justify-end gap-3 sm:col-span-3">
        <AppButton variant="secondary" :disabled="busy" @click="editing = false">Cancelar</AppButton>
        <AppButton type="submit" :loading="busy" :disabled="!form.yearId">Vincular</AppButton>
      </div>
    </form>
  </section>
</template>
