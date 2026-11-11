<script setup lang="ts">
import { useId } from 'vue';
/**
 * Cenário da tela de login: um "showroom" escuro com supercarros vermelhos em
 * camadas de profundidade (SVG próprio, sem fotos nem marcas de terceiros).
 * As animações são lentas e desligam com `prefers-reduced-motion`.
 *
 * Observação técnica: o navegador herda cor SÓLIDA pelo <use>, mas não herda
 * gradiente; por isso a cor do carro vem de `color` + `currentColor` e o
 * sombreado é uma camada de gradiente explícita dentro do próprio carro.
 */
defineProps<{ compact?: boolean }>();

/** IDs únicos por instância: a tela tem duas cópias (celular e desktop) e `url(#id)` pegaria a escondida. */
const uid = `yd${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
const u = (n: string) => `${uid}-${n}`;
const paint = (n: string) => `url(#${uid}-${n})`;
const ref = (n: string) => `#${uid}-${n}`;
</script>

<template>
  <div class="showroom" :class="{ 'showroom--compact': compact }" aria-hidden="true">
    <div class="showroom__glow" />
    <div class="showroom__streaks">
      <span v-for="n in 7" :key="n" :style="{ '--i': n }" />
    </div>

    <svg class="showroom__cars" viewBox="0 0 800 520" preserveAspectRatio="xMidYMax slice" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient :id="u('shade')" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity=".36" />
          <stop offset=".28" stop-color="#fff" stop-opacity="0" />
          <stop offset=".62" stop-color="#000" stop-opacity=".2" />
          <stop offset="1" stop-color="#000" stop-opacity=".66" />
        </linearGradient>
        <linearGradient :id="u('glass')" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#4b5a73" />
          <stop offset=".45" stop-color="#121722" />
          <stop offset="1" stop-color="#06080c" />
        </linearGradient>
        <linearGradient :id="u('shine')" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#fff" stop-opacity="0" />
          <stop offset=".4" stop-color="#fff" stop-opacity=".6" />
          <stop offset=".85" stop-color="#fff" stop-opacity=".1" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
        <radialGradient :id="u('rim')" cx=".5" cy=".5" r=".5">
          <stop offset="0" stop-color="#dfe3ec" />
          <stop offset=".7" stop-color="#7b8190" />
          <stop offset="1" stop-color="#2b2e38" />
        </radialGradient>
        <radialGradient :id="u('shadow')" cx=".5" cy=".5" r=".5">
          <stop offset="0" stop-color="#000" stop-opacity=".9" />
          <stop offset="1" stop-color="#000" stop-opacity="0" />
        </radialGradient>
        <radialGradient :id="u('lamp')" cx=".5" cy=".5" r=".5">
          <stop offset="0" stop-color="#fff6d6" stop-opacity=".95" />
          <stop offset="1" stop-color="#fff6d6" stop-opacity="0" />
        </radialGradient>
        <radialGradient :id="u('tail')" cx=".5" cy=".5" r=".5">
          <stop offset="0" stop-color="#ff2a2a" stop-opacity=".95" />
          <stop offset="1" stop-color="#ff2a2a" stop-opacity="0" />
        </radialGradient>
        <!-- reflexo: forte junto ao chão e some para baixo -->
        <linearGradient :id="u('fade')" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity=".55" />
          <stop offset=".6" stop-color="#fff" stop-opacity=".12" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </linearGradient>
        <mask :id="u('reflect')" maskUnits="userSpaceOnUse" x="-40" y="158" width="720" height="80">
          <rect x="-40" y="158" width="720" height="80" :fill="paint('fade')" />
        </mask>
        <g :id="u('wheel')">
          <circle r="41" fill="#07080b" />
          <circle r="30" :fill="paint('rim')" />
          <g fill="#171921">
            <path v-for="k in 10" :key="k" :transform="`rotate(${k * 36})`" d="M-3,-28 L3,-28 L1.4,-6 L-1.4,-6 Z" />
          </g>
          <circle r="8" fill="#0b0c10" />
          <circle r="3.2" fill="#d40000" />
        </g>

        <!--
          Supercarro de perfil, virado para a direita (cabine à frente, motor central).
          640 × 172, chão em y = 160, rodas r = 41 em x = 140 e x = 455.
        -->
        <g :id="u('car')">
          <ellipse cx="322" cy="160" rx="338" ry="10" :fill="paint('shadow')" />

          <!-- carroceria -->
          <path
            fill="currentColor"
            d="M24,146 L22,112 C24,100 36,96 56,94 L110,88 C140,74 168,70 205,64 C250,52 290,38 330,32 C360,28 396,26 424,30 C448,36 468,56 492,76 C520,86 556,92 586,98 C608,102 620,110 620,124 L616,146 Z"
          />
          <path
            :fill="paint('shade')"
            d="M24,146 L22,112 C24,100 36,96 56,94 L110,88 C140,74 168,70 205,64 C250,52 290,38 330,32 C360,28 396,26 424,30 C448,36 468,56 492,76 C520,86 556,92 586,98 C608,102 620,110 620,124 L616,146 Z"
          />
          <!-- soleira e difusor -->
          <path d="M24,136 L616,136 L616,146 L24,146 Z" fill="#000" opacity=".32" />
          <path d="M536,140 L618,132 L616,146 L536,146 Z" fill="#000" opacity=".5" />

          <!-- vidros -->
          <path d="M300,72 L332,40 C362,34 394,33 418,37 C436,44 452,60 470,74 Z" :fill="paint('glass')" />
          <path d="M338,40 C362,36 392,35 414,39" stroke="#9fb4d6" stroke-opacity=".5" stroke-width="1.6" fill="none" stroke-linecap="round" />
          <path d="M332,40 L316,72" stroke="#000" stroke-opacity=".7" stroke-width="3" />

          <!-- entrada de ar lateral (atrás da porta) -->
          <path d="M206,102 C230,96 266,100 288,111 L274,130 C254,124 228,124 202,130 Z" fill="#0a0203" />
          <path d="M212,104 C234,100 262,103 282,111" stroke="#ff6a5a" stroke-opacity=".4" stroke-width="1.4" fill="none" />
          <!-- porta -->
          <path d="M304,76 C300,98 300,118 304,138" stroke="#000" stroke-opacity=".4" stroke-width="1.8" fill="none" />
          <path d="M444,78 C448,100 450,118 448,134" stroke="#000" stroke-opacity=".28" stroke-width="1.6" fill="none" />

          <!-- brilhos -->
          <path d="M66,96 L112,90 C172,78 320,66 470,80 L578,100" :stroke="paint('shine')" stroke-width="3.4" fill="none" stroke-linecap="round" />
          <path d="M250,56 C296,44 350,40 410,42" :stroke="paint('shine')" stroke-width="2" fill="none" opacity=".75" stroke-linecap="round" />

          <!-- aerofólio traseiro -->
          <path d="M18,102 L76,90 L78,96 L22,108 Z" fill="#000" opacity=".6" />

          <!-- rodas -->
          <circle cx="140" cy="119" r="45" fill="#05060a" />
          <circle cx="455" cy="119" r="45" fill="#05060a" />
          <use :href="ref('wheel')" x="140" y="119" />
          <use :href="ref('wheel')" x="455" y="119" />

          <!-- faróis e lanternas -->
          <circle cx="594" cy="107" r="19" :fill="paint('lamp')" />
          <path d="M556,100 L608,109 L598,114 L548,105 Z" fill="#fff8e2" />
          <circle cx="34" cy="108" r="16" :fill="paint('tail')" />
          <path d="M23,106 L58,98 L58,104 L25,114 Z" fill="#ff4a4a" />
        </g>
      </defs>

      <!-- fundo: carros distantes -->
      <g class="layer layer--far" opacity=".34">
        <g transform="translate(40,127) scale(.3)"><use :href="ref('car')" color="#a60d14" /></g>
        <g transform="translate(760,127) scale(-.3,.3)"><use :href="ref('car')" color="#4a4f5e" /></g>
        <g transform="translate(330,128) scale(.26)"><use :href="ref('car')" color="#a60d14" /></g>
      </g>

      <!-- meio -->
      <g class="layer layer--mid" opacity=".8">
        <g transform="translate(360,220) scale(-.5,.5)"><use :href="ref('car')" color="#d10a0a" /></g>
        <g transform="translate(420,224) scale(.5)"><use :href="ref('car')" color="#f5c400" /></g>
      </g>

      <!-- frente, com reflexo no piso -->
      <g class="layer layer--front">
        <g transform="translate(60,291) scale(.92)">
          <g :mask="`url(#${u('reflect')})`">
            <g transform="translate(0,160) scale(1,-.5) translate(0,-160)"><use :href="ref('car')" color="#e10600" /></g>
          </g>
          <use :href="ref('car')" color="#e10600" />
        </g>
      </g>
    </svg>

    <div class="showroom__vignette" />
  </div>
</template>

<style scoped>
.showroom {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background:
    radial-gradient(120% 70% at 75% 100%, rgb(212 0 0 / 0.34), transparent 60%),
    radial-gradient(70% 50% at 0% 0%, rgb(255 255 255 / 0.05), transparent 60%),
    linear-gradient(165deg, #12131a 0%, #0a0b10 45%, #1a0507 100%);
}
.showroom__glow {
  position: absolute;
  left: 18%;
  right: -10%;
  bottom: -8%;
  height: 46%;
  background: radial-gradient(closest-side, rgb(255 40 30 / 0.28), transparent 72%);
  filter: blur(18px);
}
.showroom__cars {
  position: absolute;
  inset: auto 0 0 0;
  width: 100%;
  height: 62%;
}
.showroom--compact .showroom__cars {
  height: 100%;
}
/* Faixa do celular: só o carro da frente, para o logo ter espaço limpo. */
.showroom--compact .layer--far,
.showroom--compact .layer--mid {
  display: none;
}
.showroom__vignette {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgb(7 8 12 / 0.86) 0%, rgb(7 8 12 / 0.25) 38%, transparent 55%),
    linear-gradient(0deg, rgb(7 8 12 / 0.7) 0%, transparent 16%);
  pointer-events: none;
}
.showroom--compact .showroom__vignette {
  background: linear-gradient(180deg, rgb(7 8 12 / 0.7) 0%, transparent 70%);
}

/* Riscos de velocidade ao fundo */
.showroom__streaks {
  position: absolute;
  inset: 0;
  overflow: hidden;
  transform: rotate(-12deg) scale(1.3);
}
.showroom__streaks span {
  position: absolute;
  left: -40%;
  top: calc(var(--i) * 13% - 4%);
  width: calc(26% + var(--i) * 4%);
  height: 1px;
  background: linear-gradient(90deg, transparent, rgb(255 70 55 / 0.55), transparent);
  opacity: calc(0.25 + var(--i) * 0.05);
  animation: yd-streak calc(7s + var(--i) * 1.3s) linear infinite;
  animation-delay: calc(var(--i) * -2.1s);
}

.layer {
  animation: yd-drift 14s ease-in-out infinite alternate;
}
.layer--mid {
  animation-duration: 18s;
  animation-direction: alternate-reverse;
}
.layer--far {
  animation-duration: 24s;
}
.layer--front {
  animation-duration: 11s;
}

@keyframes yd-streak {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(520%);
  }
}
@keyframes yd-drift {
  from {
    transform: translateX(-6px);
  }
  to {
    transform: translateX(6px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .showroom__streaks span,
  .layer {
    animation: none;
  }
}
</style>
