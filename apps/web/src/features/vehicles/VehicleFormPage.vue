<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { brazilianStates, type Vehicle } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import FileDropzone from '@/components/ui/FileDropzone.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError, type UploadedFileResponse } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const route = useRoute();
const router = useRouter();
const toasts = useToastStore();

const vehicleId = computed(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed(() => Boolean(vehicleId.value));

const form = reactive({
  plate: '',
  renavam: '',
  vin: '',
  registrationState: '',
  registrationCity: '',
  brand: '',
  model: '',
  year: '',
  color: '',
  mileageKm: '0',
  purchaseDate: '',
  purchaseAmountCents: 0,
});

const photos = ref<Array<{ fileId: string; url: string; originalName: string }>>([]);
const errors = ref<Record<string, string>>({});
const saving = ref(false);
const loading = ref(false);

const stateOptions = brazilianStates.map((uf) => ({ value: uf, label: uf }));

onMounted(async () => {
  if (!vehicleId.value) return;
  loading.value = true;
  try {
    const vehicle = await api.get<Vehicle>(`/vehicles/${vehicleId.value}`);
    form.plate = vehicle.plate;
    form.renavam = vehicle.renavam ?? '';
    form.vin = vehicle.vin ?? '';
    form.registrationState = vehicle.registrationState ?? '';
    form.registrationCity = vehicle.registrationCity ?? '';
    form.brand = vehicle.brand;
    form.model = vehicle.model;
    form.year = vehicle.year ? String(vehicle.year) : '';
    form.color = vehicle.color ?? '';
    form.mileageKm = String(vehicle.mileageKm);
    form.purchaseDate = vehicle.purchaseDate ?? '';
    form.purchaseAmountCents = vehicle.purchaseAmountCents ?? 0;
    photos.value = vehicle.photos.map((p) => ({
      fileId: p.fileId,
      url: p.url,
      originalName: p.originalName,
    }));
  } catch {
    toasts.error('Veículo não encontrado');
    router.replace('/dashboard/vehicles');
  } finally {
    loading.value = false;
  }
});

function onUploaded(file: UploadedFileResponse) {
  photos.value = [...photos.value, { fileId: file.id, url: file.url, originalName: file.originalName }];
}

function removePhoto(fileId: string) {
  photos.value = photos.value.filter((p) => p.fileId !== fileId);
}

async function submit() {
  errors.value = {};
  saving.value = true;
  const payload = {
    plate: form.plate,
    renavam: form.renavam || undefined,
    vin: form.vin || undefined,
    registrationState: form.registrationState || undefined,
    registrationCity: form.registrationCity || undefined,
    brand: form.brand,
    model: form.model,
    year: form.year ? Number(form.year) : undefined,
    color: form.color || undefined,
    mileageKm: Number(form.mileageKm || 0),
    purchaseDate: form.purchaseDate || undefined,
    purchaseAmountCents: form.purchaseAmountCents || undefined,
    photoFileIds: photos.value.map((p) => p.fileId),
  };
  try {
    if (isEdit.value) {
      await api.patch(`/vehicles/${vehicleId.value}`, payload);
      toasts.success('Veículo atualizado');
      await router.push(`/dashboard/vehicles/${vehicleId.value}`);
    } else {
      const created = await api.post<Vehicle>('/vehicles', payload);
      toasts.success('Veículo cadastrado', `${created.plate} entrou na frota.`);
      await router.push(`/dashboard/vehicles/${created.id}`);
    }
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      toasts.error(
        Object.keys(errors.value).length > 0 ? 'Revise os campos destacados' : 'Não foi possível salvar',
        Object.keys(errors.value).length > 0 ? undefined : err.message,
      );
    } else {
      toasts.error('Não foi possível salvar o veículo');
    }
  } finally {
    saving.value = false;
  }
}

/** Alerta o usuário antes de descartar alterações não salvas. */
function cancel() {
  router.push(isEdit.value ? `/dashboard/vehicles/${vehicleId.value}` : '/dashboard/vehicles');
}

</script>

<template>
  <form class="space-y-6" novalidate @submit.prevent="submit">
    <PageHeader
      eyebrow="FROTA"
      :title="isEdit ? 'Editar Veículo' : 'Novo Veículo'"
      :subtitle="isEdit ? 'Atualize as informações do veículo' : 'Cadastre um novo veículo na frota'"
      :back-to="isEdit ? `/dashboard/vehicles/${vehicleId}` : '/dashboard/vehicles'"
    />

    <div class="grid gap-6 xl:grid-cols-2">
      <!-- Informações básicas -->
      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Informações Básicas</h2>
        <div class="grid gap-5 sm:grid-cols-3">
          <FormField
            v-slot="field"
            label="Placa"
            required
            hint="Formato Mercosul (ABC1D23)"
            :error="errors.plate"
          >
            <AppInput
              :id="field.id"
              v-model="form.plate"
              placeholder="ABC1D23"
              :invalid="field.invalid"
              :described-by="field.describedBy"
              :maxlength="8"
            />
          </FormField>
          <FormField v-slot="field" label="Renavam" :error="errors.renavam">
            <AppInput
              :id="field.id"
              v-model="form.renavam"
              placeholder="12345678901"
              inputmode="numeric"
              :invalid="field.invalid"
              :described-by="field.describedBy"
            />
          </FormField>
          <FormField v-slot="field" label="Chassi" :error="errors.vin">
            <AppInput
              :id="field.id"
              v-model="form.vin"
              placeholder="9BWZZZ377VT004251"
              :invalid="field.invalid"
              :described-by="field.describedBy"
              :maxlength="17"
            />
          </FormField>
        </div>

        <div class="mt-5 grid gap-5 sm:grid-cols-2">
          <FormField
            v-slot="field"
            label="UF de emplacamento"
            hint="Define qual DETRAN entra na consulta de multas."
            :error="errors.registrationState"
          >
            <AppSelect
              :id="field.id"
              v-model="form.registrationState"
              :options="stateOptions"
              placeholder="Selecione"
              :described-by="field.describedBy"
            />
          </FormField>
          <FormField
            v-slot="field"
            label="Município de emplacamento"
            hint="Habilita a prefeitura quando houver fonte para a cidade."
            :error="errors.registrationCity"
          >
            <AppInput
              :id="field.id"
              v-model="form.registrationCity"
              placeholder="Belo Horizonte"
              :described-by="field.describedBy"
            />
          </FormField>
        </div>
      </section>

      <!-- Dados do veículo -->
      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Dados do Veículo</h2>
        <div class="grid gap-5 sm:grid-cols-3">
          <FormField v-slot="field" label="Marca" required :error="errors.brand">
            <AppInput :id="field.id" v-model="form.brand" placeholder="Chevrolet" :invalid="field.invalid" />
          </FormField>
          <FormField v-slot="field" label="Modelo" required :error="errors.model">
            <AppInput :id="field.id" v-model="form.model" placeholder="Onix 1.0" :invalid="field.invalid" />
          </FormField>
          <FormField v-slot="field" label="Ano" :error="errors.year">
            <AppInput
              :id="field.id"
              v-model="form.year"
              type="number"
              inputmode="numeric"
              placeholder="2026"
              :invalid="field.invalid"
            />
          </FormField>
        </div>
        <div class="mt-5 grid gap-5 sm:grid-cols-2">
          <FormField v-slot="field" label="Cor" :error="errors.color">
            <AppInput :id="field.id" v-model="form.color" placeholder="Prata" />
          </FormField>
          <FormField v-slot="field" label="Hodômetro (KM)" :error="errors.mileageKm">
            <AppInput
              :id="field.id"
              v-model="form.mileageKm"
              type="number"
              inputmode="numeric"
              min="0"
              :invalid="field.invalid"
            />
          </FormField>
        </div>
      </section>

      <!-- Fotos -->
      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Fotos do Veículo</h2>
        <FileDropzone
          purpose="VEHICLE_PHOTO"
          accept="image/png,image/jpeg,image/webp"
          title="Clique para fazer upload ou arraste e solte"
          hint="PNG, JPG ou WEBP (máx. 5MB)"
          multiple
          :files="photos"
          @uploaded="onUploaded"
          @remove="removePhoto"
        />
      </section>

      <!-- Financeiro -->
      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Informações Financeiras</h2>
        <div class="grid gap-5 sm:grid-cols-2">
          <FormField v-slot="field" label="Data de Compra" :error="errors.purchaseDate">
            <AppInput :id="field.id" v-model="form.purchaseDate" type="date" />
          </FormField>
          <FormField v-slot="field" label="Valor de Compra" :error="errors.purchaseAmountCents">
            <CurrencyInput :id="field.id" v-model="form.purchaseAmountCents" />
          </FormField>
        </div>
      </section>
    </div>

    <div class="flex flex-wrap justify-end gap-3">
      <AppButton variant="secondary" :disabled="saving" @click="cancel">Cancelar</AppButton>
      <AppButton type="submit" :loading="saving || loading">
        {{ isEdit ? 'Atualizar Veículo' : 'Cadastrar Veículo' }}
      </AppButton>
    </div>
  </form>
</template>
