<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { ShieldAlert } from 'lucide-vue-next';
import { claimKindLabels, claimStatusLabels, claimStatuses, formatIsoDateBR, type Claim, type ClaimStatus } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import SearchInput from '@/components/ui/SearchInput.vue';
import StatusBadge, { type BadgeTone } from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

const auth = useAuthStore();
const toasts = useToastStore();
const rows = ref<Claim[]>([]);
const loading = ref(true);
const query = ref('');
const status = ref('');

const statusOptions = [{ value: '', label: 'Todas as situações' }, ...claimStatuses.map((s) => ({ value: s, label: claimStatusLabels[s] }))];
const tones: Record<ClaimStatus, BadgeTone> = { OPEN: 'amber', IN_ANALYSIS: 'blue', IN_REPAIR: 'blue', CLOSED: 'green', CANCELED: 'slate' };

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams({ limit: '100' });
    if (query.value) params.set('q', query.value);
    if (status.value) params.set('status', status.value);
    rows.value = (await api.get<{ data: Claim[] }>(`/claims?${params}`)).data;
  } catch (err) {
    toasts.error('Não foi possível carregar os sinistros', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    loading.value = false;
  }
}
onMounted(load);
watch([query, status], load);
</script>

<template>
  <div>
    <PageHeader eyebrow="Frota" title="Sinistros" subtitle="Acidentes, roubos e danos: acompanhe a seguradora, o reparo e a cobrança da franquia." />
    <div class="mb-5 flex flex-wrap items-center gap-3">
      <SearchInput v-model="query" placeholder="Buscar por número, placa, motorista ou B.O." class="min-w-72 flex-1" />
      <AppSelect v-model="status" :options="statusOptions" class="w-64" />
      <RouterLink v-if="auth.allows('claims', 'create')" to="/dashboard/claims/new"><AppButton>Registrar sinistro</AppButton></RouterLink>
    </div>
    <div class="fo-card overflow-x-auto">
      <p v-if="loading" class="p-8 text-ink-muted" role="status">Carregando...</p>
      <EmptyState v-else-if="rows.length === 0" :icon="ShieldAlert" title="Nenhum sinistro" message="Quando houver um acidente, roubo ou dano, registre aqui para acompanhar o caso." />
      <table v-else class="w-full text-left text-[15px]">
        <thead class="border-b border-line text-sm text-ink-muted">
          <tr>
            <th class="px-5 py-3 font-semibold">Número</th>
            <th class="px-5 py-3 font-semibold">Veículo</th>
            <th class="px-5 py-3 font-semibold">Motorista</th>
            <th class="px-5 py-3 font-semibold">Tipo</th>
            <th class="px-5 py-3 font-semibold">Data</th>
            <th class="px-5 py-3 font-semibold">Situação</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in rows" :key="c.id" class="border-b border-line last:border-0">
            <td class="px-5 py-3"><RouterLink :to="`/dashboard/claims/${c.id}`" class="font-semibold text-brand-600 hover:underline">{{ c.claimNumber }}</RouterLink></td>
            <td class="px-5 py-3">{{ c.vehicle.plate }} <span class="text-ink-muted">{{ c.vehicle.label }}</span></td>
            <td class="px-5 py-3">{{ c.driver?.fullName ?? '—' }}</td>
            <td class="px-5 py-3">{{ claimKindLabels[c.kind] }}</td>
            <td class="px-5 py-3">{{ formatIsoDateBR(c.occurredOn) }}</td>
            <td class="px-5 py-3"><StatusBadge :label="claimStatusLabels[c.status]" :tone="tones[c.status]" /></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
