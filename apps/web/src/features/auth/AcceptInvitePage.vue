<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';

/** [R] Tela de aceite de convite — não há captura de referência. */
interface InvitePreview {
  name: string;
  email: string;
  organizationName: string;
  expiresAt: string;
}

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const token = String(route.params.token ?? '');
const preview = ref<InvitePreview | null>(null);
const loadError = ref('');
const loading = ref(true);

const name = ref('');
const password = ref('');
const confirmPassword = ref('');
const submitting = ref(false);
const fieldErrors = ref<Record<string, string>>({});
const formError = ref('');

onMounted(async () => {
  try {
    preview.value = await api.get<InvitePreview>(`/invitations/${token}`);
    name.value = preview.value.name;
  } catch (err) {
    loadError.value =
      err instanceof ApiRequestError ? err.message : 'Convite inválido ou expirado.';
  } finally {
    loading.value = false;
  }
});

async function submit() {
  fieldErrors.value = {};
  formError.value = '';
  submitting.value = true;
  try {
    await api.post('/invitations/accept', {
      token,
      name: name.value,
      password: password.value,
      confirmPassword: confirmPassword.value,
    });
    await auth.load();
    await router.replace('/dashboard');
  } catch (err) {
    if (err instanceof ApiRequestError) {
      fieldErrors.value = err.fieldErrors();
      if (Object.keys(fieldErrors.value).length === 0) formError.value = err.message;
    } else {
      formError.value = 'Não foi possível concluir o convite.';
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-screen items-center justify-center bg-canvas p-6">
    <div class="w-full max-w-md">
      <div class="mb-8 flex items-center gap-3">
        <span class="flex size-11 items-center justify-center rounded-xl bg-sidebar">
          <img src="/brand/yudirect-mark-white.png" alt="" class="size-7 object-contain" />
        </span>
        <span class="text-xl font-bold text-ink">YuDirect</span>
      </div>

      <div class="fo-card p-7">
        <p v-if="loading" class="text-[15px] text-ink-muted">Carregando convite…</p>

        <template v-else-if="loadError">
          <h1 class="text-2xl font-bold text-ink">Convite indisponível</h1>
          <p class="mt-2 text-[15px] leading-relaxed text-ink-muted">{{ loadError }}</p>
          <AppButton class="mt-6" variant="secondary" @click="router.replace({ name: 'login' })">
            Ir para o login
          </AppButton>
        </template>

        <template v-else>
          <h1 class="text-2xl font-bold text-ink">Você foi convidado(a)</h1>
          <p class="mt-2 text-[15px] leading-relaxed text-ink-muted">
            Crie sua senha para acessar o YuDirect da
            <strong class="text-ink">{{ preview?.organizationName }}</strong
            >.
          </p>

          <form class="mt-6 space-y-5" novalidate @submit.prevent="submit">
            <FormField v-slot="field" label="E-mail">
              <AppInput :id="field.id" :model-value="preview?.email" readonly disabled />
            </FormField>

            <FormField v-slot="field" label="Nome completo" required :error="fieldErrors.name">
              <AppInput :id="field.id" v-model="name" :invalid="Boolean(fieldErrors.name)" />
            </FormField>

            <FormField
              v-slot="field"
              label="Senha"
              required
              hint="Mínimo 6 caracteres"
              :error="fieldErrors.password"
            >
              <AppInput
                :id="field.id"
                v-model="password"
                type="password"
                autocomplete="new-password"
                :invalid="Boolean(fieldErrors.password)"
              />
            </FormField>

            <FormField
              v-slot="field"
              label="Confirmar senha"
              required
              :error="fieldErrors.confirmPassword"
            >
              <AppInput
                :id="field.id"
                v-model="confirmPassword"
                type="password"
                autocomplete="new-password"
                :invalid="Boolean(fieldErrors.confirmPassword)"
              />
            </FormField>

            <p v-if="formError" class="text-sm text-negative" role="alert">{{ formError }}</p>

            <AppButton type="submit" block size="lg" :loading="submitting">Aceitar convite</AppButton>
          </form>
        </template>
      </div>
    </div>
  </div>
</template>
