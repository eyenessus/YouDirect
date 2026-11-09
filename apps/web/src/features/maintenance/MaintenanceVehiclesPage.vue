<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { CalendarDays, DollarSign, Wrench } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  vehicleStatusLabels,
  type MaintenanceVehicleCard,
  type VehicleStatus,
} from '@frotaone/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import SearchInput from '@/components/ui/SearchInput.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();

const cards = ref<MaintenanceVehicleCard[]>([]);
const loading = ref(true);
const query = ref('');

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ data: MaintenanceVehicleCard[] }>('/maintenance/vehicles', {
      query: { q: query.value || undefined },
    });
    cards.value = res.data;
  } catch {
    toasts.error('Falha ao carregar manutenções');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="MANUTENÇÃO"
      title="Manutenções"
      subtitle="Selecione um veículo para visualizar ou lançar manutenções."
    />

    <SearchInput
      v-model="query"
      placeholder="Buscar por placa, marca ou modelo..."
      label="Buscar veículos"
      @search="load"
    />

    <AppSkeleton v-if="loading" variant="cards" :rows="6" />

    <EmptyState
      v-else-if="cards.length === 0"
      :icon="Wrench"
      message="Nenhum veículo encontrado para lançar manutenções."
    />

    <div v-else class="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
      <article v-for="card in cards" :key="card.vehicle.id" class="fo-card p-6">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-xl font-bold text-ink">{{ card.vehicle.plate }}</h2>
            <p class="mt-1 truncate text-[17px] text-ink-soft">
              {{ card.vehicle.brand }} {{ card.vehicle.model }}
              <span v-if="card.vehicle.year"> {{ card.vehicle.year }}</span>
            </p>
          </div>
          <StatusBadge
            :label="vehicleStatusLabels[card.vehicle.status as VehicleStatus]"
            :tone="statusTone.vehicle[card.vehicle.status as VehicleStatus]"
            :solid="false"
          />
        </div>

        <div class="mt-5 flex flex-wrap items-end justify-between gap-4">
          <p class="flex items-center gap-2 text-[15px] text-ink-soft">
            <Wrench class="size-[18px] text-ink-muted" aria-hidden="true" />
            {{ card.orderCount }} {{ card.orderCount === 1 ? 'OS' : "OS's" }}
          </p>
          <div class="text-right">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
              Total em manutenção
            </p>
            <p class="mt-1 flex items-center justify-end gap-1.5 text-[17px] font-bold tabular text-ink">
              <DollarSign class="size-4 text-ink-muted" aria-hidden="true" />
              {{ formatCentsBRL(card.totalCents) }}
            </p>
          </div>
        </div>

        <p v-if="card.lastPerformedAt" class="mt-4 flex items-center gap-2 text-[15px] text-ink-soft">
          <CalendarDays class="size-[18px] text-ink-muted" aria-hidden="true" />
          Última: {{ formatIsoDateBR(card.lastPerformedAt) }}
        </p>

        <div class="mt-5 grid grid-cols-2 gap-3">
          <AppButton variant="secondary" @click="router.push(`/dashboard/maintenance/${card.vehicle.id}`)">
            <template #icon><Wrench class="size-4" /></template>
            Ver Histórico
          </AppButton>
          <AppButton
            v-if="auth.allows('maintenance', 'create')"
            @click="router.push(`/dashboard/maintenance/${card.vehicle.id}/new`)"
          >
            <template #icon><span class="text-lg leading-none">+</span></template>
            Lançar
          </AppButton>
        </div>
      </article>
    </div>
  </div>
</template>
