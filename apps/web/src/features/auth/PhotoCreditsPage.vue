<script setup lang="ts">
import { RouterLink } from 'vue-router';
import { authPhotos } from './auth-photos';
</script>

<template>
  <div class="min-h-screen bg-canvas px-6 py-12">
    <div class="mx-auto max-w-3xl">
      <RouterLink to="/login" class="text-sm font-medium text-brand-600 hover:underline">← Voltar para o login</RouterLink>
      <h1 class="mt-6 text-[28px] font-bold text-ink">Créditos das fotos</h1>
      <p class="mt-2 text-[17px] leading-relaxed text-ink-muted">
        As fotos de fundo das telas de acesso vêm do Wikimedia Commons e são usadas conforme a licença de cada autor.
        Elas foram redimensionadas e recortadas para caber na tela. Ferrari e os demais nomes e marcas que aparecem nas
        fotos pertencem aos seus donos; o YuDirect não tem relação com a Ferrari S.p.A.
      </p>

      <ul class="mt-8 grid gap-4 sm:grid-cols-2">
        <li v-for="photo in authPhotos" :key="photo.id" class="fo-card overflow-hidden">
          <img :src="photo.src" :alt="`Ferrari ${photo.model}`" class="h-40 w-full object-cover" loading="lazy" />
          <div class="space-y-1 p-4 text-[15px]">
            <p class="font-semibold text-ink">Ferrari {{ photo.model }}</p>
            <p class="text-ink-muted">Foto: {{ photo.author }}</p>
            <p class="text-ink-muted">
              Licença:
              <a :href="photo.licenseUrl" target="_blank" rel="noopener noreferrer" class="text-brand-600 hover:underline">{{ photo.license }}</a>
            </p>
            <a :href="photo.source" target="_blank" rel="noopener noreferrer" class="text-sm text-brand-600 hover:underline">Ver no Wikimedia Commons</a>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>
