<script setup lang="ts">
import AuthShell from './AuthShell.vue';
import { ref } from 'vue';
import { RouterLink } from 'vue-router';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';

/** [R] "Esqueci a senha" — a resposta é sempre a mesma (não revela se o e-mail existe). */
const email = ref('');
const loading = ref(false);
const sent = ref(false);
const error = ref('');

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    await api.post('/auth/password/forgot', { email: email.value.trim() });
    sent.value = true;
  } catch (err) {
    error.value = err instanceof ApiRequestError ? err.message : 'Não foi possível enviar. Tente novamente.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <AuthShell>
    <h1 class="text-[28px] font-bold text-ink">Esqueci a senha</h1>

    <div v-if="sent" class="mt-6 space-y-4" role="status">
      <p class="text-[17px] leading-relaxed text-ink">
        Se <strong>{{ email }}</strong> estiver cadastrado, você receberá em instantes um e-mail com o link para
        criar uma nova senha. O link vale por 1 hora.
      </p>
      <p class="text-sm text-ink-muted">Não chegou? Confira a caixa de spam ou peça de novo em alguns minutos.</p>
    </div>

    <form v-else class="mt-7 space-y-5" novalidate @submit.prevent="submit">
      <p class="text-[17px] text-ink-muted">Informe o e-mail da sua conta para receber o link de redefinição.</p>
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
      <p v-if="error" class="text-sm text-negative" role="alert">{{ error }}</p>
      <AppButton type="submit" block size="lg" :loading="loading" :disabled="!email.trim()">Enviar link</AppButton>
    </form>

    <p class="mt-8 text-center text-sm">
      <RouterLink to="/login" class="font-medium text-brand-600 hover:underline">Voltar para o login</RouterLink>
    </p>
  </AuthShell>
</template>
