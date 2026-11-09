<script setup lang="ts">
withDefaults(defineProps<{ title?: string; message: string; icon?: unknown }>(), {});
</script>

<template>
  <div class="flex flex-col items-center justify-center px-6 py-16 text-center">
    <component :is="icon" v-if="icon" class="mb-5 size-12 text-ink-muted/60" aria-hidden="true" />
    <h3 v-if="title" class="mb-2 text-lg font-semibold text-ink">{{ title }}</h3>
    <p class="max-w-xl text-[17px] leading-relaxed text-ink-muted">{{ message }}</p>
    <div v-if="$slots.default" class="mt-6">
      <slot />
    </div>
  </div>
</template>
