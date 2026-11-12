<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { Fuel } from 'lucide-vue-next';
import {
  formatCentsBRL,
  formatIsoDateBR,
  fuelTypeLabels,
  fuelTypes,
  type FuelLog,
  type FuelSummary,
  type Vehicle,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppCheckbox from '@/components/ui/AppCheckbox.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import CurrencyInput from '@/components/ui/CurrencyInput.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import FormField from '@/components/ui/FormField.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/** Abastecimento por veículo, com consumo (km/l) e custo por km dos últimos 90 dias. */
const auth = useAuthStore();
const toasts = useToastStore();
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

const vehicles = ref<Vehicle[]>([]);
const logs = ref<FuelLog[]>([]);
const summaries = ref<FuelSummary[]>([]);
const loading = ref(true);
const saving = ref(false);
const errors = ref<Record<string, string>>({});
const form = reactive({ vehicleId: '', date: today, fuelType: 'GASOLINE', liters: '', totalCents: 0, odometerKm: '', fullTank: true, station: '' });

const fuelOptions = fuelTypes.map((f) => ({ value: f, label: fuelTypeLabels[f] }));
const canEdit = () => auth.allows('vehicles', 'update');

const perKm = (cents: number | null) => (cents === null ? '—' : formatCentsBRL(Math.round(cents)));

async function load() {
  loading.value = true;
  try {
    const [v, l, s] = await Promise.all([
      api.get<{ data: Vehicle[] }>('/vehicles?limit=100'),
      api.get<{ data: FuelLog[] }>('/fuel-logs?limit=30'),
      api.get<{ data: FuelSummary[] }>('/fuel-logs/summary?days=90'),
    ]);
    vehicles.value = v.data;
    logs.value = l.data;
    summaries.value = s.data;
  } catch (err) {
    toasts.error('Não foi possível carregar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function submit() {
  errors.value = {};
  if (!form.vehicleId) {
    errors.value = { vehicleId: 'Escolha o veículo' };
    return;
  }
  saving.value = true;
  try {
    await api.post('/fuel-logs', {
      vehicleId: form.vehicleId,
      date: form.date,
      fuelType: form.fuelType,
      liters: Number(String(form.liters).replace(',', '.')),
      totalCents: form.totalCents,
      odometerKm: Number(form.odometerKm),
      fullTank: form.fullTank,
      station: form.station || undefined,
    });
    toasts.success('Abastecimento registrado');
    form.liters = '';
    form.totalCents = 0;
    form.odometerKm = '';
    form.station = '';
    await load();
  } catch (err) {
    if (err instanceof ApiRequestError) {
      errors.value = err.fieldErrors();
      toasts.error(
        Object.keys(errors.value).length > 0 ? 'Revise os campos destacados' : 'Não foi possível registrar',
        Object.keys(errors.value).length > 0 ? undefined : err.message,
      );
    }
  } finally {
    saving.value = false;
  }
}

async function remove(id: string) {
  try {
    await api.delete(`/fuel-logs/${id}`);
    toasts.success('Abastecimento excluído');
    await load();
  } catch (err) {
    toasts.error('Não foi possível excluir', err instanceof ApiRequestError ? err.message : undefined);
  }
}
</script>

<template>
  <div>
    <PageHeader eyebrow="Veículos" title="Abastecimento" subtitle="Registre os abastecimentos e acompanhe o consumo e o custo por km de cada veículo." />

    <section v-if="canEdit()" class="fo-card mb-6 p-7">
      <h2 class="mb-5 text-xl font-bold text-ink">Registrar abastecimento</h2>
      <form class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" novalidate @submit.prevent="submit">
        <FormField v-slot="field" label="Veículo" required :error="errors.vehicleId">
          <AppSelect :id="field.id" v-model="form.vehicleId" placeholder="Escolha o veículo" :invalid="field.invalid" :options="vehicles.map((v) => ({ value: v.id, label: `${v.plate} · ${v.brand} ${v.model}` }))" />
        </FormField>
        <FormField v-slot="field" label="Data" required :error="errors.date">
          <AppInput :id="field.id" v-model="form.date" type="date" :invalid="field.invalid" />
        </FormField>
        <FormField v-slot="field" label="Combustível" :error="errors.fuelType">
          <AppSelect :id="field.id" v-model="form.fuelType" :options="fuelOptions" />
        </FormField>
        <FormField v-slot="field" label="Litros" required :error="errors.liters">
          <AppInput :id="field.id" v-model="form.liters" inputmode="decimal" placeholder="38,5" :invalid="field.invalid" />
        </FormField>
        <FormField v-slot="field" label="Valor pago" required :error="errors.totalCents">
          <CurrencyInput :id="field.id" v-model="form.totalCents" :invalid="field.invalid" />
        </FormField>
        <FormField v-slot="field" label="Hodômetro (km)" required :error="errors.odometerKm">
          <AppInput :id="field.id" v-model="form.odometerKm" inputmode="numeric" :invalid="field.invalid" />
        </FormField>
        <FormField v-slot="field" label="Posto" :error="errors.station">
          <AppInput :id="field.id" v-model="form.station" />
        </FormField>
        <div class="flex items-end"><AppCheckbox v-model="form.fullTank" label="Tanque cheio" /></div>
        <div class="flex items-end justify-end"><AppButton type="submit" :loading="saving">Registrar</AppButton></div>
      </form>
    </section>

    <section class="fo-card mb-6 overflow-x-auto">
      <h2 class="p-7 pb-3 text-xl font-bold text-ink">Consumo e custo por km (últimos 90 dias)</h2>
      <p v-if="loading" class="p-7 text-ink-muted" role="status">Carregando...</p>
      <EmptyState v-else-if="summaries.length === 0" :icon="Fuel" title="Sem abastecimentos" message="Registre o primeiro abastecimento para ver o consumo e o custo por km." />
      <table v-else class="w-full text-left text-[15px]">
        <thead class="border-y border-line text-sm text-ink-muted">
          <tr>
            <th class="px-5 py-3 font-semibold">Veículo</th>
            <th class="px-5 py-3 font-semibold">Abastec.</th>
            <th class="px-5 py-3 font-semibold">Litros</th>
            <th class="px-5 py-3 font-semibold">Gasto</th>
            <th class="px-5 py-3 font-semibold">Km rodados</th>
            <th class="px-5 py-3 font-semibold">Km/l</th>
            <th class="px-5 py-3 font-semibold">Custo/km</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in summaries" :key="s.vehicleId" class="border-b border-line last:border-0">
            <td class="px-5 py-3"><span class="font-semibold text-ink">{{ s.plate }}</span> <span class="text-ink-muted">{{ s.label }}</span></td>
            <td class="px-5 py-3">{{ s.fills }}</td>
            <td class="px-5 py-3">{{ s.liters.toLocaleString('pt-BR') }}</td>
            <td class="px-5 py-3">{{ formatCentsBRL(s.totalCents) }}</td>
            <td class="px-5 py-3">{{ s.distanceKm ?? '—' }}</td>
            <td class="px-5 py-3">{{ s.kmPerLiter?.toLocaleString('pt-BR') ?? '—' }}</td>
            <td class="px-5 py-3">{{ perKm(s.costPerKmCents) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="summaries.length" class="px-7 py-4 text-sm text-ink-muted">Consumo e custo por km só aparecem com dois abastecimentos de tanque cheio no período.</p>
    </section>

    <section v-if="logs.length" class="fo-card overflow-x-auto">
      <h2 class="p-7 pb-3 text-xl font-bold text-ink">Últimos abastecimentos</h2>
      <table class="w-full text-left text-[15px]">
        <thead class="border-y border-line text-sm text-ink-muted">
          <tr>
            <th class="px-5 py-3 font-semibold">Data</th>
            <th class="px-5 py-3 font-semibold">Veículo</th>
            <th class="px-5 py-3 font-semibold">Motorista</th>
            <th class="px-5 py-3 font-semibold">Combustível</th>
            <th class="px-5 py-3 font-semibold">Litros</th>
            <th class="px-5 py-3 font-semibold">Valor</th>
            <th class="px-5 py-3 font-semibold">Km</th>
            <th v-if="canEdit()" class="px-5 py-3 font-semibold"><span class="sr-only">Ação</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in logs" :key="l.id" class="border-b border-line last:border-0">
            <td class="px-5 py-3">{{ formatIsoDateBR(l.date) }}</td>
            <td class="px-5 py-3">{{ l.vehicle.plate }}</td>
            <td class="px-5 py-3">{{ l.driver?.fullName ?? '—' }}</td>
            <td class="px-5 py-3">{{ fuelTypeLabels[l.fuelType] }}{{ l.fullTank ? '' : ' (parcial)' }}</td>
            <td class="px-5 py-3">{{ l.liters.toLocaleString('pt-BR') }}</td>
            <td class="px-5 py-3">{{ formatCentsBRL(l.totalCents) }}</td>
            <td class="px-5 py-3">{{ l.odometerKm.toLocaleString('pt-BR') }}</td>
            <td v-if="canEdit()" class="px-5 py-3 text-right">
              <button type="button" class="text-sm font-semibold text-[rgb(var(--c-negative))] hover:underline" @click="remove(l.id)">Excluir</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
