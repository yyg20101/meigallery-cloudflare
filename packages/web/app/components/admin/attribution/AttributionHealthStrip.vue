<script setup lang="ts">
const props = withDefaults(defineProps<{
  providerLabel?: string
  browserLabel?: string
  serverLabel?: string
  browserEnabled?: boolean
  serverEnabled?: boolean
  browserAttempted?: number
  serverProcessed?: number
  serverPending?: number
  serverFailed?: number
}>(), {
  providerLabel: '广告平台',
  browserLabel: 'Browser',
  serverLabel: 'Server API',
  browserEnabled: undefined,
  serverEnabled: undefined,
  browserAttempted: 0,
  serverProcessed: 0,
  serverPending: 0,
  serverFailed: 0,
})

function status(enabled: boolean | undefined) {
  if (enabled === true) return { value: '已开启', tone: 'green' }
  if (enabled === false) return { value: '已关闭', tone: 'gray' }
  return { value: '未确认', tone: 'gold' }
}

const items = computed(() => [
  { label: `${props.browserLabel} 状态`, ...status(props.browserEnabled) },
  { label: `${props.serverLabel} 状态`, ...status(props.serverEnabled) },
  { label: 'Browser 已尝试', value: formatAnalyticsNumber(props.browserAttempted), tone: 'gold' },
  { label: 'Server 已处理', value: formatAnalyticsNumber(props.serverProcessed), tone: 'blue' },
  { label: 'Server 处理中', value: formatAnalyticsNumber(props.serverPending), tone: props.serverPending > 0 ? 'gold' : 'gray' },
  { label: 'Server 失败', value: formatAnalyticsNumber(props.serverFailed), tone: props.serverFailed > 0 ? 'red' : 'gray' },
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
  <section data-attribution-health :aria-label="`${providerLabel} 投递健康`" class="min-w-0 border-y border-gray-200 bg-white py-3">
    <div data-health-grid class="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-6">
      <div v-for="item in items" :key="item.label" data-health-item :class="['min-w-0 border px-3 py-2 [overflow-wrap:anywhere]', toneClass(item.tone)]">
        <p data-health-label class="text-xs font-medium opacity-75">{{ item.label }}</p>
        <p data-health-value class="mt-1 text-sm font-semibold tabular-nums">{{ item.value }}</p>
      </div>
    </div>
  </section>
</template>
