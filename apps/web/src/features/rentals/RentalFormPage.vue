<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Car, UserPlus } from 'lucide-vue-next';
import {
  inspectionPeriodLabels,
  inspectionPeriods,
  inspectionWeekdayLabels,
  inspectionWeekdays,
  maskCpf,
  rentalAmountLabels,
  rentalPrepaidLabels,
  rentalTypeLabels,
  rentalTypes,
  type Driver,
  type Rental,
  type RentalType,
  type Vehicle,
} from '@frotaone/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import FileDropzone from '@/components/ui/FileDropzone.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError, type UploadedFileResponse } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const route = useRoute();
const router = useRouter();
const toasts = useToastStore();

const rentalId = computed(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed(() => Boolean(rentalId.value));

const form = reactive({
  vehicleId: '',
  driverId: '',
  startDate: '',
  endDate: '',
  rentalType: 'MONTHLY' as RentalType,
  inspectionPeriod: 'WEEKLY',
  inspectionWeekday: 'ANY',
  periodicAmountCents: 0,
  depositCents: 0,
  firstPeriodPrepaid: false,
  depositPrepaid: false,
  allowedKm: '0',
  monthlyFranchiseKm: '0',
  notes: '',
});

const contract = ref<{ fileId: string; url: string; originalName: string } | null>(null);
const vehicles = ref<Vehicle[]>([]);
const drivers = ref<Driver[]>([]);
const errors = ref<Record<string, string>>({});
const saving = ref(false);

const typeOptions = rentalTypes.map((t) => ({ value: t, label: rentalTypeLabels[t] }));
const periodOptions = inspectionPeriods.map((p) => ({ value: p, label: inspectionPeriodLabels[p] }));
const weekdayOptions = inspectionWeekdays.map((d) => ({ value: d, label: inspectionWeekdayLabels[d] }));

const vehicleOptions = computed(() =>
  vehicles.value.map((v) => ({
    value: v.id,
    label: `${v.plate} - ${v.brand} ${v.model}`,
    disabled: !isEdit.value && v.status === 'RENTED',
  })),
);
const driverOptions = computed(() =>
  drivers.value.map((d) => ({
    value: d.id,
    label: d.cpf ? `${d.fullName} - ${maskCpf(d.cpf)}` : d.fullName,
  })),
);

const amountLabel = computed(() => rentalAmountLabels[form.rentalType]);
const prepaidLabel = computed(() => rentalPrepaidLabels[form.rentalType]);

onMounted(async () => {
  const [vehicleRes, driverRes] = await Promise.all([
    api.get<{ data: Vehicle[] }>('/vehicles', { query: { limit: 100 } }),
    api.get<{ data: Driver[] }>('/drivers', { query: { limit: 100 } }),
  ]);
  vehicles.value = vehicleRes.data;
  drivers.value = driverRes.data;

  if (!rentalId.value) return;
  try {
    const rental = await api.get<Rental>(`/rentals/${rentalId.value}`);
    form.vehicleId = rental.vehicle.id;
    form.driverId = rental.driver.id;
    form.startDate = rental.startDate;
    form.endDate = rental.endDate ?? '';
    form.rentalType = rental.rentalType;
    form.inspectionPeriod = rental.inspectionPeriod ?? 'WEEKLY';
    form.inspectionWeekday = rental.inspectionWeekday;
    form.periodicAmountCents = rental.periodicAmountCents;
    form.depositCents = rental.depositCents;
    form.firstPeriodPrepaid = rental.firstPeriodPrepaid;
    form.depositPrepaid = rental.depositPrepaid;
    form.allowedKm = String(rental.allowedKm ?? 0);
    form.monthlyFranchiseKm = String(rental.monthlyFranchiseKm ?? 0);
    form.notes = rental.notes ?? '';
    contract.value = rental.contractFile
      ? {
          fileId: rental.contractFile.fileId,
          url: rental.contractFile.url,
          originalName: rental.contractFile.originalName,
        }
      : null;
  } catch {
    toasts.error('Locação não encontrada');
    router.replace('/dashboard/rentals');
  }
});

async function submit() {
  errors.value = {};
  saving.value = true;
  const base = {
    startDate: form.startDate,
    endDate: form.endDate || undefined,
    rentalType: form.rentalType,
    inspectionPeriod: form.inspectionPeriod || undefined,
    inspectionWeekday: form.inspectionWeekday,
    periodicAmountCents: form.periodicAmountCents,
    depositCents: form.depositCents,
    firstPeriodPrepaid: form.firstPeriodPrepaid,
    depositPrepaid: form.depositPrepaid,
    allowedKm: Number(form.allowedKm || 0) || undefined,
    monthlyFranchiseKm: Number(form.monthlyFranchiseKm || 0) || undefined,
    contractFileId: contract.value?.fileId,
    notes: form.notes || undefined,
  };
  try {
    if (isEdit.value) {
      await api.patch(`/rentals/${rentalId.value}`, base);
      toasts.success('Locação atualizada');
    } else {
      await api.post('/rentals', { ...base, vehicleId: form.vehicleId, driverId: form.driverId });
      toasts.success('Locação cadastrada', 'A conta a receber do contrato foi gerada.');
    }
    await router.push('/dashboard/rentals');
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      toasts.error(
        Object.keys(errors.value).length > 0 ? 'Revise os campos destacados' : 'Não foi possível salvar',
        Object.keys(errors.value).length > 0 ? undefined : err.message,
      );
    } else {
      toasts.error('Não foi possível salvar a locação');
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="space-y-6" novalidate @submit.prevent="submit">
    <PageHeader
      eyebrow="LOCAÇÕES"
      :title="isEdit ? 'Editar Locação' : 'Nova Locação'"
      :subtitle="isEdit ? 'Atualize as informações da locação' : 'Cadastre uma nova locação na frota'"
      back-to="/dashboard/rentals"
    >
      <template v-if="!isEdit" #actions>
        <AppButton variant="secondary" @click="router.push('/dashboard/vehicles/new')">
          <template #icon><Car class="size-4" /></template>
          Novo Veículo
        </AppButton>
        <AppButton @click="router.push('/dashboard/drivers/new')">
          <template #icon><UserPlus class="size-4" /></template>
          Novo Cliente
        </AppButton>
      </template>
    </PageHeader>

    <!-- Informações básicas -->
    <section class="fo-card p-7">
      <h2 class="mb-6 text-xl font-bold text-ink">Informações Básicas</h2>

      <div class="grid gap-5 lg:grid-cols-2">
        <FormField
          v-slot="field"
          label="Veículo"
          required
          :hint="isEdit ? 'O veículo não pode ser alterado após a criação da locação' : 'Selecione o veículo a ser locado'"
          :error="errors.vehicleId"
        >
          <AppSelect
            :id="field.id"
            v-model="form.vehicleId"
            :options="vehicleOptions"
            placeholder="Selecione o veículo"
            :disabled="isEdit"
            :invalid="field.invalid"
            :described-by="field.describedBy"
          />
        </FormField>

        <FormField
          v-slot="field"
          label="Motorista"
          required
          :hint="isEdit ? 'O motorista não pode ser alterado após a criação da locação' : 'Selecione o motorista responsável'"
          :error="errors.driverId"
        >
          <AppSelect
            :id="field.id"
            v-model="form.driverId"
            :options="driverOptions"
            placeholder="Selecione o motorista"
            :disabled="isEdit"
            :invalid="field.invalid"
            :described-by="field.describedBy"
          />
        </FormField>

        <FormField
          v-slot="field"
          label="Data de Início"
          required
          hint="Data de início da locação"
          :error="errors.startDate"
        >
          <AppInput :id="field.id" v-model="form.startDate" type="date" :invalid="field.invalid" />
        </FormField>

        <FormField
          v-slot="field"
          label="Data de Término"
          hint="Data de término da locação (opcional)"
          :error="errors.endDate"
        >
          <AppInput :id="field.id" v-model="form.endDate" type="date" :invalid="field.invalid" />
        </FormField>

        <FormField
          v-slot="field"
          label="Tipo de Locação"
          required
          hint="Tipo de locação (mensal, diária, etc.)"
          :error="errors.rentalType"
        >
          <AppSelect :id="field.id" v-model="form.rentalType" :options="typeOptions" />
        </FormField>

        <FormField
          v-slot="field"
          label="Período de Vistoria"
          hint="A primeira notificação sai após esse intervalo. O motorista pode enviar a vistoria até o próximo ciclo."
          :error="errors.inspectionPeriod"
        >
          <AppSelect :id="field.id" v-model="form.inspectionPeriod" :options="periodOptions" />
        </FormField>

        <FormField
          v-slot="field"
          label="Dia da semana da vistoria"
          hint="A vistoria será enviada às 9h do dia em que o ciclo vencer."
          :error="errors.inspectionWeekday"
        >
          <AppSelect :id="field.id" v-model="form.inspectionWeekday" :options="weekdayOptions" />
        </FormField>
      </div>
    </section>

    <!-- Financeiro -->
    <section class="fo-card p-7">
      <h2 class="mb-6 text-xl font-bold text-ink">Informações Financeiras</h2>

      <div class="grid gap-5 lg:grid-cols-2">
        <FormField
          v-slot="field"
          :label="amountLabel"
          required
          :hint="`Valor ${form.rentalType === 'MONTHLY' ? 'mensal' : 'semanal'} da locação`"
          :error="errors.periodicAmountCents"
        >
          <CurrencyInput :id="field.id" v-model="form.periodicAmountCents" :invalid="field.invalid" />
        </FormField>

        <FormField
          v-slot="field"
          label="Valor do Caução"
          hint="Valor do caução (opcional)"
          :error="errors.depositCents"
        >
          <CurrencyInput :id="field.id" v-model="form.depositCents" />
        </FormField>

        <AppCheckbox
          v-model="form.firstPeriodPrepaid"
          boxed
          :label="prepaidLabel"
          :disabled="form.periodicAmountCents === 0"
          :description="
            form.periodicAmountCents === 0
              ? 'Informe o valor da locação acima para habilitar esta opção.'
              : 'Marque esta opção se o primeiro valor já foi recebido como adiantamento.'
          "
        />

        <AppCheckbox
          v-model="form.depositPrepaid"
          boxed
          label="Caução já foi pago"
          :disabled="form.depositCents === 0"
          description="Marque esta opção se o caução já foi recebido. O valor será registrado no financeiro."
        />

        <FormField
          v-slot="field"
          label="Quilometragem Permitida"
          hint="KM permitidos no período (opcional)"
          :error="errors.allowedKm"
        >
          <AppInput :id="field.id" v-model="form.allowedKm" type="number" min="0" inputmode="numeric" />
        </FormField>

        <FormField
          v-slot="field"
          label="Franquia mensal de KM"
          hint="Limite de KM por mês. O locador é notificado se o veículo exceder esse ritmo (opcional)."
          :error="errors.monthlyFranchiseKm"
        >
          <AppInput
            :id="field.id"
            v-model="form.monthlyFranchiseKm"
            type="number"
            min="0"
            inputmode="numeric"
          />
        </FormField>
      </div>
    </section>

    <!-- Contrato e observações -->
    <section class="fo-card p-7">
      <div class="mb-6 flex items-center justify-between gap-4">
        <h2 class="text-xl font-bold text-ink">Observações e contrato</h2>
        <span class="text-sm text-ink-muted">PDF ou imagem</span>
      </div>

      <p class="fo-label">Contrato</p>
      <FileDropzone
        purpose="RENTAL_CONTRACT"
        title="Clique ou arraste o contrato aqui"
        hint="PDF, JPG, PNG — máx. 25MB"
        :disabled="!isEdit && !form.vehicleId"
        disabled-reason="Selecione o veículo e clique para anexar"
        :files="contract ? [contract] : []"
        @uploaded="
          (file: UploadedFileResponse) =>
            (contract = { fileId: file.id, url: file.url, originalName: file.originalName })
        "
        @remove="contract = null"
      />

      <div class="mt-6">
        <FormField
          v-slot="field"
          label="Observações Gerais"
          hint="Informações adicionais sobre a locação (opcional)"
          :error="errors.notes"
        >
          <AppTextarea
            :id="field.id"
            v-model="form.notes"
            placeholder="Adicione observações sobre a locação..."
            :rows="4"
          />
        </FormField>
      </div>
    </section>

    <div class="flex flex-wrap justify-end gap-3">
      <AppButton variant="secondary" :disabled="saving" @click="router.push('/dashboard/rentals')">
        Cancelar
      </AppButton>
      <AppButton type="submit" :loading="saving">
        {{ isEdit ? 'Atualizar Locação' : 'Cadastrar Locação' }}
      </AppButton>
    </div>
  </form>
</template>
