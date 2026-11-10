<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Award } from 'lucide-vue-next';
import type { LoyaltyStatus } from '@yudirect/contracts';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api } from '@/lib/api';

/** Nível de fidelidade do motorista (estilo Zarp Acelera) e de onde vêm os pontos. */
const props = defineProps<{ driverId: string }>();
const status = ref<LoyaltyStatus | null>(null);

onMounted(async () => {
  status.value = await api.get<LoyaltyStatus>(`/drivers/${props.driverId}/loyalty`).catch(() => null);
});
</script>

<template>
  <section v-if="status?.enabled" class="fo-card p-7" aria-label="Fidelidade">
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="flex items-center gap-2.5 text-xl font-bold text-ink"><Award class="size-5 text-ink-soft" aria-hidden="true" /> Fidelidade</h2>
      <StatusBadge :label="status.level.name" tone="blue" :solid="false" />
    </div>
    <p class="text-[15px] text-ink">
      <strong class="tabular">{{ status.score }}</strong> pontos{{ status.nextLevel ? ` · faltam ${status.pointsToNext} para ${status.nextLevel.name}` : ' · nível máximo' }}
    </p>
    <p v-if="status.level.weeklyDiscountPercent > 0" class="mt-1 text-sm text-ink-soft">
      Benefício: {{ status.level.weeklyDiscountPercent }}% de desconto na semana (aplicado pela locadora no valor do contrato).
    </p>
    <ul class="mt-4 divide-y divide-line">
      <li v-for="c in status.criteria" :key="c.key" class="flex justify-between gap-3 py-2 text-[15px]">
        <span class="text-ink-soft">{{ c.label }} <span class="text-sm text-ink-muted">· {{ c.detail }}</span></span>
        <span class="font-semibold tabular" :class="c.points < 0 ? 'text-[rgb(var(--c-negative))]' : 'text-ink'">{{ c.points > 0 ? '+' : '' }}{{ c.points }}</span>
      </li>
    </ul>
  </section>
</template>
