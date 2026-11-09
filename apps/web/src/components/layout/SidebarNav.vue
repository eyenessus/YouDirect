<script setup lang="ts">
import { computed, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ChevronDown, ChevronRight, PanelLeft, Bug } from 'lucide-vue-next';
import { navigation, type NavItem } from './navigation';
import { useAuthStore } from '@/stores/auth';
import { useSidebarStore } from '@/stores/ui';

const route = useRoute();
const auth = useAuthStore();
const sidebar = useSidebarStore();

const items = computed(() =>
  navigation.filter((item) => {
    if (item.ownerOnly) return auth.isOwnerOrAdmin;
    if (item.module) return auth.hasAccess(item.module);
    return true;
  }),
);

function isItemActive(item: NavItem): boolean {
  if (item.to) {
    return item.to === '/dashboard' ? route.path === '/dashboard' : route.path.startsWith(item.to);
  }
  return (item.children ?? []).some(
    (child) => route.path === child.to || route.path.startsWith(`${child.to}/`),
  );
}

// Mantém aberto o grupo da rota atual.
watch(
  () => route.path,
  () => {
    for (const item of items.value) {
      if (item.children && isItemActive(item)) sidebar.openGroup(item.key);
    }
  },
  { immediate: true },
);

const expanded = computed(() => !sidebar.collapsed);
</script>

<template>
  <nav
    class="flex h-full flex-col bg-sidebar text-white"
    :aria-label="'Navegação principal'"
  >
    <!-- Marca -->
    <div class="flex h-topbar shrink-0 items-center gap-3 px-4">
      <RouterLink
        to="/dashboard"
        class="flex min-w-0 items-center gap-3"
        :aria-label="'FrotaOne — ir para o painel'"
      >
        <span class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-sidebar-active">
          <img src="/brand/frotaone-mark-white.png" alt="" class="size-7 object-contain" />
        </span>
        <span v-if="expanded" class="truncate text-[22px] font-bold tracking-tight">FrotaOne</span>
      </RouterLink>
      <button
        v-if="expanded"
        type="button"
        class="ml-auto rounded-lg p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
        aria-label="Recolher menu"
        @click="sidebar.toggle()"
      >
        <PanelLeft class="size-5" />
      </button>
    </div>

    <div class="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-4">
      <ul class="space-y-1">
        <li v-for="item in items" :key="item.key">
          <!-- Item simples -->
          <RouterLink
            v-if="item.to"
            :to="item.to"
            class="flex items-center gap-3 rounded-xl px-3 py-3 text-[17px] transition-colors"
            :class="[
              isItemActive(item) ? 'bg-sidebar-active font-semibold' : 'text-white/85 hover:bg-white/10',
              expanded ? '' : 'justify-center px-0',
            ]"
            :aria-current="isItemActive(item) ? 'page' : undefined"
            :title="expanded ? undefined : item.label"
            @click="sidebar.mobileOpen = false"
          >
            <component :is="item.icon" class="size-[22px] shrink-0" aria-hidden="true" />
            <span v-if="expanded" class="truncate">{{ item.label }}</span>
            <span v-else class="sr-only">{{ item.label }}</span>
          </RouterLink>

          <!-- Grupo com submenu -->
          <template v-else>
            <button
              v-if="expanded"
              type="button"
              class="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-[17px] transition-colors"
              :class="
                isItemActive(item) ? 'bg-sidebar-active font-semibold' : 'text-white/85 hover:bg-white/10'
              "
              :aria-expanded="sidebar.openGroups.has(item.key)"
              :aria-controls="`nav-group-${item.key}`"
              @click="sidebar.toggleGroup(item.key)"
            >
              <component :is="item.icon" class="size-[22px] shrink-0" aria-hidden="true" />
              <span class="truncate">{{ item.label }}</span>
              <component
                :is="sidebar.openGroups.has(item.key) ? ChevronDown : ChevronRight"
                class="ml-auto size-4 shrink-0 opacity-80"
                aria-hidden="true"
              />
            </button>

            <RouterLink
              v-else
              :to="item.children?.[0]?.to ?? '/dashboard'"
              class="flex items-center justify-center rounded-xl py-3 transition-colors"
              :class="isItemActive(item) ? 'bg-sidebar-active' : 'text-white/85 hover:bg-white/10'"
              :title="item.label"
            >
              <component :is="item.icon" class="size-[22px]" aria-hidden="true" />
              <span class="sr-only">{{ item.label }}</span>
            </RouterLink>

            <ul
              v-if="expanded && sidebar.openGroups.has(item.key)"
              :id="`nav-group-${item.key}`"
              class="ml-5 mt-1 space-y-1 border-l border-white/15 pl-3"
            >
              <li v-for="child in item.children" :key="child.to">
                <RouterLink
                  :to="child.to"
                  class="block truncate rounded-lg px-3 py-2.5 text-[15px] transition-colors"
                  :class="
                    route.path === child.to
                      ? 'bg-sidebar-active font-semibold'
                      : 'text-white/80 hover:bg-white/10'
                  "
                  :aria-current="route.path === child.to ? 'page' : undefined"
                  @click="sidebar.mobileOpen = false"
                >
                  {{ child.label }}
                </RouterLink>
              </li>
            </ul>
          </template>
        </li>
      </ul>
    </div>

    <!-- Rodapé -->
    <div class="shrink-0 border-t border-white/10 px-3 py-4">
      <button
        v-if="!expanded"
        type="button"
        class="mb-2 flex w-full items-center justify-center rounded-xl py-2.5 text-white/80 transition-colors hover:bg-white/10"
        aria-label="Expandir menu"
        @click="sidebar.toggle()"
      >
        <PanelLeft class="size-5" />
      </button>
      <a
        href="mailto:suporte@frotaone.com.br?subject=Reportar%20bug"
        class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-[17px] text-white/85 transition-colors hover:bg-white/10"
        :class="expanded ? '' : 'justify-center px-0'"
        :title="expanded ? undefined : 'Reportar bug'"
      >
        <Bug class="size-[22px] shrink-0" aria-hidden="true" />
        <span v-if="expanded">Reportar bug</span>
        <span v-else class="sr-only">Reportar bug</span>
      </a>
    </div>
  </nav>
</template>
