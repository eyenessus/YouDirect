<script setup lang="ts">
import { computed, ref } from 'vue';
import { MessageCircle } from 'lucide-vue-next';
import { consentSourceLabels, consentSources, formatDateTimeBR, type ConsentSource, type Driver } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/**
 * Consentimento (opt-in) para mensagens de vistoria pelo WhatsApp —
 * exigido pela política da Meta. Sem ele, a coleta automática não é
 * disparada e a vistoria usa o link manual.
 */
const props = defineProps<{ driver: Driver }>();
const emit = defineEmits<{ updated: [] }>();

const auth = useAuthStore();
const toasts = useToastStore();
const source = ref<ConsentSource>('CONTRACT');
const saving = ref(false);
const confirmRevoke = ref(false);

const consent = computed(() => props.driver.whatsappConsent ?? null);
const granted = computed(() => consent.value?.status === 'GRANTED');
const sourceOptions = consentSources.map((s) => ({ value: s, label: consentSourceLabels[s] }));

async function save(action: 'GRANT' | 'REVOKE') {
  saving.value = true;
  try {
    await api.put(`/drivers/${props.driver.id}/whatsapp-consent`, action === 'GRANT' ? { action, source: source.value } : { action });
    toasts.success(action === 'GRANT' ? 'Consentimento registrado' : 'Consentimento revogado');
    emit('updated');
  } catch (err) {
    toasts.error('Não foi possível salvar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    saving.value = false;
    confirmRevoke.value = false;
  }
}
</script>

<template>
  <section class="fo-card p-7 xl:col-span-2" aria-labelledby="wa-consent-title">
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h2 id="wa-consent-title" class="flex items-center gap-2.5 text-xl font-bold text-ink">
        <MessageCircle class="size-5 text-ink-soft" aria-hidden="true" /> Mensagens de vistoria pelo WhatsApp
      </h2>
      <StatusBadge
        :label="granted ? 'Consentimento ativo' : consent ? 'Consentimento revogado' : 'Sem consentimento'"
        :tone="granted ? 'green' : consent ? 'red' : 'slate'"
        :solid="false"
      />
    </div>

    <p class="text-[15px] leading-relaxed text-ink-soft">
      Com o consentimento registrado, a vistoria agendada é solicitada automaticamente pelo WhatsApp oficial da
      locadora, com instruções para cada foto. O cliente pode cancelar a qualquer momento respondendo
      <strong>SAIR</strong>.
    </p>

    <dl v-if="consent" class="mt-5 grid gap-x-8 gap-y-4 sm:grid-cols-3">
      <div>
        <dt class="text-[15px] text-ink-muted">Registrado em</dt>
        <dd class="mt-1 text-[17px] font-semibold tabular text-ink">{{ formatDateTimeBR(consent.grantedAt) }}</dd>
      </div>
      <div>
        <dt class="text-[15px] text-ink-muted">Origem</dt>
        <dd class="mt-1 text-[17px] font-semibold text-ink">{{ consent.source ? consentSourceLabels[consent.source] : '—' }}</dd>
      </div>
      <div v-if="consent.revokedAt">
        <dt class="text-[15px] text-ink-muted">Revogado em</dt>
        <dd class="mt-1 text-[17px] font-semibold tabular text-ink">
          {{ formatDateTimeBR(consent.revokedAt) }}
          <span class="block text-sm font-normal text-ink-muted">
            {{ consent.revokedSource === 'WHATSAPP_STOP' ? 'pelo cliente no WhatsApp' : 'pela equipe' }}
          </span>
        </dd>
      </div>
    </dl>

    <div v-if="auth.allows('drivers', 'update')" class="mt-6 flex flex-wrap items-end gap-4">
      <template v-if="!granted">
        <FormField v-slot="field" label="Como o cliente autorizou" class="w-full sm:w-72">
          <AppSelect :id="field.id" v-model="source" :options="sourceOptions" />
        </FormField>
        <AppButton :loading="saving" @click="save('GRANT')">Registrar consentimento</AppButton>
      </template>
      <AppButton v-else variant="danger-outline" :loading="saving" @click="confirmRevoke = true">
        Revogar consentimento
      </AppButton>
    </div>

    <ConfirmDialog
      :open="confirmRevoke"
      title="Revogar consentimento"
      message="O cliente deixará de receber solicitações de vistoria pelo WhatsApp. Vistorias futuras usarão o link manual."
      confirm-label="Revogar"
      danger
      @confirm="save('REVOKE')"
      @cancel="confirmRevoke = false"
    />
  </section>
</template>
