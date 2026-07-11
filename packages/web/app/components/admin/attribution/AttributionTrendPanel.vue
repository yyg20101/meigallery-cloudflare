<script setup lang="ts">
import type { EvidenceLayer } from '~/composables/useAdminAttribution'

interface TrendSeries {
  key: string
  label: string
  layer: EvidenceLayer
  format?: 'number' | 'percent'
  aggregation?:
    | { type: 'sum' }
    | { type: 'weightedRate'; numeratorKey: string; denominatorKey: string }
}

const props = withDefaults(defineProps<{
  title: string
  description?: string
  rows: Array<Record<string, unknown>>
  series: TrendSeries[]
  maxRows?: number
}>(), {
  description: '',
  maxRows: 31,
})

const layerStyles: Record<EvidenceLayer, { stroke: string; text: string; bg: string }> = {
  business: { stroke: '#047857', text: 'text-emerald-700', bg: 'bg-emerald-50' },
  pixel: { stroke: '#d97706', text: 'text-amber-700', bg: 'bg-amber-50' },
  capi: { stroke: '#2563eb', text: 'text-blue-700', bg: 'bg-blue-50' },
  quality: { stroke: '#be123c', text: 'text-rose-700', bg: 'bg-rose-50' },
}
const chart = { width: 720, height: 240, left: 46, right: 18, top: 18, bottom: 38 }
const displayRows = computed(() => props.rows.slice(-props.maxRows))
const plotWidth = chart.width - chart.left - chart.right
const plotHeight = chart.height - chart.top - chart.bottom
const variants = [
  { key: 'solid', label: '实线实心圆点', dash: '', radius: 3.5, fill: 'stroke', opacity: 1 },
  { key: 'dashed', label: '虚线空心圆点', dash: '8 4', radius: 3.5, fill: 'white', opacity: 1 },
  { key: 'dotted', label: '点线小圆点', dash: '2 4', radius: 2.5, fill: 'stroke', opacity: 0.9 },
  { key: 'dash-dot', label: '点划线空心圆点', dash: '10 3 2 3', radius: 4, fill: 'white', opacity: 0.9 },
  { key: 'long-dash', label: '长虚线小圆点', dash: '14 5', radius: 2.5, fill: 'white', opacity: 0.8 },
] as const
const seriesViews = computed(() => props.series.map((series, index) => {
  const layerIndex = props.series.slice(0, index).filter(item => item.layer === series.layer).length
  return { ...series, variant: variants[layerIndex % variants.length]! }
}))
const maxValue = computed(() => Math.max(1, ...displayRows.value.flatMap(row => seriesViews.value.map(series => valueFor(row, series)))))
const summary = computed(() => seriesViews.value.map(series => ({ ...series, total: aggregateSeries(series) })))
const ariaSummary = computed(() => `${props.title}。${summary.value.map(item => `${item.label} ${formatValue(item.total, item.format)}（${item.variant.label}）`).join('，')}`)

function nestedValue(row: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
  }, row)
}

function valueFor(row: Record<string, unknown>, series: TrendSeries) {
  const value = Number(nestedValue(row, series.key))
  if (!Number.isFinite(value)) return 0
  return series.format === 'percent' ? Math.min(1, Math.max(0, value)) : Math.max(0, value)
}

function pointFor(row: Record<string, unknown>, index: number, series: TrendSeries) {
  const count = Math.max(1, displayRows.value.length - 1)
  return {
    x: round(chart.left + index / count * plotWidth),
    y: round(chart.top + (1 - valueFor(row, series) / maxValue.value) * plotHeight),
  }
}

function pathFor(series: TrendSeries) {
  return displayRows.value.map((row, index) => {
    const point = pointFor(row, index, series)
    return `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`
  }).join(' ')
}

function showDateTick(index: number) {
  const length = displayRows.value.length
  return length <= 8 || index === 0 || index === length - 1 || index % Math.ceil(length / 5) === 0
}

function formatCount(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function aggregateSeries(series: TrendSeries) {
  const aggregation = series.aggregation
  if (aggregation?.type === 'weightedRate') {
    const numerator = displayRows.value.reduce((total, row) => total + numericValue(nestedValue(row, aggregation.numeratorKey)), 0)
    const denominator = displayRows.value.reduce((total, row) => total + numericValue(nestedValue(row, aggregation.denominatorKey)), 0)
    return denominator > 0 ? Math.min(1, numerator / denominator) : null
  }
  return displayRows.value.reduce((total, row) => total + valueFor(row, series), 0)
}

function numericValue(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, number) : 0
}

function formatValue(value: number | null, format: TrendSeries['format']) {
  if (value === null) return '暂无样本'
  return format === 'percent' ? `${Math.round(value * 10_000) / 100}%` : formatCount(value)
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
</script>

<template>
  <div data-attribution-trend class="min-w-0">
    <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h3 class="text-sm font-semibold text-gray-900">{{ title }}</h3>
        <p v-if="description" class="mt-1 text-xs leading-5 text-gray-500">{{ description }}</p>
      </div>
      <span class="shrink-0 text-xs tabular-nums text-gray-400">{{ displayRows.length }} 个业务日</span>
    </div>

    <div v-if="displayRows.length" data-chart-scroll class="mt-4 min-w-0 overflow-x-auto border border-gray-200 bg-gray-50">
      <svg
        data-attribution-chart
        class="h-60 w-full min-w-[36rem]"
        :viewBox="`0 0 ${chart.width} ${chart.height}`"
        role="img"
        :aria-label="ariaSummary"
      >
        <line
          v-for="line in [0, 0.25, 0.5, 0.75, 1]"
          :key="line"
          :x1="chart.left"
          :x2="chart.width - chart.right"
          :y1="chart.top + line * plotHeight"
          :y2="chart.top + line * plotHeight"
          stroke="#e5e7eb"
          stroke-width="1"
        />
        <text :x="chart.left" :y="chart.top + 8" fill="#6b7280" font-size="11">{{ formatCount(maxValue) }}</text>
        <path
          v-for="item in seriesViews"
          :key="item.key"
          data-trend-path
          :data-evidence-layer="item.layer"
          :d="pathFor(item)"
          :stroke="layerStyles[item.layer].stroke"
          :stroke-dasharray="item.variant.dash || undefined"
          :opacity="item.variant.opacity"
          :data-series-variant="item.variant.key"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2.5"
        />
        <template v-for="item in seriesViews" :key="`${item.key}-markers`">
          <circle
            v-for="(row, index) in displayRows"
            :key="`${item.key}-${String(row.date)}`"
            data-trend-marker
            :data-series-variant="item.variant.key"
            :cx="pointFor(row, index, item).x"
            :cy="pointFor(row, index, item).y"
            :r="item.variant.radius"
            :fill="item.variant.fill === 'stroke' ? layerStyles[item.layer].stroke : '#ffffff'"
            :stroke="layerStyles[item.layer].stroke"
            stroke-width="1.5"
            :opacity="item.variant.opacity"
          />
        </template>
        <template v-for="(row, index) in displayRows" :key="String(row.date)">
          <text
            v-if="showDateTick(index)"
            :x="pointFor(row, index, seriesViews[0]!).x"
            :y="chart.height - 12"
            fill="#6b7280"
            font-size="11"
            text-anchor="middle"
          >
            {{ String(row.date).slice(5) || '-' }}
          </text>
        </template>
      </svg>
    </div>
    <p v-else class="mt-4 border-y border-gray-200 py-8 text-center text-sm text-gray-500">当前范围暂无趋势数据</p>

    <div data-trend-summary class="mt-3 overflow-x-auto pb-1">
      <div class="flex min-w-max gap-2">
        <span
          v-for="item in summary"
          :key="item.key"
          :data-evidence-layer="item.layer"
          data-trend-legend-variant
          :data-series-variant="item.variant.key"
          :aria-label="`${item.label}，${item.variant.label}，${formatValue(item.total, item.format)}`"
          :class="['inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium', layerStyles[item.layer].bg, layerStyles[item.layer].text]"
        >
          <span class="relative inline-flex h-3 w-7 items-center" aria-hidden="true">
            <span class="w-full border-t-2" :style="{ borderColor: layerStyles[item.layer].stroke, borderTopStyle: item.variant.dash ? 'dashed' : 'solid', opacity: item.variant.opacity }" />
            <span class="absolute left-1/2 h-2 w-2 -translate-x-1/2 rounded-full border" :style="{ borderColor: layerStyles[item.layer].stroke, backgroundColor: item.variant.fill === 'stroke' ? layerStyles[item.layer].stroke : '#ffffff' }" />
          </span>
          {{ item.label }} {{ formatValue(item.total, item.format) }}
        </span>
      </div>
    </div>
    <p class="sr-only">{{ displayRows.map(row => String(row.date)).join('，') }}</p>
  </div>
</template>
