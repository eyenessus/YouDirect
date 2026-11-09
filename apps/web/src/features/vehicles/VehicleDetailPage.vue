<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Pencil } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  formatKm,
  vehicleStatusLabels,
  type Vehicle,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();

const vehicle = ref<Vehicle | null>(null);
const loading = ref(true);

const fields = computed(() => {
  const v = vehicle.value;
  if (!v) return [];
  return [
    { label: 'Placa', value: v.plate },
    { label: 'Marca / Modelo', value: `${v.brand} ${v.model}`.trim() },
    { label: 'Ano', value: v.year ? String(v.year) : '—' },
    { label: 'Cor', value: v.color ?? '—' },
    { label: 'Chassi', value: v.vin ?? '—' },
    { label: 'Renavam', value: v.renavam ?? '—' },
    {
      label: 'UF / município',
      value:
        v.registrationState || v.registrationCity
          ? [v.registrationState, v.registrationCity].filter(Boolean).join(' / ')
          : '—',
    },
    { label: 'Hodômetro', value: formatKm(v.mileageKm) },
    { label: 'Status', value: vehicleStatusLabels[v.status] },
    { label: 'Data da compra', value: formatIsoDateBR(v.purchaseDate) },
    {
      label: 'Valor da compra',
      value: v.purchaseAmountCents !== null ? formatCentsBRL(v.purchaseAmountCents) : '—',
    },
  ];
});

onMounted(async () => {
  try {
    vehicle.value = await api.get<Vehicle>(`/vehicles/${route.params.id}`);
  } catch {
    toasts.error('Veículo não encontrado');
    router.replace('/dashboard/vehicles');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="space-y-6">
    <AppSkeleton v-if="loading" variant="block" />

    <template v-else-if="vehicle">
      <PageHeader
        eyebrow="FROTA"
        :title="`${vehicle.brand} ${vehicle.model} • ${vehicle.plate}`"
        subtitle="Detalhes do veículo e consulta de multas"
        back-to="/dashboard/vehicles"
      >
        <template #actions>
          <AppButton
            v-if="auth.allows('vehicles', 'update')"
            variant="secondary"
            @click="router.push(`/dashboard/vehicles/${vehicle.id}/edit`)"
          >
            <template #icon><Pencil class="size-4" /></template>
            Editar
          </AppButton>
        </template>
      </PageHeader>

      <section class="fo-card p-8">
        <dl class="grid gap-x-8 gap-y-7 sm:grid-cols-2 xl:grid-cols-4">
          <div v-for="field in fields" :key="field.label">
            <dt class="text-[15px] text-ink-muted">{{ field.label }}</dt>
            <dd class="mt-1 break-words text-[17px] font-semibold text-ink">{{ field.value }}</dd>
          </div>
        </dl>
      </section>

      <section v-if="vehicle.photos.length > 0" class="fo-card p-8">
        <h2 class="mb-5 text-xl font-bold text-ink">Fotos do Veículo</h2>
        <div class="grid gap-4 sm:grid-cols-3 xl:grid-cols-4">
          <a
            v-for="photo in vehicle.photos"
            :key="photo.fileId"
            :href="photo.url"
            target="_blank"
            rel="noopener"
            class="block overflow-hidden rounded-card border border-line"
          >
            <img
              :src="photo.url"
              :alt="`Foto do veículo ${vehicle.plate}`"
              class="aspect-[4/3] w-full object-cover transition-transform hover:scale-[1.02]"
              loading="lazy"
            />
          </a>
        </div>
      </section>

      <div class="flex flex-wrap gap-3">
        <AppButton variant="secondary" @click="router.push(`/dashboard/maintenance/${vehicle.id}`)">
          Ver manutenções
        </AppButton>
        <AppButton variant="secondary" @click="router.push(`/dashboard/inspections/${vehicle.id}`)">
          Ver vistorias
        </AppButton>
      </div>
    </template>
  </div>
</template>
