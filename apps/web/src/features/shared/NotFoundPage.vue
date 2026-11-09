<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="flex min-h-screen flex-col items-center justify-center bg-canvas p-6 text-center">
    <span class="flex size-14 items-center justify-center rounded-2xl bg-sidebar">
      <img src="/brand/frotaone-mark-white.png" alt="" class="size-9 object-contain" />
    </span>
    <h1 class="mt-6 text-3xl font-bold text-ink">Página não encontrada</h1>
    <p class="mt-2 max-w-md text-[17px] leading-relaxed text-ink-muted">
      O endereço acessado não existe ou foi movido.
    </p>
    <AppButton class="mt-7" @click="router.replace('/dashboard')">Voltar ao painel</AppButton>
  </div>
</template>
