<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  formatCentsBRL,
  formatIsoDateBR,
  paymentWeekStatusLabels,
  receivableStatusLabels,
  type Receivable,
  type RentalPaymentSchedule,
  type RentalPaymentWeek,
} from '@yudirect/contracts';
import AppModal from '@/components/ui/AppModal.vue';
import AppButton from '@/components/ui/AppButton.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import RegisterPaymentModal from './RegisterPaymentModal.vue';
import { api, ApiRequestError } from '@/lib/api';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

/**
 * Baixa do pagamento do motorista. Lista as contas a receber em aberto (do
 * motorista ou de uma locação) e, para locações, o cronograma de semanas com
 * "Dar baixa" por semana. O pagamento vai para POST /receivables/:id/payments,
 * o mesmo caminho de Contas a Receber > Pagar, e abate as semanas mais antigas
 * primeiro; por isso o valor sugerido é o acumulado pendente até a semana escolhida.
 */
const props = defineProps<{
  open: boolean;
  driverId?: string;
  rentalId?: string;
  title?: string;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();

interface PayTarget {
  receivable: Receivable;
  suggestedCents: number;
  hint?: string;
}

const toasts = useToastStore();
const rows = ref<Receivable[]>([]);
const schedules = ref<Record<string, RentalPaymentSchedule>>({});
const loading = ref(false);
const payTarget = ref<PayTarget | null>(null);

const weekWord = (s: RentalPaymentSchedule) => (s.rentalType === 'WEEKLY' ? 'Semana' : 'Mês');
const weekTone = { PAID: 'green', PARTIAL: 'amber', OPEN: 'blue', OVERDUE: 'red' } as const;

async function load() {
  loading.value = true;
  try {
    // Atualiza status vencidos antes de listar, como a tela de Contas a Receber.
    await api.post('/finance/refresh-statuses').catch(() => undefined);
    const res = await api.get<{ data: Receivable[] }>('/receivables', {
      query: {
        driverId: props.driverId,
        rentalId: props.rentalId,
        openOnly: 'true',
        sort: 'dueDate',
        limit: 50,
      },
    });
    rows.value = res.data.filter((r) => r.remainingCents > 0);

    const next: Record<string, RentalPaymentSchedule> = {};
    await Promise.all(
      rows.value
        .filter((r) => r.rental)
        .map(async (r) => {
          try {
            const schedule = await api.get<RentalPaymentSchedule>(`/rentals/${r.rental!.id}/payment-schedule`);
            if (schedule.weeks.length > 0) next[r.id] = schedule;
          } catch {
            // Sem cronograma, a conta continua podendo receber pelo botão "Pagar".
          }
        }),
    );
    schedules.value = next;
  } catch (err) {
    toasts.error('Falha ao carregar contas a receber', err instanceof ApiRequestError ? err.message : undefined);
    rows.value = [];
    schedules.value = {};
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
);

/** Soma do que falta nas semanas 1..N (o pagamento abate das mais antigas). */
function cumulativeRemaining(schedule: RentalPaymentSchedule, week: RentalPaymentWeek): number {
  return schedule.weeks
    .filter((w) => w.number <= week.number)
    .reduce((acc, w) => acc + w.remainingCents, 0);
}

function payAccount(r: Receivable) {
  payTarget.value = { receivable: r, suggestedCents: r.remainingCents };
}

function payWeek(r: Receivable, schedule: RentalPaymentSchedule, week: RentalPaymentWeek) {
  const word = weekWord(schedule).toLowerCase();
  payTarget.value = {
    receivable: r,
    suggestedCents: cumulativeRemaining(schedule, week),
    hint:
      week.number > 1
        ? `Valor acumulado até a ${word} ${week.number}: o pagamento abate as mais antigas primeiro. Pode ser parcial.`
        : 'Pode ser parcial — o saldo restante continua em aberto.',
  };
}

async function onSaved() {
  emit('saved');
  await load();
}
</script>

<template>
  <AppModal :open="open && payTarget === null" :title="title ?? 'Lançar pagamento'" size="lg" @close="emit('close')">
    <p v-if="loading" class="py-6 text-center text-ink-muted">Carregando…</p>
    <p v-else-if="rows.length === 0" class="py-6 text-center text-ink-muted">
      Nenhuma conta a receber em aberto.
    </p>
    <ul v-else class="divide-y divide-line">
      <li v-for="r in rows" :key="r.id" class="py-4">
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <p class="truncate font-semibold text-ink">{{ r.description }}</p>
            <p class="mt-0.5 text-sm text-ink-muted">
              Pendente no contrato
              <span class="font-semibold tabular text-ink">{{ formatCentsBRL(r.remainingCents) }}</span>
            </p>
            <StatusBadge
              class="mt-1"
              :label="receivableStatusLabels[r.status]"
              :tone="statusTone.receivable[r.status]"
              :solid="false"
            />
          </div>
          <AppButton variant="secondary" @click="payAccount(r)">Pagar valor livre</AppButton>
        </div>

        <table v-if="schedules[r.id]" class="mt-4 w-full text-left text-sm" :aria-label="`Cronograma de ${r.description}`">
          <thead class="text-ink-muted">
            <tr>
              <th class="py-1.5 pr-3 font-medium">{{ weekWord(schedules[r.id]!) }}</th>
              <th class="py-1.5 pr-3 font-medium">Vencimento</th>
              <th class="py-1.5 pr-3 text-right font-medium">Valor</th>
              <th class="py-1.5 pr-3 text-right font-medium">Pendente</th>
              <th class="py-1.5 pr-3 font-medium">Situação</th>
              <th class="py-1.5 text-right font-medium"><span class="sr-only">Ação</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in schedules[r.id]!.weeks" :key="w.number" class="border-t border-line">
              <td class="py-2 pr-3 font-semibold text-ink">{{ w.number }}</td>
              <td class="py-2 pr-3 tabular">{{ formatIsoDateBR(w.dueDate) }}</td>
              <td class="py-2 pr-3 text-right tabular">{{ formatCentsBRL(w.amountCents) }}</td>
              <td class="py-2 pr-3 text-right tabular">{{ formatCentsBRL(w.remainingCents) }}</td>
              <td class="py-2 pr-3">
                <StatusBadge :label="paymentWeekStatusLabels[w.status]" :tone="weekTone[w.status]" :solid="false" />
              </td>
              <td class="py-2 text-right">
                <AppButton
                  v-if="w.remainingCents > 0"
                  size="sm"
                  :aria-label="`Dar baixa na ${weekWord(schedules[r.id]!).toLowerCase()} ${w.number}`"
                  @click="payWeek(r, schedules[r.id]!, w)"
                >
                  Dar baixa
                </AppButton>
              </td>
            </tr>
          </tbody>
        </table>
      </li>
    </ul>
    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">Fechar</AppButton>
    </template>
  </AppModal>

  <RegisterPaymentModal
    :open="payTarget !== null"
    kind="receivable"
    :target="
      payTarget && {
        id: payTarget.receivable.id,
        description: payTarget.receivable.description,
        remainingCents: payTarget.receivable.remainingCents,
      }
    "
    :suggested-amount-cents="payTarget?.suggestedCents"
    :hint="payTarget?.hint"
    @close="payTarget = null"
    @saved="onSaved"
  />
</template>
