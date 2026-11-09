<script setup lang="ts" generic="T extends { id: string }">
import AppSkeleton from './AppSkeleton.vue';
import EmptyState from './EmptyState.vue';

export interface Column {
  key: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
  srOnly?: boolean;
}

withDefaults(
  defineProps<{
    columns: Column[];
    rows: T[];
    loading?: boolean;
    emptyMessage?: string;
    emptyTitle?: string;
    rowKey?: (row: T) => string;
    caption?: string;
  }>(),
  { loading: false, emptyMessage: 'Nenhum registro encontrado.' },
);

const alignment = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;
</script>

<template>
  <div>
    <AppSkeleton v-if="loading" variant="table" />

    <EmptyState v-else-if="rows.length === 0" :title="emptyTitle" :message="emptyMessage">
      <slot name="empty-action" />
    </EmptyState>

    <div v-else class="fo-scroll-x px-6 pb-6">
      <table class="fo-table">
        <caption v-if="caption" class="sr-only">{{ caption }}</caption>
        <thead>
          <tr>
            <th
              v-for="column in columns"
              :key="column.key"
              scope="col"
              :class="alignment[column.align ?? 'left']"
              :style="column.width ? { width: column.width } : undefined"
            >
              <span :class="column.srOnly ? 'sr-only' : ''">{{ column.label }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="rowKey ? rowKey(row) : row.id">
            <td
              v-for="column in columns"
              :key="column.key"
              :class="alignment[column.align ?? 'left']"
            >
              <slot :name="`cell-${column.key}`" :row="row">—</slot>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
