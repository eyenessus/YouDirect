<script setup lang="ts">
import { computed } from 'vue';
import type { EChartsOption } from 'echarts';
import BaseChart from './BaseChart.vue';
import { axisBRL, compactBRL, useChartTheme, withAlpha } from './useChartTheme';
import { formatCentsBRL } from '@yudirect/contracts';

const props = withDefaults(
  defineProps<{
    labels: string[];
    revenue: number[];
    expenses: number[];
    profit: number[];
    highlightIndex?: number;
    height?: string;
    caption: string;
  }>(),
  { height: '340px' },
);

const emit = defineEmits<{ selectMonth: [number] }>();
const chart = useChartTheme();

const option = computed<EChartsOption>(() => {
  const t = chart.value;
  return {
    animationDuration: 400,
    grid: { left: 56, right: 20, top: 42, bottom: 36 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: t.tooltipBg,
      borderColor: t.grid,
      borderWidth: 1,
      textStyle: { color: t.tooltipInk, fontSize: 14 },
      padding: [12, 16],
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const list = params as Array<{ dataIndex: number; axisValue: string }>;
        const index = list[0]?.dataIndex ?? 0;
        return `<div style="font-weight:700;margin-bottom:6px">${list[0]?.axisValue ?? ''}</div>
          <div>Faturamento: <b>${formatCentsBRL(props.revenue[index] ?? 0)}</b></div>
          <div>Despesas: <b>${formatCentsBRL(props.expenses[index] ?? 0)}</b></div>
          <div style="margin-top:4px">Lucro: <b>${formatCentsBRL(props.profit[index] ?? 0)}</b></div>`;
      },
    },
    xAxis: {
      type: 'category',
      data: props.labels,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: t.axis, fontSize: 13, margin: 14 },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: t.axis, fontSize: 13, formatter: (v: number) => axisBRL(v) },
      splitLine: { lineStyle: { color: t.grid } },
    },
    series: [
      {
        name: 'Faturamento',
        type: 'bar',
        data: props.revenue,
        barWidth: 26,
        barGap: '10%',
        itemStyle: { color: t.brand, borderRadius: [2, 2, 0, 0] },
        label: {
          show: true,
          position: 'top',
          distance: 24,
          color: t.axis,
          fontSize: 12,
          formatter: (params: { dataIndex: number }) => compactBRL(props.profit[params.dataIndex] ?? 0),
        },
        markArea:
          props.highlightIndex !== undefined
            ? {
                silent: true,
                itemStyle: { color: withAlpha(t.brand, 0.07) },
                data: [
                  [
                    { xAxis: props.labels[props.highlightIndex] ?? '' },
                    { xAxis: props.labels[props.highlightIndex] ?? '' },
                  ],
                ],
              }
            : undefined,
      },
      {
        name: 'Despesas',
        type: 'bar',
        data: props.expenses,
        barWidth: 26,
        itemStyle: { color: t.neutral, borderRadius: [2, 2, 0, 0] },
      },
    ],
  };
});

function onClick(event: unknown) {
  const payload = event as { dataIndex?: number };
  if (typeof payload?.dataIndex === 'number') emit('selectMonth', payload.dataIndex);
}
</script>

<template>
  <BaseChart :option="option" :height="height" :caption="caption" @click="onClick" />
</template>
