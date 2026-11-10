<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import {
  formatCentsBRL,
  paymentMethodLabels,
  paymentMethods,
  type BankAccount,
} from '@yudirect/contracts';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

/**
 * [P] A referência mostra apenas o item de menu "Pagar"; o diálogo de
 * quitação não foi capturado. Este modal é a proposta documentada em
 * ASSUMPTIONS (A-FIN-03): valor recebido (padrão = saldo pendente),
 * data, método, conta bancária e confirmação explícita.
 */
const props = defineProps<{
  open: boolean;
  kind: 'receivable' | 'payable';
  target: { id: string; description: string; remainingCents: number } | null;
  /** Valor pré-preenchido (ex.: acumulado das semanas até a escolhida); padrão = saldo pendente. */
  suggestedAmountCents?: number;
  /** Explicação exibida abaixo do valor (ex.: "abate as semanas mais antigas primeiro"). */
  hint?: string;
}>();

const emit = defineEmits<{ close: []; saved: [] }>();

const toasts = useToastStore();
const accounts = ref<BankAccount[]>([]);
const form = reactive({
  amountCents: 0,
  paidAt: new Date().toISOString().slice(0, 10),
  method: 'PIX',
  bankAccountId: '',
  notes: '',
});
const errors = ref<Record<string, string>>({});
const saving = ref(false);
// Uma chave por abertura do modal: reenvios (duplo clique/rede) são
// deduplicados, mas dois pagamentos iguais no mesmo dia continuam válidos.
const attemptKey = ref('');

const methodOptions = paymentMethods.map((m) => ({ value: m, label: paymentMethodLabels[m] }));

watch(
  () => props.open,
  async (open) => {
    if (!open || !props.target) return;
    errors.value = {};
    attemptKey.value = `${props.kind}-${props.target.id}-${crypto.randomUUID()}`;
    form.amountCents = props.suggestedAmountCents ?? props.target.remainingCents;
    form.paidAt = new Date().toISOString().slice(0, 10);
    form.method = 'PIX';
    form.notes = '';
    const res = await api.get<{ data: BankAccount[] }>('/bank-accounts');
    accounts.value = res.data.filter((a) => a.active);
    form.bankAccountId = accounts.value.find((a) => a.isDefault)?.id ?? accounts.value[0]?.id ?? '';
  },
);

async function submit() {
  if (!props.target) return;
  if (!form.bankAccountId) {
    toasts.warning('Cadastre uma conta bancária', 'É necessário informar em qual conta o valor entrou.');
    return;
  }
  errors.value = {};
  saving.value = true;
  try {
    await api.post(
      `/${props.kind === 'receivable' ? 'receivables' : 'payables'}/${props.target.id}/payments`,
      {
        amountCents: form.amountCents,
        paidAt: form.paidAt,
        method: form.method,
        bankAccountId: form.bankAccountId,
        notes: form.notes || undefined,
      },
      {
        headers: {
          'idempotency-key': attemptKey.value,
        },
      },
    );
    toasts.success(
      props.kind === 'receivable' ? 'Recebimento registrado' : 'Pagamento registrado',
      'O extrato bancário foi atualizado.',
    );
    emit('saved');
    emit('close');
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      if (Object.keys(errors.value).length === 0) toasts.error('Não foi possível registrar', err.message);
    } else {
      toasts.error('Não foi possível registrar');
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppModal
    :open="open"
    :title="kind === 'receivable' ? 'Registrar recebimento' : 'Registrar pagamento'"
    :description="target?.description"
    @close="emit('close')"
  >
    <div v-if="target" class="space-y-5">
      <div class="rounded-card bg-surface-muted p-4">
        <p class="text-[15px] text-ink-soft">Saldo pendente</p>
        <p class="mt-1 text-[22px] font-bold tabular text-ink">
          {{ formatCentsBRL(target.remainingCents) }}
        </p>
      </div>

      <FormField
        v-slot="field"
        :label="kind === 'receivable' ? 'Valor recebido' : 'Valor pago'"
        required
        :hint="hint ?? 'Pode ser parcial — o saldo restante continua em aberto.'"
        :error="errors.amountCents"
      >
        <CurrencyInput :id="field.id" v-model="form.amountCents" :invalid="field.invalid" />
      </FormField>

      <div class="grid gap-5 sm:grid-cols-2">
        <FormField v-slot="field" label="Data" required :error="errors.paidAt">
          <AppInput :id="field.id" v-model="form.paidAt" type="date" />
        </FormField>
        <FormField v-slot="field" label="Método" required :error="errors.method">
          <AppSelect :id="field.id" v-model="form.method" :options="methodOptions" />
        </FormField>
      </div>

      <FormField v-slot="field" label="Conta bancária" required :error="errors.bankAccountId">
        <AppSelect
          :id="field.id"
          v-model="form.bankAccountId"
          :options="accounts.map((a) => ({ value: a.id, label: a.isDefault ? `${a.name} (Padrão)` : a.name }))"
          placeholder="Selecione a conta"
        />
      </FormField>

      <FormField v-slot="field" label="Observações" :error="errors.notes">
        <AppInput :id="field.id" v-model="form.notes" placeholder="Opcional" />
      </FormField>
    </div>

    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">Cancelar</AppButton>
      <AppButton :loading="saving" @click="submit">Confirmar</AppButton>
    </template>
  </AppModal>
</template>
