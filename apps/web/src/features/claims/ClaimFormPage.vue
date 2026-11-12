<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { claimFaultLabels, claimFaults, claimKindLabels, claimKinds, type Claim, type Vehicle } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import FileDropzone from '@/components/ui/FileDropzone.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError, type UploadedFileResponse } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const router = useRouter();
const toasts = useToastStore();
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

const form = reactive({
  vehicleId: '',
  occurredOn: today,
  kind: 'COLLISION',
  fault: 'UNDETERMINED',
  location: '',
  description: '',
  policeReportNumber: '',
  insurerClaimNumber: '',
  deductibleCents: 0,
  estimatedCostCents: 0,
});
const files = ref<Array<{ fileId: string; url: string; originalName: string }>>([]);
const vehicles = ref<Vehicle[]>([]);
const errors = ref<Record<string, string>>({});
const saving = ref(false);

const kindOptions = claimKinds.map((k) => ({ value: k, label: claimKindLabels[k] }));
const faultOptions = claimFaults.map((f) => ({ value: f, label: claimFaultLabels[f] }));

onMounted(async () => {
  vehicles.value = (await api.get<{ data: Vehicle[] }>('/vehicles?limit=100')).data;
});

function onUploaded(file: UploadedFileResponse) {
  files.value = [...files.value, { fileId: file.id, url: file.url, originalName: file.originalName }];
}
function removeFile(fileId: string) {
  files.value = files.value.filter((f) => f.fileId !== fileId);
}

async function submit() {
  errors.value = {};
  if (!form.vehicleId) {
    errors.value = { vehicleId: 'Escolha o veículo' };
    return;
  }
  saving.value = true;
  try {
    const created = await api.post<Claim>('/claims', {
      vehicleId: form.vehicleId,
      occurredOn: form.occurredOn,
      kind: form.kind,
      fault: form.fault,
      location: form.location || undefined,
      description: form.description,
      policeReportNumber: form.policeReportNumber || undefined,
      insurerClaimNumber: form.insurerClaimNumber || undefined,
      deductibleCents: form.deductibleCents || undefined,
      estimatedCostCents: form.estimatedCostCents || undefined,
      fileIds: files.value.map((f) => f.fileId),
    });
    toasts.success('Sinistro registrado', created.claimNumber);
    await router.push(`/dashboard/claims/${created.id}`);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      toasts.error(
        Object.keys(errors.value).length > 0 ? 'Revise os campos destacados' : 'Não foi possível registrar',
        Object.keys(errors.value).length > 0 ? undefined : err.message,
      );
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Sinistros"
      title="Registrar sinistro"
      subtitle="O motorista é identificado pela locação do veículo na data do ocorrido."
      show-back
      back-to="/dashboard/claims"
    />
    <form class="space-y-6" novalidate @submit.prevent="submit">
      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">O que aconteceu</h2>
        <div class="grid gap-5 sm:grid-cols-2">
          <FormField v-slot="field" label="Veículo" required :error="errors.vehicleId">
            <AppSelect
              :id="field.id"
              v-model="form.vehicleId"
              placeholder="Escolha o veículo"
              :invalid="field.invalid"
              :options="vehicles.map((v) => ({ value: v.id, label: `${v.plate} · ${v.brand} ${v.model}` }))"
            />
          </FormField>
          <FormField v-slot="field" label="Data do ocorrido" required :error="errors.occurredOn">
            <AppInput :id="field.id" v-model="form.occurredOn" type="date" :invalid="field.invalid" />
          </FormField>
          <FormField v-slot="field" label="Tipo" :error="errors.kind">
            <AppSelect :id="field.id" v-model="form.kind" :options="kindOptions" />
          </FormField>
          <FormField v-slot="field" label="Culpa" :error="errors.fault">
            <AppSelect :id="field.id" v-model="form.fault" :options="faultOptions" />
          </FormField>
          <FormField v-slot="field" label="Local" :error="errors.location" class="sm:col-span-2">
            <AppInput :id="field.id" v-model="form.location" placeholder="Rua, cidade" />
          </FormField>
          <FormField v-slot="field" label="Descrição" required :error="errors.description" class="sm:col-span-2">
            <AppTextarea :id="field.id" v-model="form.description" :rows="4" :invalid="field.invalid" />
          </FormField>
        </div>
      </section>

      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Seguro e valores</h2>
        <div class="grid gap-5 sm:grid-cols-2">
          <FormField v-slot="field" label="Número do B.O." :error="errors.policeReportNumber">
            <AppInput :id="field.id" v-model="form.policeReportNumber" />
          </FormField>
          <FormField v-slot="field" label="Protocolo da seguradora" :error="errors.insurerClaimNumber">
            <AppInput :id="field.id" v-model="form.insurerClaimNumber" />
          </FormField>
          <FormField v-slot="field" label="Franquia" :error="errors.deductibleCents">
            <CurrencyInput :id="field.id" v-model="form.deductibleCents" />
          </FormField>
          <FormField v-slot="field" label="Custo estimado do reparo" :error="errors.estimatedCostCents">
            <CurrencyInput :id="field.id" v-model="form.estimatedCostCents" />
          </FormField>
        </div>
      </section>

      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Fotos e documentos</h2>
        <FileDropzone
          purpose="CLAIM_FILE"
          title="Clique ou arraste fotos, B.O. ou orçamentos"
          hint="PNG, JPG, WEBP ou PDF (máx. 10MB)"
          multiple
          :files="files"
          @uploaded="onUploaded"
          @remove="removeFile"
        />
      </section>

      <div class="flex justify-end gap-3">
        <AppButton variant="secondary" :disabled="saving" @click="router.push('/dashboard/claims')">Cancelar</AppButton>
        <AppButton type="submit" :loading="saving">Registrar sinistro</AppButton>
      </div>
    </form>
  </div>
</template>
