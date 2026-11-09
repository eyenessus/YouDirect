<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Bell } from 'lucide-vue-next';
import { shortRelativeTime } from '@yudirect/contracts';
import { useNotificationStore } from '@/stores/notifications';

const router = useRouter();
const notifications = useNotificationStore();
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

async function toggle() {
  open.value = !open.value;
  if (open.value) {
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeydown);
    await notifications.fetch({ limit: 10 });
  } else {
    close();
  }
}

async function openItem(id: string, targetPath: string | null) {
  // Marca como lida apenas na interação explícita do usuário.
  await notifications.markRead(id).catch(() => undefined);
  close();
  if (targetPath) router.push(targetPath);
}

onBeforeUnmount(close);
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="relative flex size-10 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-surface-muted hover:text-ink"
      :aria-label="`Notificações${notifications.unread ? ` (${notifications.unread} não lidas)` : ''}`"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click.stop="toggle"
    >
      <Bell class="size-[22px]" />
      <span
        v-if="notifications.unread > 0"
        class="absolute right-1.5 top-1.5 size-2.5 rounded-full bg-negative ring-2 ring-[rgb(var(--topbar-bg))]"
        aria-hidden="true"
      />
    </button>

    <Transition
      enter-active-class="transition duration-100 ease-out"
      enter-from-class="scale-95 opacity-0"
      leave-active-class="transition duration-75 ease-in"
      leave-to-class="scale-95 opacity-0"
    >
      <div
        v-if="open"
        role="dialog"
        aria-label="Notificações"
        class="absolute right-0 top-full z-40 mt-2 w-[400px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-card border border-line bg-surface shadow-pop"
      >
        <div class="border-b border-line px-5 py-4">
          <h2 class="text-lg font-bold text-ink">Notificações</h2>
        </div>

        <div class="max-h-[380px] overflow-y-auto">
          <p v-if="notifications.loading" class="px-5 py-8 text-center text-sm text-ink-muted">
            Carregando…
          </p>
          <p
            v-else-if="notifications.items.length === 0"
            class="px-5 py-10 text-center text-[15px] text-ink-muted"
          >
            Nenhuma notificação por aqui.
          </p>
          <ul v-else class="divide-y divide-line">
            <li v-for="item in notifications.items" :key="item.id">
              <button
                type="button"
                class="w-full px-5 py-4 text-left transition-colors hover:bg-surface-muted"
                @click="openItem(item.id, item.targetPath)"
              >
                <div class="flex items-start gap-2.5">
                  <span
                    class="mt-1.5 size-2 shrink-0 rounded-full"
                    :class="item.readAt ? 'bg-transparent' : 'bg-negative'"
                    aria-hidden="true"
                  />
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="text-[15px] font-semibold text-ink">{{ item.title }}</span>
                      <span
                        v-if="item.subjectLabel"
                        class="rounded-md border border-line bg-surface-muted px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-soft"
                      >
                        {{ item.subjectLabel }}
                      </span>
                    </div>
                    <p class="mt-1 text-sm leading-relaxed text-ink-muted">{{ item.message }}</p>
                    <p class="mt-1.5 text-xs text-ink-muted">{{ shortRelativeTime(item.createdAt) }}</p>
                  </div>
                </div>
              </button>
            </li>
          </ul>
        </div>

        <div class="border-t border-line">
          <RouterLink
            to="/dashboard/notifications"
            class="block px-5 py-3.5 text-center text-[15px] font-semibold text-ink transition-colors hover:bg-surface-muted"
            @click="close"
          >
            Ver todas
          </RouterLink>
        </div>
      </div>
    </Transition>
  </div>
</template>
