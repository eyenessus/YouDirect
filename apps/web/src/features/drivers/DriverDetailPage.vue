<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  CalendarDays,
  CreditCard,
  DollarSign,
  FileText,
  Mail,
  MapPin,
  Pencil,
  Phone,
  ShieldCheck,
  User,
} from 'lucide-vue-next';
import {
  driverStatusLabels,
  formatDateTimeBR,
  formatIsoDateBR,
  maskCpf,
  maskPhone,
  maskPostalCode,
  type Driver,
  type Rental,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppInput from '@/components/ui/AppInput.vue';
import AppModal from '@/components/ui/AppModal.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import FormField from '@/components/ui/FormField.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import WhatsappConsentCard from './WhatsappConsentCard.vue';
import FinesPanel from '@/features/fines/FinesPanel.vue';
import DriverPortalCard from './DriverPortalCard.vue';
import DriverLoyaltyCard from './DriverLoyaltyCard.vue';
import DriverCreditCard from '@/features/credit/DriverCreditCard.vue';
import { api, ApiRequestError, downloadFile } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();

const driver = ref<Driver | null>(null);
const loading = ref(true);
const chooserOpen = ref(false);
const activeRentals = ref<Rental[]>([]);
const openingPayments = ref(false);

const paymentsLink = (rentalId: string) => ({ path: `/dashboard/rentals/${rentalId}`, query: { tab: 'payments' } });

/** Lançar pagamento: leva à locação ATIVA do motorista (aba Pagamentos). */
async function openPayments() {
  if (!driver.value) return;
  openingPayments.value = true;
  try {
    const res = await api.get<{ data: Rental[] }>('/rentals', {
      query: { driverId: driver.value.id, status: 'ACTIVE', limit: 50 },
    });
    activeRentals.value = res.data;
    if (res.data.length === 1) await router.push(paymentsLink(res.data[0]!.id));
    else if (res.data.length > 1) chooserOpen.value = true;
    else toasts.warning('Motorista sem locação ativa', 'Cadastre uma locação para lançar pagamentos.');
  } catch {
    toasts.error('Não foi possível abrir os pagamentos');
  } finally {
    openingPayments.value = false;
  }
}

/* ----------------------------- LGPD ------------------------------ */
const exporting = ref(false);
const anonymizeOpen = ref(false);
const anonymizeConfirm = ref('');
const anonymizing = ref(false);

async function exportData() {
  if (!driver.value) return;
  exporting.value = true;
  try {
    await downloadFile(`/drivers/${driver.value.id}/data-export`, `dados-motorista-${driver.value.id}.json`);
  } catch (err) {
    toasts.error('Não foi possível exportar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    exporting.value = false;
  }
}

async function anonymize() {
  if (!driver.value) return;
  anonymizing.value = true;
  try {
    await api.post(`/drivers/${driver.value.id}/anonymize`, { confirm: anonymizeConfirm.value.trim() });
    toasts.success('Motorista anonimizado', 'Os dados pessoais foram apagados; o histórico financeiro foi mantido.');
    anonymizeOpen.value = false;
    await router.replace('/dashboard/drivers');
  } catch (err) {
    toasts.error('Não foi possível anonimizar', err instanceof ApiRequestError ? err.message : undefined);
  } finally {
    anonymizing.value = false;
  }
}

async function reload() {
  driver.value = await api.get<Driver>(`/drivers/${route.params.id}`);
}

onMounted(async () => {
  try {
    await reload();
  } catch {
    toasts.error('Motorista não encontrado');
    router.replace('/dashboard/drivers');
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="space-y-6">
    <AppSkeleton v-if="loading" variant="block" />

    <template v-else-if="driver">
      <PageHeader
        eyebrow="FROTA"
        :title="driver.fullName"
        subtitle="Detalhes do motorista"
        back-to="/dashboard/drivers"
      >
        <template #actions>
          <AppButton v-if="auth.allows('finance', 'pay')" variant="secondary" :loading="openingPayments" @click="openPayments">
            <template #icon><DollarSign class="size-4" /></template>
            Lançar pagamento
          </AppButton>
          <AppButton
            v-if="auth.allows('drivers', 'update')"
            @click="router.push(`/dashboard/drivers/${driver.id}/edit`)"
          >
            <template #icon><Pencil class="size-4" /></template>
            Editar
          </AppButton>
        </template>
      </PageHeader>

      <section
        v-if="auth.allows('drivers', 'export') || auth.isOwnerOrAdmin"
        class="fo-card flex flex-wrap items-center justify-between gap-4 p-5"
      >
        <div class="min-w-0">
          <p class="font-semibold text-ink">Dados pessoais (LGPD)</p>
          <p class="text-sm text-ink-muted">
            Atenda pedidos do titular: exportar tudo o que a empresa guarda ou anonimizar o cadastro.
          </p>
        </div>
        <div class="flex flex-wrap gap-3">
          <AppButton v-if="auth.allows('drivers', 'export')" variant="secondary" :loading="exporting" @click="exportData">
            Exportar dados
          </AppButton>
          <AppButton v-if="auth.isOwnerOrAdmin" variant="danger-outline" @click="anonymizeOpen = true">
            Anonimizar
          </AppButton>
        </div>
      </section>

      <div class="grid gap-6 xl:grid-cols-2">
        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <User class="size-5 text-ink-soft" aria-hidden="true" /> Informações Pessoais
          </h2>
          <dl class="grid gap-x-8 gap-y-6 sm:grid-cols-2">
            <div>
              <dt class="text-[15px] text-ink-muted">Nome Completo</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">{{ driver.fullName }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">CPF</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">{{ maskCpf(driver.cpf) }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">RG</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">{{ driver.rg ?? '—' }}</dd>
            </div>
            <div>
              <dt class="flex items-center gap-1.5 text-[15px] text-ink-muted">
                <CalendarDays class="size-4" aria-hidden="true" /> Data de Nascimento
              </dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">
                {{ formatIsoDateBR(driver.birthDate) }}
              </dd>
            </div>
          </dl>
        </section>

        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <Phone class="size-5 text-ink-soft" aria-hidden="true" /> Contato
          </h2>
          <dl class="space-y-6">
            <div>
              <dt class="flex items-center gap-1.5 text-[15px] text-ink-muted">
                <Phone class="size-4" aria-hidden="true" /> Telefone
              </dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">
                {{ maskPhone(driver.phone) }}
              </dd>
            </div>
            <div>
              <dt class="flex items-center gap-1.5 text-[15px] text-ink-muted">
                <Mail class="size-4" aria-hidden="true" /> E-mail
              </dt>
              <dd class="mt-1 break-all text-[17px] font-semibold text-ink">{{ driver.email ?? '—' }}</dd>
            </div>
          </dl>
        </section>

        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <MapPin class="size-5 text-ink-soft" aria-hidden="true" /> Endereço
          </h2>
          <dl class="grid gap-x-8 gap-y-6 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <dt class="text-[15px] text-ink-muted">Logradouro</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">
                {{
                  [driver.address.street, driver.address.number].filter(Boolean).join(', ') || '—'
                }}
              </dd>
            </div>
            <div class="sm:col-span-2">
              <dt class="text-[15px] text-ink-muted">Bairro</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">{{ driver.address.district ?? '—' }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Cidade</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">{{ driver.address.city ?? '—' }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Estado</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">{{ driver.address.state ?? '—' }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">CEP</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">
                {{ maskPostalCode(driver.address.postalCode) }}
              </dd>
            </div>
          </dl>
        </section>

        <section class="fo-card p-7">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <CreditCard class="size-5 text-ink-soft" aria-hidden="true" /> Carteira de Habilitação
          </h2>
          <dl class="grid gap-x-8 gap-y-6 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <dt class="text-[15px] text-ink-muted">Número da CNH</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">
                {{ driver.cnhNumber ?? '—' }}
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Categoria</dt>
              <dd class="mt-1 text-[17px] font-semibold text-ink">{{ driver.cnhCategory ?? '—' }}</dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Validade</dt>
              <dd class="mt-1 flex items-center gap-2 text-[17px] font-semibold tabular text-ink">
                {{ formatIsoDateBR(driver.cnhExpiresAt) }}
                <StatusBadge v-if="driver.cnhExpired" label="Vencida" tone="red" :solid="false" />
              </dd>
            </div>
          </dl>
        </section>

        <section class="fo-card p-7 xl:col-span-2">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <FileText class="size-5 text-ink-soft" aria-hidden="true" /> Documentos
          </h2>
          <div class="grid gap-4 sm:grid-cols-2">
            <a
              v-if="driver.idDocument"
              :href="driver.idDocument.url"
              target="_blank"
              rel="noopener"
              class="flex items-start gap-3 rounded-card border border-line p-5 transition-colors hover:border-brand-400"
            >
              <ShieldCheck class="mt-0.5 size-5 text-brand-500" aria-hidden="true" />
              <span>
                <span class="block font-semibold text-ink">Documento de Identificação</span>
                <span class="mt-0.5 block text-sm text-ink-muted">Clique para visualizar</span>
              </span>
            </a>
            <div
              v-else
              class="rounded-card border border-dashed border-line p-5 text-[15px] text-ink-muted"
            >
              Documento de identificação não enviado.
            </div>

            <a
              v-if="driver.addressProof"
              :href="driver.addressProof.url"
              target="_blank"
              rel="noopener"
              class="flex items-start gap-3 rounded-card border border-line p-5 transition-colors hover:border-brand-400"
            >
              <ShieldCheck class="mt-0.5 size-5 text-brand-500" aria-hidden="true" />
              <span>
                <span class="block font-semibold text-ink">Comprovante de Endereço</span>
                <span class="mt-0.5 block text-sm text-ink-muted">Clique para visualizar</span>
              </span>
            </a>
            <div
              v-else
              class="rounded-card border border-dashed border-line p-5 text-[15px] text-ink-muted"
            >
              Comprovante de endereço não enviado.
            </div>
          </div>
        </section>

        <section class="fo-card p-7 xl:col-span-2">
          <h2 class="mb-6 flex items-center gap-2.5 text-xl font-bold text-ink">
            <CalendarDays class="size-5 text-ink-soft" aria-hidden="true" /> Informações do Sistema
          </h2>
          <dl class="grid gap-x-8 gap-y-6 sm:grid-cols-3">
            <div>
              <dt class="text-[15px] text-ink-muted">Data de cadastro</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">
                {{ formatDateTimeBR(driver.createdAt) }}
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Status</dt>
              <dd class="mt-1">
                <StatusBadge
                  :label="driverStatusLabels[driver.status]"
                  :tone="statusTone.driver[driver.status]"
                  :solid="false"
                />
              </dd>
            </div>
            <div>
              <dt class="text-[15px] text-ink-muted">Locações ativas</dt>
              <dd class="mt-1 text-[17px] font-semibold tabular text-ink">
                {{ driver.activeRentalsCount }}
              </dd>
            </div>
          </dl>
        </section>

        <WhatsappConsentCard :driver="driver" @updated="reload" />

        <DriverPortalCard :driver-id="driver.id" :active="driver.status === 'ACTIVE'" />

        <DriverLoyaltyCard :driver-id="driver.id" />

        <DriverCreditCard v-if="auth.allows('credit', 'read')" :driver-id="driver.id" :has-cpf="Boolean(driver.cpf)" />

        <FinesPanel v-if="auth.allows('fines', 'read')" class="xl:col-span-2" :driver-id="driver.id" />
      </div>
    </template>

    <AppModal :open="chooserOpen" :title="`Lançar pagamento — ${driver?.fullName ?? ''}`" @close="chooserOpen = false">
      <p class="mb-4 text-[15px] text-ink-soft">Este motorista tem mais de uma locação ativa. Escolha a locação:</p>
      <ul class="divide-y divide-line">
        <li v-for="r in activeRentals" :key="r.id" class="flex items-center justify-between gap-4 py-3">
          <div>
            <p class="font-semibold text-ink">{{ r.rentalNumber }}</p>
            <p class="text-sm text-ink-muted">{{ r.vehicle.plate }} · {{ r.vehicle.brand }} {{ r.vehicle.model }}</p>
          </div>
          <AppButton @click="router.push(paymentsLink(r.id))">Abrir pagamentos</AppButton>
        </li>
      </ul>
      <template #footer>
        <AppButton variant="secondary" @click="chooserOpen = false">Fechar</AppButton>
      </template>
    </AppModal>

    <AppModal
      :open="anonymizeOpen"
      title="Anonimizar motorista"
      description="Apaga nome, CPF, RG, contato, CNH, endereço e documentos. Locações, cobranças e pagamentos ficam no histórico, sem identificação. Não pode ser desfeito."
      @close="anonymizeOpen = false"
    >
      <FormField v-slot="field" label="Digite ANONIMIZAR para confirmar" required>
        <AppInput :id="field.id" v-model="anonymizeConfirm" autocomplete="off" />
      </FormField>
      <template #footer>
        <AppButton variant="secondary" @click="anonymizeOpen = false">Cancelar</AppButton>
        <AppButton
          variant="danger"
          :disabled="anonymizeConfirm.trim() !== 'ANONIMIZAR'"
          :loading="anonymizing"
          @click="anonymize"
        >
          Anonimizar
        </AppButton>
      </template>
    </AppModal>
  </div>
</template>
