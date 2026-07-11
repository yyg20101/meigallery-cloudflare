<script setup lang="ts">
import type { AttributionRangePreset } from '~/composables/useAdminAttribution'
import { ATTRIBUTION_RANGE_OPTIONS, attributionRouteQuery } from '~/composables/useAdminAttribution'

const props = defineProps<{
  title: string
  description?: string
  range: AttributionRangePreset
  date?: string
  loading?: boolean
  error?: string
  usage?: { rowsRead: number; rowsWritten: number; durationMs: number } | null
}>()

const emit = defineEmits<{
  'update:range': [value: AttributionRangePreset]
  'update:date': [value: string]
  refresh: []
}>()

const route = useRoute()

const tabs = [
  { label: '总览', to: '/admin/attribution' },
  { label: '转化', to: '/admin/attribution/conversions' },
  { label: '投放链接', to: '/admin/attribution/links' },
  { label: 'Meta 运维', to: '/admin/attribution/meta' },
  { label: '发布检查', to: '/admin/attribution/readiness' },
]

const tabLinks = computed(() => tabs.map(tab => ({
  ...tab,
  route: {
    path: tab.to,
    query: attributionRouteQuery(props.range, props.date || ''),
  },
})))

function isActive(to: string) {
  return to === '/admin/attribution' ? route.path === to : route.path.startsWith(to)
}
</script>

<template>
  <div data-attribution-page class="min-w-0 space-y-4">
    <div data-attribution-header class="min-w-0 border-y border-gray-200 bg-white px-3 py-4 sm:px-5">
      <div class="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div class="min-w-0">
          <h1 data-attribution-header-title class="min-w-0 [overflow-wrap:anywhere] text-xl font-bold text-gray-900">{{ title }}</h1>
          <p v-if="description" data-attribution-header-description class="mt-1 min-w-0 max-w-3xl [overflow-wrap:anywhere] text-sm leading-6 text-gray-500">{{ description }}</p>
        </div>
        <div data-attribution-controls class="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
          <div data-attribution-range-group class="col-span-2 grid min-w-0 grid-cols-[repeat(2,minmax(0,1fr))] rounded-md border border-gray-200 bg-white p-1 sm:inline-flex sm:w-auto">
            <button
              v-for="option in ATTRIBUTION_RANGE_OPTIONS"
              :key="option.value"
              data-attribution-control
              data-attribution-range-control
              :class="[
                'min-h-9 min-w-0 max-w-full rounded px-2 [overflow-wrap:anywhere] text-sm font-medium transition-colors sm:px-3',
                props.range === option.value ? 'bg-gray-950 text-white' : 'text-gray-600 hover:bg-gray-100',
              ]"
              type="button"
              @click="emit('update:range', option.value)"
            >
              {{ option.label }}
            </button>
          </div>
          <input
            v-if="props.range === 'day'"
            data-attribution-control
            :value="props.date || ''"
            aria-label="选择归因日期"
            class="min-h-9 w-full min-w-0 max-w-full rounded-md border border-gray-200 bg-white px-3 text-sm text-gray-700 focus:border-gray-400 focus:outline-none sm:w-auto"
            type="date"
            @input="emit('update:date', ($event.target as HTMLInputElement).value)"
          >
          <button data-attribution-control data-attribution-refresh class="min-h-9 w-full min-w-0 max-w-full rounded-md border border-gray-200 bg-white px-3 [overflow-wrap:anywhere] text-sm text-gray-700 hover:bg-gray-50 sm:w-auto" type="button" @click="emit('refresh')">
            刷新
          </button>
        </div>
      </div>
    </div>

    <div data-attribution-tabs class="min-w-0 overflow-x-auto border-y border-gray-200 bg-white px-2 py-2">
      <div data-attribution-tab-list class="flex min-w-max gap-1">
        <NuxtLink
          v-for="tab in tabLinks"
          :key="tab.to"
          data-attribution-tab
          :to="tab.route"
          :class="[
            'min-w-0 max-w-full rounded-md px-3 py-2 [overflow-wrap:anywhere] text-sm font-medium transition-colors',
            isActive(tab.to) ? 'bg-gray-950 text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900',
          ]"
        >
          {{ tab.label }}
        </NuxtLink>
      </div>
    </div>

    <div v-if="usage" class="flex min-w-0 flex-wrap items-center gap-3 border-y border-gray-200 bg-white px-4 py-2 text-xs text-gray-500 [overflow-wrap:anywhere]">
      <span class="min-w-0">Rows read {{ formatAnalyticsNumber(usage.rowsRead) }}</span>
      <span class="min-w-0">Rows written {{ formatAnalyticsNumber(usage.rowsWritten) }}</span>
      <span class="min-w-0">查询耗时 {{ formatAnalyticsNumber(usage.durationMs) }}ms</span>
    </div>

    <div v-if="error" class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {{ error }}
    </div>

    <div v-if="loading" class="border-y border-gray-200 bg-white px-4 py-16 text-center text-sm text-gray-500">
      加载中...
    </div>

    <slot v-else />
  </div>
</template>
