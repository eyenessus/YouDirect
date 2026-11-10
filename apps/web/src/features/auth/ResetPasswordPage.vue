<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { MIN_PASSWORD_LENGTH } from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';

/** [R] Nova senha a partir do link enviado por e-mail (uso único, 1 hora). */
const route = useRoute();
const router = useRouter();
const token = String(route.params.token ?? '');

const password = ref('');
const confirmPassword = ref('');
const loading = ref(false);
const done = ref(false);
const error = ref('');
const fieldErrors = ref<Record<string, string>>({});

async function submit() {
  error.value = '';
  fieldErrors.value = {};
  loading.value = true;
  try {
    await api.post('/auth/password/reset', {
      token,
      password: password.value,
      confirmPassword: confirmPassword.value,
    });
    done.value = true;
    setTimeout(() => void router.replace('/login'), 2500);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      fieldErrors.value = err.fieldErrors();
      error.value = Object.keys(fieldErrors.value).length ? '' : err.message;
    } else {
      error.value = 'Não foi possível redefinir. Tente novamente.';
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-canvas p-6 sm:p-10">
    <div class="w-full max-w-md">
      <div class="mb-8 flex items-center gap-3">
        <span class="flex size-11 items-center justify-center rounded-xl bg-sidebar">
          <img src="/brand/yudirect-mark-white.png" alt="" class="size-7 object-contain" />
        </span>
        <span class="text-xl font-bold text-ink">YuDirect</span>
      </div>

      <h1 class="text-[28px] font-bold text-ink">Nova senha</h1>

      <p v-if="done" class="mt-6 text-[17px] text-ink" role="status">
        Senha alterada. Por segurança, todas as sessões abertas foram encerradas — entre novamente com a nova senha.
      </p>

      <form v-else class="mt-7 space-y-5" novalidate @submit.prevent="submit">
        <FormField
          v-slot="field"
          label="Nova senha"
          required
          :error="fieldErrors.password"
          :hint="`Mínimo de ${MIN_PASSWORD_LENGTH} caracteres; evite senhas óbvias.`"
        >
          <AppInput
            :id="field.id"
            v-model="password"
            type="password"
            autocomplete="new-password"
            :invalid="Boolean(fieldErrors.password)"
          />
        </FormField>
        <FormField v-slot="field" label="Confirme a nova senha" required :error="fieldErrors.confirmPassword">
          <AppInput
            :id="field.id"
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            :invalid="Boolean(fieldErrors.confirmPassword)"
          />
        </FormField>
        <p v-if="error" class="text-sm text-negative" role="alert">
          {{ error }}
          <RouterLink to="/esqueci-a-senha" class="ml-1 font-medium underline">Pedir novo link</RouterLink>
        </p>
        <AppButton type="submit" block size="lg" :loading="loading">Salvar nova senha</AppButton>
      </form>

      <p class="mt-8 text-center text-sm">
        <RouterLink to="/login" class="font-medium text-brand-600 hover:underline">Voltar para o login</RouterLink>
      </p>
    </div>
  </div>
</template>
