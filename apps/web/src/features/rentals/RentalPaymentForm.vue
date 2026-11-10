<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  paymentMethodLabels,
  paymentMethods,
  rentalPaymentCategories,
  rentalPaymentCategoryLabels,
  type RentalPaymentEntry,
  type RentalPaymentsView,
} from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

/**
 * Formulário "Adicionar Pagamento" (igual ao do Frota One):
 * Categoria*, Valor*, Data Prevista*, "Já foi pago?" (revela Data do Pagamento* e Forma de
 * Pagamento) e Observação. As datas são SEMPRE informadas pelo dono: nada vem preenchido.
 *   create → POST   · edit → PATCH (só pendente)   · pay → "Marcar como pago"
 */
const props = defineProps<{
  rentalId: string;
  mode: 'create' | 'edit' | 'pay';
  entry?: RentalPaymentEntry | null;
}>();
const emit = defineEmits<{ close: []; saved: [RentalPaymentsView] }>();

const toasts = useToastStore();
const categoryOptions = rentalPaymentCategories.map((c) => ({ value: c, label: rentalPaymentCategoryLabels[c] }));
const methodOptions = paymentMethods.map((m) => ({ value: m, label: paymentMethodLabels[m] }));

const form = reactive({
  category: 'RENT' as 'RENT' | 'EXTRA_KM',
  amountCents: 0,
  expectedDate: '',
  alreadyPaid: false,
  paidAt: '',
  method: 'PIX' as string,
  notes: '',
});
const errors = ref<Record<string, string>>({});
const saving = ref(false);
// Uma chave por abertura do formulário: clique duplo / reenvio não cria dois pagamentos.
const attemptKey = ref(crypto.randomUUID());

const title = computed(() =>
  props.mode === 'create' ? 'Adicionar Pagamento' : props.mode === 'edit' ? 'Editar Pagamento' : 'Marcar como pago',
);
const showPaidFields = computed(() => props.mode === 'pay' || (props.mode === 'create' && form.alreadyPaid));

watch(
  () => [props.mode, props.entry?.id],
  () => {
    errors.value = {};
    attemptKey.value = crypto.randomUUID();
    form.category = props.entry?.category ?? 'RENT';
    form.amountCents = props.entry?.amountCents ?? 0;
    form.expectedDate = props.mode === 'create' ? '' : (props.entry?.expectedDate ?? '');
    form.alreadyPaid = false;
    form.paidAt = '';
    form.method = props.entry?.method ?? 'PIX';
    form.notes = props.entry?.notes ?? '';
  },
  { immediate: true },
);

function validate(): boolean {
  const missing: Record<string, string> = {};
  if (props.mode !== 'pay') {
    if (!form.amountCents || form.amountCents <= 0) missing.amountCents = 'Informe um valor maior que zero';
    if (!form.expectedDate) missing.expectedDate = 'Informe a data prevista';
  }
  if (showPaidFields.value && !form.paidAt) missing.paidAt = 'Informe a data do pagamento';
  errors.value = missing;
  return Object.keys(missing).length === 0;
}

async function submit() {
  if (!validate()) return;
  saving.value = true;
  try {
    let view: RentalPaymentsView;
    const base = `/rentals/${props.rentalId}/payments`;
    if (props.mode === 'create') {
      view = await api.post<RentalPaymentsView>(
        base,
        {
          category: form.category,
          amountCents: form.amountCents,
          expectedDate: form.expectedDate,
          alreadyPaid: form.alreadyPaid,
          paidAt: form.alreadyPaid ? form.paidAt : undefined,
          method: form.alreadyPaid ? form.method : undefined,
          notes: form.notes || undefined,
        },
        { headers: { 'idempotency-key': attemptKey.value } },
      );
      toasts.success('Pagamento adicionado');
    } else if (props.mode === 'edit') {
      view = await api.patch<RentalPaymentsView>(`${base}/${props.entry!.id}`, {
        amountCents: form.amountCents,
        expectedDate: form.expectedDate,
        notes: form.notes || undefined,
      });
      toasts.success('Pagamento atualizado');
    } else {
      view = await api.post<RentalPaymentsView>(`${base}/${props.entry!.id}/pay`, {
        paidAt: form.paidAt,
        method: form.method,
      });
      toasts.success('Pagamento registrado como pago');
    }
    emit('saved', view);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      if (Object.keys(errors.value).length === 0) toasts.error('Não foi possível salvar', err.message);
    } else {
      toasts.error('Não foi possível salvar o pagamento');
    }
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="fo-card p-7" aria-label="Formulário de pagamento">
    <div class="mb-5 flex items-start justify-between gap-4">
      <h2 class="text-xl font-bold text-ink">{{ title }}</h2>
      <button
        type="button"
        class="rounded-control p-1 text-ink-muted hover:bg-surface-muted"
        aria-label="Fechar formulário"
        @click="emit('close')"
      >
        ×
      </button>
    </div>

    <form class="space-y-5" novalidate @submit.prevent="submit">
      <template v-if="mode !== 'pay'">
        <FormField v-slot="field" label="Categoria" required :error="errors.category">
          <AppSelect :id="field.id" v-model="form.category" :options="categoryOptions" :disabled="mode === 'edit'" />
        </FormField>

        <FormField v-slot="field" label="Valor" required :error="errors.amountCents">
          <CurrencyInput :id="field.id" v-model="form.amountCents" :invalid="field.invalid" />
        </FormField>

        <FormField v-slot="field" label="Data Prevista" required :error="errors.expectedDate">
          <AppInput :id="field.id" v-model="form.expectedDate" type="date" :invalid="field.invalid" />
        </FormField>

        <AppCheckbox v-if="mode === 'create'" v-model="form.alreadyPaid" label="Já foi pago?" />
      </template>

      <template v-if="showPaidFields">
        <FormField v-slot="field" label="Data do Pagamento" required :error="errors.paidAt">
          <AppInput :id="field.id" v-model="form.paidAt" type="date" :invalid="field.invalid" />
        </FormField>
        <FormField v-slot="field" label="Forma de Pagamento" :error="errors.method">
          <AppSelect :id="field.id" v-model="form.method" :options="methodOptions" />
        </FormField>
      </template>

      <FormField v-if="mode !== 'pay'" v-slot="field" label="Observação" :error="errors.notes">
        <AppTextarea :id="field.id" v-model="form.notes" :rows="3" />
      </FormField>

      <div class="flex justify-end gap-3">
        <AppButton variant="secondary" :disabled="saving" @click="emit('close')">Fechar</AppButton>
        <AppButton type="submit" :loading="saving" class="!bg-positive !text-white hover:opacity-90">Salvar</AppButton>
      </div>
    </form>
  </section>
</template>
