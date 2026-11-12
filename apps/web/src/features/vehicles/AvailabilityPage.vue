<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { CarFront } from 'lucide-vue-next';
import {
  formatIsoDateBR,
  swapReasonLabels,
  swapReasons,
  vehicleStatusLabels,
  type AvailabilityRow,
  type Rental,
  type VehicleSwap,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge, { type BadgeTone } from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/** Quadro de disponibilidade da frota e carro reserva (troca temporária do veículo da locação). */
const auth = useAuthStore();
const toasts = useToastStore();
const rows = ref<AvailabilityRow[]>([]);
const swaps = ref<VehicleSwap[]>([]);
const rentals = ref<Rental[]>([]);
const loading = ref(true);
const saving = ref(false);
const form = reactive({ rentalId: '', replacementVehicleId: '', reason: 'MAINTENANCE' });

const canSwap = computed(() => auth.allows('rentals', 'update'));
const tones: Record<string, BadgeTone> = { AVAILABLE: 'green', RENTED: 'blue', MAINTENANCE: 'amber', INACTIVE: 'slate' };
const reasonOptions = swapReasons.map((r) => ({ value: r, label: swapReasonLabels[r] }));
const rentalOptions = computed(() =>
  rentals.value
    .filter((r) => !swaps.value.some((s) => s.rental.id === r.id))
    .map((r) => ({ value: r.id, label: `${r.rentalNumber} · ${r.driver.fullName} · ${r.vehicle.plate}` })),
);
const reserveOptions = computed(() => rows.value.filter((r) => r.usableAsReplacement).map((r) => ({ value: r.vehicleId, label: `${r.plate} · ${r.label}` })));

async function load() {
  loading.value = true;
  try {
    const [a, s, r] = await Promise.all([
      api.get<{ data: AvailabilityRow[] }>('/vehicles/availability'),
      api.get<{ data: VehicleSwap[] }>('/vehicle-swaps?status=ACTIVE'),
      api.get<{ data: Rental[] }>('/rentals?status=ACTIVE&limit=100'),
    ]);
    rows.value = a.data;
    swaps.value = s.data;
    rentals.value = r.data;
  } catch (err) {
    toasts.error('Não foi possível carregar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function startSwap() {
  if (!form.rentalId || !form.replacementVehicleId) {
    toasts.error('Escolha a locação e o carro reserva');
    return;
  }
  saving.value = true;
  try {
    await api.post(`/rentals/${form.rentalId}/swap`, { replacementVehicleId: form.replacementVehicleId, reason: form.reason });
    toasts.success('Carro reserva entregue');
    form.rentalId = '';
    form.replacementVehicleId = '';
    await load();
  } catch (err) {
    toasts.error('Não foi possível trocar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    saving.value = false;
  }
}

async function endSwap(swap: VehicleSwap, originalReturned: boolean) {
  try {
    await api.post(`/vehicle-swaps/${swap.id}/end`, { originalReturned });
    toasts.success(originalReturned ? 'Reserva devolvido e veículo original de volta' : 'Reserva devolvido');
    await load();
  } catch (err) {
    toasts.error('Não foi possível encerrar a troca', err instanceof ApiRequestError ? err.message : undefined);
  }
}
</script>

<template>
  <div>
    <PageHeader eyebrow="Veículos" title="Disponibilidade e carro reserva" subtitle="Veja quem está com cada carro e troque o veículo de uma locação sem perder o contrato." />

    <section v-if="canSwap" class="fo-card mb-6 p-7">
      <h2 class="mb-5 text-xl font-bold text-ink">Entregar carro reserva</h2>
      <form class="grid gap-5 sm:grid-cols-2 lg:grid-cols-4" novalidate @submit.prevent="startSwap">
        <FormField v-slot="field" label="Locação" required>
          <AppSelect :id="field.id" v-model="form.rentalId" placeholder="Escolha a locação" :options="rentalOptions" />
        </FormField>
        <FormField v-slot="field" label="Carro reserva" required>
          <AppSelect :id="field.id" v-model="form.replacementVehicleId" placeholder="Veículo disponível" :options="reserveOptions" />
        </FormField>
        <FormField v-slot="field" label="Motivo">
          <AppSelect :id="field.id" v-model="form.reason" :options="reasonOptions" />
        </FormField>
        <div class="flex items-end"><AppButton type="submit" :loading="saving">Entregar reserva</AppButton></div>
      </form>
      <p class="mt-3 text-sm text-ink-muted">O contrato, a cobrança e o km continuam no veículo original. Só aparecem como reserva os veículos disponíveis, sem OS nem sinistro em aberto.</p>
    </section>

    <section v-if="swaps.length" class="fo-card mb-6 overflow-x-auto">
      <h2 class="p-7 pb-3 text-xl font-bold text-ink">Trocas em andamento</h2>
      <table class="w-full text-left text-[15px]">
        <thead class="border-y border-line text-sm text-ink-muted">
          <tr>
            <th class="px-5 py-3 font-semibold">Locação</th>
            <th class="px-5 py-3 font-semibold">Motorista</th>
            <th class="px-5 py-3 font-semibold">Original</th>
            <th class="px-5 py-3 font-semibold">Reserva</th>
            <th class="px-5 py-3 font-semibold">Desde</th>
            <th class="px-5 py-3 font-semibold">Motivo</th>
            <th v-if="canSwap" class="px-5 py-3 font-semibold"><span class="sr-only">Ações</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in swaps" :key="s.id" class="border-b border-line last:border-0">
            <td class="px-5 py-3">{{ s.rental.rentalNumber }}</td>
            <td class="px-5 py-3">{{ s.driver?.fullName ?? '—' }}</td>
            <td class="px-5 py-3">{{ s.original.plate }}</td>
            <td class="px-5 py-3 font-semibold text-ink">{{ s.replacement.plate }}</td>
            <td class="px-5 py-3">{{ formatIsoDateBR(s.startedOn) }}</td>
            <td class="px-5 py-3">{{ swapReasonLabels[s.reason] }}</td>
            <td v-if="canSwap" class="space-x-3 px-5 py-3 text-right">
              <button type="button" class="text-sm font-semibold text-brand-600 hover:underline" @click="endSwap(s, true)">Devolver e voltar ao original</button>
              <button type="button" class="text-sm font-semibold text-ink-soft hover:underline" @click="endSwap(s, false)">Devolver (original segue parado)</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="fo-card overflow-x-auto">
      <h2 class="p-7 pb-3 text-xl font-bold text-ink">Frota</h2>
      <p v-if="loading" class="p-7 text-ink-muted" role="status">Carregando...</p>
      <EmptyState v-else-if="rows.length === 0" :icon="CarFront" title="Nenhum veículo" message="Cadastre veículos para acompanhar a disponibilidade." />
      <table v-else class="w-full text-left text-[15px]">
        <thead class="border-y border-line text-sm text-ink-muted">
          <tr>
            <th class="px-5 py-3 font-semibold">Veículo</th>
            <th class="px-5 py-3 font-semibold">Situação</th>
            <th class="px-5 py-3 font-semibold">Com</th>
            <th class="px-5 py-3 font-semibold">Até</th>
            <th class="px-5 py-3 font-semibold">Observações</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.vehicleId" class="border-b border-line last:border-0">
            <td class="px-5 py-3"><span class="font-semibold text-ink">{{ r.plate }}</span> <span class="text-ink-muted">{{ r.label }}</span></td>
            <td class="px-5 py-3"><StatusBadge :label="vehicleStatusLabels[r.status]" :tone="tones[r.status] ?? 'slate'" /></td>
            <td class="px-5 py-3">{{ r.driverName ?? '—' }}</td>
            <td class="px-5 py-3">{{ r.rentalNumber ? (r.rentalEndsOn ? formatIsoDateBR(r.rentalEndsOn) : 'Sem término') : '—' }}</td>
            <td class="px-5 py-3 text-sm text-ink-soft">
              <span v-if="r.asReplacementFor" class="block">Reserva do {{ r.asReplacementFor }}</span>
              <span v-if="r.replacedBy" class="block">Trocado pelo {{ r.replacedBy }}</span>
              <span v-if="r.openMaintenance" class="block">{{ r.openMaintenance }} OS em aberto</span>
              <span v-if="r.openClaims" class="block">{{ r.openClaims }} sinistro(s) em aberto</span>
              <span v-if="r.usableAsReplacement" class="block font-semibold text-[rgb(var(--c-positive))]">Pode ser reserva</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
