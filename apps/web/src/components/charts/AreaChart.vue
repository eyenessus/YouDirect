<script setup lang="ts">
import { computed } from 'vue';
import type { EChartsOption } from 'echarts';
import BaseChart from './BaseChart.vue';
import { axisBRL, useChartTheme, withAlpha } from './useChartTheme';
import { formatCentsBRL } from '@frotaone/contracts';

const props = withDefaults(
  defineProps<{
    labels: string[];
    values: number[];
    seriesName?: string;
    tone?: 'green' | 'blue';
    height?: string;
    caption: string;
    loading?: boolean;
  }>(),
  { seriesName: 'Receita', tone: 'green', height: '320px', loading: false },
);

const chart = useChartTheme();

/** Arredonda para cima até 1, 2, 2,5, 4, 5 ou 10 × 10^k. O degrau 4
 *  reproduz a escala da referência (máximo 15.703 → marcas de R$ 4k). */
function niceStep(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const ladder = [1, 2, 2.5, 4, 5, 10];
  const step = ladder.find((candidate) => normalized <= candidate) ?? 10;
  return step * magnitude;
}

/** Topo do eixo em 4 intervalos iguais, como na referência. */
const axisBounds = computed(() => {
  const max = Math.max(0, ...props.values);
  if (max === 0) return { max: undefined, interval: undefined };
  const interval = niceStep(max / 4);
  return { max: interval * 4, interval };
});

const option = computed<EChartsOption>(() => {
  const t = chart.value;
  const color = props.tone === 'green' ? t.positive : t.brand;
  return {
    animationDuration: 400,
    grid: { left: 64, right: 24, top: 20, bottom: 36 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tooltipBg,
      borderColor: t.grid,
      borderWidth: 1,
      textStyle: { color: t.tooltipInk, fontSize: 14 },
      padding: [12, 16],
      axisPointer: { type: 'line', lineStyle: { color: t.axis, width: 1 } },
      formatter: (params: unknown) => {
        const list = params as Array<{ axisValue: string; value: number }>;
        const point = list[0];
        if (!point) return '';
        return `<div style="font-weight:700;margin-bottom:6px">${point.axisValue}</div>
                <div style="color:${color}">${props.seriesName} : ${formatCentsBRL(point.value)}</div>`;
      },
    },
    xAxis: {
      type: 'category',
      data: props.labels,
      boundaryGap: false,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: t.axis, fontSize: 13, margin: 14 },
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: axisBounds.value.max,
      interval: axisBounds.value.interval,
      axisLabel: { color: t.axis, fontSize: 13, formatter: (v: number) => axisBRL(v) },
      splitLine: { lineStyle: { color: t.grid, type: 'dashed' } },
    },
    series: [
      {
        name: props.seriesName,
        type: 'line',
        smooth: 0.4,
        symbol: 'circle',
        symbolSize: 8,
        showSymbol: false,
        data: props.values,
        lineStyle: { width: 2.5, color },
        itemStyle: { color },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: withAlpha(color, 0.25) },
              { offset: 1, color: withAlpha(color, 0.02) },
            ],
          },
        },
      },
    ],
  };
});
</script>

<template>
  <BaseChart :option="option" :height="height" :caption="caption" :loading="loading" />
</template>
