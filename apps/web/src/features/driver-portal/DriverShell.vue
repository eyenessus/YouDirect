<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { CircleUser, Home, Receipt, ReceiptText, Wrench } from 'lucide-vue-next';
import { usePortal } from './usePortal';

/** Layout da Área do Motorista: mobile-first, cabeçalho da locadora e navegação inferior. */
const portal = usePortal();
const failed = ref(false);

const tabs = [
  { to: '/motorista', label: 'Início', icon: Home, exact: true },
  { to: '/motorista/faturas', label: 'Faturas', icon: Receipt },
  { to: '/motorista/multas', label: 'Multas', icon: ReceiptText },
  { to: '/motorista/manutencao', label: 'Manutenção', icon: Wrench },
  { to: '/motorista/conta', label: 'Conta', icon: CircleUser },
];

onMounted(async () => {
  try {
    await portal.load();
  } catch {
    failed.value = true;
  }
});
</script>

<template>
  <div class="min-h-screen bg-canvas pb-24">
    <header class="bg-sidebar px-5 py-4 text-white">
      <div class="mx-auto flex max-w-2xl items-center gap-3">
        <span class="flex size-10 items-center justify-center rounded-xl bg-sidebar-active">
          <img src="/brand/yudirect-mark-white.png" alt="" class="size-6 object-contain" />
        </span>
        <div class="min-w-0">
          <p class="truncate text-lg font-bold leading-tight">{{ portal.state.me?.organization.name || 'Área do Motorista' }}</p>
          <p class="truncate text-sm text-white/75">
            {{ portal.state.me ? `Olá, ${portal.state.me.driver.fullName.split(' ')[0]}` : 'Área do Motorista' }}
          </p>
        </div>
      </div>
    </header>

    <main class="mx-auto max-w-2xl px-4 py-6">
      <p v-if="failed" class="fo-card p-6 text-[15px] text-ink-soft">Não foi possível carregar seus dados. Tente novamente.</p>
      <p v-else-if="!portal.state.loaded" class="text-[15px] text-ink-muted">Carregando…</p>
      <RouterView v-else />
    </main>

    <nav
      class="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]"
      aria-label="Área do Motorista"
    >
      <ul class="mx-auto grid max-w-2xl grid-cols-5">
        <li v-for="t in tabs" :key="t.to">
          <RouterLink
            :to="t.to"
            class="flex flex-col items-center gap-1 py-2.5 text-xs font-medium text-ink-muted"
            :exact-active-class="'!text-brand-600'"
            :active-class="t.exact ? '' : '!text-brand-600'"
          >
            <component :is="t.icon" class="size-5" aria-hidden="true" />
            {{ t.label }}
          </RouterLink>
        </li>
      </ul>
    </nav>
  </div>
</template>
