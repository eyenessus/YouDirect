<script setup lang="ts">
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  MarkAreaComponent,
  GraphicComponent,
} from 'echarts/components';
import VChart from 'vue-echarts';
import type { EChartsOption } from 'echarts';

use([
  CanvasRenderer,
  LineChart,
  BarChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkAreaComponent,
  GraphicComponent,
]);

withDefaults(
  defineProps<{ option: EChartsOption; height?: string; caption: string; loading?: boolean }>(),
  { height: '320px', loading: false },
);

const emit = defineEmits<{ click: [unknown] }>();
</script>

<template>
  <div :style="{ height }" role="img" :aria-label="caption">
    <VChart
      class="size-full"
      :option="option"
      :loading="loading"
      autoresize
      @click="emit('click', $event)"
    />
  </div>
</template>
