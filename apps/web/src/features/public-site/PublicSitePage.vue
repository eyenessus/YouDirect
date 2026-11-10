<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Car, CheckCircle2, ClipboardCheck, MessageCircle, ShieldCheck, Wrench } from 'lucide-vue-next';
import { addDaysIso, businessDate, formatCentsBRL, type PublicCatalog, type PublicCatalogGroup } from '@yudirect/contracts';
import { api } from '@/lib/api';
import { whatsappLink } from '@/features/driver-portal/usePortal';

/**
 * Site da locadora, no formato da home da Localiza: busca no topo, vitrine
 * de grupos "ou similar" com preço, como funciona, requisitos e FAQ.
 */
const route = useRoute();
const router = useRouter();
const slug = computed(() => String(route.params.slug));
const catalog = ref<PublicCatalog | null>(null);
const notFound = ref(false);
const pickDate = ref(addDaysIso(businessDate(), 1));
const pickGroup = ref('');
const openFaq = ref<number | null>(null);

const whats = computed(() => whatsappLink(catalog.value?.organization.whatsappPhone, 'Olá! Vi o site e quero alugar um carro para rodar no app.'));

const faq = [
  { q: 'Preciso ter cadastro na Uber ou 99?', a: 'Sim. A locação é para motoristas de aplicativo; você pode se cadastrar no app enquanto analisamos seu pedido.' },
  { q: 'Como funciona o pagamento?', a: 'O aluguel é semanal. Você acompanha as faturas pela Área do Motorista e paga por Pix.' },
  { q: 'E se o carro der problema?', a: 'Manutenção é por nossa conta. Você abre o pedido pela Área do Motorista e agendamos a oficina.' },
  { q: 'Como são as vistorias?', a: 'Periódicas e pelo celular: você envia as fotos do carro pelo WhatsApp ou pelo link que recebe.' },
  { q: 'E as multas?', a: 'Multas do período da locação são do motorista. Avisamos você assim que a notificação chega, com os prazos.' },
];

function reserve(group?: PublicCatalogGroup) {
  void router.push({
    path: `/l/${slug.value}/reservar`,
    query: { grupo: group?.groupName ?? (pickGroup.value || undefined), data: pickDate.value || undefined },
  });
}

onMounted(async () => {
  try {
    catalog.value = await api.get<PublicCatalog>(`/public/${slug.value}/catalog`);
    document.title = `${catalog.value.organization.name} · Aluguel de carros para app`;
  } catch {
    notFound.value = true;
  }
});
</script>

<template>
  <div class="min-h-screen bg-canvas">
    <p v-if="notFound" class="p-10 text-center text-ink-soft">Página não encontrada.</p>
    <p v-else-if="!catalog" class="p-10 text-center text-ink-muted">Carregando…</p>

    <template v-else>
      <!-- Topo -->
      <header class="bg-sidebar text-white">
        <div class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
          <p class="text-lg font-bold">{{ catalog.organization.name }}</p>
          <nav class="flex items-center gap-5 text-sm font-medium">
            <a href="#grupos" class="hidden hover:underline sm:inline">Carros</a>
            <a href="#como-funciona" class="hidden hover:underline sm:inline">Como funciona</a>
            <RouterLink to="/motorista" class="rounded-control bg-white/15 px-3 py-1.5 hover:bg-white/25">Área do Motorista</RouterLink>
          </nav>
        </div>

        <!-- Hero + busca -->
        <div class="mx-auto grid max-w-6xl gap-8 px-5 pb-12 pt-6 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <div>
            <h1 class="text-3xl font-bold leading-tight sm:text-4xl">
              {{ catalog.organization.headline || 'Carro para rodar no aplicativo' }}
            </h1>
            <p class="mt-3 text-[17px] text-white/80">
              {{ catalog.organization.about || 'Aluguel semanal para motoristas de Uber e 99, com manutenção inclusa.' }}
            </p>
            <p v-if="catalog.organization.city" class="mt-2 text-sm text-white/60">{{ catalog.organization.city }}</p>
          </div>
          <form class="rounded-card bg-surface p-5 text-ink shadow-lg" aria-label="Buscar carro" @submit.prevent="reserve()">
            <p class="mb-4 text-lg font-bold">Reserve seu carro</p>
            <label class="mb-1 block text-sm font-medium text-ink-soft" for="pick-date">Quando quer retirar?</label>
            <input id="pick-date" v-model="pickDate" type="date" class="mb-4 w-full rounded-control border border-line bg-surface px-3 py-2.5" />
            <label class="mb-1 block text-sm font-medium text-ink-soft" for="pick-group">Grupo de carro</label>
            <select id="pick-group" v-model="pickGroup" class="mb-5 w-full rounded-control border border-line bg-surface px-3 py-2.5">
              <option value="">Qualquer grupo</option>
              <option v-for="g in catalog.groups" :key="g.groupName" :value="g.groupName">
                {{ g.groupName }} · a partir de {{ formatCentsBRL(g.fromWeeklyPriceCents) }}/semana
              </option>
            </select>
            <button type="submit" class="w-full rounded-control bg-brand-500 px-4 py-3 font-semibold text-white hover:bg-brand-600">
              Pedir reserva
            </button>
          </form>
        </div>
      </header>

      <main>
        <!-- Grupos -->
        <section id="grupos" class="mx-auto max-w-6xl px-5 py-12" aria-labelledby="grupos-titulo">
          <h2 id="grupos-titulo" class="text-2xl font-bold text-ink">Escolha o seu grupo</h2>
          <p class="mt-1 text-ink-muted">A reserva garante um carro do grupo: um dos modelos listados ou similar.</p>
          <p v-if="catalog.groups.length === 0" class="mt-6 text-ink-muted">Em breve novos carros disponíveis.</p>
          <div class="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <article v-for="g in catalog.groups" :key="g.groupName" class="fo-card flex flex-col overflow-hidden" :aria-label="`Grupo ${g.groupName}`">
              <div class="flex aspect-[16/9] items-center justify-center bg-surface-muted">
                <img v-if="g.photoUrl" :src="g.photoUrl" :alt="`Carro do grupo ${g.groupName}`" class="size-full object-cover" loading="lazy" />
                <Car v-else class="size-16 text-ink-muted" aria-hidden="true" />
              </div>
              <div class="flex flex-1 flex-col p-5">
                <div class="flex items-center justify-between gap-2">
                  <h3 class="text-xl font-bold text-ink">{{ g.groupName }}</h3>
                  <span
                    class="rounded-full px-2.5 py-0.5 text-xs font-semibold"
                    :class="g.available ? 'bg-[rgb(var(--c-positive)/0.12)] text-[rgb(var(--c-positive))]' : 'bg-surface-muted text-ink-muted'"
                  >
                    {{ g.available ? 'Disponível' : 'Lista de espera' }}
                  </span>
                </div>
                <p class="mt-1 text-sm text-ink-muted">{{ g.models.join(', ') }} ou similar</p>
                <ul class="mt-3 space-y-1 text-sm text-ink-soft">
                  <li>{{ g.kmPolicy === 'UNLIMITED' ? 'KM livre' : `${g.weeklyKmFranchise} km por semana` }}</li>
                  <li v-for="h in g.highlights" :key="h">{{ h }}</li>
                  <li v-if="g.depositCents > 0">Caução de {{ formatCentsBRL(g.depositCents) }}</li>
                </ul>
                <div class="mt-auto pt-5">
                  <p class="text-sm text-ink-muted">a partir de</p>
                  <p class="text-2xl font-bold tabular text-ink">{{ formatCentsBRL(g.fromWeeklyPriceCents) }}<span class="text-base font-medium text-ink-muted">/semana</span></p>
                  <button
                    type="button"
                    class="mt-4 w-full rounded-control bg-brand-500 px-4 py-2.5 font-semibold text-white hover:bg-brand-600"
                    @click="reserve(g)"
                  >
                    {{ g.available ? 'Reservar' : 'Entrar na lista' }}
                  </button>
                </div>
              </div>
            </article>
          </div>
        </section>

        <!-- Como funciona -->
        <section id="como-funciona" class="bg-surface py-12" aria-labelledby="como-titulo">
          <div class="mx-auto max-w-6xl px-5">
            <h2 id="como-titulo" class="text-2xl font-bold text-ink">Como funciona</h2>
            <ol class="mt-6 grid gap-5 sm:grid-cols-3">
              <li class="fo-card p-5">
                <p class="text-3xl font-bold text-brand-500">1</p>
                <p class="mt-2 font-semibold text-ink">Peça sua reserva</p>
                <p class="text-sm text-ink-muted">Escolha o grupo e mande seus dados. Respondemos pelo WhatsApp.</p>
              </li>
              <li class="fo-card p-5">
                <p class="text-3xl font-bold text-brand-500">2</p>
                <p class="mt-2 font-semibold text-ink">Análise e contrato</p>
                <p class="text-sm text-ink-muted">Conferimos CNH e documentos e combinamos a retirada.</p>
              </li>
              <li class="fo-card p-5">
                <p class="text-3xl font-bold text-brand-500">3</p>
                <p class="mt-2 font-semibold text-ink">Retire e rode</p>
                <p class="text-sm text-ink-muted">Faturas, multas e manutenção você acompanha pela Área do Motorista.</p>
              </li>
            </ol>
            <ul class="mt-8 grid gap-4 sm:grid-cols-3">
              <li class="flex items-start gap-3"><Wrench class="mt-0.5 size-5 text-brand-500" aria-hidden="true" /><span class="text-ink-soft">Manutenção inclusa</span></li>
              <li class="flex items-start gap-3"><ClipboardCheck class="mt-0.5 size-5 text-brand-500" aria-hidden="true" /><span class="text-ink-soft">Vistoria pelo celular</span></li>
              <li class="flex items-start gap-3"><ShieldCheck class="mt-0.5 size-5 text-brand-500" aria-hidden="true" /><span class="text-ink-soft">Documentação em dia</span></li>
            </ul>
          </div>
        </section>

        <!-- Requisitos + FAQ -->
        <section class="mx-auto grid max-w-6xl gap-8 px-5 py-12 lg:grid-cols-2">
          <div>
            <h2 class="text-2xl font-bold text-ink">O que você precisa</h2>
            <ul class="mt-4 space-y-3">
              <li v-for="r in catalog.organization.requirements" :key="r" class="flex items-start gap-3 text-ink-soft">
                <CheckCircle2 class="mt-0.5 size-5 shrink-0 text-[rgb(var(--c-positive))]" aria-hidden="true" /> {{ r }}
              </li>
            </ul>
          </div>
          <div>
            <h2 class="text-2xl font-bold text-ink">Dúvidas frequentes</h2>
            <div class="mt-4 divide-y divide-line rounded-card border border-line bg-surface">
              <div v-for="(item, i) in faq" :key="item.q">
                <button
                  type="button"
                  class="flex w-full items-center justify-between gap-3 px-4 py-3 text-left font-semibold text-ink"
                  :aria-expanded="openFaq === i"
                  @click="openFaq = openFaq === i ? null : i"
                >
                  {{ item.q }} <span aria-hidden="true">{{ openFaq === i ? '−' : '+' }}</span>
                </button>
                <p v-if="openFaq === i" class="px-4 pb-4 text-[15px] text-ink-soft">{{ item.a }}</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer class="border-t border-line py-6 text-center text-sm text-ink-muted">
        {{ catalog.organization.name }} · Locação de veículos para motoristas de aplicativo
      </footer>

      <a
        v-if="whats"
        :href="whats"
        target="_blank"
        rel="noopener"
        class="fixed bottom-5 right-5 flex items-center gap-2 rounded-full bg-[rgb(var(--c-positive-solid))] px-4 py-3 font-semibold text-white shadow-lg"
      >
        <MessageCircle class="size-5" aria-hidden="true" /> WhatsApp
      </a>
    </template>
  </div>
</template>
