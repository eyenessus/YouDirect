<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  ChevronRight, Download, ExternalLink, FileText, RefreshCw,
} from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatLongDateBR,
  invoiceStatusLabels,
  type SubscriptionOverview,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

const auth = useAuthStore();
const toasts = useToastStore();

const overview = ref<SubscriptionOverview | null>(null);
const loading = ref(true);
const expandedInvoice = ref<string | null>(null);

async function load() {
  loading.value = true;
  try {
    overview.value = await api.get<SubscriptionOverview>('/subscription');
  } catch (err) {
    toasts.error('Falha ao carregar a assinatura', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    loading.value = false;
  }
}

/**
 * O link só é aberto quando o provedor real devolve a URL. Sem provedor
 * conectado a ação informa a indisponibilidade — nunca simula pagamento.
 */
async function openPaymentLink(invoiceId: string) {
  try {
    const res = await api.get<{ url: string }>(`/subscription/invoices/${invoiceId}/link`);
    window.open(res.url, '_blank', 'noopener');
  } catch (err) {
    toasts.warning(
      'Pagamento indisponível',
      err instanceof ApiRequestError
        ? err.message
        : 'Nenhum provedor de cobrança está conectado a esta organização.',
    );
  }
}

async function refresh() {
  try {
    await api.post('/subscription/refresh');
    await load();
  } catch (err) {
    toasts.warning(
      'Sincronização indisponível',
      err instanceof ApiRequestError ? err.message : undefined,
    );
  }
}

function openInvoice(url: string | null) {
  if (url) window.open(url, '_blank', 'noopener');
}

const BOM = String.fromCharCode(0xfeff);

/** Extrato do período em CSV, gerado com os mesmos números exibidos na tela. */
function downloadStatement() {
  if (!overview.value) return;
  const { statement } = overview.value;
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const money = (c: number) => (c / 100).toFixed(2).replace('.', ',');
  const lines = [
    [cell('Item'), cell('Valor (R$)')].join(';'),
    ...statement.lines.map((l) => [cell(l.hint ? `${l.label} (${l.hint})` : l.label), money(l.amountCents)].join(';')),
    [cell('Total no período'), money(statement.totalCents)].join(';'),
  ];
  const blob = new Blob([`${BOM}${statement.periodLabel}\r\n${lines.join('\r\n')}\r\n`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'extrato-assinatura.csv';
  a.click();
  URL.revokeObjectURL(url);
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="COBRANÇA"
      title="Assinatura"
      subtitle="Status, composição de valores e histórico de pagamentos"
    />

    <AppSkeleton v-if="loading" variant="cards" :rows="2" />

    <template v-else-if="overview">
      <div class="grid gap-6 xl:grid-cols-2">
        <!-- Status -->
        <section class="fo-card p-7">
          <div class="flex items-start justify-between gap-4">
            <h2 class="text-[22px] font-bold text-ink">Status da Assinatura</h2>
            <StatusBadge
              :label="overview.subscription.statusLabel"
              :tone="overview.subscription.status === 'ACTIVE' ? 'blue' : 'amber'"
            />
          </div>

          <dl class="mt-6 space-y-5">
            <div>
              <dt class="text-[15px] text-ink-muted">Plano</dt>
              <dd class="mt-0.5 text-[19px] font-semibold text-ink">
                {{ overview.subscription.planLabel }}
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Produto</dt>
              <dd class="mt-0.5 text-[19px] font-semibold text-ink">
                {{ overview.subscription.productLabel }}
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Ciclo de cobrança</dt>
              <dd class="mt-0.5 text-[19px] font-semibold text-ink">
                {{ overview.subscription.cycleLabel }}
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Próxima cobrança</dt>
              <dd class="mt-0.5 text-[19px] font-semibold text-ink">
                {{ formatLongDateBR(overview.subscription.nextDueAt) }}
              </dd>
            </div>
          </dl>

          <!-- Sem integração de cobrança não há upgrade/cancelamento automático:
               em vez de botões que só avisam "indisponível", orientamos o caminho real. -->
          <p v-if="auth.isOwnerOrAdmin" class="mt-7 text-[15px] leading-relaxed text-ink-soft">
            Para mudar de plano ou cancelar a assinatura, fale com o suporte do YuDirect — a alteração vale a
            partir do próximo ciclo.
          </p>

          <p
            v-if="!overview.subscription.provider.connected"
            class="mt-6 rounded-card border border-[rgb(var(--c-warning)/0.3)] bg-[rgb(var(--c-warning)/0.08)] px-4 py-3 text-sm leading-relaxed text-ink-soft"
          >
            {{ overview.subscription.provider.message }}
          </p>
        </section>

        <!-- Extrato do período -->
        <section class="fo-card p-7">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 class="text-[22px] font-bold text-ink">Extrato do Período</h2>
              <p class="mt-1.5 text-[15px] text-ink-muted">
                {{ overview.statement.periodLabel }}
              </p>
            </div>
            <div class="flex items-center gap-3">
              <StatusBadge :label="overview.subscription.cycleLabel" tone="slate" :solid="false" />
              <AppButton variant="secondary" size="sm" @click="downloadStatement">
                <template #icon><Download class="size-4" /></template>
                Baixar
              </AppButton>
            </div>
          </div>

          <p class="fo-eyebrow mt-6">{{ overview.statement.planRangeLabel }}</p>

          <ul class="mt-3 divide-y divide-line rounded-card border border-line">
            <li
              v-for="line in overview.statement.lines"
              :key="line.label"
              class="flex items-center justify-between gap-4 px-5 py-4"
            >
              <span class="text-[15px] text-ink">
                {{ line.label }}
                <span v-if="line.hint" class="ml-1.5 text-brand-600">{{ line.hint }}</span>
              </span>
              <span class="tabular text-[15px] font-semibold text-ink">
                {{ formatCentsBRL(line.amountCents) }}
                <span v-if="line.label === 'Plano'" class="font-normal text-ink-muted">/mês</span>
              </span>
            </li>
            <li class="flex items-center justify-between gap-4 bg-surface-muted/60 px-5 py-4">
              <span class="text-[17px] font-bold text-ink">Total no período</span>
              <span class="tabular text-[19px] font-bold text-ink">
                {{ formatCentsBRL(overview.statement.totalCents) }}
              </span>
            </li>
          </ul>
        </section>
      </div>

      <!-- Histórico de cobranças -->
      <section class="fo-card p-7">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 class="text-[22px] font-bold text-ink">Histórico de Cobranças</h2>
            <p class="mt-1.5 text-[15px] text-ink-muted">
              Pagas, pendentes e atrasadas. O link de pagamento só aparece quando o provedor oficial
              estiver conectado.
            </p>
          </div>
          <AppButton v-if="overview.subscription.provider.connected" variant="secondary" @click="refresh">
            <template #icon><RefreshCw class="size-4" /></template>
            Atualizar
          </AppButton>
        </div>

        <ul class="mt-6 space-y-4">
          <li
            v-for="invoice in overview.invoices"
            :key="invoice.id"
            class="rounded-card border border-line p-5"
          >
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-3">
                  <span class="text-[19px] font-bold tabular text-ink">
                    {{ formatCentsBRL(invoice.amountCents) }}
                  </span>
                  <StatusBadge
                    :label="invoiceStatusLabels[invoice.status]"
                    :tone="statusTone.invoice[invoice.status]"
                  />
                  <span
                    v-if="invoice.hasDetail"
                    class="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-soft"
                  >
                    com detalhe
                  </span>
                </div>
                <p class="mt-1.5 text-[15px] text-ink-soft">{{ invoice.description }}</p>
                <p class="mt-1 text-sm text-ink-muted">
                  Vencimento {{ formatLongDateBR(invoice.dueDate) }}
                  <span v-if="invoice.paidAt"> · Pago em {{ formatLongDateBR(invoice.paidAt) }}</span>
                </p>
              </div>

              <div class="flex flex-col items-end gap-2">
                <AppButton
                  v-if="invoice.status !== 'PAID'"
                  :disabled="!overview.subscription.provider.connected"
                  @click="openPaymentLink(invoice.id)"
                >
                  <template #icon><ExternalLink class="size-4" /></template>
                  Pagar ou 2ª via (boleto / PIX)
                </AppButton>
                <AppButton
                  v-else
                  variant="secondary"
                  :disabled="!invoice.invoiceUrl"
                  @click="openInvoice(invoice.invoiceUrl)"
                >
                  <template #icon><FileText class="size-4" /></template>
                  Ver fatura
                </AppButton>
                <button
                  v-if="invoice.composition"
                  type="button"
                  class="inline-flex items-center gap-1 text-sm text-ink-soft transition-colors hover:text-ink"
                  @click="expandedInvoice = expandedInvoice === invoice.id ? null : invoice.id"
                >
                  <ChevronRight
                    class="size-4 transition-transform"
                    :class="expandedInvoice === invoice.id ? 'rotate-90' : ''"
                    aria-hidden="true"
                  />
                  Ver composição
                </button>
              </div>
            </div>

            <ul
              v-if="expandedInvoice === invoice.id && invoice.composition"
              class="mt-4 divide-y divide-line border-t border-line pt-4"
            >
              <li
                v-for="item in invoice.composition"
                :key="item.label"
                class="flex items-center justify-between gap-4 py-2 text-[15px]"
              >
                <span class="text-ink-soft">{{ item.label }}</span>
                <span class="tabular text-ink">{{ formatCentsBRL(item.amountCents) }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
