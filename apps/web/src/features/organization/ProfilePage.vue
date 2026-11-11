<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { BellOff, Bell, Eye, EyeOff, Lock, Mail, Pencil, Phone, Shield, User } from 'lucide-vue-next';
import { formatDateTimeBR, maskPhone } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import PublicSiteCard from './PublicSiteCard.vue';
import OperationsSettingsCard from './OperationsSettingsCard.vue';
import CreditSettingsCard from '@/features/credit/CreditSettingsCard.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

interface ProfileResponse {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  initials: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  organization: { id: string; name: string };
  browserNotificationsEnabled: boolean;
  createdAt: string;
}

const auth = useAuthStore();
const toasts = useToastStore();

const profile = ref<ProfileResponse | null>(null);
const loading = ref(true);

const editOpen = ref(false);
const editForm = reactive({ name: '', phone: '' });
const editErrors = ref<Record<string, string>>({});
const savingProfile = ref(false);

const passwordForm = reactive({ currentPassword: '', newPassword: '', confirmPassword: '' });
const show = reactive({ current: false, next: false, confirm: false });
const passwordErrors = ref<Record<string, string>>({});
const changingPassword = ref(false);

const roleLabels = { OWNER: 'Proprietário', ADMIN: 'Administrador', MEMBER: 'Colaborador' } as const;

async function load() {
  loading.value = true;
  try {
    profile.value = await api.get<ProfileResponse>('/profile');
  } catch {
    toasts.error('Falha ao carregar o perfil');
  } finally {
    loading.value = false;
  }
}

function openEdit() {
  if (!profile.value) return;
  editForm.name = profile.value.name;
  editForm.phone = profile.value.phone ? maskPhone(profile.value.phone) : '';
  editErrors.value = {};
  editOpen.value = true;
}

async function saveProfile() {
  editErrors.value = {};
  savingProfile.value = true;
  try {
    await api.patch('/profile', { name: editForm.name, phone: editForm.phone || undefined });
    toasts.success('Perfil atualizado');
    editOpen.value = false;
    await Promise.all([load(), auth.load()]);
  } catch (err) {
    if (err instanceof ApiRequestError) {
      editErrors.value = err.fieldErrors();
      if (Object.keys(editErrors.value).length === 0) toasts.error('Não foi possível salvar', err.message);
    } else {
      toasts.error('Não foi possível salvar o perfil');
    }
  } finally {
    savingProfile.value = false;
  }
}

async function toggleBrowserNotifications() {
  if (!profile.value) return;
  const next = !profile.value.browserNotificationsEnabled;
  try {
    if (next && typeof Notification !== 'undefined') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        toasts.warning(
          'Permissão negada pelo navegador',
          'Autorize as notificações nas configurações do site para ativá-las.',
        );
        return;
      }
    }
    await api.patch('/profile/notification-preferences', { browserNotificationsEnabled: next });
    profile.value.browserNotificationsEnabled = next;
    toasts.success(next ? 'Notificações ativadas' : 'Notificações desativadas');
  } catch {
    toasts.error('Não foi possível atualizar a preferência');
  }
}

async function changePassword() {
  passwordErrors.value = {};
  changingPassword.value = true;
  try {
    await api.post('/auth/password/change', { ...passwordForm });
    toasts.success('Senha alterada', 'As demais sessões foram encerradas.');
    passwordForm.currentPassword = '';
    passwordForm.newPassword = '';
    passwordForm.confirmPassword = '';
  } catch (err) {
    if (err instanceof ApiRequestError) {
      passwordErrors.value = err.fieldErrors();
      if (Object.keys(passwordErrors.value).length === 0) {
        toasts.error('Não foi possível alterar a senha', err.message);
      }
    } else {
      toasts.error('Não foi possível alterar a senha');
    }
  } finally {
    changingPassword.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="CONTA"
      title="Meu Perfil"
      subtitle="Gerencie suas informações pessoais e segurança da conta"
    />

    <AppSkeleton v-if="loading" variant="cards" :rows="2" />

    <div v-else-if="profile" class="grid gap-6 xl:grid-cols-2">
      <PublicSiteCard v-if="auth.isOwnerOrAdmin" />
      <OperationsSettingsCard v-if="auth.isOwnerOrAdmin" />
      <CreditSettingsCard v-if="auth.isOwnerOrAdmin" />

      <!-- Informações pessoais -->
      <section class="fo-card p-7">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 class="text-xl font-bold text-ink">Informações Pessoais</h2>
            <p class="mt-1 text-[15px] text-ink-muted">Seus dados cadastrados na plataforma</p>
          </div>
          <AppButton variant="secondary" @click="openEdit">
            <template #icon><Pencil class="size-4" /></template>
            Editar
          </AppButton>
        </div>

        <div class="mt-7 flex items-center gap-5">
          <span
            class="flex size-20 items-center justify-center rounded-full bg-brand-500 text-3xl font-bold text-white"
          >
            {{ profile.initials }}
          </span>
          <div>
            <p class="text-[22px] font-bold text-ink">{{ profile.name }}</p>
            <p class="mt-0.5 text-[17px] text-ink-muted">{{ profile.organization.name }}</p>
            <StatusBadge class="mt-2" :label="roleLabels[profile.role]" tone="green" />
          </div>
        </div>

        <dl class="mt-7 space-y-5">
          <div class="flex items-start gap-3">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted">
              <User class="size-[18px] text-ink-muted" aria-hidden="true" />
            </span>
            <div>
              <dt class="text-sm text-ink-muted">Nome completo</dt>
              <dd class="mt-0.5 text-[17px] font-semibold text-ink">{{ profile.name }}</dd>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted">
              <Mail class="size-[18px] text-ink-muted" aria-hidden="true" />
            </span>
            <div class="min-w-0">
              <dt class="text-sm text-ink-muted">Email</dt>
              <dd class="mt-0.5 break-all text-[17px] font-semibold text-ink">{{ profile.email }}</dd>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted">
              <Phone class="size-[18px] text-ink-muted" aria-hidden="true" />
            </span>
            <div>
              <dt class="text-sm text-ink-muted">Telefone</dt>
              <dd class="mt-0.5 text-[17px] font-semibold tabular text-ink">
                {{ profile.phone ? maskPhone(profile.phone) : '—' }}
              </dd>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <span class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted">
              <Shield class="size-[18px] text-ink-muted" aria-hidden="true" />
            </span>
            <div>
              <dt class="text-sm text-ink-muted">Função</dt>
              <dd class="mt-0.5 text-[17px] font-semibold text-ink">{{ roleLabels[profile.role] }}</dd>
            </div>
          </div>
        </dl>

        <div class="mt-7 rounded-card border border-line p-5">
          <p class="text-sm text-ink-muted">Organização</p>
          <p class="mt-1 text-[17px] font-semibold text-ink">{{ profile.organization.name }}</p>
          <p class="mt-2 text-sm text-ink-muted">
            Conta criada em {{ formatDateTimeBR(profile.createdAt) }}
          </p>
        </div>
      </section>

      <div class="space-y-6">
        <!-- Notificações do navegador -->
        <section class="fo-card p-7">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 class="text-xl font-bold text-ink">Notificações do navegador</h2>
              <p class="mt-1.5 text-[15px] leading-relaxed text-ink-muted">
                Receba alertas de manutenção e CNH mesmo com a aba fechada.
              </p>
            </div>
            <AppButton variant="secondary" @click="toggleBrowserNotifications">
              <template #icon>
                <component
                  :is="profile.browserNotificationsEnabled ? BellOff : Bell"
                  class="size-4"
                />
              </template>
              {{ profile.browserNotificationsEnabled ? 'Desativar' : 'Ativar' }}
            </AppButton>
          </div>
        </section>

        <!-- Segurança -->
        <section class="fo-card p-7">
          <div class="flex items-center gap-4">
            <span class="flex size-11 items-center justify-center rounded-xl bg-brand-50">
              <Shield class="size-5 text-brand-600" aria-hidden="true" />
            </span>
            <div>
              <h2 class="text-xl font-bold text-ink">Segurança</h2>
              <p class="mt-0.5 text-[15px] text-ink-muted">Altere sua senha de acesso</p>
            </div>
          </div>

          <form class="mt-6 space-y-5" novalidate @submit.prevent="changePassword">
            <FormField v-slot="field" label="Senha atual" required :error="passwordErrors.currentPassword">
              <div class="relative">
                <Lock class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
                <AppInput
                  :id="field.id"
                  v-model="passwordForm.currentPassword"
                  :type="show.current ? 'text' : 'password'"
                  class="pl-10 pr-10"
                  placeholder="Digite sua senha atual"
                  autocomplete="current-password"
                  :invalid="field.invalid"
                />
                <button
                  type="button"
                  class="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-ink-muted"
                  :aria-label="show.current ? 'Ocultar senha' : 'Mostrar senha'"
                  @click="show.current = !show.current"
                >
                  <component :is="show.current ? EyeOff : Eye" class="size-[18px]" />
                </button>
              </div>
            </FormField>

            <FormField v-slot="field" label="Nova senha" required :error="passwordErrors.newPassword">
              <div class="relative">
                <Lock class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
                <AppInput
                  :id="field.id"
                  v-model="passwordForm.newPassword"
                  :type="show.next ? 'text' : 'password'"
                  class="pl-10 pr-10"
                  placeholder="Mínimo 8 caracteres"
                  autocomplete="new-password"
                  :invalid="field.invalid"
                />
                <button
                  type="button"
                  class="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-ink-muted"
                  :aria-label="show.next ? 'Ocultar senha' : 'Mostrar senha'"
                  @click="show.next = !show.next"
                >
                  <component :is="show.next ? EyeOff : Eye" class="size-[18px]" />
                </button>
              </div>
            </FormField>

            <FormField
              v-slot="field"
              label="Confirmar nova senha"
              required
              :error="passwordErrors.confirmPassword"
            >
              <div class="relative">
                <Lock class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-muted" />
                <AppInput
                  :id="field.id"
                  v-model="passwordForm.confirmPassword"
                  :type="show.confirm ? 'text' : 'password'"
                  class="pl-10 pr-10"
                  placeholder="Repita a nova senha"
                  autocomplete="new-password"
                  :invalid="field.invalid"
                />
                <button
                  type="button"
                  class="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-ink-muted"
                  :aria-label="show.confirm ? 'Ocultar senha' : 'Mostrar senha'"
                  @click="show.confirm = !show.confirm"
                >
                  <component :is="show.confirm ? EyeOff : Eye" class="size-[18px]" />
                </button>
              </div>
            </FormField>

            <p class="rounded-card bg-surface-muted px-4 py-3 text-sm leading-relaxed text-ink-muted">
              Use uma combinação de letras maiúsculas, minúsculas, números e símbolos para uma senha
              mais segura.
            </p>

            <AppButton type="submit" block :loading="changingPassword">
              <template #icon><Shield class="size-4" /></template>
              Alterar senha
            </AppButton>
          </form>
        </section>
      </div>
    </div>

    <AppModal :open="editOpen" title="Editar perfil" size="sm" @close="editOpen = false">
      <div class="space-y-5">
        <FormField v-slot="field" label="Nome completo" required :error="editErrors.name">
          <AppInput :id="field.id" v-model="editForm.name" :invalid="field.invalid" />
        </FormField>
        <FormField v-slot="field" label="Telefone" :error="editErrors.phone">
          <AppInput :id="field.id" v-model="editForm.phone" inputmode="tel" placeholder="(11) 98765-4321" />
        </FormField>
      </div>
      <template #footer>
        <AppButton variant="secondary" @click="editOpen = false">Cancelar</AppButton>
        <AppButton :loading="savingProfile" @click="saveProfile">Salvar</AppButton>
      </template>
    </AppModal>
  </div>
</template>
