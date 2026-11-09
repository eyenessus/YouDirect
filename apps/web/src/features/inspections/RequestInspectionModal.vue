<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { Calendar, Car, Mail, MessageCircle, User } from 'lucide-vue-next';
import type { Inspection } from '@frotaone/contracts';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const props = defineProps<{
  open: boolean;
  vehicle: { id: string; plate: string; brand: string; model: string; year: number | null } | null;
  defaultResponsible?: string | null;
  defaultPhone?: string | null;
  defaultEmail?: string | null;
}>();

const emit = defineEmits<{ close: []; created: [Inspection] }>();

const toasts = useToastStore();
const form = reactive({
  responsibleName: '',
  phone: '',
  email: '',
  scheduledAt: new Date().toISOString().slice(0, 10),
});
const errors = ref<Record<string, string>>({});
const saving = ref(false);
const manualLink = ref<string | null>(null);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    form.responsibleName = props.defaultResponsible ?? '';
    form.phone = props.defaultPhone ?? '';
    form.email = props.defaultEmail ?? '';
    form.scheduledAt = new Date().toISOString().slice(0, 10);
    errors.value = {};
    manualLink.value = null;
  },
);

async function submit() {
  if (!props.vehicle) return;
  errors.value = {};
  saving.value = true;
  try {
    const res = await api.post<{ inspection: Inspection; link: string }>(
      `/vehicles/${props.vehicle.id}/inspections/request`,
      {
        responsibleName: form.responsibleName,
        phone: form.phone,
        email: form.email || undefined,
        scheduledAt: form.scheduledAt,
      },
    );
    emit('created', res.inspection);
    const delivery = res.inspection.delivery;
    if (delivery?.status === 'SENT') {
      toasts.success('Vistoria solicitada', `Link enviado por ${delivery.channel === 'EMAIL' ? 'e-mail' : 'WhatsApp'}.`);
      emit('close');
    } else {
      // Nenhum provedor confirmou a entrega: oferecemos o link manual.
      manualLink.value = delivery?.manualLink ?? res.link;
      toasts.warning(
        'Vistoria criada, mas não enviada automaticamente',
        delivery?.message ?? 'Envie o link manualmente ao responsável.',
      );
    }
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      if (Object.keys(errors.value).length === 0) toasts.error('Não foi possível solicitar', err.message);
    } else {
      toasts.error('Não foi possível solicitar a vistoria');
    }
  } finally {
    saving.value = false;
  }
}

async function copyLink() {
  if (!manualLink.value) return;
  try {
    await navigator.clipboard.writeText(manualLink.value);
    toasts.success('Link copiado');
  } catch {
    toasts.info('Copie o link manualmente', manualLink.value);
  }
}
</script>

<template>
  <AppModal
    :open="open"
    title="Solicitar Vistoria"
    description="O link de vistoria será enviado por WhatsApp ao responsável indicado. Se o WhatsApp falhar, enviamos para o e-mail informado."
    @close="emit('close')"
  >
    <div v-if="vehicle" class="mb-6 flex items-center gap-3 rounded-card bg-surface-muted p-4">
      <Car class="size-5 text-ink-muted" aria-hidden="true" />
      <div>
        <p class="font-semibold text-ink">
          {{ vehicle.brand }} {{ vehicle.model }} {{ vehicle.year ?? '' }}
        </p>
        <p class="mt-0.5 text-sm text-ink-muted">Placa: {{ vehicle.plate }}</p>
      </div>
    </div>

    <div v-if="manualLink" class="space-y-4">
      <div class="rounded-card border border-[rgb(var(--c-warning)/0.3)] bg-[rgb(var(--c-warning)/0.08)] p-4">
        <p class="text-[15px] font-semibold text-ink">Envio automático indisponível</p>
        <p class="mt-1.5 text-sm leading-relaxed text-ink-soft">
          A vistoria foi criada, mas nenhum provedor confirmou a entrega. Compartilhe o link abaixo com o
          responsável.
        </p>
      </div>
      <div class="flex gap-2">
        <input class="fo-control" :value="manualLink" readonly aria-label="Link da vistoria" />
        <AppButton variant="secondary" @click="copyLink">Copiar</AppButton>
      </div>
      <a
        :href="manualLink"
        target="_blank"
        rel="noopener"
        class="inline-flex items-center gap-2 text-[15px] font-medium text-brand-600 hover:underline"
      >
        <MessageCircle class="size-4" /> Abrir conversa no WhatsApp
      </a>
    </div>

    <form v-else class="space-y-5" novalidate @submit.prevent="submit">
      <FormField v-slot="field" label="Nome do responsável" required :error="errors.responsibleName">
        <div class="relative">
          <User class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
          <AppInput
            :id="field.id"
            v-model="form.responsibleName"
            class="pl-10"
            :invalid="field.invalid"
          />
        </div>
      </FormField>

      <FormField
        v-slot="field"
        label="WhatsApp"
        required
        hint="Número do motorista da locação ativa. Você pode alterá-lo se necessário."
        :error="errors.phone"
      >
        <div class="relative">
          <MessageCircle
            class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[rgb(var(--c-positive))]"
          />
          <AppInput
            :id="field.id"
            v-model="form.phone"
            class="pl-10"
            inputmode="tel"
            placeholder="(11) 99999-9999"
            :invalid="field.invalid"
            :described-by="field.describedBy"
          />
        </div>
      </FormField>

      <FormField
        v-slot="field"
        label="E-mail (opcional)"
        hint="Usado como alternativa se o WhatsApp não for entregue."
        :error="errors.email"
      >
        <div class="relative">
          <Mail class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
          <AppInput
            :id="field.id"
            v-model="form.email"
            type="email"
            class="pl-10"
            :invalid="field.invalid"
            :described-by="field.describedBy"
          />
        </div>
      </FormField>

      <FormField v-slot="field" label="Data agendada" required :error="errors.scheduledAt">
        <div class="relative">
          <Calendar class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
          <AppInput :id="field.id" v-model="form.scheduledAt" type="date" class="pl-10" />
        </div>
      </FormField>
    </form>

    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">
        {{ manualLink ? 'Fechar' : 'Cancelar' }}
      </AppButton>
      <AppButton v-if="!manualLink" :loading="saving" @click="submit">Solicitar vistoria</AppButton>
    </template>
  </AppModal>
</template>
