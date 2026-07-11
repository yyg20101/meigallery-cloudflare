<script setup lang="ts">
import type { EvidenceLayer } from '~/composables/useAdminAttribution'

interface TrendSeries {
  key: string
  label: string
  layer: EvidenceLayer
  format?: 'number' | 'percent'
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
const maxValue = computed(() => Math.max(1, ...displayRows.value.flatMap(row => props.series.map(series => valueFor(row, series.key)))))
const summary = computed(() => props.series.map(series => ({
  ...series,
  total: displayRows.value.reduce((total, row) => total + valueFor(row, series.key), 0),
})))
const ariaSummary = computed(() => `${props.title}。${summary.value.map(item => `${item.label} ${formatValue(item.total, item.format)}`).join('，')}`)

function nestedValue(row: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((value, part) => {
    return value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
  }, row)
}

function valueFor(row: Record<string, unknown>, key: string) {
  const value = Number(nestedValue(row, key))
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function pointFor(row: Record<string, unknown>, index: number, series: TrendSeries) {
  const count = Math.max(1, displayRows.value.length - 1)
  return {
    x: round(chart.left + index / count * plotWidth),
    y: round(chart.top + (1 - valueFor(row, series.key) / maxValue.value) * plotHeight),
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

function formatValue(value: number, format: TrendSeries['format']) {
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

    <div v-if="displayRows.length" class="mt-4 min-w-0 overflow-hidden border border-gray-200 bg-gray-50">
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
          v-for="item in series"
          :key="item.key"
          data-trend-path
          :data-evidence-layer="item.layer"
          :d="pathFor(item)"
          :stroke="layerStyles[item.layer].stroke"
          fill="none"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2.5"
        />
        <template v-for="(row, index) in displayRows" :key="String(row.date)">
          <text
            v-if="showDateTick(index)"
            :x="pointFor(row, index, series[0]!).x"
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
          :class="['inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium', layerStyles[item.layer].bg, layerStyles[item.layer].text]"
        >
          <span class="h-2 w-2 rounded-full" :style="{ backgroundColor: layerStyles[item.layer].stroke }" />
          {{ item.label }} {{ formatValue(item.total, item.format) }}
        </span>
      </div>
    </div>
    <p class="sr-only">{{ displayRows.map(row => String(row.date)).join('，') }}</p>
  </div>
</template>
