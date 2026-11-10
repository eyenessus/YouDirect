<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { CheckCircle2 } from 'lucide-vue-next';
import type { PublicCatalog } from '@yudirect/contracts';
import { api, ApiRequestError } from '@/lib/api';

/** Pedido de reserva: cai na fila "Pedidos de reserva" do painel. */
const route = useRoute();
const slug = computed(() => String(route.params.slug));
const catalog = ref<PublicCatalog | null>(null);
const sent = ref(false);
const saving = ref(false);
const errors = ref<Record<string, string>>({});
const form = reactive({
  fullName: '',
  phone: '',
  email: '',
  groupName: (route.query.grupo as string | undefined) ?? '',
  desiredStartDate: (route.query.data as string | undefined) ?? '',
  appPlatforms: [] as string[],
  hasEarCnh: false,
  message: '',
  consent: false,
  website: '',
});
const platforms = [
  { value: 'UBER', label: 'Uber' },
  { value: '99', label: '99' },
  { value: 'INDRIVE', label: 'inDrive' },
  { value: 'OTHER', label: 'Outro' },
];

onMounted(async () => {
  try {
    catalog.value = await api.get<PublicCatalog>(`/public/${slug.value}/catalog`);
  } catch {
    catalog.value = null;
  }
});

async function submit() {
  const e: Record<string, string> = {};
  if (form.fullName.trim().length < 3) e.fullName = 'Informe seu nome';
  const digits = form.phone.replace(/\D+/g, '');
  if (digits.length < 10 || digits.length > 11) e.phone = 'Informe um WhatsApp com DDD';
  if (!form.consent) e.consent = 'É preciso aceitar o contato';
  errors.value = e;
  if (Object.keys(e).length) return;
  saving.value = true;
  try {
    await api.post(`/public/${slug.value}/leads`, { ...form, consent: true });
    sent.value = true;
  } catch (err) {
    errors.value = err instanceof ApiRequestError ? { ...err.fieldErrors(), form: err.message } : { form: 'Não foi possível enviar.' };
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="min-h-screen bg-canvas">
    <header class="bg-sidebar px-5 py-4 text-white">
      <div class="mx-auto flex max-w-2xl items-center justify-between">
        <RouterLink :to="`/l/${slug}`" class="text-lg font-bold">{{ catalog?.organization.name ?? 'Voltar' }}</RouterLink>
        <RouterLink :to="`/l/${slug}`" class="text-sm text-white/80 hover:underline">Ver carros</RouterLink>
      </div>
    </header>

    <main class="mx-auto max-w-2xl px-5 py-8">
      <section v-if="sent" class="fo-card p-7 text-center">
        <CheckCircle2 class="mx-auto size-12 text-[rgb(var(--c-positive))]" aria-hidden="true" />
        <h1 class="mt-3 text-xl font-bold text-ink">Pedido enviado!</h1>
        <p class="mt-2 text-[15px] text-ink-soft">Vamos falar com você pelo WhatsApp para combinar a análise e a retirada.</p>
      </section>

      <form v-else class="fo-card space-y-4 p-6" novalidate aria-label="Pedido de reserva" @submit.prevent="submit">
        <h1 class="text-xl font-bold text-ink">Pedir reserva</h1>

        <div>
          <label for="r-name" class="mb-1 block text-sm font-medium text-ink-soft">Nome completo *</label>
          <input id="r-name" v-model="form.fullName" class="w-full rounded-control border border-line bg-surface px-3 py-2.5" autocomplete="name" />
          <p v-if="errors.fullName" class="mt-1 text-sm text-[rgb(var(--c-negative))]">{{ errors.fullName }}</p>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label for="r-phone" class="mb-1 block text-sm font-medium text-ink-soft">WhatsApp *</label>
            <input id="r-phone" v-model="form.phone" type="tel" inputmode="tel" class="w-full rounded-control border border-line bg-surface px-3 py-2.5" placeholder="(11) 90000-0000" autocomplete="tel" />
            <p v-if="errors.phone" class="mt-1 text-sm text-[rgb(var(--c-negative))]">{{ errors.phone }}</p>
          </div>
          <div>
            <label for="r-email" class="mb-1 block text-sm font-medium text-ink-soft">E-mail</label>
            <input id="r-email" v-model="form.email" type="email" class="w-full rounded-control border border-line bg-surface px-3 py-2.5" autocomplete="email" />
          </div>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label for="r-group" class="mb-1 block text-sm font-medium text-ink-soft">Grupo</label>
            <select id="r-group" v-model="form.groupName" class="w-full rounded-control border border-line bg-surface px-3 py-2.5">
              <option value="">Qualquer grupo</option>
              <option v-for="g in catalog?.groups ?? []" :key="g.groupName" :value="g.groupName">{{ g.groupName }}</option>
            </select>
          </div>
          <div>
            <label for="r-date" class="mb-1 block text-sm font-medium text-ink-soft">Quando quer retirar?</label>
            <input id="r-date" v-model="form.desiredStartDate" type="date" class="w-full rounded-control border border-line bg-surface px-3 py-2.5" />
          </div>
        </div>
        <fieldset>
          <legend class="mb-2 text-sm font-medium text-ink-soft">Em quais apps você roda?</legend>
          <div class="flex flex-wrap gap-4">
            <label v-for="p in platforms" :key="p.value" class="flex items-center gap-2 text-[15px] text-ink">
              <input v-model="form.appPlatforms" type="checkbox" :value="p.value" /> {{ p.label }}
            </label>
          </div>
        </fieldset>
        <label class="flex items-center gap-2 text-[15px] text-ink">
          <input v-model="form.hasEarCnh" type="checkbox" /> Minha CNH tem EAR (exerce atividade remunerada)
        </label>
        <div>
          <label for="r-msg" class="mb-1 block text-sm font-medium text-ink-soft">Mensagem</label>
          <textarea id="r-msg" v-model="form.message" rows="3" class="w-full rounded-control border border-line bg-surface px-3 py-2.5" />
        </div>
        <!-- Honeypot: invisível para pessoas -->
        <input v-model="form.website" type="text" name="website" tabindex="-1" autocomplete="off" class="hidden" aria-hidden="true" />
        <label class="flex items-start gap-2 text-sm text-ink-soft">
          <input v-model="form.consent" type="checkbox" class="mt-0.5" /> Aceito ser contatado pelo WhatsApp sobre este pedido.
        </label>
        <p v-if="errors.consent" class="text-sm text-[rgb(var(--c-negative))]">{{ errors.consent }}</p>
        <p v-if="errors.form" class="text-sm text-[rgb(var(--c-negative))]">{{ errors.form }}</p>
        <button type="submit" :disabled="saving" class="w-full rounded-control bg-brand-500 px-4 py-3 font-semibold text-white hover:bg-brand-600 disabled:opacity-60">
          {{ saving ? 'Enviando…' : 'Enviar pedido' }}
        </button>
      </form>
    </main>
  </div>
</template>
