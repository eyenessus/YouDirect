<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { CheckCircle2, FileUp } from 'lucide-vue-next';
import { formatIsoDateBR } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import { api, ApiRequestError, uploadDriverFile } from '@/lib/api';
import { useToastStore } from '@/stores/ui';
import { portalPost, usePortal } from './usePortal';

const portal = usePortal();
const router = useRouter();
const toasts = useToastStore();
const busy = ref<string | null>(null);

const docs = [
  { kind: 'CNH', purpose: 'DRIVER_ID', label: 'CNH (frente e verso ou digital)', has: () => portal.state.me?.driver.hasIdDocument },
  { kind: 'ADDRESS_PROOF', purpose: 'DRIVER_ADDRESS_PROOF', label: 'Comprovante de residência', has: () => portal.state.me?.driver.hasAddressProof },
] as const;

async function onFile(doc: (typeof docs)[number], event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  busy.value = doc.kind;
  try {
    const up = await uploadDriverFile(file, doc.purpose);
    await portalPost('/driver/documents', { kind: doc.kind, fileId: up.id });
    await portal.load(true);
    toasts.success('Documento enviado');
  } catch (err) {
    toasts.error('Não foi possível enviar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    busy.value = null;
    input.value = '';
  }
}

async function logout() {
  await api.post('/driver/logout').catch(() => undefined);
  portal.reset();
  await router.replace('/motorista/sem-acesso');
}
</script>

<template>
  <div v-if="portal.state.me" class="space-y-4">
    <h1 class="text-xl font-bold text-ink">Minha conta</h1>
    <section class="fo-card p-5">
      <dl class="space-y-3 text-[15px]">
        <div>
          <dt class="text-ink-muted">Nome</dt>
          <dd class="font-semibold text-ink">{{ portal.state.me.driver.fullName }}</dd>
        </div>
        <div>
          <dt class="text-ink-muted">Telefone</dt>
          <dd class="text-ink">{{ portal.state.me.driver.phone }}</dd>
        </div>
        <div>
          <dt class="text-ink-muted">Validade da CNH</dt>
          <dd class="text-ink">{{ formatIsoDateBR(portal.state.me.driver.cnhExpiresAt) }}</dd>
        </div>
      </dl>
      <p class="mt-4 text-sm text-ink-muted">Algum dado errado? Fale com a locadora para corrigir.</p>
    </section>

    <section class="fo-card space-y-3 p-5" aria-label="Documentos">
      <h2 class="text-lg font-bold text-ink">Documentos</h2>
      <div v-for="d in docs" :key="d.kind" class="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0">
        <div class="flex items-center gap-2">
          <CheckCircle2 v-if="d.has()" class="size-5 text-[rgb(var(--c-positive))]" aria-hidden="true" />
          <FileUp v-else class="size-5 text-ink-muted" aria-hidden="true" />
          <span class="text-[15px] text-ink">{{ d.label }}</span>
        </div>
        <label class="cursor-pointer text-sm font-semibold text-brand-600">
          <input type="file" accept="image/*,application/pdf" class="sr-only" :disabled="busy !== null" @change="onFile(d, $event)" />
          {{ busy === d.kind ? 'Enviando…' : d.has() ? 'Atualizar' : 'Enviar' }}
        </label>
      </div>
    </section>

    <AppButton variant="secondary" block @click="logout">Sair</AppButton>
  </div>
</template>
