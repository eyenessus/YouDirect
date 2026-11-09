<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next';
import { useRouter, type RouteLocationRaw } from 'vue-router';

const props = withDefaults(
  defineProps<{
    eyebrow: string;
    title: string;
    subtitle?: string;
    backTo?: RouteLocationRaw;
    showBack?: boolean;
  }>(),
  { showBack: false },
);

const router = useRouter();

function goBack() {
  if (props.backTo) router.push(props.backTo);
  else router.back();
}
</script>

<template>
  <header>
    <button
      v-if="showBack || backTo"
      type="button"
      class="mb-4 inline-flex items-center gap-2 text-[15px] font-medium text-brand-600 transition-colors hover:text-brand-700"
      @click="goBack"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />
      Voltar
    </button>

    <!-- Faixa de título: acento vertical azul + gradiente horizontal sutil -->
    <div
      class="relative overflow-hidden rounded-r-card border-l-[5px] border-brand-600 py-[17px] pl-6 pr-6"
      style="
        background-image: linear-gradient(
          90deg,
          rgb(var(--banner-from)) 0%,
          rgb(var(--banner-to)) 72%
        );
      "
    >
      <div class="flex flex-wrap items-center justify-between gap-5">
        <div class="min-w-0">
          <p class="fo-eyebrow">{{ eyebrow }}</p>
          <h1 class="mt-1.5 break-words text-[30px] font-bold leading-tight text-ink">{{ title }}</h1>
          <p v-if="subtitle" class="mt-1.5 text-[17px] text-ink-muted">{{ subtitle }}</p>
        </div>
        <div v-if="$slots.actions" class="flex flex-wrap items-center gap-3">
          <slot name="actions" />
        </div>
      </div>
    </div>

  </header>
</template>
