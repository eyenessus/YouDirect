<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  CalendarDays,
  CreditCard,
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
} from '@frotaone/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { statusTone } from '@/lib/status';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();

const driver = ref<Driver | null>(null);
const loading = ref(true);

onMounted(async () => {
  try {
    driver.value = await api.get<Driver>(`/drivers/${route.params.id}`);
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
          <AppButton
            v-if="auth.allows('drivers', 'update')"
            @click="router.push(`/dashboard/drivers/${driver.id}/edit`)"
          >
            <template #icon><Pencil class="size-4" /></template>
            Editar
          </AppButton>
        </template>
      </PageHeader>

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
      </div>
    </template>
  </div>
</template>
