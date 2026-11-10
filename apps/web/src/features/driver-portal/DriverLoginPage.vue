<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiRequestError } from '@/lib/api';
import { usePortal } from './usePortal';

/**
 * Abre a sessão a partir do link enviado pela locadora. A troca é um POST
 * (pré-visualizações de link do WhatsApp só fazem GET e não "gastam" o link).
 */
const route = useRoute();
const router = useRouter();
const portal = usePortal();
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    await api.post('/driver/login', { token: route.params.token });
    portal.reset();
    await router.replace('/motorista');
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Não foi possível entrar.';
  }
});
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-canvas px-5">
    <section class="fo-card w-full max-w-md p-7 text-center">
      <h1 class="text-xl font-bold text-ink">Área do Motorista</h1>
      <p v-if="!error" class="mt-3 text-[15px] text-ink-muted">Entrando…</p>
      <template v-else>
        <p class="mt-3 text-[15px] text-ink-soft">{{ error }}</p>
        <p class="mt-2 text-sm text-ink-muted">Se você já entrou por este link antes, abra a Área do Motorista direto:</p>
        <RouterLink to="/motorista" class="mt-4 inline-block font-semibold text-brand-600 hover:underline">Ir para a Área do Motorista</RouterLink>
      </template>
    </section>
  </div>
</template>
