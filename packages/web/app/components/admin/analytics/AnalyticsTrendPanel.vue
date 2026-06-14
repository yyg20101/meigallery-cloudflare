<script setup lang="ts">
import AnalyticsEmptyState from './AnalyticsEmptyState.vue'

type TrendTone = 'blue' | 'green' | 'gold' | 'gray' | 'red' | 'teal'

interface TrendSeries {
  key: string
  label: string
  tone?: TrendTone
  fallbackKey?: string
}

const props = withDefaults(defineProps<{
  title?: string
  description?: string
  rows: Array<Record<string, unknown>>
  series?: TrendSeries[]
  maxRows?: number
  badgeLabel?: string
}>(), {
  title: '访问与转化趋势',
  description: '按日观察核心访问、联系和转化走势',
  maxRows: 21,
  badgeLabel: '',
})

const defaultSeries: TrendSeries[] = [
  { label: 'PV', key: 'page_view_count', tone: 'blue' },
  { label: '注册', key: 'register_count', tone: 'green' },
  { label: '有效联系', key: 'effective_contact_click_count', fallbackKey: 'contact_click_count', tone: 'gold' },
  { label: '会员', key: 'membership_grant_count', tone: 'gray' },
]

const toneClass: Record<TrendTone, { stroke: string; text: string; bg: string }> = {
  blue: { stroke: '#2563eb', text: 'text-blue-700', bg: 'bg-blue-50' },
  green: { stroke: '#059669', text: 'text-emerald-700', bg: 'bg-emerald-50' },
  gold: { stroke: '#d97706', text: 'text-amber-700', bg: 'bg-amber-50' },
  gray: { stroke: '#111827', text: 'text-gray-900', bg: 'bg-gray-50' },
  red: { stroke: '#dc2626', text: 'text-red-700', bg: 'bg-red-50' },
  teal: { stroke: '#0f766e', text: 'text-teal-700', bg: 'bg-teal-50' },
}

const chart = {
  width: 640,
  height: 220,
  left: 42,
  right: 18,
  top: 18,
  bottom: 34,
}

const activeSeries = computed(() => props.series?.length ? props.series : defaultSeries)
const firstSeries = computed(() => activeSeries.value[0] ?? defaultSeries[0]!)
const displayRows = computed(() => props.rows.slice(-props.maxRows))
const plotWidth = computed(() => chart.width - chart.left - chart.right)
const plotHeight = computed(() => chart.height - chart.top - chart.bottom)
const maxValue = computed(() => {
  const values = displayRows.value.flatMap(row => activeSeries.value.map(series => trendValue(row, series)))
  return Math.max(1, ...values)
})

const summary = computed(() => activeSeries.value.map(series => ({
  ...series,
  tone: series.tone ?? 'gray' as TrendTone,
  total: displayRows.value.reduce((sum, row) => sum + trendValue(row, series), 0),
})))

function trendValue(row: Record<string, unknown>, series: TrendSeries) {
  const primary = Number(row[series.key] ?? 0)
  if (Number.isFinite(primary) && primary > 0) return primary
  const fallback = series.fallbackKey ? Number(row[series.fallbackKey] ?? 0) : 0
  return Number.isFinite(fallback) ? Math.max(0, fallback) : 0
}

function pointFor(row: Record<string, unknown>, index: number, series: TrendSeries) {
  const count = Math.max(1, displayRows.value.length - 1)
  const x = chart.left + (index / count) * plotWidth.value
  const y = chart.top + (1 - trendValue(row, series) / maxValue.value) * plotHeight.value
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 }
}

function pathFor(series: TrendSeries) {
  return displayRows.value
    .map((row, index) => {
      const point = pointFor(row, index, series)
      return `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`
    })
    .join(' ')
}

function lastPoint(series: TrendSeries) {
  const row = displayRows.value[displayRows.value.length - 1]
  return row ? pointFor(row, displayRows.value.length - 1, series) : { x: 0, y: 0 }
}

function dateLabel(value: unknown) {
  const text = String(value ?? '')
  return text.slice(5) || '-'
}

function showDateTick(index: number) {
  const length = displayRows.value.length
  if (length <= 8) return true
  return index === 0 || index === length - 1 || index % Math.ceil(length / 5) === 0
}

function colorFor(series: TrendSeries) {
  return toneClass[series.tone ?? 'gray'].stroke
}

function toneFor(series: TrendSeries) {
  return toneClass[series.tone ?? 'gray']
}
</script>

<template>
  <section class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
    <div class="mb-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <h2 class="text-sm font-semibold text-gray-900">{{ title }}</h2>
        <p class="mt-1 text-xs leading-5 text-gray-500">{{ description }}</p>
      </div>
      <span class="w-max rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
        {{ badgeLabel || `近 ${displayRows.length} 天` }}
      </span>
    </div>

    <AnalyticsEmptyState
      v-if="displayRows.length === 0"
      title="暂无趋势数据"
      description="聚合任务生成日报后，这里会展示访问与转化趋势。"
      tone="blue"
    />
    <div v-else class="space-y-5">
      <div class="overflow-hidden rounded-lg border border-gray-100 bg-gray-50 px-2 py-3">
        <svg class="h-56 w-full" :viewBox="`0 0 ${chart.width} ${chart.height}`" role="img" :aria-label="title">
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
          <text :x="chart.left" :y="chart.top + 8" fill="#9ca3af" font-size="11">{{ formatAnalyticsNumber(maxValue) }}</text>
          <path
            v-for="item in activeSeries"
            :key="item.key"
            :d="pathFor(item)"
            :stroke="colorFor(item)"
            fill="none"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2.5"
          />
          <circle
            v-for="item in activeSeries"
            :key="`${item.key}-last`"
            :cx="lastPoint(item).x"
            :cy="lastPoint(item).y"
            r="3.5"
            :fill="colorFor(item)"
            stroke="#ffffff"
            stroke-width="2"
          />
          <template v-for="(row, index) in displayRows" :key="String(row.date)">
            <text
              v-if="showDateTick(index)"
              :x="pointFor(row, index, firstSeries).x"
              :y="chart.height - 10"
              fill="#9ca3af"
              font-size="11"
              text-anchor="middle"
            >
              {{ dateLabel(row.date) }}
            </text>
          </template>
        </svg>
      </div>

      <div class="flex flex-wrap gap-2">
        <span
          v-for="item in summary"
          :key="item.key"
          :class="['inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium', toneFor(item).bg, toneFor(item).text]"
        >
          <span class="h-2 w-2 rounded-full" :style="{ backgroundColor: colorFor(item) }" />
          {{ item.label }} {{ formatAnalyticsNumber(item.total) }}
        </span>
      </div>
    </div>
  </section>
</template>
