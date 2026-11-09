<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Banknote, Landmark, Pencil, Receipt } from 'lucide-vue-next';
import {
  bankAccountTypeLabels,
  bankAccountTypes,
  formatCentsBRL,
  transactionDirectionLabels,
  transactionDirections,
  type BankAccount,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();

const accounts = ref<BankAccount[]>([]);
const loading = ref(true);

const accountModal = ref<{ open: boolean; editing: BankAccount | null }>({ open: false, editing: null });
const accountForm = reactive({
  name: '',
  institution: '',
  type: 'CHECKING',
  initialBalanceCents: 0,
  initialBalanceDate: new Date().toISOString().slice(0, 10),
  isDefault: false,
  active: true,
});
const accountErrors = ref<Record<string, string>>({});
const savingAccount = ref(false);

const manualModal = ref(false);
const manualForm = reactive({
  accountId: '',
  direction: 'OUT',
  amountCents: 0,
  occurredAt: new Date().toISOString().slice(0, 10),
  description: '',
});
const manualErrors = ref<Record<string, string>>({});
const savingManual = ref(false);

const typeOptions = bankAccountTypes.map((t) => ({ value: t, label: bankAccountTypeLabels[t] }));
const directionOptions = transactionDirections.map((d) => ({
  value: d,
  label: transactionDirectionLabels[d],
}));

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ data: BankAccount[] }>('/bank-accounts');
    accounts.value = res.data;
  } catch {
    toasts.error('Falha ao carregar as contas bancárias');
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  accountModal.value = { open: true, editing: null };
  Object.assign(accountForm, {
    name: '',
    institution: '',
    type: 'CHECKING',
    initialBalanceCents: 0,
    initialBalanceDate: new Date().toISOString().slice(0, 10),
    isDefault: accounts.value.length === 0,
    active: true,
  });
  accountErrors.value = {};
}

function openEdit(account: BankAccount) {
  accountModal.value = { open: true, editing: account };
  Object.assign(accountForm, {
    name: account.name,
    institution: account.institution ?? '',
    type: account.type,
    initialBalanceCents: account.initialBalanceCents,
    initialBalanceDate: account.initialBalanceDate,
    isDefault: account.isDefault,
    active: account.active,
  });
  accountErrors.value = {};
}

async function saveAccount() {
  accountErrors.value = {};
  savingAccount.value = true;
  const payload = {
    name: accountForm.name,
    institution: accountForm.institution || undefined,
    type: accountForm.type,
    initialBalanceCents: accountForm.initialBalanceCents,
    initialBalanceDate: accountForm.initialBalanceDate,
    isDefault: accountForm.isDefault,
    ...(accountModal.value.editing ? { active: accountForm.active } : {}),
  };
  try {
    if (accountModal.value.editing) {
      await api.patch(`/bank-accounts/${accountModal.value.editing.id}`, payload);
      toasts.success('Conta atualizada');
    } else {
      await api.post('/bank-accounts', payload);
      toasts.success('Conta criada');
    }
    accountModal.value = { open: false, editing: null };
    await load();
  } catch (err) {
    if (err instanceof ApiRequestError) {
      accountErrors.value = err.fieldErrors();
      if (Object.keys(accountErrors.value).length === 0) toasts.error('Não foi possível salvar', err.message);
    } else {
      toasts.error('Não foi possível salvar a conta');
    }
  } finally {
    savingAccount.value = false;
  }
}

function openManual() {
  manualModal.value = true;
  Object.assign(manualForm, {
    accountId: accounts.value.find((a) => a.isDefault)?.id ?? accounts.value[0]?.id ?? '',
    direction: 'OUT',
    amountCents: 0,
    occurredAt: new Date().toISOString().slice(0, 10),
    description: '',
  });
  manualErrors.value = {};
}

async function saveManual() {
  manualErrors.value = {};
  savingManual.value = true;
  try {
    await api.post(
      `/bank-accounts/${manualForm.accountId}/manual-transactions`,
      {
        direction: manualForm.direction,
        amountCents: manualForm.amountCents,
        occurredAt: manualForm.occurredAt,
        description: manualForm.description,
      },
      { headers: { 'idempotency-key': `manual-${Date.now()}-${Math.random().toString(36).slice(2)}` } },
    );
    toasts.success('Lançamento registrado');
    manualModal.value = false;
    await load();
  } catch (err) {
    if (err instanceof ApiRequestError) {
      manualErrors.value = err.fieldErrors();
      if (Object.keys(manualErrors.value).length === 0) toasts.error('Não foi possível registrar', err.message);
    } else {
      toasts.error('Não foi possível registrar o lançamento');
    }
  } finally {
    savingManual.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="FINANCEIRO"
      title="Contas bancárias"
      subtitle="Gerencie suas contas e acompanhe o saldo real de cada uma."
    >
      <template #actions>
        <AppButton
          v-if="auth.allows('finance', 'create')"
          variant="secondary"
          :disabled="accounts.length === 0"
          @click="openManual"
        >
          <template #icon><Banknote class="size-4" /></template>
          Lançamento manual
        </AppButton>
        <AppButton v-if="auth.allows('finance', 'create')" @click="openCreate">
          <template #icon><span class="text-lg leading-none">+</span></template>
          Nova conta
        </AppButton>
      </template>
    </PageHeader>

    <AppSkeleton v-if="loading" variant="cards" :rows="3" />

    <EmptyState
      v-else-if="accounts.length === 0"
      :icon="Landmark"
      message="Nenhuma conta bancária cadastrada. Cadastre a primeira conta para registrar recebimentos e pagamentos."
    >
      <AppButton v-if="auth.allows('finance', 'create')" @click="openCreate">Nova conta</AppButton>
    </EmptyState>

    <div v-else class="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      <article v-for="account in accounts" :key="account.id" class="fo-card p-6">
        <div class="flex items-start justify-between gap-3">
          <h2 class="flex items-center gap-2.5 text-[19px] font-bold text-ink">
            <Landmark class="size-5 text-brand-600" aria-hidden="true" />
            {{ account.name }}
          </h2>
          <StatusBadge v-if="account.isDefault" label="Padrão" tone="slate" :solid="false" />
        </div>

        <p class="mt-4 text-[30px] font-bold tabular text-ink">
          {{ formatCentsBRL(account.currentBalanceCents) }}
        </p>
        <p class="mt-1 text-[15px] text-ink-muted">
          {{ bankAccountTypeLabels[account.type] }}
          <span v-if="account.institution"> · {{ account.institution }}</span>
          <span v-if="!account.active" class="text-[rgb(var(--c-warning))]"> · inativa</span>
        </p>

        <div class="mt-5 flex flex-wrap gap-3">
          <AppButton
            variant="secondary"
            size="sm"
            @click="router.push(`/dashboard/finance/bank-accounts/${account.id}`)"
          >
            <template #icon><Receipt class="size-4" /></template>
            Extrato
          </AppButton>
          <AppButton
            v-if="auth.allows('finance', 'update')"
            variant="ghost"
            size="sm"
            @click="openEdit(account)"
          >
            <template #icon><Pencil class="size-4" /></template>
            Editar
          </AppButton>
        </div>
      </article>
    </div>

    <!-- Modal de conta -->
    <AppModal
      :open="accountModal.open"
      :title="accountModal.editing ? 'Editar conta' : 'Nova conta bancária'"
      description="A data do saldo inicial é obrigatória — lançamentos anteriores a ela não entram no saldo."
      @close="accountModal = { open: false, editing: null }"
    >
      <div class="space-y-5">
        <FormField v-slot="field" label="Nome" required :error="accountErrors.name">
          <AppInput
            :id="field.id"
            v-model="accountForm.name"
            placeholder="Itaú – Recebimentos"
            :invalid="field.invalid"
          />
        </FormField>

        <div class="grid gap-5 sm:grid-cols-2">
          <FormField v-slot="field" label="Instituição (opcional)" :error="accountErrors.institution">
            <AppInput :id="field.id" v-model="accountForm.institution" placeholder="Itaú" />
          </FormField>
          <FormField v-slot="field" label="Tipo">
            <AppSelect :id="field.id" v-model="accountForm.type" :options="typeOptions" />
          </FormField>
        </div>

        <div class="grid gap-5 sm:grid-cols-2">
          <FormField v-slot="field" label="Saldo inicial" :error="accountErrors.initialBalanceCents">
            <CurrencyInput :id="field.id" v-model="accountForm.initialBalanceCents" />
          </FormField>
          <FormField
            v-slot="field"
            label="Data do saldo inicial"
            required
            :error="accountErrors.initialBalanceDate"
          >
            <AppInput :id="field.id" v-model="accountForm.initialBalanceDate" type="date" />
          </FormField>
        </div>

        <AppCheckbox v-model="accountForm.isDefault" label="Definir como conta padrão" />
        <AppCheckbox v-if="accountModal.editing" v-model="accountForm.active" label="Conta ativa" />
      </div>

      <template #footer>
        <AppButton variant="secondary" @click="accountModal = { open: false, editing: null }">
          Cancelar
        </AppButton>
        <AppButton :loading="savingAccount" @click="saveAccount">
          {{ accountModal.editing ? 'Salvar' : 'Criar conta' }}
        </AppButton>
      </template>
    </AppModal>

    <!-- Modal de lançamento manual -->
    <AppModal
      :open="manualModal"
      title="Lançamento manual"
      description="Registre tarifas, rendimentos, aportes ou retiradas para o saldo bater com o banco."
      @close="manualModal = false"
    >
      <div class="space-y-5">
        <FormField v-slot="field" label="Conta">
          <AppSelect
            :id="field.id"
            v-model="manualForm.accountId"
            :options="accounts.filter((a) => a.active).map((a) => ({ value: a.id, label: a.name }))"
          />
        </FormField>

        <div class="grid gap-5 sm:grid-cols-2">
          <FormField v-slot="field" label="Tipo">
            <AppSelect :id="field.id" v-model="manualForm.direction" :options="directionOptions" />
          </FormField>
          <FormField v-slot="field" label="Valor" required :error="manualErrors.amountCents">
            <CurrencyInput :id="field.id" v-model="manualForm.amountCents" :invalid="field.invalid" />
          </FormField>
        </div>

        <FormField v-slot="field" label="Data" required :error="manualErrors.occurredAt">
          <AppInput :id="field.id" v-model="manualForm.occurredAt" type="date" />
        </FormField>

        <FormField v-slot="field" label="Descrição" required :error="manualErrors.description">
          <AppInput
            :id="field.id"
            v-model="manualForm.description"
            placeholder="Tarifa bancária"
            :invalid="field.invalid"
          />
        </FormField>
      </div>

      <template #footer>
        <AppButton variant="secondary" @click="manualModal = false">Cancelar</AppButton>
        <AppButton :loading="savingManual" @click="saveManual">Registrar</AppButton>
      </template>
    </AppModal>
  </div>
</template>
