<script setup lang="ts">
const props = defineProps<{
  health?: Record<string, unknown> | null
  usage?: { rowsRead: number; rowsWritten: number; durationMs: number } | null
  to?: string
}>()

const accepted = computed(() => Number(props.health?.accepted_count ?? 0))
const rejected = computed(() => Number(props.health?.rejected_count ?? 0))
const duplicate = computed(() => Number(props.health?.duplicate_count ?? 0))
const rowsWritten = computed(() => Number(props.health?.estimated_rows_written ?? props.usage?.rowsWritten ?? 0))
const lastIngestedAt = computed(() => String(props.health?.last_ingested_at ?? ''))
const hasHealth = computed(() =>
  accepted.value > 0 ||
  rejected.value > 0 ||
  duplicate.value > 0 ||
  rowsWritten.value > 0 ||
  Boolean(lastIngestedAt.value),
)

const tone = computed(() => {
  if (!hasHealth.value) return 'empty'
  if (rejected.value > 0) return 'warning'
  return 'healthy'
})

const stripClass = computed(() => {
  if (tone.value === 'warning') return 'border-amber-200 bg-amber-50 text-amber-900'
  if (tone.value === 'healthy') return 'border-emerald-200 bg-emerald-50 text-emerald-900'
  return 'border-gray-200 bg-white text-gray-800'
})

const statusText = computed(() => {
  if (tone.value === 'warning') return '采集存在 rejected'
  if (tone.value === 'healthy') return '采集正常'
  return '暂无采集记录'
})

const detailText = computed(() => {
  if (!hasHealth.value) return '还没有收到分析事件，开启并访问前台后会生成健康记录'
  return `Accepted ${formatAnalyticsNumber(accepted.value)} · Rejected ${formatAnalyticsNumber(rejected.value)} · Duplicate ${formatAnalyticsNumber(duplicate.value)}`
})
</script>

<template>
  <div :class="['rounded-lg border px-4 py-3 shadow-sm', stripClass]">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div class="min-w-0">
        <p class="text-sm font-semibold">{{ statusText }}</p>
        <p class="mt-1 break-words text-xs opacity-80">{{ detailText }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <span class="rounded-full bg-white/70 px-2.5 py-1 text-gray-700 ring-1 ring-black/5">
          Rows written {{ formatAnalyticsNumber(rowsWritten) }}
        </span>
        <span class="rounded-full bg-white/70 px-2.5 py-1 text-gray-700 ring-1 ring-black/5">
          最近采集 {{ formatAnalyticsDateTime(lastIngestedAt) }}
        </span>
        <NuxtLink v-if="to" :to="to" class="rounded-full bg-gray-950 px-2.5 py-1 font-medium text-white hover:bg-gray-800">
          查看健康
        </NuxtLink>
      </div>
    </div>
  </div>
</template>
