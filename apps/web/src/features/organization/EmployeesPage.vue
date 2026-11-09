<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ChevronDown, ChevronRight, DollarSign, MailCheck, Trash2, Users } from 'lucide-vue-next';
import {
  formatCentsBRL,
  invitationStatusLabels,
  membershipRoleLabels,
  moduleActions,
  permissionActionLabels,
  permissionModuleLabels,
  permissionModules,
  type EmployeesOverview,
  type PermissionAction,
  type PermissionMatrix,
  type PermissionModule,
} from '@frotaone/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import AppTabs, { type TabItem } from '@/components/ui/AppTabs.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

const toasts = useToastStore();

const overview = ref<EmployeesOverview | null>(null);
const loading = ref(true);
const tab = ref<'members' | 'invites'>('members');

const modalOpen = ref(false);
const form = reactive({ name: '', email: '', phone: '' });
const matrix = ref<PermissionMatrix>({});
const expandedModules = ref<Set<string>>(new Set());
const errors = ref<Record<string, string>>({});
const saving = ref(false);
const inviteLink = ref<string | null>(null);
const removeTarget = ref<{ id: string; name: string } | null>(null);

const tabs = computed<TabItem[]>(() => [
  { key: 'members', label: 'Colaboradores', badge: overview.value?.memberships.length },
  { key: 'invites', label: 'Convites', badge: overview.value?.invitations.length },
]);

async function load() {
  loading.value = true;
  try {
    overview.value = await api.get<EmployeesOverview>('/employees');
  } catch {
    toasts.error('Falha ao carregar colaboradores');
  } finally {
    loading.value = false;
  }
}

function openModal() {
  modalOpen.value = true;
  form.name = '';
  form.email = '';
  form.phone = '';
  matrix.value = { dashboard: ['read'] };
  expandedModules.value = new Set();
  errors.value = {};
  inviteLink.value = null;
}

function isModuleEnabled(mod: PermissionModule): boolean {
  return (matrix.value[mod]?.length ?? 0) > 0;
}

function toggleModule(mod: PermissionModule) {
  const next = { ...matrix.value };
  if (isModuleEnabled(mod)) delete next[mod];
  else next[mod] = ['read'];
  matrix.value = next;
}

function hasAction(mod: PermissionModule, action: PermissionAction): boolean {
  return matrix.value[mod]?.includes(action) ?? false;
}

function toggleAction(mod: PermissionModule, action: PermissionAction) {
  const current = new Set(matrix.value[mod] ?? []);
  if (current.has(action)) current.delete(action);
  else current.add(action);
  current.add('read');
  matrix.value = { ...matrix.value, [mod]: [...current] as PermissionAction[] };
}

function toggleExpand(mod: string) {
  const next = new Set(expandedModules.value);
  if (next.has(mod)) next.delete(mod);
  else next.add(mod);
  expandedModules.value = next;
}

function selectAll() {
  const next: PermissionMatrix = {};
  for (const mod of permissionModules) next[mod] = [...moduleActions[mod]];
  matrix.value = next;
}

function clearAll() {
  matrix.value = {};
}

async function submit() {
  errors.value = {};
  saving.value = true;
  try {
    const invitation = await api.post<{ acceptUrl: string | null; delivery: { status: string } | null }>(
      '/invitations',
      {
        name: form.name,
        email: form.email,
        phone: form.phone || undefined,
        permissions: matrix.value,
      },
    );
    await load();
    if (invitation.delivery?.status === 'SENT') {
      toasts.success('Convite enviado por e-mail');
      modalOpen.value = false;
    } else {
      // Sem provedor de e-mail: entregamos o link para envio manual.
      inviteLink.value = invitation.acceptUrl;
      toasts.warning(
        'Convite criado, mas não enviado por e-mail',
        'Compartilhe o link exibido com o colaborador.',
      );
    }
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      if (Object.keys(errors.value).length === 0) toasts.error('Não foi possível convidar', err.message);
    } else {
      toasts.error('Não foi possível convidar');
    }
  } finally {
    saving.value = false;
  }
}

async function removeMember() {
  if (!removeTarget.value) return;
  try {
    await api.delete(`/memberships/${removeTarget.value.id}`);
    toasts.success('Colaborador removido');
    removeTarget.value = null;
    await load();
  } catch (err) {
    toasts.error('Não foi possível remover', err instanceof ApiRequestError ? err.message : undefined);
  }
}

async function revokeInvite(id: string) {
  try {
    await api.delete(`/invitations/${id}`);
    toasts.success('Convite revogado');
    await load();
  } catch {
    toasts.error('Não foi possível revogar o convite');
  }
}

async function copyLink() {
  if (!inviteLink.value) return;
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    toasts.success('Link copiado');
  } catch {
    toasts.info('Copie o link manualmente', inviteLink.value);
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="ORGANIZAÇÃO"
      title="Colaboradores"
      subtitle="Gerencie os usuários da sua organização e defina quais áreas eles podem acessar."
    >
      <template #actions>
        <AppButton @click="openModal">
          <template #icon><span class="text-lg leading-none">+</span></template>
          Adicionar colaborador
        </AppButton>
      </template>
    </PageHeader>

    <div
      v-if="overview"
      class="flex items-center gap-3 rounded-card border border-brand-100 bg-brand-50 px-5 py-4"
    >
      <DollarSign class="size-5 shrink-0 text-brand-600" aria-hidden="true" />
      <p class="text-[17px] text-ink">
        {{ overview.freeSeats }} colaboradores grátis. Do {{ overview.freeSeats + 1 }}º em diante:
        <strong>{{ formatCentsBRL(overview.extraSeatPriceCents) }} /mês</strong> por colaborador.
      </p>
    </div>

    <AppTabs :model-value="tab" :items="tabs" @update:model-value="tab = $event as 'members' | 'invites'" />

    <AppSkeleton v-if="loading" variant="table" />

    <section v-else class="fo-card">
      <!-- Colaboradores -->
      <template v-if="tab === 'members'">
        <EmptyState
          v-if="overview?.memberships.length === 0"
          :icon="Users"
          message="Nenhum colaborador cadastrado. Adicione colaboradores para compartilhar o acesso à sua organização."
        >
          <AppButton @click="openModal">
            <template #icon><span class="text-lg leading-none">+</span></template>
            Adicionar colaborador
          </AppButton>
        </EmptyState>

        <ul v-else class="divide-y divide-line">
          <li
            v-for="member in overview?.memberships ?? []"
            :key="member.id"
            class="flex flex-wrap items-center justify-between gap-4 p-6"
          >
            <div class="min-w-0">
              <p class="text-[17px] font-semibold text-ink">{{ member.user.name }}</p>
              <p class="mt-0.5 text-[15px] text-ink-muted">{{ member.user.email }}</p>
              <p class="mt-2 flex flex-wrap gap-1.5">
                <span
                  v-for="(actions, mod) in member.permissions"
                  :key="mod"
                  class="rounded-md border border-line bg-surface-muted px-2 py-0.5 text-xs text-ink-soft"
                >
                  {{ permissionModuleLabels[mod as PermissionModule] }} ({{ actions?.length ?? 0 }})
                </span>
              </p>
            </div>
            <div class="flex items-center gap-3">
              <StatusBadge :label="membershipRoleLabels[member.role]" tone="slate" :solid="false" />
              <AppButton
                variant="ghost"
                :aria-label="`Remover ${member.user.name}`"
                @click="removeTarget = { id: member.id, name: member.user.name }"
              >
                <template #icon><Trash2 class="size-4 text-negative" /></template>
              </AppButton>
            </div>
          </li>
        </ul>
      </template>

      <!-- Convites -->
      <template v-else>
        <EmptyState
          v-if="overview?.invitations.length === 0"
          :icon="MailCheck"
          message="Nenhum convite enviado ainda. Ao adicionar um colaborador, o convite aparecerá aqui com o status de acompanhamento."
        />

        <ul v-else class="divide-y divide-line">
          <li
            v-for="invite in overview?.invitations ?? []"
            :key="invite.id"
            class="flex flex-wrap items-center justify-between gap-4 p-6"
          >
            <div class="min-w-0">
              <p class="text-[17px] font-semibold text-ink">{{ invite.name }}</p>
              <p class="mt-0.5 text-[15px] text-ink-muted">{{ invite.email }}</p>
              <p class="mt-1 text-sm text-ink-muted">
                Expira em {{ new Date(invite.expiresAt).toLocaleDateString('pt-BR') }}
                <span v-if="invite.delivery && invite.delivery.status !== 'SENT'">
                  · envio por e-mail indisponível
                </span>
              </p>
            </div>
            <div class="flex items-center gap-3">
              <StatusBadge
                :label="invitationStatusLabels[invite.status]"
                :tone="invite.status === 'PENDING' ? 'amber' : 'slate'"
                :solid="false"
              />
              <AppButton v-if="invite.status === 'PENDING'" variant="ghost" @click="revokeInvite(invite.id)">
                Revogar
              </AppButton>
            </div>
          </li>
        </ul>
      </template>
    </section>

    <!-- Modal -->
    <AppModal
      :open="modalOpen"
      title="Adicionar colaborador"
      description="Defina os dados e as áreas que este colaborador poderá acessar."
      size="lg"
      @close="modalOpen = false"
    >
      <div v-if="inviteLink" class="space-y-4">
        <div class="rounded-card border border-[rgb(var(--c-warning)/0.3)] bg-[rgb(var(--c-warning)/0.08)] p-4">
          <p class="text-[15px] font-semibold text-ink">Envio de e-mail indisponível</p>
          <p class="mt-1.5 text-sm leading-relaxed text-ink-soft">
            O convite foi criado. Compartilhe o link abaixo com o colaborador — ele expira em 7 dias.
          </p>
        </div>
        <div class="flex gap-2">
          <input class="fo-control" :value="inviteLink" readonly aria-label="Link do convite" />
          <AppButton variant="secondary" @click="copyLink">Copiar</AppButton>
        </div>
      </div>

      <div v-else class="space-y-5">
        <div class="grid gap-5 sm:grid-cols-2">
          <FormField v-slot="field" label="Nome" required :error="errors.name">
            <AppInput :id="field.id" v-model="form.name" placeholder="João Silva" :invalid="field.invalid" />
          </FormField>
          <FormField v-slot="field" label="E-mail" required :error="errors.email">
            <AppInput
              :id="field.id"
              v-model="form.email"
              type="email"
              placeholder="joao@email.com"
              :invalid="field.invalid"
            />
          </FormField>
        </div>

        <FormField v-slot="field" label="Telefone (opcional)" :error="errors.phone">
          <AppInput :id="field.id" v-model="form.phone" placeholder="11999999999" inputmode="tel" />
        </FormField>

        <div>
          <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
            <span class="fo-label mb-0">Permissões de acesso</span>
            <span class="flex gap-5">
              <button
                type="button"
                class="text-[15px] font-medium text-ink transition-colors hover:text-brand-600"
                @click="selectAll"
              >
                Selecionar tudo
              </button>
              <button
                type="button"
                class="text-[15px] font-medium text-ink transition-colors hover:text-brand-600"
                @click="clearAll"
              >
                Limpar tudo
              </button>
            </span>
          </div>

          <ul class="divide-y divide-line rounded-card border border-line">
            <li v-for="mod in permissionModules" :key="mod">
              <div class="flex items-center justify-between gap-3 px-4 py-3.5">
                <label class="flex min-w-0 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    class="size-[18px] accent-[rgb(var(--c-brand-500))]"
                    :checked="isModuleEnabled(mod)"
                    @change="toggleModule(mod)"
                  />
                  <span class="text-[15px] text-ink">{{ permissionModuleLabels[mod] }}</span>
                </label>
                <button
                  v-if="moduleActions[mod].length > 1"
                  type="button"
                  class="inline-flex items-center gap-1 text-sm text-ink-muted transition-colors hover:text-ink"
                  :aria-expanded="expandedModules.has(mod)"
                  @click="toggleExpand(mod)"
                >
                  <component
                    :is="expandedModules.has(mod) ? ChevronDown : ChevronRight"
                    class="size-4"
                    aria-hidden="true"
                  />
                  Ações
                </button>
              </div>

              <div
                v-if="expandedModules.has(mod) && isModuleEnabled(mod)"
                class="flex flex-wrap gap-4 border-t border-line bg-surface-muted/50 px-4 py-3"
              >
                <label
                  v-for="action in moduleActions[mod]"
                  :key="action"
                  class="flex cursor-pointer items-center gap-2 text-sm text-ink"
                >
                  <input
                    type="checkbox"
                    class="size-4 accent-[rgb(var(--c-brand-500))]"
                    :checked="hasAction(mod, action)"
                    :disabled="action === 'read'"
                    @change="toggleAction(mod, action)"
                  />
                  {{ permissionActionLabels[action] }}
                </label>
              </div>
            </li>
          </ul>
        </div>
      </div>

      <template #footer>
        <AppButton variant="secondary" @click="modalOpen = false">
          {{ inviteLink ? 'Fechar' : 'Cancelar' }}
        </AppButton>
        <AppButton v-if="!inviteLink" :loading="saving" @click="submit">Enviar convite</AppButton>
      </template>
    </AppModal>

    <ConfirmDialog
      :open="removeTarget !== null"
      title="Remover colaborador"
      :message="`Remover ${removeTarget?.name ?? ''} da organização? As sessões ativas serão encerradas imediatamente.`"
      confirm-label="Remover"
      danger
      @cancel="removeTarget = null"
      @confirm="removeMember"
    />
  </div>
</template>
