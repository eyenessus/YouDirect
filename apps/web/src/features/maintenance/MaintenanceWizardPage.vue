<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ArrowLeft, ArrowRight, Plus, Trash2 } from 'lucide-vue-next';
import {
  computeMaintenanceTotalCents,
  computePartsCostCents,
  formatCentsBRL,
  formatKm,
  maintenanceTypeLabels,
  maintenanceTypes,
  paymentMethodLabels,
  paymentMethods,
  type BankAccount,
  type MaintenanceType,
  type Vehicle,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import ProgressSteps from '@/components/ui/ProgressSteps.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import FileDropzone from '@/components/ui/FileDropzone.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError, type UploadedFileResponse } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

interface PartRow {
  uid: number;
  name: string;
  code: string;
  quantity: string;
  unitCostCents: number;
  supplier: string;
  warrantyUntil: string;
  nextDueDate: string;
}

const route = useRoute();
const router = useRouter();
const toasts = useToastStore();

const vehicleId = route.params.vehicleId as string;
const vehicle = ref<Vehicle | null>(null);
const accounts = ref<BankAccount[]>([]);

const steps = [
  { key: 'details', label: 'Detalhes' },
  { key: 'parts', label: 'Peças / Itens' },
  { key: 'warranty', label: 'Garantia' },
];
const current = ref(0);
const furthest = ref(0);

const form = reactive({
  type: 'CORRECTIVE' as MaintenanceType,
  performedAt: new Date().toISOString().slice(0, 10),
  description: '',
  laborCostCents: 0,
  mileageKm: '',
  notes: '',
  paymentMethod: 'CASH',
  bankAccountId: '',
});

let partSeq = 0;
const parts = ref<PartRow[]>([]);
const invoice = ref<{ fileId: string; url: string; originalName: string } | null>(null);
const errors = ref<Record<string, string>>({});
const saving = ref(false);

const typeOptions = maintenanceTypes.map((t) => ({ value: t, label: maintenanceTypeLabels[t] }));
const paymentOptions = paymentMethods.map((m) => ({ value: m, label: paymentMethodLabels[m] }));
const accountOptions = computed(() =>
  accounts.value.map((a) => ({
    value: a.id,
    label: a.isDefault ? `${a.name} (Padrão)` : a.name,
  })),
);

const parsedParts = computed(() =>
  parts.value.map((p) => ({ quantity: Number(p.quantity || 0), unitCostCents: p.unitCostCents })),
);
const partsCostCents = computed(() => computePartsCostCents(parsedParts.value));
const totalCents = computed(() => computeMaintenanceTotalCents(form.laborCostCents, parsedParts.value));

function addPart() {
  parts.value = [
    ...parts.value,
    {
      uid: ++partSeq,
      name: '',
      code: '',
      quantity: '1',
      unitCostCents: 0,
      supplier: '',
      warrantyUntil: '',
      nextDueDate: '',
    },
  ];
}

function removePart(uid: number) {
  parts.value = parts.value.filter((p) => p.uid !== uid);
}

function subtotal(part: PartRow): number {
  return Number(part.quantity || 0) * part.unitCostCents;
}

function validateStep(step: number): boolean {
  errors.value = {};
  if (step === 0) {
    if (!form.description.trim()) errors.value.description = 'Descreva o que foi feito.';
    if (!form.type) errors.value.type = 'Selecione o tipo de manutenção.';
  }
  if (step === 1) {
    parts.value.forEach((part, index) => {
      if (!part.name.trim()) errors.value[`part-${index}-name`] = 'Informe o que foi trocado.';
      if (Number(part.quantity) <= 0) errors.value[`part-${index}-qty`] = 'Quantidade deve ser maior que zero.';
    });
  }
  return Object.keys(errors.value).length === 0;
}

function next() {
  if (!validateStep(current.value)) {
    toasts.warning('Revise os campos obrigatórios');
    return;
  }
  current.value = Math.min(current.value + 1, steps.length - 1);
  furthest.value = Math.max(furthest.value, current.value);
}

function previous() {
  current.value = Math.max(current.value - 1, 0);
}

async function submit() {
  if (!validateStep(0) || !validateStep(1)) {
    toasts.warning('Revise os campos obrigatórios');
    return;
  }
  saving.value = true;
  try {
    await api.post(`/vehicles/${vehicleId}/maintenance`, {
      type: form.type,
      performedAt: form.performedAt || undefined,
      description: form.description,
      laborCostCents: form.laborCostCents,
      mileageKm: form.mileageKm ? Number(form.mileageKm) : undefined,
      invoiceFileId: invoice.value?.fileId,
      notes: form.notes || undefined,
      paymentMethod: form.paymentMethod,
      bankAccountId: form.bankAccountId || undefined,
      status: 'COMPLETED',
      items: parts.value.map((p) => ({
        name: p.name,
        code: p.code || undefined,
        quantity: Number(p.quantity || 1),
        unitCostCents: p.unitCostCents,
        supplier: p.supplier || undefined,
        warrantyUntil: p.warrantyUntil || undefined,
        nextDueDate: p.nextDueDate || undefined,
      })),
    });
    toasts.success('Manutenção registrada', `Total de ${formatCentsBRL(totalCents.value)}.`);
    await router.push(`/dashboard/maintenance/${vehicleId}`);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      toasts.error('Não foi possível registrar', err.message);
    } else {
      toasts.error('Não foi possível registrar a manutenção');
    }
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  const [vehicleRes, accountsRes] = await Promise.all([
    api.get<Vehicle>(`/vehicles/${vehicleId}`),
    api.get<{ data: BankAccount[] }>('/bank-accounts'),
  ]);
  vehicle.value = vehicleRes;
  accounts.value = accountsRes.data.filter((a) => a.active);
  form.mileageKm = String(vehicleRes.mileageKm);
  form.bankAccountId = accounts.value.find((a) => a.isDefault)?.id ?? accounts.value[0]?.id ?? '';
  addPart();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="MANUTENÇÃO"
      :title="`Nova Manutenção — ${vehicle?.plate ?? ''}`"
      :subtitle="vehicle ? `${vehicle.brand} ${vehicle.model} ${vehicle.year ?? ''}`.trim() : ''"
      :back-to="`/dashboard/maintenance/${vehicleId}`"
    />

    <ProgressSteps
      :steps="steps"
      :current="current"
      :clickable-up-to="furthest"
      @select="current = $event"
    />

    <!-- Etapa 1 -->
    <section v-show="current === 0" class="fo-card p-7">
      <h2 class="mb-6 text-xl font-bold text-ink">Informações da Manutenção</h2>

      <div class="grid gap-5 lg:grid-cols-2">
        <FormField v-slot="field" label="Tipo de Manutenção" required :error="errors.type">
          <AppSelect :id="field.id" v-model="form.type" :options="typeOptions" />
        </FormField>
        <FormField v-slot="field" label="Data de Realização">
          <AppInput :id="field.id" v-model="form.performedAt" type="date" />
        </FormField>
      </div>

      <div class="mt-5">
        <FormField v-slot="field" label="Descrição" required :error="errors.description">
          <AppTextarea
            :id="field.id"
            v-model="form.description"
            placeholder="Descreva o que foi feito..."
            :invalid="field.invalid"
            :rows="4"
          />
        </FormField>
      </div>

      <div class="mt-5 grid gap-5 lg:grid-cols-2">
        <FormField v-slot="field" label="Custo da Mão de Obra">
          <CurrencyInput :id="field.id" v-model="form.laborCostCents" />
        </FormField>
        <FormField
          v-slot="field"
          label="Quilometragem (km)"
          :hint="
            vehicle
              ? `Pré-preenchido com o odômetro atual do veículo (${formatKm(vehicle.mileageKm)}). Valores menores ficam só nesta OS; valores maiores atualizam o odômetro do veículo.`
              : undefined
          "
        >
          <AppInput
            :id="field.id"
            v-model="form.mileageKm"
            type="number"
            min="0"
            inputmode="numeric"
            :described-by="field.describedBy"
          />
        </FormField>
      </div>

      <div class="mt-6">
        <div class="mb-1.5 flex items-center justify-between">
          <span class="fo-label mb-0">Nota Fiscal da OS</span>
          <span class="text-sm text-ink-muted">PDF ou imagem</span>
        </div>
        <FileDropzone
          purpose="MAINTENANCE_INVOICE"
          title="Clique ou arraste o arquivo aqui"
          hint="PDF, JPG, PNG — máx. 25MB"
          :files="invoice ? [invoice] : []"
          @uploaded="
            (file: UploadedFileResponse) =>
              (invoice = { fileId: file.id, url: file.url, originalName: file.originalName })
          "
          @remove="invoice = null"
        />
      </div>

      <div class="mt-5">
        <FormField v-slot="field" label="Observações">
          <AppTextarea :id="field.id" v-model="form.notes" placeholder="Observações adicionais..." :rows="3" />
        </FormField>
      </div>
    </section>

    <!-- Etapa 2 -->
    <div v-show="current === 1" class="space-y-6">
      <section
        v-for="(part, index) in parts"
        :key="part.uid"
        class="fo-card p-7"
      >
        <div class="mb-5 flex items-center justify-between">
          <h2 class="text-lg font-bold text-ink">Peça #{{ index + 1 }}</h2>
          <button
            v-if="parts.length > 1"
            type="button"
            class="inline-flex items-center gap-1.5 text-sm font-medium text-negative hover:underline"
            @click="removePart(part.uid)"
          >
            <Trash2 class="size-4" /> Remover
          </button>
        </div>

        <div class="grid gap-5 lg:grid-cols-2">
          <FormField
            v-slot="field"
            label="O que foi trocado"
            required
            :error="errors[`part-${index}-name`]"
          >
            <AppInput
              :id="field.id"
              v-model="part.name"
              placeholder="Ex: Filtro de óleo"
              :invalid="field.invalid"
            />
          </FormField>
          <FormField v-slot="field" label="Código da Peça">
            <AppInput :id="field.id" v-model="part.code" placeholder="Ex: FOL-123" />
          </FormField>
        </div>

        <div class="mt-5 grid gap-5 lg:grid-cols-3">
          <FormField v-slot="field" label="Quantidade" required :error="errors[`part-${index}-qty`]">
            <AppInput
              :id="field.id"
              v-model="part.quantity"
              type="number"
              min="1"
              inputmode="numeric"
              :invalid="field.invalid"
            />
          </FormField>
          <FormField v-slot="field" label="Custo Unit." required>
            <CurrencyInput :id="field.id" v-model="part.unitCostCents" />
          </FormField>
          <FormField v-slot="field" label="Subtotal">
            <input
              :id="field.id"
              class="fo-control tabular"
              :value="formatCentsBRL(subtotal(part))"
              readonly
              disabled
            />
          </FormField>
        </div>

        <div class="mt-5">
          <FormField v-slot="field" label="Fornecedor">
            <AppInput :id="field.id" v-model="part.supplier" placeholder="Ex: AutoPeças Brasil" />
          </FormField>
        </div>
      </section>

      <button
        type="button"
        class="fo-card flex w-full items-center justify-center gap-2 p-5 text-[17px] font-medium text-ink transition-colors hover:bg-surface-muted"
        @click="addPart"
      >
        <Plus class="size-5" /> Adicionar Peça
      </button>

      <section class="fo-card space-y-2 p-7 text-[17px]">
        <div class="flex justify-between">
          <span class="text-ink-soft">Custo das peças:</span>
          <span class="tabular text-ink">{{ formatCentsBRL(partsCostCents) }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-ink-soft">Mão de obra:</span>
          <span class="tabular text-ink">{{ formatCentsBRL(form.laborCostCents) }}</span>
        </div>
        <div class="flex justify-between border-t border-line pt-3 text-[19px] font-bold">
          <span class="text-ink">Total:</span>
          <span class="tabular text-[rgb(var(--c-positive))]">{{ formatCentsBRL(totalCents) }}</span>
        </div>
      </section>

      <section class="fo-card p-7">
        <h2 class="mb-6 text-xl font-bold text-ink">Pagamento</h2>
        <div class="grid gap-5 lg:grid-cols-2">
          <FormField v-slot="field" label="Forma de pagamento">
            <AppSelect :id="field.id" v-model="form.paymentMethod" :options="paymentOptions" />
          </FormField>
          <FormField v-slot="field" label="Conta bancária do pagamento">
            <AppSelect
              :id="field.id"
              v-model="form.bankAccountId"
              :options="accountOptions"
              placeholder="Selecione a conta"
            />
          </FormField>
        </div>
        <p class="mt-4 text-[15px] text-ink-muted">
          Valor e conta ficam registrados no cadastro. O débito no extrato só ocorre quando a manutenção
          for concluída.
        </p>
      </section>
    </div>

    <!-- Etapa 3 -->
    <section v-show="current === 2" class="fo-card p-7">
      <h2 class="mb-6 text-xl font-bold text-ink">Garantia das Peças (Opcional)</h2>

      <p v-if="parts.length === 0" class="py-10 text-center text-[17px] text-ink-muted">
        Adicione peças na aba "Peças / Itens" para configurar garantias.
      </p>

      <div v-else class="space-y-5">
        <div v-for="(part, index) in parts" :key="part.uid" class="rounded-card border border-line p-5">
          <p class="mb-4 font-semibold text-ink">
            {{ part.name || `Peça #${index + 1}` }}
          </p>
          <div class="grid gap-5 lg:grid-cols-2">
            <FormField v-slot="field" label="Garantia até">
              <AppInput :id="field.id" v-model="part.warrantyUntil" type="date" />
            </FormField>
            <FormField
              v-slot="field"
              label="Próxima troca prevista"
              hint="Gera um alerta de manutenção programada."
            >
              <AppInput :id="field.id" v-model="part.nextDueDate" type="date" />
            </FormField>
          </div>
        </div>
      </div>
    </section>

    <!-- Navegação -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <AppButton
        v-if="current > 0"
        variant="secondary"
        @click="previous"
      >
        <template #icon><ArrowLeft class="size-4" /></template>
        Anterior
      </AppButton>
      <AppButton
        v-else
        variant="secondary"
        @click="router.push(`/dashboard/maintenance/${vehicleId}`)"
      >
        Cancelar
      </AppButton>

      <AppButton v-if="current < steps.length - 1" @click="next">
        Próximo
        <template #icon><ArrowRight class="order-last size-4" /></template>
      </AppButton>
      <AppButton v-else :loading="saving" @click="submit">Registrar Manutenção</AppButton>
    </div>
  </div>
</template>
