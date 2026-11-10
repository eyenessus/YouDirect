<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { AlertTriangle, Camera, Car, MessageCircle, PhoneCall, Receipt } from 'lucide-vue-next';
import {
  businessDate,
  diffDaysIso,
  formatCentsBRL,
  formatIsoDateBR,
  portalInvoiceStatusLabels,
  rentalTypeLabels,
  type PortalFine,
  type PortalInspection,
  type PortalInvoices,
  type RentalType,
} from '@yudirect/contracts';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { portalGet, usePortal, whatsappLink } from './usePortal';

const portal = usePortal();
const today = businessDate();
const invoices = ref<PortalInvoices | null>(null);
const inspections = ref<PortalInspection[]>([]);
const fines = ref<PortalFine[]>([]);

const active = computed(() => portal.state.rentals.find((r) => r.status === 'ACTIVE') ?? null);
const finesToPay = computed(() => fines.value.filter((f) => f.charge && f.charge.remainingCents > 0));
const cnhDays = computed(() => {
  const exp = portal.state.me?.driver.cnhExpiresAt;
  return exp ? diffDaysIso(exp, today) : null;
});
const whats = computed(() => whatsappLink(portal.state.me?.organization.whatsappPhone, 'Olá! Sou motorista e preciso de ajuda.'));
const emergency = computed(() => portal.state.me?.organization.emergencyPhone ?? null);

const statusTone = { OPEN: 'slate', PARTIAL: 'amber', PAID: 'green', OVERDUE: 'red' } as const;

onMounted(async () => {
  const [inv, insp, fin] = await Promise.allSettled([
    portalGet<PortalInvoices>('/driver/invoices'),
    portalGet<{ data: PortalInspection[] }>('/driver/inspections'),
    portalGet<{ data: PortalFine[] }>('/driver/fines'),
  ]);
  if (inv.status === 'fulfilled') invoices.value = inv.value;
  if (insp.status === 'fulfilled') inspections.value = insp.value.data;
  if (fin.status === 'fulfilled') fines.value = fin.value.data;
});
</script>

<template>
  <div class="space-y-4">
    <!-- Alertas -->
    <a
      v-for="i in inspections"
      :key="i.id"
      :href="i.link ?? undefined"
      class="fo-card flex items-center gap-3 border-l-4 border-l-[rgb(var(--c-warning))] p-4"
    >
      <Camera class="size-6 shrink-0 text-[rgb(var(--c-warning))]" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="font-semibold text-ink">Vistoria pendente · {{ i.plate }}</p>
        <p class="text-sm text-ink-muted">Envie as fotos até {{ formatIsoDateBR(i.dueDate) }}</p>
      </div>
      <span class="text-sm font-semibold text-brand-600">Fazer</span>
    </a>
    <RouterLink
      v-if="finesToPay.length"
      to="/motorista/multas"
      class="fo-card flex items-center gap-3 border-l-4 border-l-[rgb(var(--c-negative))] p-4"
    >
      <AlertTriangle class="size-6 shrink-0 text-[rgb(var(--c-negative))]" aria-hidden="true" />
      <div class="flex-1">
        <p class="font-semibold text-ink">{{ finesToPay.length }} multa(s) a pagar</p>
        <p class="text-sm text-ink-muted">Veja o detalhe e o vencimento</p>
      </div>
    </RouterLink>
    <div
      v-if="cnhDays !== null && cnhDays <= 30"
      class="fo-card flex items-center gap-3 border-l-4 border-l-[rgb(var(--c-warning))] p-4"
    >
      <AlertTriangle class="size-6 shrink-0 text-[rgb(var(--c-warning))]" aria-hidden="true" />
      <p class="text-[15px] text-ink">
        {{ cnhDays < 0 ? 'Sua CNH está vencida.' : `Sua CNH vence em ${cnhDays} dia(s).` }}
        Envie a nova em <RouterLink to="/motorista/conta" class="font-semibold text-brand-600">Conta</RouterLink>.
      </p>
    </div>

    <!-- Locação -->
    <section class="fo-card p-5" aria-label="Minha locação">
      <h2 class="mb-3 flex items-center gap-2 text-lg font-bold text-ink"><Car class="size-5 text-ink-soft" aria-hidden="true" /> Minha locação</h2>
      <template v-if="active">
        <p class="text-2xl font-bold tracking-wide text-ink">{{ active.vehicle.plate }}</p>
        <p class="text-[15px] text-ink-soft">
          {{ active.vehicle.brand }} {{ active.vehicle.model }}{{ active.vehicle.year ? ` ${active.vehicle.year}` : '' }}{{ active.vehicle.color ? ` · ${active.vehicle.color}` : '' }}
        </p>
        <dl class="mt-4 grid grid-cols-2 gap-3 text-[15px]">
          <div>
            <dt class="text-ink-muted">Contrato</dt>
            <dd class="font-semibold text-ink">{{ active.rentalNumber }}</dd>
          </div>
          <div>
            <dt class="text-ink-muted">{{ rentalTypeLabels[active.rentalType as RentalType] ?? active.rentalType }}</dt>
            <dd class="font-semibold tabular text-ink">{{ formatCentsBRL(active.periodicAmountCents) }}</dd>
          </div>
          <div>
            <dt class="text-ink-muted">Início</dt>
            <dd class="tabular text-ink">{{ formatIsoDateBR(active.startDate) }}</dd>
          </div>
          <div>
            <dt class="text-ink-muted">Término</dt>
            <dd class="tabular text-ink">{{ active.endDate ? formatIsoDateBR(active.endDate) : 'Sem data' }}</dd>
          </div>
        </dl>
      </template>
      <p v-else class="text-[15px] text-ink-muted">Você não tem locação ativa no momento.</p>
    </section>

    <!-- Próxima fatura -->
    <RouterLink to="/motorista/faturas" class="fo-card block p-5" aria-label="Próxima fatura">
      <h2 class="mb-3 flex items-center gap-2 text-lg font-bold text-ink"><Receipt class="size-5 text-ink-soft" aria-hidden="true" /> Próxima fatura</h2>
      <template v-if="invoices?.next">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-2xl font-bold tabular text-ink">{{ formatCentsBRL(invoices.next.remainingCents) }}</p>
            <p class="text-[15px] text-ink-muted">{{ invoices.next.description }} · vence {{ formatIsoDateBR(invoices.next.dueDate) }}</p>
          </div>
          <StatusBadge :label="portalInvoiceStatusLabels[invoices.next.status]" :tone="statusTone[invoices.next.status]" :solid="false" />
        </div>
        <p v-if="invoices.totals.overdueCents > 0" class="mt-3 text-sm font-semibold text-[rgb(var(--c-negative))]">
          Em atraso: {{ formatCentsBRL(invoices.totals.overdueCents) }}
        </p>
      </template>
      <p v-else-if="invoices" class="text-[15px] text-ink-muted">Nenhuma fatura em aberto. Tudo em dia!</p>
      <p v-else class="text-[15px] text-ink-muted">Carregando…</p>
    </RouterLink>

    <!-- Contato -->
    <section class="grid grid-cols-2 gap-3" aria-label="Contato">
      <a
        v-if="whats"
        :href="whats"
        target="_blank"
        rel="noopener"
        class="fo-card flex flex-col items-center gap-2 p-4 text-center font-semibold text-ink"
      >
        <MessageCircle class="size-6 text-[rgb(var(--c-positive))]" aria-hidden="true" /> Falar com a locadora
      </a>
      <a v-if="emergency" :href="`tel:${emergency}`" class="fo-card flex flex-col items-center gap-2 p-4 text-center font-semibold text-ink">
        <PhoneCall class="size-6 text-[rgb(var(--c-negative))]" aria-hidden="true" /> Emergência / guincho
      </a>
    </section>
  </div>
</template>
