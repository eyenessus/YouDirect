<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { brazilianStates, maskCpf, maskPhone, type Driver, type PostalCodeLookup } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import FileDropzone from '@/components/ui/FileDropzone.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError, type UploadedFileResponse } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const route = useRoute();
const router = useRouter();
const toasts = useToastStore();

const driverId = computed(() => (route.params.id as string | undefined) ?? null);
const isEdit = computed(() => Boolean(driverId.value));

const form = reactive({
  fullName: '',
  birthDate: '',
  cpf: '',
  rg: '',
  email: '',
  cnhNumber: '',
  cnhCategory: '',
  cnhExpiresAt: '',
  phone: '',
  postalCode: '',
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  state: '',
});

const idDocument = ref<{ fileId: string; url: string; originalName: string } | null>(null);
const addressProof = ref<{ fileId: string; url: string; originalName: string } | null>(null);
const errors = ref<Record<string, string>>({});
const saving = ref(false);
const cepLoading = ref(false);

const stateOptions = brazilianStates.map((uf) => ({ value: uf, label: uf }));

onMounted(async () => {
  if (!driverId.value) return;
  try {
    const driver = await api.get<Driver>(`/drivers/${driverId.value}`);
    form.fullName = driver.fullName;
    form.birthDate = driver.birthDate ?? '';
    form.cpf = driver.cpf ? maskCpf(driver.cpf) : '';
    form.rg = driver.rg ?? '';
    form.email = driver.email ?? '';
    form.cnhNumber = driver.cnhNumber ?? '';
    form.cnhCategory = driver.cnhCategory ?? '';
    form.cnhExpiresAt = driver.cnhExpiresAt ?? '';
    form.phone = maskPhone(driver.phone);
    form.postalCode = driver.address.postalCode ?? '';
    form.street = driver.address.street ?? '';
    form.number = driver.address.number ?? '';
    form.complement = driver.address.complement ?? '';
    form.district = driver.address.district ?? '';
    form.city = driver.address.city ?? '';
    form.state = driver.address.state ?? '';
    idDocument.value = driver.idDocument
      ? {
          fileId: driver.idDocument.fileId,
          url: driver.idDocument.url,
          originalName: driver.idDocument.originalName,
        }
      : null;
    addressProof.value = driver.addressProof
      ? {
          fileId: driver.addressProof.fileId,
          url: driver.addressProof.url,
          originalName: driver.addressProof.originalName,
        }
      : null;
  } catch {
    toasts.error('Motorista não encontrado');
    router.replace('/dashboard/drivers');
  }
});

async function lookupPostalCode() {
  const digits = form.postalCode.replace(/\D/g, '');
  if (digits.length !== 8) {
    toasts.warning('CEP inválido', 'Informe os 8 dígitos do CEP.');
    return;
  }
  cepLoading.value = true;
  try {
    const result = await api.get<PostalCodeLookup>(`/postal-codes/${digits}`);
    if (!result.available) {
      toasts.info('Consulta de CEP indisponível', result.message ?? undefined);
      return;
    }
    if (!result.address) {
      toasts.warning('CEP não encontrado', 'Preencha o endereço manualmente.');
      return;
    }
    form.street = result.address.street ?? form.street;
    form.district = result.address.district ?? form.district;
    form.city = result.address.city ?? form.city;
    form.state = result.address.state ?? form.state;
    toasts.success('Endereço preenchido');
  } catch (err) {
    toasts.error('Falha na consulta', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    cepLoading.value = false;
  }
}

async function submit() {
  errors.value = {};
  saving.value = true;
  const payload = {
    fullName: form.fullName,
    birthDate: form.birthDate || undefined,
    cpf: form.cpf || undefined,
    rg: form.rg || undefined,
    email: form.email || undefined,
    cnhNumber: form.cnhNumber || undefined,
    cnhCategory: form.cnhCategory || undefined,
    cnhExpiresAt: form.cnhExpiresAt || undefined,
    phone: form.phone,
    idDocumentFileId: idDocument.value?.fileId,
    addressProofFileId: addressProof.value?.fileId,
    address: {
      postalCode: form.postalCode || undefined,
      street: form.street || undefined,
      number: form.number || undefined,
      complement: form.complement || undefined,
      district: form.district || undefined,
      city: form.city || undefined,
      state: form.state || undefined,
    },
  };
  try {
    if (isEdit.value) {
      await api.patch(`/drivers/${driverId.value}`, payload);
      toasts.success('Motorista atualizado');
      await router.push(`/dashboard/drivers/${driverId.value}`);
    } else {
      const created = await api.post<Driver>('/drivers', payload);
      toasts.success('Motorista cadastrado');
      await router.push(`/dashboard/drivers/${created.id}`);
    }
  } catch (err) {
    if (err instanceof ApiRequestError) {
      const mapped = err.fieldErrors();
      errors.value = Object.fromEntries(
        Object.entries(mapped).map(([key, value]) => [key.replace('address.', ''), value]),
      );
      toasts.error(
        Object.keys(mapped).length > 0 ? 'Revise os campos destacados' : 'Não foi possível salvar',
        Object.keys(mapped).length > 0 ? undefined : err.message,
      );
    } else {
      toasts.error('Não foi possível salvar o motorista');
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <form class="space-y-6" novalidate @submit.prevent="submit">
    <PageHeader
      eyebrow="FROTA"
      :title="isEdit ? 'Editar Motorista' : 'Novo Motorista'"
      :subtitle="isEdit ? 'Atualize os dados do motorista' : 'Cadastre um novo motorista na frota'"
      :back-to="isEdit ? `/dashboard/drivers/${driverId}` : '/dashboard/drivers'"
    />

    <div class="grid gap-6 xl:grid-cols-2">
      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Informações Pessoais</h2>

        <FormField v-slot="field" label="Nome completo" required :error="errors.fullName">
          <AppInput :id="field.id" v-model="form.fullName" placeholder="João Silva" :invalid="field.invalid" />
        </FormField>

        <div class="mt-5 grid gap-5 sm:grid-cols-3">
          <FormField v-slot="field" label="Data de nascimento" :error="errors.birthDate">
            <AppInput :id="field.id" v-model="form.birthDate" type="date" />
          </FormField>
          <FormField v-slot="field" label="CPF" :error="errors.cpf">
            <AppInput
              :id="field.id"
              v-model="form.cpf"
              placeholder="123.456.789-00"
              inputmode="numeric"
              :invalid="field.invalid"
            />
          </FormField>
          <FormField v-slot="field" label="RG" :error="errors.rg">
            <AppInput :id="field.id" v-model="form.rg" placeholder="12.345.678-9" />
          </FormField>
        </div>

        <div class="mt-5 grid gap-5 sm:grid-cols-3">
          <FormField v-slot="field" label="Email" :error="errors.email">
            <AppInput
              :id="field.id"
              v-model="form.email"
              type="email"
              placeholder="joao@example.com"
              :invalid="field.invalid"
            />
          </FormField>
          <FormField v-slot="field" label="Número da CNH" :error="errors.cnhNumber">
            <AppInput :id="field.id" v-model="form.cnhNumber" placeholder="12345678901" inputmode="numeric" />
          </FormField>
          <FormField v-slot="field" label="Categoria da CNH" :error="errors.cnhCategory">
            <AppInput :id="field.id" v-model="form.cnhCategory" placeholder="AB" :maxlength="3" />
          </FormField>
        </div>

        <div class="mt-5 grid gap-5 sm:grid-cols-2">
          <FormField v-slot="field" label="Validade da CNH" :error="errors.cnhExpiresAt">
            <AppInput :id="field.id" v-model="form.cnhExpiresAt" type="date" />
          </FormField>
          <FormField v-slot="field" label="Telefone" required :error="errors.phone">
            <AppInput
              :id="field.id"
              v-model="form.phone"
              placeholder="(11) 98765-4321"
              inputmode="tel"
              :invalid="field.invalid"
            />
          </FormField>
        </div>

        <div class="mt-6">
          <p class="fo-label">Documento de Identificação (RG/CNH) *</p>
          <FileDropzone
            purpose="DRIVER_ID"
            title="Arraste e solte o arquivo aqui"
            max-label="Limite de arquivo 10 MB"
            :files="idDocument ? [idDocument] : []"
            @uploaded="
              (file: UploadedFileResponse) =>
                (idDocument = { fileId: file.id, url: file.url, originalName: file.originalName })
            "
            @remove="idDocument = null"
          />
        </div>
      </section>

      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Endereço</h2>

        <FormField v-slot="field" label="CEP" :error="errors.postalCode">
          <div class="flex gap-3">
            <AppInput
              :id="field.id"
              v-model="form.postalCode"
              placeholder="01234-567"
              inputmode="numeric"
              :invalid="field.invalid"
            />
            <AppButton variant="secondary" :loading="cepLoading" @click="lookupPostalCode">
              Buscar
            </AppButton>
          </div>
        </FormField>

        <div class="mt-5">
          <FormField v-slot="field" label="Rua" :error="errors.street">
            <AppInput :id="field.id" v-model="form.street" placeholder="Rua das Flores" />
          </FormField>
        </div>

        <div class="mt-5 grid gap-5 sm:grid-cols-3">
          <FormField v-slot="field" label="Número" :error="errors.number">
            <AppInput :id="field.id" v-model="form.number" placeholder="123" />
          </FormField>
          <FormField v-slot="field" label="Complemento" :error="errors.complement">
            <AppInput :id="field.id" v-model="form.complement" placeholder="Apto 45" />
          </FormField>
          <FormField v-slot="field" label="Bairro" :error="errors.district">
            <AppInput :id="field.id" v-model="form.district" placeholder="Centro" />
          </FormField>
        </div>

        <div class="mt-5 grid gap-5 sm:grid-cols-2">
          <FormField v-slot="field" label="Cidade" :error="errors.city">
            <AppInput :id="field.id" v-model="form.city" placeholder="São Paulo" />
          </FormField>
          <FormField v-slot="field" label="Estado" :error="errors.state">
            <AppSelect
              :id="field.id"
              v-model="form.state"
              :options="stateOptions"
              placeholder="Selecione o estado"
            />
          </FormField>
        </div>

        <div class="mt-6">
          <p class="fo-label">Comprovante de Endereço</p>
          <FileDropzone
            purpose="DRIVER_ADDRESS_PROOF"
            title="Arraste e solte o arquivo aqui"
            max-label="Limite de arquivo 10 MB"
            :files="addressProof ? [addressProof] : []"
            @uploaded="
              (file: UploadedFileResponse) =>
                (addressProof = { fileId: file.id, url: file.url, originalName: file.originalName })
            "
            @remove="addressProof = null"
          />
        </div>
      </section>
    </div>

    <div class="flex flex-wrap justify-end gap-3">
      <AppButton
        variant="secondary"
        :disabled="saving"
        @click="router.push(isEdit ? `/dashboard/drivers/${driverId}` : '/dashboard/drivers')"
      >
        Cancelar
      </AppButton>
      <AppButton type="submit" :loading="saving">
        {{ isEdit ? 'Salvar Alterações' : 'Cadastrar Motorista' }}
      </AppButton>
    </div>
  </form>
</template>
