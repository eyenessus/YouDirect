<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  brazilianStates,
  businessDate,
  businessTime,
  fineGravities,
  fineGravityLabels,
  fineGravityPoints,
  type FineGravity,
  type TrafficFine,
  type Vehicle,
} from '@yudirect/contracts';
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

/**
 * Cadastro/edição de multa. Data e hora são do fuso local da empresa;
 * depois de salvar, a página de detalhe mostra quem estava com o carro.
 */
const route = useRoute();
const router = useRouter();
const toasts = useToastStore();

const fineId = computed(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed(() => fineId.value !== null);
const version = ref(1);

const vehicles = ref<Vehicle[]>([]);
const errors = ref<Record<string, string>>({});
const saving = ref(false);
const notice = ref<{ fileId: string; url: string; originalName: string } | null>(null);

const form = reactive({
  vehicleId: (route.query.vehicleId as string | undefined) ?? '',
  aitNumber: '',
  authorityName: '',
  authorityCode: '',
  authorityState: '',
  infractionCode: '',
  infractionDescription: '',
  gravity: '' as FineGravity | '',
  points: '',
  occurredDate: '',
  occurredTime: '',
  place: '',
  amountCents: 0,
  discountedAmountCents: 0,
  discountUntil: '',
  adminFeeCents: 0,
  noticeDate: '',
  indicationDeadline: '',
  dueDate: '',
  notes: '',
});

const vehicleOptions = computed(() => vehicles.value.map((v) => ({ value: v.id, label: `${v.plate} - ${v.brand} ${v.model}` })));
const gravityOptions = [
  { value: '', label: 'Não informada' },
  ...fineGravities.map((g) => ({ value: g, label: `${fineGravityLabels[g]} (${fineGravityPoints[g]} pontos)` })),
];
const stateOptions = [{ value: '', label: '—' }, ...brazilianStates.map((s) => ({ value: s, label: s }))];

function onGravity(value: string | null | undefined) {
  form.gravity = (value ?? '') as FineGravity | '';
  if (form.gravity && !form.points) form.points = String(fineGravityPoints[form.gravity]);
}

onMounted(async () => {
  try {
    vehicles.value = (await api.get<{ data: Vehicle[] }>('/vehicles', { query: { limit: 100 } })).data;
  } catch {
    toasts.error('Não foi possível carregar os veículos');
  }
  if (!fineId.value) return;
  try {
    const fine = await api.get<TrafficFine>(`/traffic-fines/${fineId.value}`);
    version.value = fine.version;
    Object.assign(form, {
      vehicleId: fine.vehicle.id,
      aitNumber: fine.aitNumber,
      authorityName: fine.authority.name,
      authorityCode: fine.authority.code ?? '',
      authorityState: fine.authority.state ?? '',
      infractionCode: fine.infractionCode ?? '',
      infractionDescription: fine.infractionDescription,
      gravity: fine.gravity ?? '',
      points: fine.points !== null ? String(fine.points) : '',
      occurredDate: fine.occurredOn,
      occurredTime: businessTime(new Date(fine.occurredAt)),
      place: fine.place ?? '',
      amountCents: fine.amountCents,
      discountedAmountCents: fine.discountedAmountCents ?? 0,
      discountUntil: fine.discountUntil ?? '',
      adminFeeCents: fine.adminFeeCents,
      noticeDate: fine.noticeDate ?? '',
      indicationDeadline: fine.indicationDeadline ?? '',
      dueDate: fine.dueDate ?? '',
      notes: fine.notes ?? '',
    });
    notice.value = fine.files.notice;
  } catch {
    toasts.error('Multa não encontrada');
    void router.replace('/dashboard/fines');
  }
});

function onNoticeUploaded(file: UploadedFileResponse) {
  notice.value = { fileId: file.id, url: file.url, originalName: file.originalName };
}

function validate(): boolean {
  const e: Record<string, string> = {};
  if (!form.vehicleId) e.vehicleId = 'Selecione o veículo';
  if (!form.aitNumber.trim()) e.aitNumber = 'Informe o número do auto de infração';
  if (!form.authorityName.trim()) e.authorityName = 'Informe o órgão autuador';
  if (!form.infractionDescription.trim()) e.infractionDescription = 'Descreva a infração';
  if (!form.occurredDate) e.occurredDate = 'Informe a data da infração';
  else if (form.occurredDate > businessDate()) e.occurredDate = 'A data não pode ser futura';
  if (!form.occurredTime) e.occurredTime = 'Informe a hora';
  if (!form.amountCents) e.amountCents = 'Informe o valor da multa';
  if (form.discountedAmountCents > form.amountCents) e.discountedAmountCents = 'Maior que o valor da multa';
  if (form.discountedAmountCents && !form.discountUntil) e.discountUntil = 'Informe até quando vale o desconto';
  errors.value = e;
  return Object.keys(e).length === 0;
}

async function submit() {
  if (!validate()) return;
  saving.value = true;
  const body = {
    aitNumber: form.aitNumber,
    authorityName: form.authorityName,
    authorityCode: form.authorityCode,
    authorityState: form.authorityState,
    infractionCode: form.infractionCode,
    infractionDescription: form.infractionDescription,
    gravity: form.gravity || undefined,
    points: form.points === '' ? undefined : Number(form.points),
    occurredDate: form.occurredDate,
    occurredTime: form.occurredTime,
    place: form.place,
    amountCents: form.amountCents,
    discountedAmountCents: form.discountedAmountCents || undefined,
    discountUntil: form.discountedAmountCents ? form.discountUntil : '',
    adminFeeCents: form.adminFeeCents,
    noticeDate: form.noticeDate,
    indicationDeadline: form.indicationDeadline,
    dueDate: form.dueDate,
    noticeFileId: notice.value?.fileId,
    notes: form.notes,
  };
  try {
    const saved = isEdit.value
      ? await api.patch<TrafficFine>(`/traffic-fines/${fineId.value}`, { ...body, version: version.value })
      : await api.post<TrafficFine>('/traffic-fines', { ...body, vehicleId: form.vehicleId });
    toasts.success(isEdit.value ? 'Multa atualizada' : `Multa ${saved.fineNumber} cadastrada`);
    void router.push(`/dashboard/fines/${saved.id}`);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      if (Object.keys(errors.value).length === 0) toasts.error('Não foi possível salvar', err.message);
    } else {
      toasts.error('Não foi possível salvar a multa');
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="MULTAS"
      :title="isEdit ? 'Editar Multa' : 'Nova Multa'"
      subtitle="Dados da notificação de autuação recebida do órgão de trânsito"
      :back-to="isEdit ? `/dashboard/fines/${fineId}` : '/dashboard/fines'"
    />

    <form class="space-y-6" novalidate @submit.prevent="submit">
      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Infração</h2>
        <div class="grid gap-5 md:grid-cols-2">
          <FormField v-slot="field" label="Veículo" required :error="errors.vehicleId">
            <AppSelect
              :id="field.id"
              v-model="form.vehicleId"
              :options="vehicleOptions"
              placeholder="Selecione o veículo"
              :disabled="isEdit"
              :invalid="field.invalid"
            />
          </FormField>
          <FormField v-slot="field" label="Nº do auto de infração (AIT)" required :error="errors.aitNumber">
            <AppInput :id="field.id" v-model="form.aitNumber" placeholder="Ex.: 1F2345678" :invalid="field.invalid" />
          </FormField>
          <FormField v-slot="field" label="Data da infração" required :error="errors.occurredDate">
            <AppInput :id="field.id" v-model="form.occurredDate" type="date" :invalid="field.invalid" />
          </FormField>
          <FormField v-slot="field" label="Hora" required :error="errors.occurredTime">
            <AppInput :id="field.id" v-model="form.occurredTime" type="time" :invalid="field.invalid" />
          </FormField>
          <FormField v-slot="field" class="md:col-span-2" label="Descrição da infração" required :error="errors.infractionDescription">
            <AppInput
              :id="field.id"
              v-model="form.infractionDescription"
              placeholder="Ex.: Transitar em velocidade superior à máxima permitida em até 20%"
              :invalid="field.invalid"
            />
          </FormField>
          <FormField v-slot="field" label="Código da infração" :error="errors.infractionCode">
            <AppInput :id="field.id" v-model="form.infractionCode" placeholder="Ex.: 7455-0" />
          </FormField>
          <FormField v-slot="field" label="Local" :error="errors.place">
            <AppInput :id="field.id" v-model="form.place" placeholder="Rua, km, cidade" />
          </FormField>
          <FormField v-slot="field" label="Gravidade" :error="errors.gravity">
            <AppSelect :id="field.id" :model-value="form.gravity" :options="gravityOptions" @update:model-value="onGravity" />
          </FormField>
          <FormField v-slot="field" label="Pontos na CNH" :error="errors.points">
            <AppInput :id="field.id" v-model="form.points" type="number" inputmode="numeric" />
          </FormField>
        </div>
      </section>

      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Órgão e prazos</h2>
        <div class="grid gap-5 md:grid-cols-3">
          <FormField v-slot="field" label="Órgão autuador" required :error="errors.authorityName">
            <AppInput :id="field.id" v-model="form.authorityName" placeholder="Ex.: DETRAN-SP, PRF, CET" :invalid="field.invalid" />
          </FormField>
          <FormField v-slot="field" label="Código do órgão" :error="errors.authorityCode">
            <AppInput :id="field.id" v-model="form.authorityCode" />
          </FormField>
          <FormField v-slot="field" label="UF" :error="errors.authorityState">
            <AppSelect :id="field.id" v-model="form.authorityState" :options="stateOptions" />
          </FormField>
          <FormField v-slot="field" label="Data da notificação" hint="Quando a notificação foi recebida" :error="errors.noticeDate">
            <AppInput :id="field.id" v-model="form.noticeDate" type="date" />
          </FormField>
          <FormField
            v-slot="field"
            label="Prazo para indicar o condutor"
            hint="Consta na notificação de autuação"
            :error="errors.indicationDeadline"
          >
            <AppInput :id="field.id" v-model="form.indicationDeadline" type="date" />
          </FormField>
          <FormField v-slot="field" label="Vencimento do boleto" :error="errors.dueDate">
            <AppInput :id="field.id" v-model="form.dueDate" type="date" />
          </FormField>
        </div>
      </section>

      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Valores</h2>
        <div class="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          <FormField v-slot="field" label="Valor da multa" required :error="errors.amountCents">
            <CurrencyInput :id="field.id" v-model="form.amountCents" :invalid="field.invalid" />
          </FormField>
          <FormField v-slot="field" label="Valor com desconto" hint="20% (SNE) ou 40%" :error="errors.discountedAmountCents">
            <CurrencyInput :id="field.id" v-model="form.discountedAmountCents" :invalid="field.invalid" />
          </FormField>
          <FormField v-slot="field" label="Desconto válido até" :error="errors.discountUntil">
            <AppInput :id="field.id" v-model="form.discountUntil" type="date" :invalid="field.invalid" />
          </FormField>
          <FormField v-slot="field" label="Taxa administrativa" hint="Somada na cobrança do motorista" :error="errors.adminFeeCents">
            <CurrencyInput :id="field.id" v-model="form.adminFeeCents" />
          </FormField>
        </div>
      </section>

      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Notificação e observações</h2>
        <div class="grid gap-5 md:grid-cols-2">
          <FileDropzone
            purpose="TRAFFIC_FINE_NOTICE"
            title="Anexe a notificação (PDF ou foto)"
            :files="notice ? [notice] : []"
            @uploaded="onNoticeUploaded"
            @remove="notice = null"
          />
          <FormField v-slot="field" label="Observações" :error="errors.notes">
            <AppTextarea :id="field.id" v-model="form.notes" :rows="5" />
          </FormField>
        </div>
      </section>

      <div class="flex justify-end gap-3">
        <AppButton variant="secondary" :disabled="saving" @click="router.back()">Cancelar</AppButton>
        <AppButton type="submit" :loading="saving">{{ isEdit ? 'Salvar alterações' : 'Cadastrar multa' }}</AppButton>
      </div>
    </form>
  </div>
</template>
