<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { MessageCircle } from 'lucide-vue-next';
import type { InspectionWhatsappSettings } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppInput from '@/components/ui/AppInput.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/**
 * Configuração da coleta de vistoria pelo WhatsApp (Whaply): horário do
 * disparo, lembrete e prazo. O canal (conta e número da FF Veículos) é
 * configurado no servidor — nunca pela interface.
 */
interface SettingsResponse {
  settings: InspectionWhatsappSettings;
  channel: { connected: boolean; message: string };
  templates: { request: string; reminder: string; correction: string; language: string };
}

const auth = useAuthStore();
const toasts = useToastStore();
const data = ref<SettingsResponse | null>(null);
const form = ref<InspectionWhatsappSettings | null>(null);
const saving = ref(false);

async function load() {
  try {
    data.value = await api.get<SettingsResponse>('/inspection/whatsapp-settings');
    form.value = { ...data.value.settings };
  } catch {
    toasts.error('Não foi possível carregar a configuração do WhatsApp');
  }
}

async function save() {
  if (!form.value) return;
  saving.value = true;
  try {
    await api.put('/inspection/whatsapp-settings', {
      ...form.value,
      reminderAfterHours: Number(form.value.reminderAfterHours),
      maxReminders: Number(form.value.maxReminders),
      collectionTtlHours: Number(form.value.collectionTtlHours),
    });
    toasts.success('Configuração do WhatsApp salva');
    await load();
  } catch (err) {
    toasts.error('Não foi possível salvar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="fo-card p-7" aria-labelledby="wa-settings-title">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 id="wa-settings-title" class="flex items-center gap-2.5 text-xl font-bold text-ink">
        <MessageCircle class="size-5 text-ink-soft" aria-hidden="true" /> Coleta pelo WhatsApp
      </h2>
      <StatusBadge
        v-if="data"
        :label="data.channel.connected ? 'Canal conectado' : 'Canal não conectado'"
        :tone="data.channel.connected ? 'green' : 'amber'"
        :solid="false"
      />
    </div>
    <p class="mt-2 text-[15px] leading-relaxed text-ink-soft">
      No dia agendado, o cliente com consentimento recebe a solicitação pelo WhatsApp oficial e envia uma foto por vez,
      na ordem dos tipos acima. A vistoria só é aprovada por uma pessoa da equipe.
    </p>
    <p v-if="data && !data.channel.connected" class="mt-2 text-sm text-[rgb(var(--c-warning))]">{{ data.channel.message }}</p>

    <div v-if="form" class="mt-6 space-y-5">
      <AppCheckbox
        v-model="form.enabled"
        :disabled="!auth.allows('inspections', 'update')"
        label="Solicitar fotos automaticamente pelo WhatsApp"
        description="Vale para novas vistorias de motoristas com consentimento registrado."
        boxed
      />
      <div class="grid gap-5 md:grid-cols-4">
        <FormField v-slot="field" label="Horário do disparo" hint="Fuso de Brasília">
          <AppInput :id="field.id" v-model="form.sendTime" type="time" :disabled="!auth.allows('inspections', 'update')" />
        </FormField>
        <FormField v-slot="field" label="Lembrete após (horas)">
          <AppInput :id="field.id" v-model="form.reminderAfterHours" type="number" min="1" max="168" :disabled="!auth.allows('inspections', 'update')" />
        </FormField>
        <FormField v-slot="field" label="Máximo de lembretes">
          <AppInput :id="field.id" v-model="form.maxReminders" type="number" min="0" max="3" :disabled="!auth.allows('inspections', 'update')" />
        </FormField>
        <FormField v-slot="field" label="Prazo da coleta (horas)">
          <AppInput :id="field.id" v-model="form.collectionTtlHours" type="number" min="6" max="336" :disabled="!auth.allows('inspections', 'update')" />
        </FormField>
      </div>
      <p v-if="data" class="text-sm text-ink-muted">
        Templates aprovados pela Meta em uso: {{ data.templates.request }}, {{ data.templates.reminder }} e
        {{ data.templates.correction }} ({{ data.templates.language }}).
      </p>
      <AppButton v-if="auth.allows('inspections', 'update')" :loading="saving" @click="save">Salvar configuração</AppButton>
    </div>
  </section>
</template>
