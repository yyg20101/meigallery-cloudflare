<script setup lang="ts">
import AnalyticsEmptyState from './AnalyticsEmptyState.vue'

const props = withDefaults(defineProps<{
  title?: string
  description?: string
  rows: Array<Record<string, unknown>>
}>(), {
  title: '访问与转化趋势',
  description: '按日观察 PV、注册、联系和会员发放',
})

const displayRows = computed(() => props.rows.slice(-14))
const maxPageViews = computed(() => Math.max(1, ...displayRows.value.map(row => Number(row.page_view_count ?? 0))))

function barHeight(row: Record<string, unknown>) {
  const value = Number(row.page_view_count ?? 0)
  if (value <= 0) return '0%'
  return `${Math.max(8, Math.round((value / maxPageViews.value) * 100))}%`
}

function dateLabel(value: unknown) {
  const text = String(value ?? '')
  return text.slice(5) || '-'
}
</script>

<template>
  <section class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
    <div class="mb-5 flex items-start justify-between gap-4">
      <div>
        <h2 class="text-sm font-semibold text-gray-900">{{ title }}</h2>
        <p class="mt-1 text-xs leading-5 text-gray-500">{{ description }}</p>
      </div>
      <span class="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">近 {{ displayRows.length }} 天</span>
    </div>

    <AnalyticsEmptyState
      v-if="displayRows.length === 0"
      title="暂无趋势数据"
      description="聚合任务生成日报后，这里会展示访问与转化趋势。"
      tone="blue"
    />
    <div v-else class="space-y-5">
      <div class="flex h-36 items-end gap-2 border-b border-gray-100 pb-3">
        <div v-for="row in displayRows" :key="String(row.date)" class="flex min-w-0 flex-1 flex-col items-center gap-2">
          <div class="flex h-28 w-full items-end justify-center rounded bg-gray-50 px-1">
            <div class="w-full max-w-8 rounded-t bg-blue-500" :style="{ height: barHeight(row) }" />
          </div>
          <span class="truncate text-[11px] text-gray-400">{{ dateLabel(row.date) }}</span>
        </div>
      </div>
      <div class="grid gap-2 md:grid-cols-4">
        <div
          v-for="item in [
            { label: 'PV', key: 'page_view_count', tone: 'text-blue-700' },
            { label: '注册', key: 'register_count', tone: 'text-emerald-700' },
            { label: '联系', key: 'contact_click_count', tone: 'text-amber-700' },
            { label: '会员', key: 'membership_grant_count', tone: 'text-gray-900' },
          ]"
          :key="item.key"
          class="rounded-lg bg-gray-50 px-3 py-2"
        >
          <p class="text-xs text-gray-500">{{ item.label }}</p>
          <p :class="['mt-1 text-lg font-semibold', item.tone]">
            {{ formatAnalyticsNumber(displayRows.reduce((sum, row) => sum + Number(row[item.key] ?? 0), 0)) }}
          </p>
        </div>
      </div>
    </div>
  </section>
</template>
