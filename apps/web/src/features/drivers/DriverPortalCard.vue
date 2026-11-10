<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Smartphone } from 'lucide-vue-next';
import { formatDateTimeBR, type DriverPortalAccessResult, type DriverPortalAccessStatus } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/** Acesso do motorista à Área do Motorista: enviar link, ver último acesso, revogar. */
const props = defineProps<{ driverId: string; active: boolean }>();
const auth = useAuthStore();
const toasts = useToastStore();
const status = ref<DriverPortalAccessStatus | null>(null);
const result = ref<DriverPortalAccessResult | null>(null);
const busy = ref(false);
const confirmRevoke = ref(false);

async function load() {
  try {
    status.value = await api.get<DriverPortalAccessStatus>(`/drivers/${props.driverId}/portal-access`);
  } catch {
    status.value = null;
  }
}

async function send() {
  busy.value = true;
  try {
    result.value = await api.post<DriverPortalAccessResult>(`/drivers/${props.driverId}/portal-access`);
    if (result.value.delivered) toasts.success('Link enviado pelo WhatsApp');
    await load();
  } catch (err) {
    toasts.error('Não foi possível gerar o acesso', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    busy.value = false;
  }
}

async function copy() {
  if (!result.value) return;
  await navigator.clipboard.writeText(result.value.link).catch(() => undefined);
  toasts.success('Link copiado');
}

async function revoke() {
  busy.value = true;
  try {
    await api.delete(`/drivers/${props.driverId}/portal-access`);
    result.value = null;
    confirmRevoke.value = false;
    toasts.success('Acesso revogado');
    await load();
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="fo-card p-7 xl:col-span-2" aria-label="Área do Motorista">
    <h2 class="mb-2 flex items-center gap-2.5 text-xl font-bold text-ink">
      <Smartphone class="size-5 text-ink-soft" aria-hidden="true" /> Área do Motorista
    </h2>
    <p class="mb-5 text-[15px] text-ink-muted">
      O motorista acompanha locação, faturas, multas e vistorias pelo celular e pede manutenção. O acesso é por um link pessoal,
      de uso único, válido por 7 dias.
    </p>
    <dl v-if="status" class="mb-5 grid gap-4 sm:grid-cols-3">
      <div>
        <dt class="text-[15px] text-ink-muted">Situação</dt>
        <dd class="mt-1 font-semibold text-ink">{{ status.activeSessions > 0 ? 'Com acesso ativo' : 'Sem acesso' }}</dd>
      </div>
      <div>
        <dt class="text-[15px] text-ink-muted">Último acesso</dt>
        <dd class="mt-1 tabular text-ink">{{ formatDateTimeBR(status.lastAccessAt) }}</dd>
      </div>
      <div>
        <dt class="text-[15px] text-ink-muted">Link pendente</dt>
        <dd class="mt-1 tabular text-ink">{{ status.pendingLinkExpiresAt ? `vale até ${formatDateTimeBR(status.pendingLinkExpiresAt)}` : '—' }}</dd>
      </div>
    </dl>

    <div v-if="result" class="mb-5 space-y-2 rounded-control bg-surface-muted p-4 text-[15px]">
      <p v-if="result.delivered" class="text-ink">Link enviado ao motorista pelo WhatsApp.</p>
      <p v-else class="text-ink-soft">{{ result.error ?? 'O envio automático não está disponível.' }} Envie o link manualmente:</p>
      <p class="break-all font-mono text-sm text-ink">{{ result.link }}</p>
      <div class="flex flex-wrap gap-2">
        <AppButton size="sm" variant="secondary" @click="copy">Copiar link</AppButton>
        <a
          v-if="result.manualLink"
          :href="result.manualLink"
          target="_blank"
          rel="noopener"
          class="inline-flex items-center rounded-control bg-[rgb(var(--c-positive-solid))] px-3 py-1.5 text-sm font-semibold text-white"
        >
          Abrir WhatsApp
        </a>
      </div>
    </div>

    <div v-if="auth.allows('drivers', 'update')" class="flex flex-wrap gap-3">
      <AppButton :disabled="!active" :loading="busy" @click="send">
        {{ status?.activeSessions ? 'Enviar novo link' : 'Enviar acesso' }}
      </AppButton>
      <AppButton v-if="status && (status.activeSessions > 0 || status.pendingLinkExpiresAt)" variant="danger-outline" @click="confirmRevoke = true">
        Revogar acesso
      </AppButton>
    </div>

    <ConfirmDialog
      :open="confirmRevoke"
      title="Revogar acesso"
      message="O motorista sai da Área do Motorista em todos os aparelhos e o link pendente deixa de valer."
      confirm-label="Revogar"
      danger
      :loading="busy"
      @cancel="confirmRevoke = false"
      @confirm="revoke"
    />
  </section>
</template>
