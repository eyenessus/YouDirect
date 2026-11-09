<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowUpCircle, CreditCard, LogOut, User } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

function onDocumentClick(event: MouseEvent) {
  if (!root.value?.contains(event.target as Node)) close();
}
function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') close();
}
function close() {
  open.value = false;
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKeydown);
}
function toggle() {
  open.value = !open.value;
  if (open.value) {
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeydown);
  } else {
    close();
  }
}

function go(path: string) {
  close();
  router.push(path);
}

async function logout() {
  close();
  await auth.logout();
  router.replace({ name: 'login' });
}

onBeforeUnmount(close);
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="flex size-10 items-center justify-center rounded-full bg-brand-500 text-[17px] font-semibold text-white transition-opacity hover:opacity-90"
      :aria-label="`Menu do usuário ${auth.user?.name ?? ''}`"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click.stop="toggle"
    >
      {{ auth.user?.initials ?? '?' }}
    </button>

    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="scale-95 opacity-0"
      leave-active-class="transition duration-75 ease-in"
      leave-to-class="scale-95 opacity-0"
    >
      <div
        v-if="open"
        role="menu"
        class="absolute right-0 top-full z-40 mt-2 w-72 overflow-hidden rounded-card border border-line bg-surface shadow-pop"
      >
        <div class="border-b border-line px-5 py-4">
          <p class="truncate text-[17px] font-bold text-ink">{{ auth.user?.name }}</p>
          <p class="mt-0.5 truncate text-sm text-ink-muted">{{ auth.user?.email }}</p>
          <p class="mt-1 truncate text-sm font-medium text-brand-600">
            {{ auth.organization?.name }}
          </p>
        </div>
        <div class="py-1.5">
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-3 px-5 py-2.5 text-left text-[15px] text-ink transition-colors hover:bg-surface-muted"
            @click="go('/dashboard/profile')"
          >
            <User class="size-[18px] text-ink-soft" /> Meu Perfil
          </button>
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-3 px-5 py-2.5 text-left text-[15px] text-ink transition-colors hover:bg-surface-muted"
            @click="go('/dashboard/subscription')"
          >
            <CreditCard class="size-[18px] text-ink-soft" /> Minha Assinatura
          </button>
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-3 px-5 py-2.5 text-left text-[15px] text-ink transition-colors hover:bg-surface-muted"
            @click="go('/dashboard/subscription?upgrade=1')"
          >
            <ArrowUpCircle class="size-[18px] text-ink-soft" /> Upgrade de plano
          </button>
        </div>
        <div class="border-t border-line py-1.5">
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-3 px-5 py-2.5 text-left text-[15px] font-medium text-negative transition-colors hover:bg-[rgb(var(--c-negative)/0.08)]"
            @click="logout"
          >
            <LogOut class="size-[18px]" /> Sair
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>
