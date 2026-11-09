<script setup lang="ts">
import { computed } from 'vue';
import type { EChartsOption } from 'echarts';
import BaseChart from './BaseChart.vue';
import { compactBRL, useChartTheme } from './useChartTheme';
import { formatCentsBRL } from '@frotaone/contracts';

const props = withDefaults(
  defineProps<{
    items: Array<{ label: string; amountCents: number }>;
    height?: string;
    caption: string;
  }>(),
  { height: '260px' },
);

const chart = useChartTheme();

const total = computed(() => props.items.reduce((a, i) => a + i.amountCents, 0));

const option = computed<EChartsOption>(() => {
  const t = chart.value;
  const palette = [t.brand, '#1d4ed8', '#60a5fa', '#93c5fd', '#2dd4bf', '#f59e0b'];
  return {
    animationDuration: 400,
    tooltip: {
      trigger: 'item',
      backgroundColor: t.tooltipBg,
      borderColor: t.grid,
      borderWidth: 1,
      textStyle: { color: t.tooltipInk, fontSize: 14 },
      formatter: (params: unknown) => {
        const p = params as { name: string; value: number; percent: number };
        return `${p.name}<br/><b>${formatCentsBRL(p.value)}</b> (${p.percent.toFixed(1)}%)`;
      },
    },
    series: [
      {
        type: 'pie',
        radius: ['62%', '88%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false },
        labelLine: { show: false },
        itemStyle: { borderColor: t.surface, borderWidth: 2 },
        data: props.items.map((item, index) => ({
          name: item.label,
          value: item.amountCents,
          itemStyle: { color: palette[index % palette.length] },
        })),
      },
    ],
    graphic:
      total.value > 0
        ? [
            {
              type: 'text',
              left: 'center',
              top: '44%',
              style: {
                text: 'TOTAL',
                fill: t.axis,
                fontSize: 11,
                fontWeight: 600,
                align: 'center',
              },
            },
            {
              type: 'text',
              left: 'center',
              top: '52%',
              style: {
                text: compactBRL(total.value),
                fill: t.ink,
                fontSize: 20,
                fontWeight: 700,
                align: 'center',
              },
            },
          ]
        : [],
  };
});
</script>

<template>
  <BaseChart :option="option" :height="height" :caption="caption" />
</template>
