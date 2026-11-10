<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Wrench } from 'lucide-vue-next';
import {
  formatDateTimeBR,
  maintenanceRequestCategoryLabels,
  maintenanceRequestStatusLabels,
  type MaintenanceRequest,
  type MaintenanceRequestStatus,
} from '@yudirect/contracts';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';

/** Pedidos de manutenção abertos pelos motoristas na Área do Motorista. */
const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();
const requests = ref<MaintenanceRequest[]>([]);
const notes = ref<Record<string, string>>({});
const showAll = ref(false);
const tone = { OPEN: 'amber', SCHEDULED: 'blue', DONE: 'green', REJECTED: 'slate' } as const;

async function load() {
  const res = await api.get<{ data: MaintenanceRequest[] }>('/maintenance-requests');
  requests.value = res.data;
}

async function update(r: MaintenanceRequest, status: MaintenanceRequestStatus) {
  try {
    const updated = await api.patch<MaintenanceRequest>(`/maintenance-requests/${r.id}`, {
      status,
      responseNote: notes.value[r.id] || r.responseNote || undefined,
    });
    Object.assign(r, updated);
    toasts.success('Pedido atualizado — o motorista vê a resposta na Área do Motorista');
  } catch (err) {
    toasts.error('Não foi possível atualizar', err instanceof ApiRequestError ? err.message : undefined);
  }
}

onMounted(() => void load().catch(() => undefined));
</script>

<template>
  <section v-if="requests.length" class="fo-card p-6" aria-label="Pedidos de manutenção dos motoristas">
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="flex items-center gap-2.5 text-xl font-bold text-ink">
        <Wrench class="size-5 text-ink-soft" aria-hidden="true" /> Pedidos dos motoristas
        <span class="rounded-full bg-[rgb(var(--c-warning)/0.15)] px-2 text-sm text-[rgb(var(--c-warning))]">
          {{ requests.filter((r) => r.status === 'OPEN').length }} novo(s)
        </span>
      </h2>
      <button type="button" class="text-sm font-semibold text-brand-600" @click="showAll = !showAll">
        {{ showAll ? 'Só em aberto' : 'Ver todos' }}
      </button>
    </div>
    <ul class="divide-y divide-line">
      <li
        v-for="r in requests.filter((x) => showAll || x.status === 'OPEN' || x.status === 'SCHEDULED')"
        :key="r.id"
        class="grid gap-3 py-4 lg:grid-cols-[1.5fr_1fr] lg:items-start"
      >
        <div>
          <p class="font-semibold text-ink">
            {{ r.vehicle.plate }} · {{ maintenanceRequestCategoryLabels[r.category] }}
            <span v-if="r.vehicleStopped" class="ml-1 text-sm font-semibold text-[rgb(var(--c-negative))]">carro parado</span>
          </p>
          <p class="text-sm text-ink-muted">{{ r.driver.fullName }} · {{ formatDateTimeBR(r.createdAt) }}{{ r.rentalNumber ? ` · ${r.rentalNumber}` : '' }}</p>
          <p class="mt-1 whitespace-pre-line text-[15px] text-ink-soft">{{ r.description }}</p>
          <div v-if="r.photos.length" class="mt-2 flex flex-wrap gap-2">
            <a v-for="p in r.photos" :key="p.fileId" :href="p.url" target="_blank" rel="noopener">
              <img :src="p.url" alt="Foto enviada pelo motorista" class="size-16 rounded-control object-cover" />
            </a>
          </div>
        </div>
        <div class="space-y-2">
          <StatusBadge :label="maintenanceRequestStatusLabels[r.status]" :tone="tone[r.status]" :solid="false" />
          <template v-if="auth.allows('maintenance', 'update') && (r.status === 'OPEN' || r.status === 'SCHEDULED')">
            <AppInput v-model="notes[r.id]" :placeholder="r.responseNote ?? 'Resposta ao motorista (ex.: oficina amanhã 9h)'" />
            <div class="flex flex-wrap gap-2">
              <AppButton v-if="r.status === 'OPEN'" size="sm" @click="update(r, 'SCHEDULED')">Agendar</AppButton>
              <AppButton size="sm" variant="secondary" @click="update(r, 'DONE')">Resolvido</AppButton>
              <AppButton size="sm" variant="ghost" @click="update(r, 'REJECTED')">Recusar</AppButton>
              <AppButton
                v-if="auth.allows('maintenance', 'create')"
                size="sm"
                variant="link"
                @click="router.push(`/dashboard/maintenance/${r.vehicle.id}/new`)"
              >
                Abrir OS
              </AppButton>
            </div>
          </template>
          <p v-else-if="r.responseNote" class="text-sm text-ink-soft">Resposta: {{ r.responseNote }}</p>
        </div>
      </li>
    </ul>
  </section>
</template>
