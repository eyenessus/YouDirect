<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Plus } from 'lucide-vue-next';
import {
  formatCentsBRL,
  installmentFrequencies,
  installmentFrequencyLabels,
  maxInstallments,
  type BankAccount,
  type ExpenseCategory,
  type InstallmentFrequency,
  type Payable,
  type Vehicle,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';
import { todayLocalIso } from '@/lib/dates';

const router = useRouter();
const route = useRoute();
/** Presente = edição (PATCH) de uma conta existente. */
const payableId = typeof route.params?.id === 'string' ? route.params.id : null;
const editing = ref<Payable | null>(null);
const toasts = useToastStore();

const categories = ref<ExpenseCategory[]>([]);
const vehicles = ref<Vehicle[]>([]);
const accounts = ref<BankAccount[]>([]);

const form = reactive({
  categoryId: '',
  vehicleId: '',
  amountCents: 0,
  dueDate: todayLocalIso(),
  description: '',
  supplierName: '',
  supplierTaxId: '',
  documentUrl: '',
  recurring: false,
  installmentsEnabled: false,
  installmentCount: '12',
  installmentFrequency: 'MONTHLY' as InstallmentFrequency,
  alreadyPaid: false,
  paidBankAccountId: '',
  notes: '',
});

const errors = ref<Record<string, string>>({});
const saving = ref(false);

const frequencyOptions = installmentFrequencies.map((f) => ({
  value: f,
  label: installmentFrequencyLabels[f],
}));
const installmentCountNumber = computed(() => Math.trunc(Number(form.installmentCount)) || 0);
const installmentsTotalCents = computed(() => form.amountCents * installmentCountNumber.value);

// Recorrência (gera todo mês, sem fim) e parcelamento (N parcelas) não se combinam.
watch(
  () => form.installmentsEnabled,
  (on) => {
    if (on) form.recurring = false;
  },
);
watch(
  () => form.recurring,
  (on) => {
    if (on) form.installmentsEnabled = false;
  },
);
const categoryModal = ref(false);
const newCategory = ref('');
const savingCategory = ref(false);

async function loadReferences() {
  const [cats, vs, accs] = await Promise.all([
    api.get<{ data: ExpenseCategory[] }>('/expense-categories'),
    api.get<{ data: Vehicle[] }>('/vehicles', { query: { limit: 100 } }),
    api.get<{ data: BankAccount[] }>('/bank-accounts'),
  ]);
  categories.value = cats.data;
  vehicles.value = vs.data;
  accounts.value = accs.data.filter((a) => a.active);
  form.categoryId =
    categories.value.find((c) => c.label === 'Outro')?.id ?? categories.value[0]?.id ?? '';
  form.paidBankAccountId = accounts.value.find((a) => a.isDefault)?.id ?? accounts.value[0]?.id ?? '';
  if (payableId) {
    const payable = await api.get<Payable>(`/payables/${payableId}`);
    editing.value = payable;
    form.categoryId = payable.category?.id ?? form.categoryId;
    form.vehicleId = payable.vehicle?.id ?? '';
    form.amountCents = payable.amountCents;
    form.dueDate = payable.dueDate;
    form.description = payable.description;
    form.supplierName = payable.supplierName ?? '';
    form.supplierTaxId = payable.supplierTaxId ?? '';
    form.documentUrl = payable.documentUrl ?? '';
    form.recurring = payable.recurring;
    form.notes = payable.notes ?? '';
  }
}

async function createCategory() {
  const label = newCategory.value.trim();
  if (!label) return;
  savingCategory.value = true;
  try {
    const created = await api.post<ExpenseCategory>('/expense-categories', { label });
    categories.value = [...categories.value, created];
    form.categoryId = created.id;
    newCategory.value = '';
    categoryModal.value = false;
    toasts.success('Categoria criada');
  } catch (err) {
    toasts.error('Não foi possível criar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    savingCategory.value = false;
  }
}

async function submit() {
  errors.value = {};
  saving.value = true;
  try {
    if (payableId) {
      // Edição: valor nunca abaixo do já pago (validado na API); parar a
      // recorrência encerra a série inteira.
      await api.patch(`/payables/${payableId}`, {
        categoryId: form.categoryId,
        vehicleId: form.vehicleId || null,
        amountCents: form.amountCents,
        dueDate: form.dueDate,
        description: form.description,
        supplierName: form.supplierName || null,
        supplierTaxId: form.supplierTaxId || null,
        documentUrl: form.documentUrl || null,
        recurring: editing.value?.installment ? undefined : form.recurring,
        notes: form.notes || null,
      });
      toasts.success('Conta a pagar atualizada');
      await router.push('/dashboard/finance/accounts-payable');
      return;
    }
    await api.post('/payables', {
      categoryId: form.categoryId,
      vehicleId: form.vehicleId || undefined,
      amountCents: form.amountCents,
      dueDate: form.dueDate,
      description: form.description,
      supplierName: form.supplierName || undefined,
      supplierTaxId: form.supplierTaxId || undefined,
      documentUrl: form.documentUrl || undefined,
      recurring: form.recurring,
      installments: form.installmentsEnabled
        ? { count: installmentCountNumber.value, frequency: form.installmentFrequency }
        : undefined,
      alreadyPaid: form.alreadyPaid,
      paidBankAccountId: form.alreadyPaid ? form.paidBankAccountId : undefined,
      notes: form.notes || undefined,
    });
    toasts.success(
      form.installmentsEnabled ? `${installmentCountNumber.value} parcelas criadas` : 'Conta a pagar criada',
    );
    await router.push('/dashboard/finance/accounts-payable');
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      if (Object.keys(errors.value).length === 0) toasts.error('Não foi possível salvar', err.message);
      else toasts.error('Revise os campos destacados');
    } else {
      toasts.error('Não foi possível salvar a conta');
    }
  } finally {
    saving.value = false;
  }
}

onMounted(loadReferences);
</script>

<template>
  <form class="space-y-6" novalidate @submit.prevent="submit">
    <PageHeader
      eyebrow="FINANCEIRO"
      :title="payableId ? 'Editar Conta a Pagar' : 'Nova Conta a Pagar'"
      :subtitle="
        editing?.installment
          ? `Parcela ${editing.installment.number} de ${editing.installment.total}`
          : payableId
            ? 'Altere os dados da conta'
            : 'Cadastre uma nova conta a pagar'
      "
      back-to="/dashboard/finance/accounts-payable"
    />

    <section class="fo-card p-7">
      <h2 class="text-xl font-bold text-ink">Dados da Conta a Pagar</h2>
      <p class="mb-6 mt-1 text-[15px] text-ink-muted">Preencha os dados abaixo</p>

      <div class="grid gap-5 lg:grid-cols-2">
        <div>
          <div class="mb-1.5 flex items-center justify-between gap-3">
            <label for="payable-category" class="fo-label mb-0">Categoria *</label>
            <button
              type="button"
              class="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline"
              @click="categoryModal = true"
            >
              <Plus class="size-3.5" /> Nova categoria
            </button>
          </div>
          <AppSelect
            id="payable-category"
            v-model="form.categoryId"
            :options="categories.map((c) => ({ value: c.id, label: c.label }))"
            :invalid="Boolean(errors.categoryId)"
          />
          <p v-if="errors.categoryId" class="mt-1.5 text-xs text-negative">{{ errors.categoryId }}</p>
        </div>

        <FormField v-slot="field" label="Veículo (opcional)" :error="errors.vehicleId">
          <AppSelect
            :id="field.id"
            v-model="form.vehicleId"
            :options="[
              { value: '', label: 'Nenhum' },
              ...vehicles.map((v) => ({ value: v.id, label: `${v.plate} — ${v.brand} ${v.model}` })),
            ]"
          />
        </FormField>

        <FormField
          v-slot="field"
          :label="form.installmentsEnabled ? 'Valor de cada parcela' : 'Valor'"
          required
          :error="errors.amountCents"
        >
          <CurrencyInput :id="field.id" v-model="form.amountCents" :invalid="field.invalid" />
        </FormField>

        <FormField
          v-slot="field"
          :label="form.installmentsEnabled ? 'Vencimento da 1ª parcela' : 'Data de Vencimento'"
          required
          :error="errors.dueDate"
        >
          <AppInput :id="field.id" v-model="form.dueDate" type="date" :invalid="field.invalid" />
        </FormField>
      </div>

      <div class="mt-5">
        <FormField v-slot="field" label="Descrição" required :error="errors.description">
          <AppInput :id="field.id" v-model="form.description" :invalid="field.invalid" />
        </FormField>
      </div>

      <div class="mt-5 grid gap-5 lg:grid-cols-2">
        <FormField v-slot="field" label="Nome do Fornecedor" :error="errors.supplierName">
          <AppInput :id="field.id" v-model="form.supplierName" />
        </FormField>
        <FormField v-slot="field" label="CNPJ do Fornecedor" :error="errors.supplierTaxId">
          <AppInput
            :id="field.id"
            v-model="form.supplierTaxId"
            inputmode="numeric"
            placeholder="00.000.000/0000-00"
            :invalid="field.invalid"
          />
        </FormField>
      </div>

      <div class="mt-5">
        <FormField v-slot="field" label="URL do Documento (Nota Fiscal)" :error="errors.documentUrl">
          <AppInput :id="field.id" v-model="form.documentUrl" type="url" placeholder="https://..." />
        </FormField>
      </div>

      <div v-if="payableId" class="mt-6 space-y-3">
        <AppCheckbox
          v-if="!editing?.installment"
          v-model="form.recurring"
          label="Conta Recorrente (desmarcar encerra a série inteira)"
        />
        <p v-if="editing && editing.paidAmountCents > 0" class="text-sm text-ink-muted">
          Já pago: {{ formatCentsBRL(editing.paidAmountCents) }} — o valor não pode ficar abaixo disso.
        </p>
      </div>

      <div v-else class="mt-6 space-y-3">
        <AppCheckbox
          v-model="form.recurring"
          label="Conta Recorrente (gerar automaticamente todo mês)"
        />
        <AppCheckbox
          v-model="form.installmentsEnabled"
          label="Parcelado (financiamento, seguro, IPVA, licenciamento...)"
        />
        <AppCheckbox
          v-model="form.alreadyPaid"
          :label="form.installmentsEnabled ? 'A 1ª parcela já foi paga' : 'Já foi paga (cadastrar como paga)'"
        />
      </div>

      <div v-if="!payableId && form.installmentsEnabled" class="mt-5 rounded-card bg-surface-muted p-5">
        <div class="grid gap-5 sm:grid-cols-2">
          <FormField
            v-slot="field"
            label="Número de parcelas"
            required
            :hint="`De 2 a ${maxInstallments}`"
            :error="errors['installments.count'] ?? errors.installments"
          >
            <AppInput :id="field.id" v-model="form.installmentCount" type="number" inputmode="numeric" />
          </FormField>
          <FormField
            v-slot="field"
            label="Periodicidade"
            required
            :error="errors['installments.frequency']"
          >
            <AppSelect :id="field.id" v-model="form.installmentFrequency" :options="frequencyOptions" />
          </FormField>
        </div>
        <p v-if="installmentCountNumber >= 2 && form.amountCents > 0" class="mt-4 text-[15px] text-ink-soft">
          {{ installmentCountNumber }} parcelas de {{ formatCentsBRL(form.amountCents) }} —
          total de <span class="font-semibold text-ink">{{ formatCentsBRL(installmentsTotalCents) }}</span>.
          Cada parcela será uma conta a pagar com baixa individual.
        </p>
      </div>

      <div v-if="!payableId && form.alreadyPaid" class="mt-5">
        <FormField
          v-slot="field"
          label="Conta bancária do pagamento"
          required
          hint="O valor será lançado como saída no extrato desta conta."
        >
          <AppSelect
            :id="field.id"
            v-model="form.paidBankAccountId"
            :options="accounts.map((a) => ({ value: a.id, label: a.isDefault ? `${a.name} (Padrão)` : a.name }))"
            placeholder="Selecione a conta"
          />
        </FormField>
      </div>

      <div class="mt-5">
        <FormField v-slot="field" label="Observações" :error="errors.notes">
          <AppTextarea :id="field.id" v-model="form.notes" :rows="4" />
        </FormField>
      </div>
    </section>

    <div class="flex flex-wrap justify-end gap-3">
      <AppButton
        variant="secondary"
        :disabled="saving"
        @click="router.push('/dashboard/finance/accounts-payable')"
      >
        Cancelar
      </AppButton>
      <AppButton type="submit" :loading="saving">{{ payableId ? 'Salvar alterações' : 'Criar Conta a Pagar' }}</AppButton>
    </div>

    <AppModal :open="categoryModal" title="Nova categoria" size="sm" @close="categoryModal = false">
      <FormField v-slot="field" label="Nome da categoria" required>
        <AppInput :id="field.id" v-model="newCategory" placeholder="Ex: Pedágio" />
      </FormField>
      <template #footer>
        <AppButton variant="secondary" @click="categoryModal = false">Cancelar</AppButton>
        <AppButton :loading="savingCategory" @click="createCategory">Criar</AppButton>
      </template>
    </AppModal>
  </form>
</template>
