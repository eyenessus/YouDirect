<script setup lang="ts">
import { computed } from 'vue';
import { authPhotos, type AuthPhoto } from './auth-photos';

/**
 * Fundo das telas de acesso: mosaico em ângulo com fotos reais de Ferrari,
 * em três colunas que sobem e descem devagar (loop contínuo). As animações
 * desligam com `prefers-reduced-motion`. As fotos são decorativas.
 */
const props = defineProps<{ compact?: boolean }>();

const columns = computed(() => {
  const list = props.compact ? authPhotos.slice(0, 5) : authPhotos;
  const cols: AuthPhoto[][] = [[], [], []];
  list.forEach((photo, i) => cols[i % 3]!.push(photo));
  // Três cópias: a animação anda exatamente uma cópia e recomeça sem salto.
  return cols.map((c) => [...c, ...c, ...c]);
});
</script>

<template>
  <div class="collage" :class="{ 'collage--compact': compact }" aria-hidden="true">
    <div class="collage__tilt">
      <div v-for="(col, ci) in columns" :key="ci" class="collage__col" :class="`collage__col--${ci}`">
        <img
          v-for="(photo, i) in col"
          :key="`${photo.id}-${i}`"
          class="collage__photo"
          :src="photo.src"
          :style="{ objectPosition: photo.position }"
          alt=""
          loading="lazy"
          decoding="async"
          draggable="false"
        />
      </div>
    </div>
    <div class="collage__shade" />
    <div class="collage__glow" />
  </div>
</template>

<style scoped>
.collage {
  --card-h: 290px;
  --gap: 16px;
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #07080c;
}
.collage--compact {
  --card-h: 120px;
  --gap: 10px;
}

.collage__tilt {
  position: absolute;
  inset: -22% -14%;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--gap);
  transform: rotate(-8deg);
}
.collage__col {
  display: flex;
  flex-direction: column;
  gap: var(--gap);
  padding-bottom: var(--gap);
  animation: collage-up 75s linear infinite;
  will-change: transform;
}
.collage__col--1 {
  animation-name: collage-down;
  animation-duration: 90s;
}
.collage__col--2 {
  animation-duration: 105s;
}
.collage__photo {
  display: block;
  width: 100%;
  height: var(--card-h);
  flex: none;
  object-fit: cover;
  border-radius: 18px;
  background: #14161d;
  box-shadow: 0 18px 40px -18px rgb(0 0 0 / 0.9);
  user-select: none;
}

/* Escurece para o texto (embaixo) e para o logo (em cima), com um brilho vermelho. */
.collage__shade {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(0deg, rgb(7 8 12 / 0.97) 0%, rgb(7 8 12 / 0.86) 26%, rgb(7 8 12 / 0.2) 58%, rgb(7 8 12 / 0.55) 100%),
    linear-gradient(90deg, rgb(7 8 12 / 0.55) 0%, transparent 45%);
}
.collage--compact .collage__shade {
  background: linear-gradient(180deg, rgb(7 8 12 / 0.8) 0%, rgb(7 8 12 / 0.25) 55%, rgb(7 8 12 / 0.7) 100%);
}
.collage__glow {
  position: absolute;
  inset: 0;
  background: radial-gradient(70% 45% at 85% 105%, rgb(225 6 0 / 0.38), transparent 70%);
  mix-blend-mode: screen;
  pointer-events: none;
}

@keyframes collage-up {
  to {
    transform: translateY(calc(-100% / 3));
  }
}
@keyframes collage-down {
  from {
    transform: translateY(calc(-100% / 3));
  }
  to {
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .collage__col {
    animation: none;
  }
}
</style>
