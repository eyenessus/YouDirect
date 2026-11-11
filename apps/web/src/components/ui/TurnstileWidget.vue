<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * Cloudflare Turnstile ("Confirme que você é humano"). Renderização
 * explícita: o script da Cloudflare só é carregado quando a tela usa o
 * widget. O token é de uso único e vale 5 min; `reset()` pede um novo.
 */
interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const props = defineProps<{ siteKey: string; action: string }>();
const emit = defineEmits<{ token: [string | null]; error: [string] }>();
const container = ref<HTMLElement | null>(null);
let widgetId: string | null = null;

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise<TurnstileApi>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SCRIPT_URL;
      script.async = true;
      script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile ausente')));
      script.onerror = () => {
        loading = null;
        script.remove();
        reject(new Error('falha ao carregar'));
      };
      document.head.appendChild(script);
    });
  }
  return loading;
}

async function mountWidget() {
  try {
    const api = await loadScript();
    if (!container.value) return;
    widgetId = api.render(container.value, {
      sitekey: props.siteKey,
      action: props.action,
      theme: 'auto',
      language: 'pt-br',
      size: 'flexible',
      callback: (token: string) => emit('token', token),
      'expired-callback': () => emit('token', null),
      'error-callback': () => {
        emit('token', null);
        emit('error', 'Não foi possível concluir a verificação anti-robô. Recarregue a página.');
      },
    });
  } catch {
    emit('error', 'Não foi possível carregar a verificação anti-robô. Verifique sua conexão e recarregue a página.');
  }
}

/** Pede um token novo (o anterior já foi usado ou expirou). */
function reset() {
  emit('token', null);
  if (widgetId && window.turnstile) window.turnstile.reset(widgetId);
}

defineExpose({ reset });
onMounted(mountWidget);
onBeforeUnmount(() => {
  if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
});
</script>

<template>
  <div ref="container" class="min-h-[65px]" data-testid="turnstile" />
</template>
