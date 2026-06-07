<script setup lang="ts">
export interface AnalyticsTableColumn {
  key: string
  label: string
  type?: 'text' | 'number' | 'percent' | 'duration'
  sortable?: boolean
}

const props = defineProps<{
  columns: AnalyticsTableColumn[]
  rows: Array<Record<string, unknown>>
  emptyText?: string
}>()

const sortKey = ref('')
const sortDirection = ref<'asc' | 'desc'>('desc')

const sortedRows = computed(() => {
  if (!sortKey.value) return props.rows
  const dir = sortDirection.value === 'asc' ? 1 : -1
  return [...props.rows].sort((a, b) => {
    const av = a[sortKey.value]
    const bv = b[sortKey.value]
    if (typeof av === 'number' || typeof bv === 'number') {
      return (Number(av ?? 0) - Number(bv ?? 0)) * dir
    }
    return String(av ?? '').localeCompare(String(bv ?? ''), 'zh-CN') * dir
  })
})

function setSort(column: AnalyticsTableColumn) {
  if (!column.sortable) return
  if (sortKey.value === column.key) {
    sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = column.key
    sortDirection.value = 'desc'
  }
}

function cellValue(row: Record<string, unknown>, column: AnalyticsTableColumn) {
  const value = row[column.key]
  if (column.type === 'number') return formatAnalyticsNumber(value)
  if (column.type === 'duration') return formatAnalyticsDuration(value)
  if (column.type === 'percent') {
    const num = Number(value ?? 0)
    if (!Number.isFinite(num)) return '0%'
    const percent = Math.abs(num) <= 1 ? num * 100 : num
    return `${percent.toFixed(1)}%`
  }
  return String(value ?? '-')
}
</script>

<template>
  <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
    <table v-if="rows.length > 0" class="min-w-full text-sm">
      <thead class="border-b border-gray-200 bg-gray-50">
        <tr>
          <th
            v-for="column in columns"
            :key="column.key"
            class="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold text-gray-500"
          >
            <button
              v-if="column.sortable"
              class="inline-flex items-center gap-1 hover:text-gray-900"
              type="button"
              @click="setSort(column)"
            >
              {{ column.label }}
              <span v-if="sortKey === column.key">{{ sortDirection === 'asc' ? '↑' : '↓' }}</span>
            </button>
            <span v-else>{{ column.label }}</span>
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-gray-100">
        <tr v-for="(row, index) in sortedRows" :key="index" class="hover:bg-gray-50">
          <td v-for="column in columns" :key="column.key" class="whitespace-nowrap px-4 py-3 text-gray-700">
            {{ cellValue(row, column) }}
          </td>
        </tr>
      </tbody>
    </table>
    <AnalyticsEmptyState v-else :description="emptyText || '暂无数据，部署埋点后会在这里展示'" />
  </div>
</template>
