<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { CalendarDays, Car, FileText, User } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  maskCpf,
  rentalStatusLabels,
  rentalTypeLabels,
  type Rental,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import AppTabs, { type TabItem } from '@/components/ui/AppTabs.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import RentalPaymentsTab from './RentalPaymentsTab.vue';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

/**
 * Página da locação (Locações > motorista > Lançar pagamento).
 * Abas: Detalhes · Pagamentos. A aba Pagamentos só aparece para quem pode ler o financeiro.
 */
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();

const rental = ref<Rental | null>(null);
const loading = ref(true);

const tabs = computed<TabItem[]>(() => [
  { key: 'details', label: 'Detalhes' },
  ...(auth.allows('finance', 'read') ? [{ key: 'payments', label: 'Pagamentos' }] : []),
]);

const requested = computed(() => (route.query.tab === 'payments' ? 'payments' : 'details'));
const tab = ref<string>(requested.value);
watch(requested, (v) => (tab.value = v));
watch(tab, (key) => {
  if (key !== route.query.tab) void router.replace({ query: { ...route.query, tab: key } });
});
const activeTab = computed(() => (tabs.value.some((t) => t.key === tab.value) ? tab.value : 'details'));

onMounted(async () => {
  try {
    rental.value = await api.get<Rental>(`/rentals/${route.params.id}`);
  } catch {
    toasts.error('Locação não encontrada');
    void router.replace('/dashboard/rentals');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="space-y-6">
    <AppSkeleton v-if="loading" variant="block" />

    <template v-else-if="rental">
      <PageHeader
        eyebrow="LOCAÇÕES"
        :title="`Locação #${rental.rentalNumber}`"
        subtitle="Detalhes completos da locação"
        back-to="/dashboard/rentals"
      >
        <template #actions>
          <StatusBadge :label="rentalStatusLabels[rental.status]" :tone="statusTone.rental[rental.status]" :solid="false" />
        </template>
      </PageHeader>

      <AppTabs v-model="tab" :items="tabs" />

      <RentalPaymentsTab v-if="activeTab === 'payments'" :rental-id="rental.id" />

      <div v-else class="grid gap-6 xl:grid-cols-2">
        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <Car class="size-5 text-ink-soft" aria-hidden="true" /> Veículo
          </h2>
          <dl class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <div>
              <dt class="text-[15px] text-ink-muted">Placa</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">{{ rental.vehicle.plate }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Veículo</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">
                {{ rental.vehicle.brand }} {{ rental.vehicle.model }}{{ rental.vehicle.year ? ` ${rental.vehicle.year}` : '' }}
              </dd>
            </div>
          </dl>
        </section>

        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <User class="size-5 text-ink-soft" aria-hidden="true" /> Motorista
          </h2>
          <dl class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <div>
              <dt class="text-[15px] text-ink-muted">Nome</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">
                <RouterLink :to="`/dashboard/drivers/${rental.driver.id}`" class="hover:text-brand-600">
                  {{ rental.driver.fullName }}
                </RouterLink>
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">CPF</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">{{ maskCpf(rental.driver.cpf) }}</dd>
            </div>
          </dl>
        </section>

        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <CalendarDays class="size-5 text-ink-soft" aria-hidden="true" /> Período e valores
          </h2>
          <dl class="grid gap-x-8 gap-y-5 sm:grid-cols-2">
            <div>
              <dt class="text-[15px] text-ink-muted">Início</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">{{ formatIsoDateBR(rental.startDate) }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Término</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">
                {{ rental.endDate ? formatIsoDateBR(rental.endDate) : 'Sem data de término' }}
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Tipo de locação</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">{{ rentalTypeLabels[rental.rentalType] }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Valor do período</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">{{ formatCentsBRL(rental.periodicAmountCents) }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Caução</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">{{ formatCentsBRL(rental.depositCents) }}</dd>
            </div>
          </dl>
        </section>

        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <FileText class="size-5 text-ink-soft" aria-hidden="true" /> Contrato e observações
          </h2>
          <dl class="space-y-5">
            <div>
              <dt class="text-[15px] text-ink-muted">Contrato anexado</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">
                <a
                  v-if="rental.contractFile"
                  :href="rental.contractFile.url"
                  target="_blank"
                  rel="noopener"
                  class="text-brand-600 hover:underline"
                >
                  {{ rental.contractFile.originalName }}
                </a>
                <span v-else>—</span>
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Observações</dt>
              <dd class="mt-1 text-[17px] text-ink">{{ rental.notes || '—' }}</dd>
            </div>
          </dl>
        </section>
      </div>
    </template>
  </div>
</template>
