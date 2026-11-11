<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { Eye, EyeOff } from 'lucide-vue-next';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import FormField from '@/components/ui/FormField.vue';
import LoginShowroom from './LoginShowroom.vue';
import TurnstileWidget from '@/components/ui/TurnstileWidget.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';

/**
 * [R] Tela de acesso — NÃO existe captura de referência para login.
 * Construída a partir dos mesmos tokens visuais do restante do produto
 * e marcada como acréscimo em docs/ASSUMPTIONS.md (A-UI-01).
 */
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const email = ref('');
const password = ref('');
const showPassword = ref(false);
const loading = ref(false);
const error = ref('');
const expired = ref(false);

/** Anti-robô (Cloudflare Turnstile): só aparece quando o servidor tem as chaves. */
const captcha = ref<{ siteKey: string; action: string } | null>(null);
const captchaToken = ref<string | null>(null);
const captchaError = ref('');
const widget = ref<InstanceType<typeof TurnstileWidget> | null>(null);

onMounted(async () => {
  expired.value = route.query.expired === '1';
  try {
    const config = await api.get<{ captcha: { siteKey: string; action: string } | null }>('/auth/login-config');
    captcha.value = config.captcha;
  } catch {
    captcha.value = null; // o servidor recusa o login se exigir o desafio
  }
});

function onCaptchaToken(token: string | null) {
  captchaToken.value = token;
  if (token) captchaError.value = '';
}

async function submit() {
  error.value = '';
  if (captcha.value && !captchaToken.value) {
    error.value = 'Confirme a verificação anti-robô antes de entrar.';
    return;
  }
  loading.value = true;
  try {
    await auth.login(email.value, password.value, captchaToken.value);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
    await router.replace(redirect);
  } catch (err) {
    error.value =
      err instanceof ApiRequestError ? err.message : 'Não foi possível entrar. Tente novamente.';
    // O token do Turnstile é de uso único: depois de uma tentativa recusada, pede outro.
    if (captcha.value) widget.value?.reset();
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="grid min-h-screen lg:grid-cols-[1fr_minmax(420px,520px)]">
    <!-- Faixa de marca (celular) -->
    <div class="relative h-56 overflow-hidden bg-[#0a0b10] lg:hidden">
      <LoginShowroom compact />
      <div class="relative z-10 flex items-center gap-3 p-6">
        <span class="flex size-11 items-center justify-center rounded-xl border border-white/15 bg-white/10 backdrop-blur">
          <img src="/brand/yudirect-mark-white.png" alt="" class="size-7 object-contain" />
        </span>
        <span class="text-xl font-bold text-white">YuDirect</span>
      </div>
    </div>

    <!-- Painel de marca -->
    <div class="relative hidden min-h-screen flex-col overflow-hidden bg-[#0a0b10] p-12 text-white lg:flex">
      <LoginShowroom />
      <div class="relative z-10 flex items-center gap-3">
        <span class="flex size-12 items-center justify-center rounded-xl border border-white/15 bg-white/10 shadow-lg backdrop-blur">
          <img src="/brand/yudirect-mark-white.png" alt="" class="size-8 object-contain" />
        </span>
        <span class="text-2xl font-bold tracking-tight">YuDirect</span>
      </div>
      <div class="relative z-10 mt-[11vh] max-w-lg">
        <h1 class="text-5xl font-bold leading-[1.08] tracking-tight">
          Gestão completa da sua
          <span class="bg-gradient-to-r from-[#ff4d3d] to-[#d40000] bg-clip-text text-transparent">frota.</span>
        </h1>
        <p class="mt-5 text-lg leading-relaxed text-white/75">
          Veículos, motoristas, locações, vistorias, manutenções e financeiro — em um só lugar.
        </p>
      </div>
      <p class="relative z-10 mt-auto text-sm text-white/55">© {{ new Date().getFullYear() }} YuDirect · Gestão veicular</p>
    </div>

    <!-- Formulário -->
    <div class="flex items-center justify-center bg-canvas p-6 sm:p-10">
      <div class="w-full max-w-md">
        <h2 class="text-[28px] font-bold text-ink">Entrar</h2>
        <p class="mt-1.5 text-[17px] text-ink-muted">Acesse o painel da sua organização.</p>

        <div
          v-if="expired"
          class="mt-6 rounded-card border border-[rgb(var(--c-warning)/0.3)] bg-[rgb(var(--c-warning)/0.1)] px-4 py-3 text-sm text-ink"
          role="status"
        >
          Sua sessão expirou. Entre novamente para continuar.
        </div>

        <form class="mt-7 space-y-5" novalidate @submit.prevent="submit">
          <FormField v-slot="field" label="E-mail" required>
            <AppInput
              :id="field.id"
              v-model="email"
              type="email"
              autocomplete="username"
              placeholder="voce@empresa.com.br"
              :invalid="Boolean(error)"
            />
          </FormField>

          <FormField v-slot="field" label="Senha" required>
            <div class="relative">
              <AppInput
                :id="field.id"
                v-model="password"
                :type="showPassword ? 'text' : 'password'"
                autocomplete="current-password"
                placeholder="Sua senha"
                :invalid="Boolean(error)"
              />
              <button
                type="button"
                class="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 text-ink-muted transition-colors hover:text-ink"
                :aria-label="showPassword ? 'Ocultar senha' : 'Mostrar senha'"
                @click="showPassword = !showPassword"
              >
                <EyeOff v-if="showPassword" class="size-[18px]" />
                <Eye v-else class="size-[18px]" />
              </button>
            </div>
          </FormField>

          <TurnstileWidget
            v-if="captcha"
            ref="widget"
            :site-key="captcha.siteKey"
            :action="captcha.action"
            @token="onCaptchaToken"
            @error="(m: string) => (captchaError = m)"
          />
          <p v-if="captchaError" class="text-sm text-negative" role="alert">{{ captchaError }}</p>

          <p v-if="error" class="text-sm text-negative" role="alert">{{ error }}</p>

          <div class="-mt-2 text-right">
            <RouterLink to="/esqueci-a-senha" class="text-sm font-medium text-brand-600 hover:underline">
              Esqueci a senha
            </RouterLink>
          </div>

          <AppButton type="submit" block size="lg" :loading="loading" :disabled="Boolean(captcha) && !captchaToken">Entrar</AppButton>
        </form>

        <p class="mt-8 text-center text-sm leading-relaxed text-ink-muted">
          Problemas para acessar? Fale com o proprietário da organização para receber um novo convite.
        </p>
      </div>
    </div>
  </div>
</template>
