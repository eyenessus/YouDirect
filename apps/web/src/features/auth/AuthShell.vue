<script setup lang="ts">
import { RouterLink } from 'vue-router';
import AuthCollage from './AuthCollage.vue';

/**
 * Moldura das telas de acesso (entrar, esqueci a senha, nova senha, convite):
 * painel de marca com mosaico de fotos de Ferrari + conteúdo da tela ao lado.
 * No celular o painel vira uma faixa no topo.
 */
</script>

<template>
  <div class="grid min-h-screen lg:grid-cols-[1fr_minmax(420px,520px)]">
    <!-- Faixa de marca (celular) -->
    <header class="relative h-52 overflow-hidden bg-[#07080c] lg:hidden">
      <AuthCollage compact />
      <div class="relative z-10 flex items-center gap-3 p-6">
        <span class="flex size-11 items-center justify-center rounded-xl border border-white/15 bg-black/35 backdrop-blur">
          <img src="/brand/yudirect-mark-white.png" alt="" class="size-7 object-contain" />
        </span>
        <span class="text-xl font-bold text-white">YuDirect</span>
      </div>
    </header>

    <!-- Painel de marca (computador) -->
    <aside class="relative hidden min-h-screen flex-col overflow-hidden bg-[#07080c] p-12 text-white lg:flex">
      <AuthCollage />
      <div class="relative z-10 flex items-center gap-3">
        <span class="flex size-12 items-center justify-center rounded-xl border border-white/15 bg-black/35 shadow-lg backdrop-blur">
          <img src="/brand/yudirect-mark-white.png" alt="" class="size-8 object-contain" />
        </span>
        <span class="text-2xl font-bold tracking-tight">YuDirect</span>
      </div>

      <div class="relative z-10 mt-auto max-w-xl">
        <p class="text-5xl font-bold leading-[1.08] tracking-tight">
          Gestão completa da sua
          <span class="bg-gradient-to-r from-[#ff4d3d] to-[#e10600] bg-clip-text text-transparent">frota.</span>
        </p>
        <p class="mt-5 text-lg leading-relaxed text-white/75">
          Veículos, motoristas, locações, vistorias, manutenções e financeiro — em um só lugar.
        </p>
        <p class="mt-10 text-sm text-white/55">
          © {{ new Date().getFullYear() }} YuDirect · Gestão veicular ·
          <RouterLink to="/creditos-fotos" class="underline decoration-white/30 underline-offset-2 hover:text-white">Créditos das fotos</RouterLink>
        </p>
      </div>
    </aside>

    <!-- Conteúdo da tela -->
    <main class="flex items-center justify-center bg-canvas p-6 sm:p-10">
      <div class="w-full max-w-md">
        <slot />
        <p class="mt-10 text-center text-xs text-ink-muted lg:hidden">
          <RouterLink to="/creditos-fotos" class="underline underline-offset-2">Créditos das fotos</RouterLink>
        </p>
      </div>
    </main>
  </div>
</template>
