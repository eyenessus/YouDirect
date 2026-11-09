import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Notification, NotificationType } from '@yudirect/contracts';
import { api } from '@/lib/api';

interface ListResponse {
  data: Notification[];
  unread: number;
  page: { nextCursor: string | null };
}

export const useNotificationStore = defineStore('notifications', () => {
  const items = ref<Notification[]>([]);
  const unread = ref(0);
  const loading = ref(false);
  const nextCursor = ref<string | null>(null);

  async function fetch(options: { type?: NotificationType; unreadOnly?: boolean; limit?: number } = {}) {
    loading.value = true;
    try {
      const res = await api.get<ListResponse>('/notifications', {
        query: {
          type: options.type,
          unread: options.unreadOnly ? 'true' : undefined,
          limit: options.limit ?? 20,
        },
      });
      items.value = res.data;
      unread.value = res.unread;
      nextCursor.value = res.page.nextCursor;
      return res;
    } finally {
      loading.value = false;
    }
  }

  async function loadMore(options: { type?: NotificationType; unreadOnly?: boolean } = {}) {
    if (!nextCursor.value) return;
    const res = await api.get<ListResponse>('/notifications', {
      query: {
        type: options.type,
        unread: options.unreadOnly ? 'true' : undefined,
        cursor: nextCursor.value,
        limit: 20,
      },
    });
    items.value = [...items.value, ...res.data];
    nextCursor.value = res.page.nextCursor;
  }

  async function refreshCount() {
    try {
      const res = await api.get<{ unread: number }>('/notifications/unread-count');
      unread.value = res.unread;
    } catch {
      /* silencioso: o contador é informativo */
    }
  }

  async function markRead(id: string) {
    await api.patch(`/notifications/${id}/read`);
    const item = items.value.find((n) => n.id === id);
    if (item && !item.readAt) {
      item.readAt = new Date().toISOString();
      unread.value = Math.max(0, unread.value - 1);
    }
  }

  async function markAllRead() {
    await api.post('/notifications/mark-all-read');
    const stamp = new Date().toISOString();
    items.value = items.value.map((n) => ({ ...n, readAt: n.readAt ?? stamp }));
    unread.value = 0;
  }

  return { items, unread, loading, nextCursor, fetch, loadMore, refreshCount, markRead, markAllRead };
});
