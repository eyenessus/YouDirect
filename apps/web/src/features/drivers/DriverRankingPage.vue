<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { Award } from 'lucide-vue-next';
import type { DriverRankingRow } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';

/** Pontuação dos motoristas com locação ativa: quem precisa de atenção aparece primeiro. */
const toasts = useToastStore();
const rows = ref<DriverRankingRow[]>([]);
const loading = ref(true);
const onlyAttention = ref(false);

const shown = computed(() => (onlyAttention.value ? rows.value.filter((r) => r.attention) : rows.value));
const attentionCount = computed(() => rows.value.filter((r) => r.attention).length);

onMounted(async () => {
  try {
    rows.value = (await api.get<{ data: DriverRankingRow[] }>('/drivers/ranking')).data;
  } catch (err) {
    toasts.error('Não foi possível carregar o ranking', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Motoristas"
      title="Ranking de motoristas"
      subtitle="Pontos por tempo de contrato, pagamentos em dia, vistorias no prazo, multas e sinistros com culpa. Recalculado todo dia."
    />
    <div class="mb-5 flex flex-wrap items-center gap-4">
      <label class="flex items-center gap-2 text-[15px] text-ink-soft">
        <input v-model="onlyAttention" type="checkbox" class="size-4" />
        Só quem precisa de atenção
      </label>
      <p v-if="attentionCount > 0" class="text-sm font-semibold text-[rgb(var(--c-warning))]" role="status">{{ attentionCount }} motorista(s) com pontuação baixa</p>
    </div>

    <div class="fo-card overflow-x-auto">
      <p v-if="loading" class="p-8 text-ink-muted" role="status">Carregando...</p>
      <EmptyState v-else-if="shown.length === 0" :icon="Award" title="Nenhum motorista" message="Motoristas com locação ativa aparecem aqui depois do primeiro cálculo diário." />
      <table v-else class="w-full text-left text-[15px]">
        <thead class="border-b border-line text-sm text-ink-muted">
          <tr>
            <th class="px-5 py-3 font-semibold">Motorista</th>
            <th class="px-5 py-3 font-semibold">Veículo</th>
            <th class="px-5 py-3 font-semibold">Pontos</th>
            <th class="px-5 py-3 font-semibold">Nível</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in shown" :key="r.driverId" class="border-b border-line last:border-0">
            <td class="px-5 py-3">
              <RouterLink :to="`/dashboard/drivers/${r.driverId}`" class="font-semibold text-brand-600 hover:underline">{{ r.fullName }}</RouterLink>
            </td>
            <td class="px-5 py-3">{{ r.plate ?? '—' }}</td>
            <td class="px-5 py-3 tabular font-semibold" :class="r.attention ? 'text-[rgb(var(--c-warning))]' : 'text-ink'">{{ r.score }}</td>
            <td class="px-5 py-3"><StatusBadge :label="r.attention ? `${r.levelName} · atenção` : r.levelName" :tone="r.attention ? 'amber' : 'blue'" :solid="false" /></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
