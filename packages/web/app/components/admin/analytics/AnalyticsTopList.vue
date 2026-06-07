<script setup lang="ts">
import AnalyticsEmptyState from './AnalyticsEmptyState.vue'

const props = withDefaults(defineProps<{
  title: string
  description?: string
  rows: Array<Record<string, unknown>>
  labelKey: string
  valueKey: string
  metaKey?: string
  valueLabel?: string
  to?: string
}>(), {
  description: '',
  metaKey: '',
  valueLabel: '',
  to: '',
})

const visibleRows = computed(() => props.rows.slice(0, 5))

function textValue(row: Record<string, unknown>, key: string) {
  const value = row[key]
  const text = String(value ?? '')
  return text || '-'
}
</script>

<template>
  <section class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
    <div class="mb-4 flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-gray-900">{{ title }}</h2>
        <p v-if="description" class="mt-1 text-xs leading-5 text-gray-500">{{ description }}</p>
      </div>
      <NuxtLink v-if="to" :to="to" class="shrink-0 text-xs font-medium text-blue-600 hover:underline">更多</NuxtLink>
    </div>

    <AnalyticsEmptyState
      v-if="visibleRows.length === 0"
      title="暂无排行"
      description="有聚合数据后会展示前 5 项。"
    />
    <ol v-else class="space-y-3">
      <li v-for="(row, index) in visibleRows" :key="index" class="flex items-start gap-3">
        <span class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-950 text-xs font-semibold text-white">{{ index + 1 }}</span>
        <div class="min-w-0 flex-1">
          <p class="break-words text-sm font-medium text-gray-900">{{ textValue(row, labelKey) }}</p>
          <p v-if="metaKey" class="mt-1 break-words text-xs text-gray-400">{{ textValue(row, metaKey) }}</p>
        </div>
        <div class="shrink-0 text-right">
          <p class="text-sm font-semibold text-gray-900">{{ formatAnalyticsNumber(row[valueKey]) }}</p>
          <p v-if="valueLabel" class="text-xs text-gray-400">{{ valueLabel }}</p>
        </div>
      </li>
    </ol>
  </section>
</template>
