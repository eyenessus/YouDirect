<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { CalendarDays, Car, ClipboardList, User } from 'lucide-vue-next';
import { formatIsoDateBR, type InspectionVehicleCard } from '@frotaone/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import SearchInput from '@/components/ui/SearchInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import RequestInspectionModal from './RequestInspectionModal.vue';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();

const cards = ref<InspectionVehicleCard[]>([]);
const loading = ref(true);
const query = ref('');
const status = ref('');
const requestTarget = ref<InspectionVehicleCard | null>(null);

const statusOptions = [
  { value: '', label: 'Todos' },
  { value: 'ok', label: 'Em dia' },
  { value: 'late', label: 'Atrasadas' },
];

async function load() {
  loading.value = true;
  try {
    const res = await api.get<{ data: InspectionVehicleCard[] }>('/inspections/vehicles', {
      query: { q: query.value || undefined, status: status.value || undefined },
    });
    cards.value = res.data;
  } catch {
    toasts.error('Falha ao carregar vistorias');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader eyebrow="FROTA" title="Vistorias" subtitle="Acompanhe as vistorias dos veículos da frota" />

    <section class="fo-card p-6">
      <div class="grid gap-4 lg:grid-cols-[1fr_240px]">
        <SearchInput
          v-model="query"
          placeholder="Buscar por placa, marca ou modelo..."
          label="Buscar veículos"
          @search="load"
        />
        <AppSelect v-model="status" :options="statusOptions" @update:model-value="load" />
      </div>
    </section>

    <AppSkeleton v-if="loading" variant="cards" :rows="4" />

    <EmptyState
      v-else-if="cards.length === 0"
      :icon="ClipboardList"
      message="Nenhum veículo encontrado para acompanhamento de vistorias."
    />

    <div v-else class="space-y-5">
      <article v-for="card in cards" :key="card.vehicle.id" class="fo-card p-6">
        <div class="flex flex-wrap items-start gap-6">
          <img
            v-if="card.vehicle.photoUrl"
            :src="card.vehicle.photoUrl"
            :alt="`Foto do veículo ${card.vehicle.plate}`"
            class="h-[120px] w-[160px] shrink-0 rounded-card object-cover"
            loading="lazy"
          />
          <div
            v-else
            class="flex h-[120px] w-[160px] shrink-0 items-center justify-center rounded-card bg-surface-muted"
            aria-hidden="true"
          >
            <Car class="size-8 text-ink-muted" />
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <h2 class="text-[22px] font-bold text-ink">
                  {{ card.vehicle.brand }} {{ card.vehicle.model }} {{ card.vehicle.year ?? '' }}
                </h2>
                <p class="mt-1 text-[17px] text-ink-muted">Placa: {{ card.vehicle.plate }}</p>
              </div>
              <StatusBadge
                :label="card.onSchedule ? 'Em dia' : 'Atrasada'"
                :tone="card.onSchedule ? 'green' : 'red'"
              />
            </div>

            <p class="mt-3 flex items-center gap-2 text-[17px] text-ink-soft">
              <User class="size-[18px] text-ink-muted" aria-hidden="true" />
              {{ card.driverName ?? 'Sem motorista vinculado' }}
            </p>
            <p class="mt-2 flex items-center gap-2 text-[17px] text-ink-soft">
              <CalendarDays class="size-[18px] text-ink-muted" aria-hidden="true" />
              Última: {{ card.lastInspectionAt ? formatIsoDateBR(card.lastInspectionAt) : 'Nenhuma' }}
              <span class="text-ink-muted">|</span>
              Próxima:
              {{ card.nextInspectionAt ? formatIsoDateBR(card.nextInspectionAt) : '—' }}
            </p>

            <div class="mt-5 flex flex-wrap gap-3">
              <AppButton
                variant="secondary"
                @click="router.push(`/dashboard/inspections/${card.vehicle.id}`)"
              >
                Ver vistorias
              </AppButton>
              <AppButton v-if="auth.allows('inspections', 'request')" @click="requestTarget = card">
                <template #icon><ClipboardList class="size-4" /></template>
                Solicitar vistoria
              </AppButton>
            </div>
          </div>
        </div>
      </article>
    </div>

    <RequestInspectionModal
      :open="requestTarget !== null"
      :vehicle="
        requestTarget
          ? {
              id: requestTarget.vehicle.id,
              plate: requestTarget.vehicle.plate,
              brand: requestTarget.vehicle.brand,
              model: requestTarget.vehicle.model,
              year: requestTarget.vehicle.year,
            }
          : null
      "
      :default-responsible="requestTarget?.driverName ?? null"
      @close="requestTarget = null"
      @created="load"
    />
  </div>
</template>
