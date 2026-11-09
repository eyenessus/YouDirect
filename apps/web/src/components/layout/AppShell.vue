<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount } from 'vue';
import { Menu, Monitor, Sun } from 'lucide-vue-next';
import SidebarNav from './SidebarNav.vue';
import NotificationPopover from './NotificationPopover.vue';
import ProfileMenu from './ProfileMenu.vue';
import { useSidebarStore, useThemeStore } from '@/stores/ui';
import { useNotificationStore } from '@/stores/notifications';
import { useAuthStore } from '@/stores/auth';

const sidebar = useSidebarStore();
const theme = useThemeStore();
const notifications = useNotificationStore();
const auth = useAuthStore();

const sidebarWidth = computed(() => (sidebar.collapsed ? '82px' : '260px'));

let timer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  if (auth.hasAccess('notifications')) {
    void notifications.refreshCount();
    timer = setInterval(() => void notifications.refreshCount(), 120_000);
  }
});

onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="min-h-screen bg-canvas">
    <!-- Sidebar fixa (desktop) -->
    <aside
      class="fixed inset-y-0 left-0 z-30 hidden transition-[width] duration-200 lg:block"
      :style="{ width: sidebarWidth }"
    >
      <SidebarNav />
    </aside>

    <!-- Drawer (telas pequenas) -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="opacity-0"
    >
      <div v-if="sidebar.mobileOpen" class="fixed inset-0 z-40 lg:hidden">
        <div
          class="absolute inset-0 bg-[rgb(var(--overlay)/0.6)]"
          aria-hidden="true"
          @click="sidebar.mobileOpen = false"
        />
        <div class="absolute inset-y-0 left-0 w-[280px] max-w-[85vw]">
          <SidebarNav />
        </div>
      </div>
    </Transition>

    <div class="transition-[padding] duration-200" :style="{ paddingLeft: sidebarWidth }" data-shell-content>
      <!-- Topbar -->
      <header
        class="sticky top-0 z-20 flex h-topbar items-center gap-3 border-b border-line px-4 sm:px-8"
        style="background-color: rgb(var(--topbar-bg))"
      >
        <button
          type="button"
          class="flex size-10 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-surface-muted lg:hidden"
          aria-label="Abrir menu"
          @click="sidebar.mobileOpen = true"
        >
          <Menu class="size-6" />
        </button>

        <div class="ml-auto flex items-center gap-2 sm:gap-3">
          <button
            type="button"
            class="flex size-10 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-surface-muted hover:text-ink"
            :aria-label="theme.isDark ? 'Mudar para tema claro' : 'Mudar para tema escuro'"
            @click="theme.toggle()"
          >
            <Monitor v-if="theme.isDark" class="size-[22px]" />
            <Sun v-else class="size-[22px]" />
          </button>
          <NotificationPopover v-if="auth.hasAccess('notifications')" />
          <ProfileMenu />
        </div>
      </header>

      <main class="px-4 pb-16 pt-6 sm:px-8">
        <div class="mx-auto w-full max-w-[1760px]">
          <RouterView v-slot="{ Component }">
            <component :is="Component" />
          </RouterView>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* Em telas pequenas o conteúdo ocupa toda a largura (sidebar vira drawer). */
@media (max-width: 1023px) {
  [data-shell-content] {
    padding-left: 0 !important;
  }
}
</style>
