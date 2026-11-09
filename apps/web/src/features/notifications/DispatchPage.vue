<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { AlertTriangle, History, Plus, Save, Send, Trash2 } from 'lucide-vue-next';
import {
  maskPhone,
  renderMessage,
  type Dispatch,
  type Driver,
  type MessageTemplate,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppTextarea from '@/components/ui/AppTextarea.vue';
import ConfirmDialog from '@/components/ui/ConfirmDialog.vue';
import SearchInput from '@/components/ui/SearchInput.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

const auth = useAuthStore();
const toasts = useToastStore();

const templates = ref<MessageTemplate[]>([]);
const drivers = ref<Driver[]>([]);
const selectedTemplateId = ref('');
const templateName = ref('');
const body = ref('');
const search = ref('');
const selected = ref<Set<string>>(new Set());
const sending = ref(false);
const savingTemplate = ref(false);
const confirmSend = ref(false);
const confirmDeleteTemplate = ref(false);
const historyOpen = ref(false);
const history = ref<Dispatch[]>([]);
const lastResult = ref<Dispatch | null>(null);

/* Escritos fora do template porque `{{ … }}` dentro dele é interpolação. */
const tokenDriver = '{' + '{nome_motorista}' + '}';
const tokenCompany = '{' + '{nome_empresa}' + '}';

const filteredDrivers = computed(() => {
  const term = search.value.trim().toLowerCase();
  if (!term) return drivers.value;
  return drivers.value.filter(
    (d) => d.fullName.toLowerCase().includes(term) || d.phone.includes(term.replace(/\D/g, '')),
  );
});

const preview = computed(() =>
  renderMessage(body.value, {
    driverName: drivers.value.find((d) => selected.value.has(d.id))?.fullName ?? '[nome do motorista]',
    companyName: auth.organization?.name ?? '',
  }),
);

/** Converte a marcação *negrito* e _itálico_ do WhatsApp em HTML seguro. */
const previewHtml = computed(() =>
  preview.value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*([^*\n]+)\*/g, '<strong>$1</strong>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/\n/g, '<br />'),
);

interface IntegrationStatus {
  name: string | null;
  connected: boolean;
  message: string;
}

const whatsapp = ref<IntegrationStatus | null>(null);

async function load() {
  const [tpl, drv, status] = await Promise.all([
    api.get<{ data: MessageTemplate[] }>('/message-templates'),
    api.get<{ data: Driver[] }>('/drivers', { query: { limit: 100, status: 'ACTIVE' } }),
    api
      .get<{ whatsapp: IntegrationStatus }>('/integrations/status')
      .then((r) => r.whatsapp)
      .catch(() => null),
  ]);
  whatsapp.value = status;
  templates.value = tpl.data;
  drivers.value = drv.data;
  selected.value = new Set(drivers.value.map((d) => d.id));
  const first = templates.value[0];
  if (first) applyTemplate(first.id);
}

function applyTemplate(id: string) {
  const template = templates.value.find((t) => t.id === id);
  if (!template) return;
  selectedTemplateId.value = id;
  templateName.value = template.name;
  body.value = template.body;
}

function insertToken(token: string) {
  body.value = `${body.value}${body.value.endsWith(' ') || body.value === '' ? '' : ' '}${token}`;
}

function toggleDriver(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function clearSelection() {
  selected.value = new Set();
}

function newTemplate() {
  selectedTemplateId.value = '';
  templateName.value = '';
  body.value = '';
}

async function saveTemplate() {
  if (!templateName.value.trim() || !body.value.trim()) {
    toasts.warning('Informe o nome e o conteúdo do template');
    return;
  }
  savingTemplate.value = true;
  try {
    if (selectedTemplateId.value) {
      await api.patch(`/message-templates/${selectedTemplateId.value}`, {
        name: templateName.value,
        body: body.value,
      });
    } else {
      const created = await api.post<MessageTemplate>('/message-templates', {
        name: templateName.value,
        body: body.value,
      });
      selectedTemplateId.value = created.id;
    }
    const tpl = await api.get<{ data: MessageTemplate[] }>('/message-templates');
    templates.value = tpl.data;
    toasts.success('Template salvo');
  } catch (err) {
    toasts.error('Não foi possível salvar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    savingTemplate.value = false;
  }
}

async function deleteTemplate() {
  if (!selectedTemplateId.value) return;
  try {
    await api.delete(`/message-templates/${selectedTemplateId.value}`);
    const tpl = await api.get<{ data: MessageTemplate[] }>('/message-templates');
    templates.value = tpl.data;
    confirmDeleteTemplate.value = false;
    newTemplate();
    toasts.success('Template excluído');
  } catch (err) {
    toasts.error('Não foi possível excluir', err instanceof ApiRequestError ? err.message : undefined);
  }
}

async function send() {
  confirmSend.value = false;
  sending.value = true;
  try {
    const result = await api.post<Dispatch>('/message-dispatches', {
      templateId: selectedTemplateId.value || undefined,
      body: body.value,
      driverIds: [...selected.value],
      consentConfirmed: true,
    });
    lastResult.value = result;
    if (result.summary.sent > 0) {
      toasts.success(
        `${result.summary.sent} mensagem(ns) enviada(s)`,
        result.summary.failed > 0 ? `${result.summary.failed} falharam.` : undefined,
      );
    } else {
      toasts.warning(
        'Nenhuma mensagem foi enviada automaticamente',
        'O provedor de WhatsApp não está conectado. Use os links manuais listados abaixo.',
      );
    }
  } catch (err) {
    toasts.error('Não foi possível disparar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    sending.value = false;
  }
}

async function openHistory() {
  historyOpen.value = true;
  const res = await api.get<{ data: Dispatch[] }>('/message-dispatches');
  history.value = res.data;
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="NOTIFICAÇÕES"
      title="Disparo de Mensagens"
      subtitle="Escreva, escolha os motoristas e envie pelo WhatsApp."
    >
      <template #actions>
        <AppButton variant="secondary" @click="openHistory">
          <template #icon><History class="size-4" /></template>
          Histórico
        </AppButton>
      </template>
    </PageHeader>

    <!-- Estado real da integração: nada é "enviado" sem provedor. -->
    <section
      v-if="whatsapp && !whatsapp.connected"
      class="flex items-start gap-3 rounded-card border border-[rgb(var(--c-warning)/0.3)] bg-[rgb(var(--c-warning)/0.08)] p-4"
    >
      <AlertTriangle class="mt-0.5 size-5 shrink-0 text-[rgb(var(--c-warning))]" aria-hidden="true" />
      <div>
        <p class="text-[15px] font-semibold text-ink">Provedor de WhatsApp não conectado</p>
        <p class="mt-1 text-sm leading-relaxed text-ink-soft">{{ whatsapp.message }}</p>
      </div>
    </section>

    <!-- Barra de templates -->
    <section class="fo-card p-5">
      <div class="flex flex-wrap items-center gap-3">
        <div class="min-w-[220px] flex-1">
          <AppSelect
            :model-value="selectedTemplateId"
            :options="templates.map((t) => ({ value: t.id, label: t.name }))"
            placeholder="Selecione um template"
            @update:model-value="applyTemplate"
          />
        </div>
        <div class="min-w-[220px] flex-1">
          <AppInput v-model="templateName" placeholder="Nome do template" aria-label="Nome do template" />
        </div>
        <AppButton variant="secondary" @click="newTemplate">
          <template #icon><Plus class="size-4" /></template>
          Nova
        </AppButton>
        <AppButton
          v-if="auth.allows('notifications', 'dispatch')"
          variant="secondary"
          :loading="savingTemplate"
          @click="saveTemplate"
        >
          <template #icon><Save class="size-4" /></template>
          Salvar
        </AppButton>
        <AppButton
          v-if="auth.allows('notifications', 'dispatch') && selectedTemplateId"
          variant="ghost"
          aria-label="Excluir template"
          @click="confirmDeleteTemplate = true"
        >
          <template #icon><Trash2 class="size-4 text-negative" /></template>
        </AppButton>
      </div>
    </section>

    <!-- Editor + prévia -->
    <div class="grid gap-6 xl:grid-cols-2">
      <section class="fo-card p-6">
        <h2 class="mb-4 text-lg font-bold text-ink">Mensagem</h2>
        <div class="mb-4 flex flex-wrap gap-3">
          <button
            type="button"
            class="rounded-control bg-surface-muted px-4 py-2.5 text-[15px] text-ink transition-colors hover:bg-line"
            @click="insertToken(tokenDriver)"
          >
            + Nome do motorista
          </button>
          <button
            type="button"
            class="rounded-control bg-surface-muted px-4 py-2.5 text-[15px] text-ink transition-colors hover:bg-line"
            @click="insertToken(tokenCompany)"
          >
            + Nome da empresa
          </button>
        </div>
        <AppTextarea
          v-model="body"
          :rows="12"
          placeholder="Escreva a mensagem. Use os botões acima para inserir variáveis."
          aria-label="Conteúdo da mensagem"
        />
        <p class="fo-hint">
          Variáveis disponíveis: <code>{{ tokenDriver }}</code> e <code>{{ tokenCompany }}</code
          >. A formatação <code>*negrito*</code> e <code>_itálico_</code> segue o padrão do WhatsApp.
        </p>
      </section>

      <section class="fo-card p-6">
        <h2 class="mb-4 text-lg font-bold text-ink">Prévia</h2>
        <div class="rounded-card bg-[rgb(var(--c-positive)/0.06)] p-5">
          <!--
            previewHtml escapa &, < e > ANTES de inserir as tags de negrito,
            itálico e quebra de linha: o texto digitado nunca chega como HTML
            ativo. Por isso o v-html é seguro neste ponto.
          -->
          <!-- eslint-disable vue/no-v-html -->
          <div
            class="rounded-[14px] bg-[rgb(16_124_90)] px-5 py-4 text-[15px] leading-relaxed text-white"
            v-html="previewHtml"
          />
          <!-- eslint-enable vue/no-v-html -->
        </div>
      </section>
    </div>

    <!-- Destinatários -->
    <section class="fo-card p-6">
      <div class="mb-5 flex flex-wrap items-center justify-between gap-4">
        <h2 class="text-lg font-bold text-ink">Quem recebe</h2>
        <AppButton
          v-if="auth.allows('notifications', 'dispatch')"
          :disabled="selected.size === 0 || !body.trim()"
          :loading="sending"
          @click="confirmSend = true"
        >
          <template #icon><Send class="size-4" /></template>
          Enviar para {{ selected.size }} motorista{{ selected.size === 1 ? '' : 's' }}
        </AppButton>
      </div>

      <div class="mb-5 flex flex-wrap items-center gap-4">
        <div class="min-w-[260px] flex-1">
          <SearchInput v-model="search" placeholder="Buscar motorista..." label="Buscar motorista" />
        </div>
        <span class="text-[15px] text-ink-muted">
          {{ selected.size }} de {{ drivers.length }} selecionados
        </span>
        <button
          type="button"
          class="text-[15px] font-semibold text-ink transition-colors hover:text-brand-600"
          @click="clearSelection"
        >
          Desmarcar todos
        </button>
      </div>

      <ul class="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <li v-for="driver in filteredDrivers" :key="driver.id">
          <label
            class="flex cursor-pointer items-center gap-3 rounded-card border border-line p-4 transition-colors hover:border-brand-400"
          >
            <input
              type="checkbox"
              class="size-[18px] accent-[rgb(var(--c-brand-500))]"
              :checked="selected.has(driver.id)"
              @change="toggleDriver(driver.id)"
            />
            <span class="min-w-0">
              <span class="block truncate font-semibold text-ink">{{ driver.fullName }}</span>
              <span class="mt-0.5 block text-sm tabular text-ink-muted">{{ maskPhone(driver.phone) }}</span>
            </span>
          </label>
        </li>
      </ul>
    </section>

    <!-- Resultado do disparo -->
    <section v-if="lastResult" class="fo-card p-6">
      <h2 class="text-lg font-bold text-ink">Resultado do disparo</h2>
      <p class="mt-1.5 text-[15px] text-ink-muted">
        {{ lastResult.summary.sent }} enviada(s) · {{ lastResult.summary.failed }} falha(s) ·
        {{ lastResult.summary.unavailable }} sem provedor
      </p>

      <div
        v-if="!lastResult.providerAvailable"
        class="mt-4 rounded-card border border-[rgb(var(--c-warning)/0.3)] bg-[rgb(var(--c-warning)/0.08)] p-4"
      >
        <p class="text-[15px] font-semibold text-ink">Provedor de WhatsApp não conectado</p>
        <p class="mt-1.5 text-sm leading-relaxed text-ink-soft">
          Nenhuma mensagem foi enviada automaticamente. Abra os links abaixo para enviar manualmente,
          um a um.
        </p>
      </div>

      <ul class="mt-4 divide-y divide-line">
        <li
          v-for="delivery in lastResult.deliveries"
          :key="delivery.driverId"
          class="flex flex-wrap items-center justify-between gap-3 py-3"
        >
          <span class="min-w-0">
            <span class="block font-medium text-ink">{{ delivery.driverName }}</span>
            <span class="block text-sm tabular text-ink-muted">{{ maskPhone(delivery.phone) }}</span>
          </span>
          <span class="flex items-center gap-3">
            <StatusBadge
              :label="
                delivery.status === 'SENT'
                  ? 'Enviada'
                  : delivery.status === 'FAILED'
                    ? 'Falhou'
                    : 'Sem provedor'
              "
              :tone="delivery.status === 'SENT' ? 'green' : delivery.status === 'FAILED' ? 'red' : 'amber'"
              :solid="false"
            />
            <a
              v-if="delivery.manualLink"
              :href="delivery.manualLink"
              target="_blank"
              rel="noopener"
              class="text-sm font-medium text-brand-600 hover:underline"
            >
              Enviar manualmente
            </a>
          </span>
        </li>
      </ul>
    </section>

    <ConfirmDialog
      :open="confirmSend"
      title="Confirmar disparo"
      :message="`A mensagem será enviada para ${selected.size} motorista(s). Confirme que os destinatários autorizaram receber comunicações da sua organização.`"
      confirm-label="Confirmar e enviar"
      @cancel="confirmSend = false"
      @confirm="send"
    />

    <ConfirmDialog
      :open="confirmDeleteTemplate"
      title="Excluir template"
      message="Tem certeza que deseja excluir este template de mensagem?"
      confirm-label="Excluir"
      danger
      @cancel="confirmDeleteTemplate = false"
      @confirm="deleteTemplate"
    />

    <AppModal :open="historyOpen" title="Histórico de disparos" size="lg" @close="historyOpen = false">
      <p v-if="history.length === 0" class="text-[15px] text-ink-muted">Nenhum disparo registrado.</p>
      <ul v-else class="divide-y divide-line">
        <li v-for="dispatch in history" :key="dispatch.id" class="py-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="text-[15px] font-semibold text-ink">
              {{ new Date(dispatch.createdAt).toLocaleString('pt-BR') }}
            </span>
            <span class="text-sm text-ink-muted">
              {{ dispatch.summary.total }} destinatário(s) · {{ dispatch.summary.sent }} enviada(s)
            </span>
          </div>
          <p class="mt-2 line-clamp-2 text-sm text-ink-soft">{{ dispatch.bodySnapshot }}</p>
        </li>
      </ul>
    </AppModal>
  </div>
</template>
