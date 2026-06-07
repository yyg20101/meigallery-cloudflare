<script setup lang="ts">
import type { AnalyticsRangePreset } from '~/composables/useAdminAnalytics'
import { ANALYTICS_RANGE_OPTIONS } from '~/composables/useAdminAnalytics'

const props = defineProps<{
  title: string
  description?: string
  range: AnalyticsRangePreset
  loading?: boolean
  error?: string
  usage?: { rowsRead: number; rowsWritten: number; durationMs: number } | null
  showExport?: boolean
}>()

const emit = defineEmits<{
  'update:range': [value: AnalyticsRangePreset]
  refresh: []
  export: []
}>()

const route = useRoute()

const tabs = [
  { label: '总览', to: '/admin/analytics' },
  { label: '来源', to: '/admin/analytics/sources' },
  { label: '内容', to: '/admin/analytics/pages' },
  { label: '链路', to: '/admin/analytics/paths' },
  { label: '点击', to: '/admin/analytics/clicks' },
  { label: '时长', to: '/admin/analytics/durations' },
  { label: '邀请', to: '/admin/analytics/invites' },
  { label: '健康', to: '/admin/analytics/health' },
]

function isActive(to: string) {
  return to === '/admin/analytics' ? route.path === to : route.path.startsWith(to)
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-bold text-gray-900">{{ title }}</h1>
        <p v-if="description" class="mt-1 max-w-3xl text-sm leading-6 text-gray-500">{{ description }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div class="inline-flex rounded-lg border border-gray-200 bg-white p-1 shadow-sm">
          <button
            v-for="option in ANALYTICS_RANGE_OPTIONS"
            :key="option.value"
            :class="[
              'min-h-9 rounded-md px-3 text-sm font-medium transition-colors',
              props.range === option.value ? 'bg-gray-950 text-white' : 'text-gray-600 hover:bg-gray-100',
            ]"
            type="button"
            @click="emit('update:range', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
        <button class="min-h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 shadow-sm hover:bg-gray-50" type="button" @click="emit('refresh')">
          刷新
        </button>
        <button v-if="showExport" class="min-h-9 rounded-lg bg-gray-950 px-3 text-sm font-medium text-white shadow-sm hover:bg-gray-800" type="button" @click="emit('export')">
          导出 CSV
        </button>
      </div>
    </div>

    <div class="rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm">
      <div class="flex flex-wrap gap-1">
        <NuxtLink
          v-for="tab in tabs"
          :key="tab.to"
          :to="tab.to"
          :class="[
            'rounded-md px-3 py-2 text-sm font-medium transition-colors',
            isActive(tab.to) ? 'bg-gray-950 text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900',
          ]"
        >
          {{ tab.label }}
        </NuxtLink>
      </div>
    </div>

    <div v-if="usage" class="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-xs text-gray-500">
      <span>Rows read {{ formatAnalyticsNumber(usage.rowsRead) }}</span>
      <span>Rows written {{ formatAnalyticsNumber(usage.rowsWritten) }}</span>
      <span>查询耗时 {{ formatAnalyticsNumber(usage.durationMs) }}ms</span>
    </div>

    <div v-if="error" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {{ error }}
    </div>

    <div v-if="loading" class="rounded-lg border border-gray-200 bg-white px-4 py-10 text-center text-sm text-gray-500">
      加载中...
    </div>

    <slot v-else />
  </div>
</template>
