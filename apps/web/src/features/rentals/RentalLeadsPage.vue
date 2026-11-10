<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ExternalLink } from 'lucide-vue-next';
import {
  formatDateTimeBR,
  formatIsoDateBR,
  maskPhone,
  rentalLeadStatusLabels,
  rentalLeadStatuses,
  type PublicSiteSettings,
  type RentalLead,
  type RentalLeadStatus,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/** Pedidos de reserva vindos do site da locadora. */
const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();
const leads = ref<RentalLead[]>([]);
const site = ref<PublicSiteSettings | null>(null);
const loading = ref(true);
const status = ref<string>('NEW');
const tone: Record<RentalLeadStatus, 'blue' | 'amber' | 'green' | 'slate'> = {
  NEW: 'blue',
  CONTACTED: 'amber',
  APPROVED: 'green',
  REJECTED: 'slate',
};
const statusOptions = [{ value: '', label: 'Todos' }, ...rentalLeadStatuses.map((s) => ({ value: s, label: rentalLeadStatusLabels[s] }))];
const siteUrl = computed(() => (site.value?.publicSlug && site.value.enabled ? `${window.location.origin}/l/${site.value.publicSlug}` : null));

async function load() {
  loading.value = true;
  try {
    const [res, settings] = await Promise.all([
      api.get<{ data: RentalLead[] }>('/rental-leads', { query: { status: status.value || undefined } }),
      api.get<PublicSiteSettings>('/public-site/settings').catch(() => null),
    ]);
    leads.value = res.data;
    site.value = settings;
  } finally {
    loading.value = false;
  }
}

async function setStatus(lead: RentalLead, next: RentalLeadStatus) {
  try {
    const updated = await api.patch<RentalLead>(`/rental-leads/${lead.id}`, { status: next });
    Object.assign(lead, updated);
    if (next === 'APPROVED' && auth.allows('drivers', 'create')) {
      void router.push({ path: '/dashboard/drivers/new', query: { fullName: lead.fullName, phone: lead.phone, email: lead.email ?? undefined } });
    }
  } catch (err) {
    toasts.error('Não foi possível atualizar', err instanceof ApiRequestError ? err.message : undefined);
  }
}

function whats(lead: RentalLead) {
  return `https://wa.me/55${lead.phone}?text=${encodeURIComponent(`Olá, ${lead.fullName.split(' ')[0]}! Recebemos seu pedido de reserva pelo site.`)}`;
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader eyebrow="LOCAÇÕES" title="Pedidos de Reserva" subtitle="Interessados que pediram um carro pelo site da locadora">
      <template #actions>
        <a v-if="siteUrl" :href="siteUrl" target="_blank" rel="noopener" class="inline-flex items-center gap-2 font-semibold text-brand-600 hover:underline">
          Ver site <ExternalLink class="size-4" />
        </a>
      </template>
    </PageHeader>

    <p v-if="site && !site.enabled" class="fo-card p-5 text-[15px] text-ink-soft">
      O site da locadora ainda não está publicado. O proprietário pode ativá-lo em Perfil &gt; Site da locadora.
    </p>

    <section class="fo-card overflow-hidden">
      <div class="flex items-center justify-between gap-4 p-6">
        <p class="text-[15px] text-ink-muted">{{ leads.length }} pedido(s)</p>
        <div class="w-56"><AppSelect v-model="status" :options="statusOptions" aria-label="Filtrar por status" @update:model-value="load" /></div>
      </div>
      <p v-if="loading" class="px-6 pb-6 text-ink-muted">Carregando…</p>
      <p v-else-if="leads.length === 0" class="px-6 pb-6 text-ink-muted">Nenhum pedido.</p>
      <ul v-else class="divide-y divide-line">
        <li v-for="l in leads" :key="l.id" class="grid gap-3 px-6 py-4 lg:grid-cols-[1.4fr_1fr_auto] lg:items-center">
          <div>
            <p class="font-semibold text-ink">{{ l.fullName }}</p>
            <p class="text-sm text-ink-muted">
              {{ maskPhone(l.phone) }}{{ l.email ? ` · ${l.email}` : '' }} · {{ formatDateTimeBR(l.createdAt) }}
            </p>
            <p v-if="l.message" class="mt-1 text-[15px] text-ink-soft">“{{ l.message }}”</p>
          </div>
          <div class="text-sm text-ink-soft">
            <p>Grupo: <strong class="text-ink">{{ l.groupName ?? 'Qualquer' }}</strong></p>
            <p>Retirada: {{ formatIsoDateBR(l.desiredStartDate) }}</p>
            <p>Apps: {{ l.appPlatforms.join(', ') || '—' }} · EAR: {{ l.hasEarCnh ? 'sim' : 'não informado' }}</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <StatusBadge :label="rentalLeadStatusLabels[l.status]" :tone="tone[l.status]" :solid="false" />
            <a :href="whats(l)" target="_blank" rel="noopener" class="text-sm font-semibold text-brand-600 hover:underline" @click="l.status === 'NEW' && setStatus(l, 'CONTACTED')">
              WhatsApp
            </a>
            <template v-if="auth.allows('rentals', 'update') && (l.status === 'NEW' || l.status === 'CONTACTED')">
              <AppButton size="sm" @click="setStatus(l, 'APPROVED')">Aprovar</AppButton>
              <AppButton size="sm" variant="ghost" @click="setStatus(l, 'REJECTED')">Recusar</AppButton>
            </template>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>
