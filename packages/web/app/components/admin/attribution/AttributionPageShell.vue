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
  { label: 'Meta 同步', to: '/admin/attribution/meta' },
  { label: '重复诊断', to: '/admin/attribution/duplicates' },
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
  <div class="space-y-5">
    <div class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div class="min-w-0">
          <h1 class="text-xl font-bold text-gray-900">{{ title }}</h1>
          <p v-if="description" class="mt-1 max-w-3xl text-sm leading-6 text-gray-500">{{ description }}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="inline-flex rounded-lg border border-gray-200 bg-white p-1 shadow-sm">
            <button
              v-for="option in ATTRIBUTION_RANGE_OPTIONS"
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
          <input
            v-if="props.range === 'day'"
            :value="props.date || ''"
            aria-label="选择归因日期"
            class="min-h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 shadow-sm focus:border-gray-400 focus:outline-none"
            type="date"
            @input="emit('update:date', ($event.target as HTMLInputElement).value)"
          >
          <button class="min-h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 shadow-sm hover:bg-gray-50" type="button" @click="emit('refresh')">
            刷新
          </button>
        </div>
      </div>
    </div>

    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white px-2 py-2 shadow-sm">
      <div class="flex w-max min-w-full gap-1">
        <NuxtLink
          v-for="tab in tabLinks"
          :key="tab.to"
          :to="tab.route"
          :class="[
            'shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors',
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

    <div v-if="loading" class="rounded-lg border border-gray-200 bg-white px-4 py-16 text-center text-sm text-gray-500 shadow-sm">
      加载中...
    </div>

    <slot v-else />
  </div>
</template>
