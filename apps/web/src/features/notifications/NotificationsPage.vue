<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Bell, CheckCheck } from 'lucide-vue-next';
import {
  formatDateTimeBR,
  notificationSeverityLabels,
  notificationTypeLabels,
  type NotificationType,
} from '@yudirect/contracts';
import PageHeader from '@/components/layout/PageHeader.vue';
import AppButton from '@/components/ui/AppButton.vue';
import AppSkeleton from '@/components/ui/AppSkeleton.vue';
import AppTabs, { type TabItem } from '@/components/ui/AppTabs.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import StatusBadge from '@/components/ui/StatusBadge.vue';
import { useNotificationStore } from '@/stores/notifications';
import { useAuthStore } from '@/stores/auth';
import { useToastStore } from '@/stores/ui';
import { severityBorder } from '@/lib/status';

const router = useRouter();
const auth = useAuthStore();
const toasts = useToastStore();
const notifications = useNotificationStore();

const tab = ref<'ALL' | NotificationType>('ALL');
const readFilter = ref<'all' | 'unread'>('all');

const tabs: TabItem[] = [
  { key: 'ALL', label: 'Todas' },
  { key: 'MAINTENANCE', label: notificationTypeLabels.MAINTENANCE },
  { key: 'CNH', label: notificationTypeLabels.CNH },
  { key: 'RENTAL', label: notificationTypeLabels.RENTAL },
  { key: 'INSPECTION', label: notificationTypeLabels.INSPECTION },
];

const readTabs: TabItem[] = [
  { key: 'all', label: 'Todas' },
  { key: 'unread', label: 'Não lidas' },
];

const loading = computed(() => notifications.loading);

async function load() {
  await notifications.fetch({
    type: tab.value === 'ALL' ? undefined : tab.value,
    unreadOnly: readFilter.value === 'unread',
    limit: 50,
  });
}

async function markAll() {
  try {
    await notifications.markAllRead();
    toasts.success('Todas as notificações foram marcadas como lidas');
    await load();
  } catch {
    toasts.error('Não foi possível marcar as notificações');
  }
}

async function open(id: string, targetPath: string | null) {
  await notifications.markRead(id).catch(() => undefined);
  if (targetPath) router.push(targetPath);
}

onMounted(load);
</script>

<template>
  <div class="space-y-6">
    <PageHeader
      eyebrow="ALERTAS"
      title="Notificações"
      subtitle="Acompanhe manutenções, CNHs, locações e outros alertas importantes da sua frota."
    />

    <div class="flex justify-end">
      <AppButton
        v-if="auth.allows('notifications', 'update')"
        variant="secondary"
        :disabled="notifications.unread === 0"
        @click="markAll"
      >
        <template #icon><CheckCheck class="size-4" /></template>
        Marcar todas como lidas
      </AppButton>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-4">
      <AppTabs
        :model-value="tab"
        :items="tabs"
        @update:model-value="
          tab = $event as 'ALL' | NotificationType;
          load();
        "
      />
      <AppTabs
        :model-value="readFilter"
        :items="readTabs"
        variant="pill"
        @update:model-value="
          readFilter = $event as 'all' | 'unread';
          load();
        "
      />
    </div>

    <section class="fo-card p-6">
      <AppSkeleton v-if="loading" variant="table" :rows="4" />

      <EmptyState
        v-else-if="notifications.items.length === 0"
        :icon="Bell"
        message="Nenhuma notificação encontrada para este filtro."
      />

      <ul v-else class="space-y-4">
        <li v-for="item in notifications.items" :key="item.id">
          <button
            type="button"
            class="w-full rounded-card border border-line border-l-4 bg-surface p-5 text-left transition-colors hover:bg-surface-muted/60"
            :class="[severityBorder[item.severity], item.readAt ? 'opacity-75' : '']"
            @click="open(item.id, item.targetPath)"
          >
            <div class="flex flex-wrap items-center gap-3">
              <span class="text-[19px] font-bold text-ink">{{ item.title }}</span>
              <span
                v-if="item.subjectLabel"
                class="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-muted px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ink-soft"
              >
                {{ item.subjectLabel }}
              </span>
              <StatusBadge
                v-if="item.severity === 'CRITICAL'"
                :label="notificationSeverityLabels.CRITICAL"
                tone="red"
              />
              <span v-if="!item.readAt" class="ml-auto size-2.5 rounded-full bg-negative" aria-label="Não lida" />
            </div>
            <p class="mt-2 text-[17px] leading-relaxed text-ink-soft">{{ item.message }}</p>
            <p class="mt-2.5 text-sm tabular text-ink-muted">{{ formatDateTimeBR(item.createdAt) }}</p>
          </button>
        </li>
      </ul>

      <div v-if="notifications.nextCursor" class="mt-6 flex justify-center">
        <AppButton
          variant="secondary"
          @click="
            notifications.loadMore({
              type: tab === 'ALL' ? undefined : tab,
              unreadOnly: readFilter === 'unread',
            })
          "
        >
          Carregar mais
        </AppButton>
      </div>
    </section>
  </div>
</template>
