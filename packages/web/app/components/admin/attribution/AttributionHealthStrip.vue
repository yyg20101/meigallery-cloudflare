<script setup lang="ts">
const props = withDefaults(defineProps<{
  pixelEnabled?: boolean
  capiEnabled?: boolean
  pixelAttemptedCount?: number
  capiSentCount?: number
  failedCount?: number
  skippedCount?: number
  lastSentAt?: string
  secretPresent?: boolean
  testEventCodePresent?: boolean
  queueBindingPresent?: boolean
  showPresenceSummary?: boolean
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
    label: 'Pixel 状态',
    ...statusItem(props.pixelEnabled),
  },
  {
    label: 'CAPI 状态',
    ...statusItem(props.capiEnabled),
  },
  {
    label: 'Pixel 尝试',
    value: formatAnalyticsNumber(props.pixelAttemptedCount ?? 0),
    tone: 'blue',
  },
  {
    label: 'CAPI 成功',
    value: formatAnalyticsNumber(props.capiSentCount ?? 0),
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
])

const presenceSummary = computed(() => {
  if (!props.showPresenceSummary) return ''
  const states = [props.secretPresent, props.testEventCodePresent, props.queueBindingPresent]
  const label = (value: boolean | undefined) => value === true ? '存在' : value === false ? '缺失' : '未确认'
  return `CAPI 配置：token ${label(props.secretPresent)} · Test Event Code ${label(props.testEventCodePresent)} · Queue binding ${label(props.queueBindingPresent)}`
})

function toneClass(tone: string) {
  if (tone === 'green') return 'border-emerald-100 bg-emerald-50 text-emerald-800'
  if (tone === 'blue') return 'border-blue-100 bg-blue-50 text-blue-800'
  if (tone === 'gold') return 'border-amber-100 bg-amber-50 text-amber-800'
  if (tone === 'red') return 'border-red-100 bg-red-50 text-red-800'
  return 'border-gray-200 bg-white text-gray-700'
}
</script>

<template>
  <section data-attribution-health aria-label="Meta 渠道健康" class="w-full min-w-0 max-w-full rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
    <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
      <div v-for="item in items" :key="item.label" :class="['min-w-0 rounded-lg border px-3 py-2', toneClass(item.tone)]">
        <p data-health-label class="text-xs font-medium opacity-75">{{ item.label }}</p>
        <p class="mt-1 text-sm font-semibold tabular-nums">{{ item.value }}</p>
      </div>
    </div>
    <p class="mt-3 break-words text-xs text-gray-500">最近 CAPI 成功：{{ formatAnalyticsDateTime(lastSentAt) }}</p>
    <p v-if="presenceSummary" class="mt-1 break-words text-xs text-gray-500">{{ presenceSummary }}</p>
  </section>
</template>
