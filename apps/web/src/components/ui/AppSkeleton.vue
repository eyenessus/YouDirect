<script setup lang="ts">
withDefaults(defineProps<{ rows?: number; variant?: 'table' | 'cards' | 'block' }>(), {
  rows: 5,
  variant: 'table',
});
</script>

<template>
  <div class="animate-pulse" role="status" aria-label="Carregando">
    <div v-if="variant === 'table'" class="space-y-3 p-4">
      <div v-for="i in rows" :key="i" class="flex items-center gap-4">
        <div class="h-10 w-16 rounded bg-surface-muted" />
        <div class="h-4 flex-1 rounded bg-surface-muted" />
        <div class="h-4 w-24 rounded bg-surface-muted" />
        <div class="h-4 w-20 rounded bg-surface-muted" />
      </div>
    </div>
    <div v-else-if="variant === 'cards'" class="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
      <div v-for="i in rows" :key="i" class="h-44 rounded-card border border-line bg-surface-muted" />
    </div>
    <div v-else class="h-40 rounded-card bg-surface-muted" />
    <span class="sr-only">Carregando…</span>
  </div>
</template>
