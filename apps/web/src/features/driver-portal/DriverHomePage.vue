<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { AlertTriangle, Award, Camera, Car, FileSignature, Gauge, MessageCircle, PhoneCall, Receipt } from 'lucide-vue-next';
import {
  businessDate,
  diffDaysIso,
  formatCentsBRL,
  formatIsoDateBR,
  portalInvoiceStatusLabels,
  rentalTypeLabels,
  type ContractSignature,
  type LoyaltyStatus,
  type RentalKmSummary,
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

const loyalty = ref<LoyaltyStatus | null>(null);
const contracts = ref<ContractSignature[]>([]);
const km = ref<{ rentalId: string | null; summary: RentalKmSummary | null } | null>(null);
const kmRatio = computed(() => {
  const s = km.value?.summary;
  return s && s.allowedKm ? s.drivenKm / s.allowedKm : 0;
});

onMounted(async () => {
  const [inv, insp, fin, loy, con, kms] = await Promise.allSettled([
    portalGet<PortalInvoices>('/driver/invoices'),
    portalGet<{ data: PortalInspection[] }>('/driver/inspections'),
    portalGet<{ data: PortalFine[] }>('/driver/fines'),
    portalGet<LoyaltyStatus>('/driver/loyalty'),
    portalGet<{ data: ContractSignature[] }>('/driver/contracts'),
    portalGet<{ rentalId: string | null; summary: RentalKmSummary | null }>('/driver/km'),
  ]);
  if (inv.status === 'fulfilled') invoices.value = inv.value;
  if (insp.status === 'fulfilled') inspections.value = insp.value.data;
  if (fin.status === 'fulfilled') fines.value = fin.value.data;
  if (loy.status === 'fulfilled') loyalty.value = loy.value;
  if (con.status === 'fulfilled') contracts.value = con.value.data;
  if (kms.status === 'fulfilled') km.value = kms.value;
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

    <!-- Contrato para assinar -->
    <a
      v-for="c in contracts.filter((x) => x.status === 'SENT' && x.signUrl)"
      :key="c.id"
      :href="c.signUrl!"
      target="_blank"
      rel="noopener"
      class="fo-card flex items-center gap-3 border-l-4 border-l-brand-500 p-4"
    >
      <FileSignature class="size-6 shrink-0 text-brand-600" aria-hidden="true" />
      <div class="flex-1">
        <p class="font-semibold text-ink">Assine seu contrato</p>
        <p class="text-sm text-ink-muted">Leva 2 minutos: selfie, foto da CNH e assinatura na tela.</p>
      </div>
      <span class="text-sm font-semibold text-brand-600">Assinar</span>
    </a>

    <!-- KM -->
    <section v-if="km?.summary?.policy?.weeklyFranchiseKm" class="fo-card p-5" aria-label="Quilometragem">
      <h2 class="mb-3 flex items-center gap-2 text-lg font-bold text-ink"><Gauge class="size-5 text-ink-soft" aria-hidden="true" /> Quilometragem</h2>
      <div class="h-2 overflow-hidden rounded-full bg-surface-muted">
        <div
          class="h-full rounded-full"
          :class="kmRatio > 1 ? 'bg-[rgb(var(--c-negative-solid))]' : kmRatio > 0.85 ? 'bg-[rgb(var(--c-warning-solid))]' : 'bg-brand-500'"
          :style="{ width: `${Math.min(100, Math.round(kmRatio * 100))}%` }"
        />
      </div>
      <p class="mt-2 text-[15px] text-ink">
        {{ km.summary.drivenKm.toLocaleString('pt-BR') }} km rodados de {{ (km.summary.allowedKm ?? 0).toLocaleString('pt-BR') }} km de franquia até agora
      </p>
      <p class="text-sm text-ink-muted">
        Franquia de {{ km.summary.policy.weeklyFranchiseKm.toLocaleString('pt-BR') }} km/semana · km extra a {{ formatCentsBRL(km.summary.policy.extraKmPriceCents) }}
      </p>
    </section>

    <!-- Fidelidade -->
    <section v-if="loyalty?.enabled" class="fo-card p-5" aria-label="Fidelidade">
      <h2 class="mb-1 flex items-center gap-2 text-lg font-bold text-ink"><Award class="size-5 text-ink-soft" aria-hidden="true" /> Nível {{ loyalty.level.name }}</h2>
      <p class="text-sm text-ink-muted">{{ loyalty.score }} pontos{{ loyalty.nextLevel ? ` · faltam ${loyalty.pointsToNext} para ${loyalty.nextLevel.name}` : ' · nível máximo' }}</p>
      <ul v-if="loyalty.level.benefits.length" class="mt-3 space-y-1 text-[15px] text-ink">
        <li v-for="b in loyalty.level.benefits" :key="b">✓ {{ b }}</li>
      </ul>
      <details class="mt-3 text-sm">
        <summary class="cursor-pointer font-semibold text-brand-600">Como subir de nível</summary>
        <ul class="mt-2 space-y-1">
          <li v-for="c in loyalty.criteria" :key="c.key" class="flex justify-between gap-3">
            <span class="text-ink-soft">{{ c.label }} <span class="text-ink-muted">({{ c.detail }})</span></span>
            <span class="tabular font-semibold" :class="c.points < 0 ? 'text-[rgb(var(--c-negative))]' : 'text-ink'">{{ c.points > 0 ? '+' : '' }}{{ c.points }}</span>
          </li>
        </ul>
      </details>
    </section>

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
