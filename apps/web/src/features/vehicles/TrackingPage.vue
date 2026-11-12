<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { MapPin } from 'lucide-vue-next';
import type { Geofence, TrackedVehicle, Vehicle } from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppSelect from '@/components/ui/AppSelect.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/**
 * Rastreamento: última posição de cada carro, áreas permitidas e a conexão com a plataforma de
 * rastreadores (webhook com token). Não bloqueia nem imobiliza veículos.
 */
const auth = useAuthStore();
const toasts = useToastStore();
interface DeviceRow { id: string; vehicleId: string; deviceId: string; label: string | null }

const overview = ref<TrackedVehicle[]>([]);
const devices = ref<DeviceRow[]>([]);
const zones = ref<Geofence[]>([]);
const vehicles = ref<Vehicle[]>([]);
const tokenInfo = ref<{ configured: boolean; rotatedAt: string | null; webhookUrl: string } | null>(null);
const newToken = ref('');
const loading = ref(true);
const deviceForm = reactive({ vehicleId: '', deviceId: '', label: '' });
const zoneForm = reactive({ name: '', lat: '', lng: '', radiusM: '' });

const canEdit = computed(() => auth.allows('vehicles', 'update'));
const canToken = computed(() => auth.me?.organization?.role === 'OWNER' || auth.me?.organization?.role === 'ADMIN');
const plateOf = (id: string) => vehicles.value.find((v) => v.id === id)?.plate ?? '—';
const fail = (title: string, err: unknown) => toasts.error(title, err instanceof ApiRequestError ? err.message : undefined);

function ago(minutes: number | null): string {
  if (minutes === null) return 'Nunca reportou';
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  if (minutes < 48 * 60) return `há ${Math.floor(minutes / 60)} h`;
  return `há ${Math.floor(minutes / 1440)} dias`;
}

async function load() {
  loading.value = true;
  try {
    const [o, d, z, v, t] = await Promise.all([
      api.get<{ data: TrackedVehicle[] }>('/tracking/overview'),
      api.get<{ data: DeviceRow[] }>('/tracking/devices'),
      api.get<{ data: Geofence[] }>('/tracking/geofences'),
      api.get<{ data: Vehicle[] }>('/vehicles?limit=100'),
      api.get<{ configured: boolean; rotatedAt: string | null; webhookUrl: string }>('/tracking/token'),
    ]);
    overview.value = o.data;
    devices.value = d.data;
    zones.value = z.data;
    vehicles.value = v.data;
    tokenInfo.value = t;
  } catch (err) {
    fail('Não foi possível carregar o rastreamento', err);
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function rotateToken() {
  try {
    newToken.value = (await api.post<{ token: string }>('/tracking/token', {})).token;
    await load();
  } catch (err) {
    fail('Não foi possível gerar o token', err);
  }
}
async function addDevice() {
  try {
    await api.post('/tracking/devices', { vehicleId: deviceForm.vehicleId, deviceId: deviceForm.deviceId, label: deviceForm.label || undefined });
    toasts.success('Rastreador cadastrado');
    deviceForm.deviceId = '';
    deviceForm.label = '';
    await load();
  } catch (err) {
    fail('Não foi possível cadastrar', err);
  }
}
async function removeDevice(id: string) {
  try {
    await api.delete(`/tracking/devices/${id}`);
    await load();
  } catch (err) {
    fail('Não foi possível remover', err);
  }
}
async function addZone() {
  try {
    await api.post('/tracking/geofences', {
      name: zoneForm.name,
      lat: Number(zoneForm.lat.replace(',', '.')),
      lng: Number(zoneForm.lng.replace(',', '.')),
      radiusM: Number(zoneForm.radiusM),
    });
    toasts.success('Área cadastrada');
    zoneForm.name = '';
    zoneForm.lat = '';
    zoneForm.lng = '';
    zoneForm.radiusM = '';
    await load();
  } catch (err) {
    fail('Não foi possível cadastrar a área', err);
  }
}
async function removeZone(id: string) {
  try {
    await api.delete(`/tracking/geofences/${id}`);
    await load();
  } catch (err) {
    fail('Não foi possível remover a área', err);
  }
}
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Veículos"
      title="Rastreamento"
      subtitle="Última posição dos carros com rastreador, áreas permitidas e alertas de sinal. O sistema mostra e avisa; não bloqueia nem imobiliza veículos."
    />

    <section class="fo-card mb-6 overflow-x-auto">
      <h2 class="p-7 pb-3 text-xl font-bold text-ink">Onde estão os carros</h2>
      <p v-if="loading" class="p-7 text-ink-muted" role="status">Carregando...</p>
      <EmptyState v-else-if="overview.length === 0" :icon="MapPin" title="Nenhum rastreador" message="Cadastre o rastreador de um veículo abaixo e conecte a plataforma de rastreamento pelo token." />
      <table v-else class="w-full text-left text-[15px]">
        <thead class="border-y border-line text-sm text-ink-muted">
          <tr>
            <th class="px-5 py-3 font-semibold">Veículo</th>
            <th class="px-5 py-3 font-semibold">Motorista</th>
            <th class="px-5 py-3 font-semibold">Última posição</th>
            <th class="px-5 py-3 font-semibold">Velocidade</th>
            <th class="px-5 py-3 font-semibold">Área</th>
            <th class="px-5 py-3 font-semibold">Mapa</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in overview" :key="r.vehicleId" class="border-b border-line last:border-0">
            <td class="px-5 py-3"><span class="font-semibold text-ink">{{ r.plate }}</span> <span class="text-ink-muted">{{ r.label }}</span></td>
            <td class="px-5 py-3">{{ r.driverName ?? '—' }}</td>
            <td class="px-5 py-3">{{ ago(r.minutesAgo) }}</td>
            <td class="px-5 py-3">{{ r.position?.speedKmh != null ? `${r.position.speedKmh} km/h` : '—' }}</td>
            <td class="px-5 py-3">
              <StatusBadge v-if="r.insideAllowedArea === null" label="Sem áreas" tone="slate" />
              <StatusBadge v-else-if="r.insideAllowedArea" label="Dentro" tone="green" />
              <StatusBadge v-else label="Fora da área" tone="red" />
            </td>
            <td class="px-5 py-3"><a v-if="r.mapUrl" :href="r.mapUrl" target="_blank" rel="noopener noreferrer" class="text-sm font-semibold text-brand-600 hover:underline">Abrir no mapa</a><span v-else>—</span></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="fo-card mb-6 p-7">
      <h2 class="mb-3 text-xl font-bold text-ink">Conexão com a plataforma de rastreadores</h2>
      <p class="text-[15px] text-ink-muted">
        Qualquer plataforma que envie posições por webhook (JSON) funciona. Envie um <code>POST</code> para o endereço abaixo com o cabeçalho
        <code>x-tracker-token</code>. Cada posição tem <code>deviceId</code>, <code>lat</code>, <code>lng</code> e <code>at</code> (ISO com fuso); <code>speedKmh</code>, <code>ignition</code> e <code>odometerKm</code> são opcionais.
      </p>
      <p v-if="tokenInfo" class="mt-3 break-all rounded-control bg-surface-muted p-3 font-mono text-sm text-ink">{{ tokenInfo.webhookUrl }}</p>
      <p v-if="tokenInfo?.configured" class="mt-3 text-sm text-ink-soft">Token configurado{{ tokenInfo.rotatedAt ? ` em ${new Date(tokenInfo.rotatedAt).toLocaleDateString('pt-BR')}` : '' }}. Por segurança ele não é mostrado de novo.</p>
      <p v-else class="mt-3 text-sm text-ink-soft">Nenhum token gerado ainda.</p>
      <div v-if="newToken" class="mt-3 rounded-control border border-line p-3" role="status">
        <p class="text-sm font-semibold text-ink">Copie agora, ele não aparecerá novamente:</p>
        <p class="mt-1 break-all font-mono text-sm text-ink">{{ newToken }}</p>
      </div>
      <div v-if="canToken" class="mt-4">
        <AppButton variant="secondary" @click="rotateToken">{{ tokenInfo?.configured ? 'Gerar novo token (invalida o atual)' : 'Gerar token' }}</AppButton>
      </div>
    </section>

    <div class="grid gap-6 xl:grid-cols-2">
      <section class="fo-card p-7">
        <h2 class="mb-4 text-xl font-bold text-ink">Rastreadores</h2>
        <form v-if="canEdit" class="mb-5 grid gap-4 sm:grid-cols-2" novalidate @submit.prevent="addDevice">
          <FormField v-slot="field" label="Veículo" required>
            <AppSelect :id="field.id" v-model="deviceForm.vehicleId" placeholder="Escolha o veículo" :options="vehicles.map((v) => ({ value: v.id, label: `${v.plate} · ${v.brand} ${v.model}` }))" />
          </FormField>
          <FormField v-slot="field" label="Código do rastreador (IMEI/serial)" required>
            <AppInput :id="field.id" v-model="deviceForm.deviceId" />
          </FormField>
          <FormField v-slot="field" label="Apelido">
            <AppInput :id="field.id" v-model="deviceForm.label" />
          </FormField>
          <div class="flex items-end"><AppButton type="submit" :disabled="!deviceForm.vehicleId || !deviceForm.deviceId">Cadastrar rastreador</AppButton></div>
        </form>
        <ul class="divide-y divide-line text-[15px]">
          <li v-for="d in devices" :key="d.id" class="flex items-center justify-between gap-3 py-2">
            <span><span class="font-semibold text-ink">{{ plateOf(d.vehicleId) }}</span> <span class="text-ink-muted">{{ d.deviceId }}{{ d.label ? ` · ${d.label}` : '' }}</span></span>
            <button v-if="canEdit" type="button" class="text-sm font-semibold text-[rgb(var(--c-negative))] hover:underline" @click="removeDevice(d.id)">Remover</button>
          </li>
          <li v-if="devices.length === 0" class="py-2 text-ink-muted">Nenhum rastreador cadastrado.</li>
        </ul>
      </section>

      <section class="fo-card p-7">
        <h2 class="mb-2 text-xl font-bold text-ink">Áreas permitidas</h2>
        <p class="mb-4 text-sm text-ink-muted">Se houver áreas cadastradas, a equipe é avisada quando um carro locado sai de todas elas (um aviso por dia).</p>
        <form v-if="canEdit" class="mb-5 grid gap-4 sm:grid-cols-2" novalidate @submit.prevent="addZone">
          <FormField v-slot="field" label="Nome" required><AppInput :id="field.id" v-model="zoneForm.name" placeholder="São Paulo capital" /></FormField>
          <FormField v-slot="field" label="Raio (metros)" required><AppInput :id="field.id" v-model="zoneForm.radiusM" inputmode="numeric" placeholder="20000" /></FormField>
          <FormField v-slot="field" label="Latitude do centro" required><AppInput :id="field.id" v-model="zoneForm.lat" inputmode="decimal" placeholder="-23,5505" /></FormField>
          <FormField v-slot="field" label="Longitude do centro" required><AppInput :id="field.id" v-model="zoneForm.lng" inputmode="decimal" placeholder="-46,6333" /></FormField>
          <div class="sm:col-span-2"><AppButton type="submit" :disabled="!zoneForm.name || !zoneForm.lat || !zoneForm.lng || !zoneForm.radiusM">Cadastrar área</AppButton></div>
        </form>
        <ul class="divide-y divide-line text-[15px]">
          <li v-for="z in zones" :key="z.id" class="flex items-center justify-between gap-3 py-2">
            <span><span class="font-semibold text-ink">{{ z.name }}</span> <span class="text-ink-muted">raio de {{ (z.radiusM / 1000).toLocaleString('pt-BR') }} km</span></span>
            <button v-if="canEdit" type="button" class="text-sm font-semibold text-[rgb(var(--c-negative))] hover:underline" @click="removeZone(z.id)">Remover</button>
          </li>
          <li v-if="zones.length === 0" class="py-2 text-ink-muted">Nenhuma área cadastrada.</li>
        </ul>
      </section>
    </div>
  </div>
</template>
