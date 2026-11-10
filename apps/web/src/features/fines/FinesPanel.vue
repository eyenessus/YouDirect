<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Receipt } from 'lucide-vue-next';
import {
  businessDate,
  formatCentsBRL,
  formatDateTimeBR,
  trafficFineStatusLabels,
  type TrafficFine,
} from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { fineDeadlineTone, statusTone } from '@/lib/status';

/** Multas de um veículo, motorista ou locação (cartão usado nas páginas de detalhe). */
const props = defineProps<{ vehicleId?: string; driverId?: string; rentalId?: string; title?: string }>();

const router = useRouter();
const auth = useAuthStore();
const today = businessDate();
const fines = ref<TrafficFine[]>([]);
const loading = ref(true);
const failed = ref(false);

const openTotal = computed(() =>
  fines.value
    .filter((f) => !['PAID', 'COMPANY_LIABLE', 'CANCELED'].includes(f.status))
    .reduce((a, f) => a + f.amountCents, 0),
);

onMounted(async () => {
  try {
    const res = await api.get<{ data: TrafficFine[] }>('/traffic-fines', {
      query: { vehicleId: props.vehicleId, driverId: props.driverId, rentalId: props.rentalId, limit: 50 },
    });
    fines.value = res.data;
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="fo-card p-7" aria-label="Multas">
    <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h2 class="flex items-center gap-2.5 text-xl font-bold text-ink">
        <Receipt class="size-5 text-ink-soft" aria-hidden="true" /> {{ title ?? 'Multas' }}
      </h2>
      <div class="flex items-center gap-3">
        <span v-if="openTotal > 0" class="text-sm text-ink-muted">Em andamento: {{ formatCentsBRL(openTotal) }}</span>
        <AppButton
          v-if="vehicleId && auth.allows('fines', 'create')"
          size="sm"
          variant="secondary"
          @click="router.push({ path: '/dashboard/fines/new', query: { vehicleId } })"
        >
          Nova multa
        </AppButton>
      </div>
    </div>

    <p v-if="loading" class="text-[15px] text-ink-muted">Carregando…</p>
    <p v-else-if="failed" class="text-[15px] text-ink-muted">Não foi possível carregar as multas.</p>
    <p v-else-if="fines.length === 0" class="text-[15px] text-ink-muted">Nenhuma multa registrada.</p>
    <ul v-else class="divide-y divide-line">
      <li v-for="f in fines" :key="f.id" class="flex flex-wrap items-center justify-between gap-3 py-3">
        <div class="min-w-0">
          <RouterLink :to="`/dashboard/fines/${f.id}`" class="font-semibold text-ink hover:text-brand-600">
            {{ f.fineNumber }} · {{ f.vehicle.plate }}
          </RouterLink>
          <p class="truncate text-sm text-ink-muted">
            {{ formatDateTimeBR(f.occurredAt) }} · {{ f.infractionDescription }}
            <template v-if="!driverId && f.match.driver"> · {{ f.match.driver.fullName }}</template>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-semibold tabular">{{ formatCentsBRL(f.amountCents) }}</span>
          <StatusBadge v-if="fineDeadlineTone(f, today)" :label="fineDeadlineTone(f, today)!.label" :tone="fineDeadlineTone(f, today)!.tone" />
          <StatusBadge :label="trafficFineStatusLabels[f.status]" :tone="statusTone.fine[f.status]" :solid="false" />
        </div>
      </li>
    </ul>
  </section>
</template>
