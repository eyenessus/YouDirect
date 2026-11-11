<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { Award, BellRing } from 'lucide-vue-next';
import type { BillingSettings, LoyaltySettings } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppInput from '@/components/ui/AppInput.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

/** Régua de cobrança (WhatsApp + Pix) e níveis de fidelidade dos motoristas. */
const toasts = useToastStore();
const billing = reactive<BillingSettings>({ remindersEnabled: true, reminderDaysBefore: 2, overdueReminderDays: [1, 3], escalationDays: 7 });
const overdueText = ref('1, 3');
const providers = ref<{ pix: { connected: boolean; message: string }; whatsapp: { connected: boolean; message: string } } | null>(null);
const loyalty = ref<LoyaltySettings | null>(null);
interface ReminderRow { id: string; driverName: string; bucket: string; dueDate: string; status: 'SENT' | 'FAILED'; error: string | null; attempts: number; createdAt: string }
const reminders = ref<ReminderRow[]>([]);
const saving = ref<string | null>(null);

onMounted(async () => {
  const [b, l] = await Promise.all([
    api.get<{ settings: BillingSettings; pix: { connected: boolean; message: string }; whatsapp: { connected: boolean; message: string } }>('/billing/settings'),
    api.get<LoyaltySettings>('/loyalty/settings'),
  ]);
  Object.assign(billing, b.settings);
  overdueText.value = b.settings.overdueReminderDays.join(', ');
  providers.value = { pix: b.pix, whatsapp: b.whatsapp };
  reminders.value = (await api.get<{ data: ReminderRow[] }>('/billing/reminders').catch(() => ({ data: [] }))).data;
  loyalty.value = l;
});

async function saveBilling() {
  saving.value = 'billing';
  try {
    const days = overdueText.value.split(',').map((d) => Number(d.trim())).filter((n) => Number.isInteger(n) && n > 0);
    await api.put('/billing/settings', { ...billing, reminderDaysBefore: Number(billing.reminderDaysBefore), escalationDays: Number(billing.escalationDays), overdueReminderDays: days });
    toasts.success('Régua de cobrança salva');
  } catch (err) {
    toasts.error('Não foi possível salvar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    saving.value = null;
  }
}

async function saveLoyalty() {
  if (!loyalty.value) return;
  saving.value = 'loyalty';
  try {
    loyalty.value = await api.put<LoyaltySettings>('/loyalty/settings', {
      ...loyalty.value,
      levels: loyalty.value.levels.map((l) => ({ ...l, minScore: Number(l.minScore), weeklyDiscountPercent: Number(l.weeklyDiscountPercent) })),
    });
    toasts.success('Programa de fidelidade salvo');
  } catch (err) {
    toasts.error('Não foi possível salvar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    saving.value = null;
  }
}
</script>

<template>
  <section class="fo-card p-7 xl:col-span-2" aria-label="Cobrança e fidelidade">
    <h2 class="mb-2 flex items-center gap-2.5 text-xl font-bold text-ink"><BellRing class="size-5 text-ink-soft" aria-hidden="true" /> Cobrança automática</h2>
    <p class="mb-4 text-[15px] text-ink-muted">
      Lembretes de vencimento pelo WhatsApp com o link de pagamento por Pix da Área do Motorista. A baixa do Pix é automática.
    </p>
    <ul v-if="providers" class="mb-4 space-y-1 text-sm">
      <li :class="providers.pix.connected ? 'text-[rgb(var(--c-positive))]' : 'text-ink-soft'">Pix: {{ providers.pix.message }}</li>
      <li :class="providers.whatsapp.connected ? 'text-[rgb(var(--c-positive))]' : 'text-ink-soft'">WhatsApp: {{ providers.whatsapp.message }}</li>
    </ul>
    <div class="grid gap-4 md:grid-cols-3">
      <AppCheckbox v-model="billing.remindersEnabled" label="Enviar lembretes de cobrança" />
      <label class="text-sm text-ink-soft">
        Dias antes do vencimento
        <AppInput v-model="billing.reminderDaysBefore" type="number" inputmode="numeric" class="mt-1" />
      </label>
      <label class="text-sm text-ink-soft">
        Dias depois (atraso), separados por vírgula
        <AppInput v-model="overdueText" class="mt-1" />
      </label>
      <label class="text-sm text-ink-soft">
        Avisar a equipe após (dias de atraso)
        <AppInput v-model="billing.escalationDays" type="number" inputmode="numeric" class="mt-1" />
      </label>
    </div>
    <div class="mt-4 flex justify-end"><AppButton :loading="saving === 'billing'" @click="saveBilling">Salvar régua</AppButton></div>

    <div v-if="reminders.length" class="mt-6">
      <h3 class="mb-2 text-base font-semibold text-ink">Últimos lembretes enviados</h3>
      <ul class="divide-y divide-line rounded-control border border-line text-sm">
        <li v-for="r in reminders.slice(0, 8)" :key="r.id" class="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <span class="text-ink">{{ r.driverName }} <span class="text-ink-muted">· marco {{ r.bucket }}</span></span>
          <span :class="r.status === 'SENT' ? 'text-[rgb(var(--c-positive))]' : 'text-[rgb(var(--c-negative))]'">
            {{ r.status === 'SENT' ? 'Enviado' : `Falhou (${r.attempts}/3): ${r.error ?? 'sem detalhe'}` }}
          </span>
        </li>
      </ul>
    </div>

    <hr class="my-7 border-line" />

    <h2 class="mb-2 flex items-center gap-2.5 text-xl font-bold text-ink"><Award class="size-5 text-ink-soft" aria-hidden="true" /> Fidelidade dos motoristas</h2>
    <p class="mb-4 text-[15px] text-ink-muted">
      Pontos por tempo de contrato, pagamentos em dia, vistorias no prazo e direção sem multas. Recalculado todo dia; o motorista vê o nível na Área do Motorista.
    </p>
    <template v-if="loyalty">
      <AppCheckbox v-model="loyalty.enabled" label="Programa ativo" class="mb-4" />
      <div class="space-y-3">
        <div v-for="(l, i) in loyalty.levels" :key="l.code" class="grid gap-3 rounded-control border border-line p-3 md:grid-cols-[1fr_120px_120px_2fr]">
          <label class="text-sm text-ink-soft">Nível<AppInput v-model="l.name" class="mt-1" /></label>
          <label class="text-sm text-ink-soft">A partir de (pts)<AppInput v-model="l.minScore" type="number" :disabled="i === 0" class="mt-1" /></label>
          <label class="text-sm text-ink-soft">Desconto (%)<AppInput v-model="l.weeklyDiscountPercent" type="number" class="mt-1" /></label>
          <label class="text-sm text-ink-soft">
            Benefícios (separados por ;)
            <AppInput
              :model-value="l.benefits.join('; ')"
              class="mt-1"
              @update:model-value="(v: string | number | null | undefined) => (l.benefits = String(v ?? '').split(';').map((b) => b.trim()).filter(Boolean))"
            />
          </label>
        </div>
      </div>
      <div class="mt-4 flex justify-end"><AppButton :loading="saving === 'loyalty'" @click="saveLoyalty">Salvar fidelidade</AppButton></div>
    </template>
  </section>
</template>
