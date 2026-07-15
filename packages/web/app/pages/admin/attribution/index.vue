<script setup lang="ts">
import AttributionHealthStrip from '~/components/admin/attribution/AttributionHealthStrip.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionProviderSwitch from '~/components/admin/attribution/AttributionProviderSwitch.vue'
import AttributionTrendPanel from '~/components/admin/attribution/AttributionTrendPanel.vue'
import type {
  AdPlatformConnectionData,
  AttributionCapacityData,
  AttributionDashboardProvider,
  AttributionQualityData,
  AttributionSummaryData,
  AttributionTrendsData,
} from '~/composables/useAdminAttribution'
import { attributionConnectionStateLabel, attributionPlatformDefinition } from '~/utils/attributionPlatforms'

definePageMeta({ layout: 'admin' })

interface BreakdownData {
  provider: AttributionDashboardProvider
  dimension: string
  rows: Array<{
    value: string
    factCount: number
    contactCount: number
    completeRegistrationCount: number
    delivery: AttributionSummaryData['delivery']
  }>
}

const rangeState = useAdminAttributionRange('7d')
const selectedProvider = useAttributionProvider()
const platformQuery = computed(() => ({ provider: selectedProvider.value }))
const requestOptions = { rangeState, autoRefresh: false }
const platformRequestOptions = { ...requestOptions, query: platformQuery }
const summary = useAdminAttribution<AttributionSummaryData>('/api/admin/attribution/summary', platformRequestOptions)
const trends = useAdminAttribution<AttributionTrendsData>('/api/admin/attribution/trends', {
  ...requestOptions,
  query: computed(() => ({ provider: selectedProvider.value, granularity: 'day' })),
})
const quality = useAdminAttribution<AttributionQualityData>('/api/admin/attribution/quality', platformRequestOptions)
const breakdown = useAdminAttribution<BreakdownData>('/api/admin/attribution/breakdown', {
  ...requestOptions,
  query: computed(() => ({ provider: selectedProvider.value, dimension: 'utm_campaign', limit: 10 })),
})
const platforms = useAdminAttribution<AdPlatformConnectionData[]>('/api/admin/attribution/platforms', requestOptions)
const capacity = useAdminAttribution<AttributionCapacityData>('/api/admin/attribution/capacity', {
  ...requestOptions,
  query: computed(() => ({ date: new Date().toISOString().slice(0, 10) })),
})
const sources = [summary, trends, quality, breakdown, platforms, capacity]
const platformSources = [summary, trends, quality, breakdown]

const loading = computed(() => sources.some(source => source.loading.value))
const error = computed(() => sources.map(source => source.error.value).find(Boolean) || '')
const platform = computed(() => attributionPlatformDefinition(selectedProvider.value))
const connectionsByProvider = computed(() => Object.fromEntries((platforms.data.value || []).map(item => [item.provider, item])))
const selectedConnection = computed(() => connectionsByProvider.value[selectedProvider.value] ?? null)
const business = computed(() => summary.data.value?.business ?? { contactCount: 0, completeRegistrationCount: 0, factCount: 0 })
const routing = computed(() => summary.data.value?.routing ?? {
  totalFactCount: 0,
  attributedFactCount: 0,
  unattributedFactCount: 0,
  conflictFactCount: 0,
  byProvider: { meta: 0, tiktok: 0, google: 0 },
})
const delivery = computed(() => summary.data.value?.delivery ?? {
  browserAttempted: 0,
  server: { planned: 0, queued: 0, accepted: 0, processed: 0, retrying: 0, rejected: 0, deadLetter: 0, cancelled: 0 },
  queueRetryCount: 0,
  queueEnqueueCount: 0,
})
const serverAccepted = computed(() => delivery.value.server.accepted + delivery.value.server.processed)
const serverPending = computed(() => delivery.value.server.planned + delivery.value.server.queued + delivery.value.server.retrying)
const serverFailed = computed(() => delivery.value.server.rejected + delivery.value.server.deadLetter)
const pairing = computed(() => quality.data.value?.pairing.summary ?? emptyMetric())
const match = computed(() => quality.data.value?.match.summary ?? emptyMetric())
const qualityTrendRows = computed(() => (quality.data.value?.pairing.rows ?? []).map(row => ({
  date: row.date,
  pairing: row,
  match: quality.data.value?.match.rows.find(item => item.date === row.date) ?? emptyMetric(),
})))
const capacityRows = computed(() => {
  const labels: Record<keyof AttributionCapacityData['metrics'], string> = {
    workerRequests: 'Worker 请求',
    queueOperations: 'Queue 操作',
    d1RowsRead: 'D1 读取行',
    d1RowsWritten: 'D1 写入行',
    workflowSteps: 'Workflow 步骤',
    serverConversions: 'Server 转化',
  }
  return Object.entries(capacity.data.value?.metrics ?? {}).map(([key, metric]) => ({
    key,
    label: labels[key as keyof typeof labels],
    ...metric,
  }))
})
const capacityWarning = computed(() => capacityRows.value.some(item => item.warning))
const platformRoute = computed(() => ({ path: '/admin/attribution/platforms', query: { provider: selectedProvider.value } }))

const businessSeries = [
  { key: 'business.contactCount', label: '有效联系', layer: 'business' as const, aggregation: { type: 'sum' as const } },
  { key: 'business.completeRegistrationCount', label: '完成注册', layer: 'business' as const, aggregation: { type: 'sum' as const } },
]
const deliverySeries = [
  { key: 'delivery.browserAttempted', label: 'Browser 已尝试', layer: 'browser' as const, aggregation: { type: 'sum' as const } },
  { key: 'delivery.server.accepted', label: 'Server 已接收', layer: 'server' as const, aggregation: { type: 'sum' as const } },
  { key: 'delivery.server.processed', label: 'Server 已处理', layer: 'server' as const, aggregation: { type: 'sum' as const } },
  { key: 'delivery.server.rejected', label: 'Server 已拒绝', layer: 'server' as const, aggregation: { type: 'sum' as const } },
  { key: 'delivery.server.deadLetter', label: '死信', layer: 'server' as const, aggregation: { type: 'sum' as const } },
]
const qualitySeries = [
  { key: 'pairing.rate', label: 'Browser/Server 配对率', layer: 'quality' as const, format: 'percent' as const, aggregation: { type: 'weightedRate' as const, numeratorKey: 'pairing.numerator', denominatorKey: 'pairing.denominator' } },
  { key: 'match.rate', label: '匹配信号覆盖率', layer: 'quality' as const, format: 'percent' as const, aggregation: { type: 'weightedRate' as const, numeratorKey: 'match.numerator', denominatorKey: 'match.denominator' } },
]
const evidenceLayers = [
  { label: '站内事实', detail: '不可变业务事实', class: 'bg-emerald-50 text-emerald-800', dot: '#047857' },
  { label: 'Browser 回执', detail: '脚本实际执行成功', class: 'bg-amber-50 text-amber-800', dot: '#d97706' },
  { label: 'Server 状态', detail: '规划至终态', class: 'bg-blue-50 text-blue-800', dot: '#2563eb' },
  { label: '质量证据', detail: '配对与匹配信号', class: 'bg-rose-50 text-rose-800', dot: '#be123c' },
]

watch(rangeState.queryKey, () => void refreshAll())
watch(selectedProvider, () => void Promise.all(platformSources.map(source => source.refresh())))
onMounted(() => void refreshAll())

async function refreshAll() {
  await Promise.all(sources.map(source => source.refresh()))
}

function emptyMetric() {
  return { availability: 'unavailable' as const, numerator: 0, denominator: 0, rate: null }
}

function formatCount(value: unknown) {
  const parsed = Number(value)
  return new Intl.NumberFormat('zh-CN').format(Number.isFinite(parsed) ? parsed : 0)
}

function formatRate(value: number | null) {
  return value === null ? '暂无样本' : `${Math.round(value * 10_000) / 100}%`
}

function serverSuccess(row: BreakdownData['rows'][number]) {
  return row.delivery.server.accepted + row.delivery.server.processed
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="广告归因总览"
    description="统一核对 Meta、TikTok 与 Google 的业务事实、投递状态、质量和容量。"
    :loading="loading"
    :error="error"
    :usage="summary.usage.value"
    @refresh="refreshAll"
  >
    <AttributionProviderSwitch v-model="selectedProvider" />

    <section class="flex min-w-0 flex-col gap-3 border-b border-gray-200 bg-white px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div class="flex min-w-0 items-center gap-3">
        <span :class="platform.accentClass" class="h-8 w-1 shrink-0 rounded-sm" aria-hidden="true" />
        <div class="min-w-0">
          <p class="text-sm font-semibold text-gray-900">{{ platform.label }} · {{ attributionConnectionStateLabel(selectedConnection) }}</p>
          <p class="mt-0.5 truncate text-xs text-gray-500">{{ selectedConnection?.mode || 'disabled' }} · rollout {{ selectedConnection?.rolloutEffectivePercentage ?? 0 }}%</p>
        </div>
      </div>
      <NuxtLink :to="platformRoute" class="w-fit text-sm font-medium text-blue-700 hover:text-blue-900">管理平台连接</NuxtLink>
    </section>

    <div data-evidence-rail class="min-w-0 overflow-x-auto border-b border-gray-200 bg-white py-2">
      <div class="flex min-w-max gap-2 px-3 sm:px-5">
        <div v-for="layer in evidenceLayers" :key="layer.label" :class="['flex items-center gap-2 rounded-md px-3 py-2 text-xs', layer.class]">
          <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: layer.dot }" />
          <strong>{{ layer.label }}</strong><span class="opacity-70">{{ layer.detail }}</span>
        </div>
      </div>
    </div>

    <div class="bg-white">
      <section data-attribution-section="business" class="border-b border-gray-200 px-3 py-5 sm:px-5">
        <div v-if="routing.conflictFactCount" role="alert" class="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">
          存在 {{ formatCount(routing.conflictFactCount) }} 条来源冲突事实，未投递至任何广告平台。
        </div>
        <p class="text-xs font-medium text-gray-400">01 · 业务事实</p>
        <h2 class="mt-1 text-base font-semibold text-gray-900">{{ platform.label }} 转化</h2>
        <dl class="my-4 grid grid-cols-2 border-y border-gray-200 lg:grid-cols-6">
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">有效联系</dt><dd class="mt-1 text-xl font-semibold tabular-nums text-emerald-800">{{ formatCount(business.contactCount) }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">完成注册</dt><dd class="mt-1 text-xl font-semibold tabular-nums text-emerald-800">{{ formatCount(business.completeRegistrationCount) }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">当前平台事实</dt><dd class="mt-1 text-xl font-semibold tabular-nums">{{ formatCount(business.factCount) }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">全部平台事实</dt><dd class="mt-1 text-xl font-semibold tabular-nums">{{ formatCount(routing.attributedFactCount) }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">未归因</dt><dd class="mt-1 text-xl font-semibold tabular-nums text-amber-700">{{ formatCount(routing.unattributedFactCount) }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">来源冲突</dt><dd class="mt-1 text-xl font-semibold tabular-nums" :class="routing.conflictFactCount ? 'text-red-700' : 'text-gray-900'">{{ formatCount(routing.conflictFactCount) }}</dd></div>
        </dl>
        <AttributionTrendPanel title="业务趋势" :rows="trends.data.value?.rows || []" :series="businessSeries" />

        <div class="mt-5 overflow-x-auto">
          <table class="w-full min-w-[42rem] text-left text-sm">
            <thead class="border-y border-gray-200 bg-gray-50 text-xs text-gray-500"><tr><th class="px-3 py-2 font-medium">Campaign</th><th class="px-3 py-2 font-medium">事实</th><th class="px-3 py-2 font-medium">有效联系</th><th class="px-3 py-2 font-medium">完成注册</th><th class="px-3 py-2 font-medium">Browser 已尝试</th><th class="px-3 py-2 font-medium">Server 已接收</th></tr></thead>
            <tbody class="divide-y divide-gray-100"><tr v-for="row in breakdown.data.value?.rows || []" :key="row.value"><td class="px-3 py-2.5 font-medium text-gray-900">{{ row.value }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.factCount }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.contactCount }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.completeRegistrationCount }}</td><td class="px-3 py-2.5 tabular-nums text-amber-700">{{ row.delivery.browserAttempted }}</td><td class="px-3 py-2.5 tabular-nums text-blue-700">{{ serverSuccess(row) }}</td></tr><tr v-if="!breakdown.data.value?.rows.length"><td colspan="6" class="px-3 py-6 text-center text-gray-500">当前范围没有 Campaign 转化</td></tr></tbody>
          </table>
        </div>
      </section>

      <section data-attribution-section="delivery" class="border-b border-gray-200 px-3 py-5 sm:px-5">
        <p class="text-xs font-medium text-gray-400">02 · 投递状态</p>
        <h2 class="mt-1 text-base font-semibold text-gray-900">{{ platform.browserLabel }} 与 {{ platform.serverLabel }}</h2>
        <AttributionHealthStrip
          class="mt-4"
          :provider-label="platform.label"
          :browser-label="platform.browserLabel"
          :server-label="platform.serverLabel"
          :browser-enabled="selectedConnection?.browserEnabled"
          :server-enabled="selectedConnection?.serverEnabled"
          :browser-attempted="delivery.browserAttempted"
          :server-accepted="serverAccepted"
          :server-pending="serverPending"
          :server-failed="serverFailed"
        />
        <dl class="my-4 grid grid-cols-2 border-b border-gray-200 md:grid-cols-4">
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">入队次数</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.queueEnqueueCount }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">重试次数</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.queueRetryCount }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">已拒绝</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.server.rejected }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">死信</dt><dd class="mt-1 text-lg font-semibold tabular-nums" :class="delivery.server.deadLetter ? 'text-red-700' : ''">{{ delivery.server.deadLetter }}</dd></div>
        </dl>
        <AttributionTrendPanel title="投递趋势" :rows="trends.data.value?.rows || []" :series="deliverySeries" />
      </section>

      <section data-attribution-section="quality" class="border-b border-gray-200 px-3 py-5 sm:px-5">
        <p class="text-xs font-medium text-gray-400">03 · 投递质量</p>
        <h2 class="mt-1 text-base font-semibold text-gray-900">配对与匹配覆盖</h2>
        <dl class="my-4 grid grid-cols-2 border-y border-gray-200 md:grid-cols-3">
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">Browser/Server 配对率</dt><dd class="mt-1 text-lg font-semibold text-rose-700">{{ formatRate(pairing.rate) }}</dd><p class="mt-1 text-xs text-gray-400">{{ pairing.numerator }} / {{ pairing.denominator }}</p></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">匹配信号覆盖率</dt><dd class="mt-1 text-lg font-semibold text-rose-700">{{ formatRate(match.rate) }}</dd><p class="mt-1 text-xs text-gray-400">{{ match.numerator }} / {{ match.denominator }}</p></div>
          <div class="col-span-2 px-3 py-3 md:col-span-1"><dt class="text-xs text-gray-500">平台质量快照</dt><dd class="mt-1 text-sm font-semibold">{{ quality.data.value?.platformQuality.latest?.metricKey || '暂无数据' }}</dd></div>
        </dl>
        <AttributionTrendPanel title="质量趋势" :rows="qualityTrendRows" :series="qualitySeries" />
        <div class="mt-5 overflow-x-auto">
          <table class="w-full min-w-[30rem] text-left text-sm">
            <thead class="border-y border-gray-200 bg-gray-50 text-xs text-gray-500"><tr><th class="px-3 py-2 font-medium">匹配信号</th><th class="px-3 py-2 font-medium">覆盖数</th><th class="px-3 py-2 font-medium">Server 样本</th><th class="px-3 py-2 font-medium">覆盖率</th></tr></thead>
            <tbody class="divide-y divide-gray-100"><tr v-for="signal in quality.data.value?.match.signals || []" :key="signal.key"><td class="px-3 py-2.5 font-medium">{{ signal.key }}</td><td class="px-3 py-2.5 tabular-nums">{{ signal.numerator }}</td><td class="px-3 py-2.5 tabular-nums">{{ signal.denominator }}</td><td class="px-3 py-2.5 tabular-nums">{{ formatRate(signal.rate) }}</td></tr><tr v-if="!quality.data.value?.match.signals.length"><td colspan="4" class="px-3 py-6 text-center text-gray-500">暂无匹配信号样本</td></tr></tbody>
          </table>
        </div>
      </section>

      <section data-attribution-section="capacity" class="px-3 py-5 sm:px-5">
        <div class="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div><p class="text-xs font-medium text-gray-400">04 · Free 容量</p><h2 class="mt-1 text-base font-semibold text-gray-900">UTC 配额日内部估算</h2></div>
          <p class="text-xs tabular-nums text-gray-500">{{ capacity.data.value?.date || '-' }} · UTC</p>
        </div>
        <p v-if="capacityWarning" role="alert" class="mt-4 border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">至少一项已达到项目 70% 安全线。</p>
        <div class="mt-4 overflow-x-auto">
          <table class="w-full min-w-[34rem] text-left text-sm">
            <thead class="border-y border-gray-200 bg-gray-50 text-xs text-gray-500"><tr><th class="px-3 py-2 font-medium">资源</th><th class="px-3 py-2 font-medium">估算值</th><th class="px-3 py-2 font-medium">安全线</th><th class="px-3 py-2 font-medium">占用</th><th class="px-3 py-2 font-medium">状态</th></tr></thead>
            <tbody class="divide-y divide-gray-100"><tr v-for="row in capacityRows" :key="row.key"><td class="px-3 py-2.5 font-medium">{{ row.label }}</td><td class="px-3 py-2.5 tabular-nums">{{ formatCount(row.value) }}</td><td class="px-3 py-2.5 tabular-nums">{{ formatCount(row.safetyLimit) }}</td><td class="px-3 py-2.5 tabular-nums">{{ Math.round(row.ratio * 1000) / 10 }}%</td><td class="px-3 py-2.5 font-medium" :class="row.warning ? 'text-red-700' : 'text-emerald-700'">{{ row.warning ? '预警' : '正常' }}</td></tr></tbody>
          </table>
        </div>
        <p class="mt-3 text-xs leading-5 text-gray-500">{{ capacity.data.value?.note }}</p>
      </section>
    </div>
  </AttributionPageShell>
</template>
