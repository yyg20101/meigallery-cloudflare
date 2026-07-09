<script setup lang="ts">
const props = withDefaults(defineProps<{
  pixelEnabled?: boolean
  capiEnabled?: boolean
  sentCount?: number
  failedCount?: number
  skippedCount?: number
  duplicateRate?: number
  lastSentAt?: string
}>(), {
  pixelEnabled: undefined,
  capiEnabled: undefined,
})

function statusItem(enabled: boolean | undefined) {
  if (enabled === true) return { value: '已开启', tone: 'green' }
  if (enabled === false) return { value: '关闭', tone: 'gray' }
  return { value: '未确认', tone: 'gold' }
}

const items = computed(() => [
  {
    label: 'Pixel',
    ...statusItem(props.pixelEnabled),
  },
  {
    label: 'CAPI',
    ...statusItem(props.capiEnabled),
  },
  {
    label: '已同步',
    value: formatAnalyticsNumber(props.sentCount ?? 0),
    tone: 'blue',
  },
  {
    label: '失败',
    value: formatAnalyticsNumber(props.failedCount ?? 0),
    tone: (props.failedCount ?? 0) > 0 ? 'red' : 'gray',
  },
  {
    label: '跳过',
    value: formatAnalyticsNumber(props.skippedCount ?? 0),
    tone: (props.skippedCount ?? 0) > 0 ? 'gold' : 'gray',
  },
  {
    label: '重复率',
    value: `${((props.duplicateRate ?? 0) * 100).toFixed(1)}%`,
    tone: (props.duplicateRate ?? 0) >= 0.1 ? 'red' : 'gray',
  },
])

function toneClass(tone: string) {
  if (tone === 'green') return 'border-emerald-100 bg-emerald-50 text-emerald-800'
  if (tone === 'blue') return 'border-blue-100 bg-blue-50 text-blue-800'
  if (tone === 'gold') return 'border-amber-100 bg-amber-50 text-amber-800'
  if (tone === 'red') return 'border-red-100 bg-red-50 text-red-800'
  return 'border-gray-200 bg-white text-gray-700'
}
</script>

<template>
  <section class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
    <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
      <div v-for="item in items" :key="item.label" :class="['rounded-lg border px-3 py-2', toneClass(item.tone)]">
        <p class="text-xs font-medium opacity-75">{{ item.label }}</p>
        <p class="mt-1 text-sm font-semibold tabular-nums">{{ item.value }}</p>
      </div>
    </div>
    <p class="mt-3 text-xs text-gray-500">最近成功同步：{{ formatAnalyticsDateTime(lastSentAt) }}</p>
  </section>
</template>
