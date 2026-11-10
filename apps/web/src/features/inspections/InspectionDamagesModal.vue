<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { addDaysIso, businessDate, formatCentsBRL, type DamagePrice, type InspectionDamage } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppModal from '@/components/ui/AppModal.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

/** Cobrança de avarias da vistoria pela tabela de preços ("Régua de Avarias"). */
const props = defineProps<{ open: boolean; inspectionId: string | null; plate: string }>();
const emit = defineEmits<{ close: []; charged: [] }>();
const toasts = useToastStore();

const prices = ref<DamagePrice[]>([]);
const existing = ref<InspectionDamage[]>([]);
const qty = ref<Record<string, number>>({});
const notes = ref<Record<string, string>>({});
const dueDate = ref(addDaysIso(businessDate(), 7));
const saving = ref(false);

const active = computed(() => existing.value.find((d) => d.status === 'CHARGED') ?? null);
const groups = computed(() => {
  const map = new Map<string, DamagePrice[]>();
  for (const p of prices.value.filter((x) => x.active)) map.set(p.category, [...(map.get(p.category) ?? []), p]);
  return [...map.entries()];
});
const total = computed(() => prices.value.reduce((a, p) => a + (qty.value[p.id] ?? 0) * p.priceCents, 0));

watch(
  () => [props.open, props.inspectionId],
  async () => {
    if (!props.open || !props.inspectionId) return;
    qty.value = {};
    notes.value = {};
    const [p, d] = await Promise.all([
      api.get<{ data: DamagePrice[] }>('/damage-prices'),
      api.get<{ data: InspectionDamage[] }>(`/inspections/${props.inspectionId}/damages`),
    ]);
    prices.value = p.data;
    existing.value = d.data;
  },
  { immediate: true },
);

async function charge() {
  const items = Object.entries(qty.value)
    .filter(([, q]) => q > 0)
    .map(([damagePriceId, quantity]) => ({ damagePriceId, quantity, note: notes.value[damagePriceId] || undefined }));
  if (!items.length) {
    toasts.error('Marque ao menos uma avaria');
    return;
  }
  saving.value = true;
  try {
    await api.post(`/inspections/${props.inspectionId}/damages`, { items, dueDate: dueDate.value });
    toasts.success('Avarias cobradas do motorista');
    emit('charged');
    emit('close');
  } catch (err) {
    toasts.error('Não foi possível cobrar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    saving.value = false;
  }
}

async function cancel() {
  saving.value = true;
  try {
    await api.delete(`/inspections/${props.inspectionId}/damages`);
    toasts.success('Cobrança de avarias cancelada');
    existing.value = (await api.get<{ data: InspectionDamage[] }>(`/inspections/${props.inspectionId}/damages`)).data;
  } catch (err) {
    toasts.error('Não foi possível cancelar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppModal :open="open" :title="`Avarias · ${plate}`" description="Marque as avarias encontradas. Os valores vêm da tabela de avarias." size="lg" @close="emit('close')">
    <div v-if="active" class="space-y-3">
      <p class="text-[15px] text-ink">Avarias já cobradas nesta vistoria:</p>
      <ul class="divide-y divide-line rounded-control border border-line">
        <li v-for="(i, idx) in active.items" :key="idx" class="flex justify-between px-4 py-2 text-[15px]">
          <span>{{ i.quantity }}× {{ i.name }}<span v-if="i.note" class="text-ink-muted"> — {{ i.note }}</span></span>
          <span class="tabular">{{ formatCentsBRL(i.totalCents) }}</span>
        </li>
      </ul>
      <p class="text-right font-bold tabular">Total {{ formatCentsBRL(active.totalCents) }}</p>
      <p v-if="active.receivable && active.receivable.paidAmountCents > 0" class="text-sm text-ink-muted">Já há pagamento: estorne em Contas a Receber antes de cancelar.</p>
    </div>
    <div v-else class="max-h-[55vh] space-y-5 overflow-y-auto pr-1">
      <section v-for="[category, list] in groups" :key="category">
        <h3 class="mb-2 text-sm font-bold uppercase tracking-wide text-ink-muted">{{ category }}</h3>
        <div v-for="p in list" :key="p.id" class="grid grid-cols-[1fr_auto_80px] items-center gap-3 py-1.5">
          <label :for="`q-${p.id}`" class="text-[15px] text-ink">{{ p.name }} <span class="text-ink-muted">· {{ formatCentsBRL(p.priceCents) }}</span></label>
          <AppInput v-if="qty[p.id]" v-model="notes[p.id]" placeholder="Observação" class="w-48" />
          <span v-else />
          <input
            :id="`q-${p.id}`"
            v-model.number="qty[p.id]"
            type="number"
            min="0"
            max="20"
            class="w-20 rounded-control border border-line bg-surface px-2 py-1.5 text-right"
            :aria-label="`Quantidade de ${p.name}`"
          />
        </div>
      </section>
      <FormField v-slot="field" label="Vencimento da cobrança">
        <AppInput :id="field.id" v-model="dueDate" type="date" />
      </FormField>
    </div>
    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">Fechar</AppButton>
      <AppButton v-if="active" variant="danger-outline" :loading="saving" @click="cancel">Cancelar cobrança</AppButton>
      <AppButton v-else :loading="saving" :disabled="total === 0" @click="charge">Cobrar {{ formatCentsBRL(total) }}</AppButton>
    </template>
  </AppModal>
</template>
