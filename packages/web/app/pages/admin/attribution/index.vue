<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionProviderSwitch from '~/components/admin/attribution/AttributionProviderSwitch.vue'
import AttributionTrendPanel from '~/components/admin/attribution/AttributionTrendPanel.vue'
import type {
  AdPlatformConnectionData,
  AttributionQualityData,
  AttributionSummaryData,
  AttributionTrendsData,
} from '~/composables/useAdminAttribution'
import { attributionRouteQuery } from '~/composables/useAdminAttribution'
import {
  attributionConnectionStateLabel,
  attributionPlatformDefinition,
} from '~/utils/attributionPlatforms'
import type { AttributionDashboardProvider } from '~/composables/useAdminAttribution'

definePageMeta({ layout: 'admin' })

interface BreakdownData {
  provider: AttributionDashboardProvider
  dimension: string
  rows: Array<{
    value: string
    actionCount: number
    contactCount: number
    completeRegistrationCount: number
    delivery: { pixelAttempted: number; serverSent: number; failed: number }
  }>
}

interface DuplicateData {
  provider: AttributionDashboardProvider
  duplicateSuppressedCount: number
  duplicateActionCount: number
  duplicateRate: number
  samples: Array<Record<string, unknown>>
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
  query: computed(() => ({ provider: selectedProvider.value, dimension: 'utm_campaign', limit: 8 })),
})
const duplicates = useAdminAttribution<DuplicateData>('/api/admin/attribution/duplicates', platformRequestOptions)
const platforms = useAdminAttribution<AdPlatformConnectionData[]>('/api/admin/attribution/platforms', requestOptions)
const sources = [summary, trends, quality, breakdown, duplicates, platforms]
const platformSources = [summary, trends, quality, breakdown, duplicates]

const loading = computed(() => sources.some(source => source.loading.value))
const error = computed(() => sources.map(source => source.error.value).find(Boolean) || '')
const platform = computed(() => attributionPlatformDefinition(selectedProvider.value))
const connectionsByProvider = computed(() => Object.fromEntries((platforms.data.value || []).map(item => [item.provider, item])))
const selectedConnection = computed(() => connectionsByProvider.value[selectedProvider.value] ?? null)
const business = computed(() => summary.data.value?.business ?? { contactCount: 0, completeRegistrationCount: 0, actionCount: 0 })
const delivery = computed(() => summary.data.value?.delivery ?? { pixelAttempted: 0, serverSent: 0, failed: 0, skipped: 0, pending: 0, retryExhausted: 0 })
const routing = computed(() => summary.data.value?.routing ?? { mismatchCount: 0, unroutedActionCount: 0 })
const matchEntries = computed(() => {
  const match = quality.data.value?.match
  if (!match) return []
  return [
    { key: 'browserId', label: match.labels.browserId, metric: match.summary.browserId },
    { key: 'clickId', label: match.labels.clickId, metric: match.summary.clickId },
    { key: 'email', label: match.labels.email, metric: match.summary.email },
    { key: 'externalId', label: match.labels.externalId, metric: match.summary.externalId },
  ]
})
const qualitySeries = computed(() => matchEntries.value
  .filter(item => item.metric.availability === 'available')
  .map(item => ({
    key: `${item.key}.rate`,
    label: item.label,
    layer: 'quality' as const,
    format: 'percent' as const,
    aggregation: {
      type: 'weightedRate' as const,
      numeratorKey: `${item.key}.numerator`,
      denominatorKey: `${item.key}.denominator`,
    },
  })))
const qualityRows = computed(() => quality.data.value?.match.rows as unknown as Array<Record<string, unknown>> ?? [])
const platformQuality = computed(() => quality.data.value?.platformQuality)
const linkRoute = computed(() => ({
  path: '/admin/attribution/links',
  query: { ...attributionRouteQuery(rangeState.range.value, rangeState.date.value), provider: selectedProvider.value },
}))
const platformRoute = computed(() => ({
  path: '/admin/attribution/platforms',
  query: { provider: selectedProvider.value },
}))

const businessSeries = [
  { key: 'business.contactCount', label: '有效联系', layer: 'business' as const, aggregation: { type: 'sum' as const } },
  { key: 'business.completeRegistrationCount', label: '完成注册', layer: 'business' as const, aggregation: { type: 'sum' as const } },
]
const deliverySeries = [
  { key: 'delivery.pixelAttempted', label: 'Pixel 尝试', layer: 'pixel' as const, aggregation: { type: 'sum' as const } },
  { key: 'delivery.serverSent', label: 'Server API 接收', layer: 'server' as const, aggregation: { type: 'sum' as const } },
  { key: 'delivery.failed', label: '失败', layer: 'server' as const, aggregation: { type: 'sum' as const } },
  { key: 'delivery.skipped', label: '跳过', layer: 'server' as const, aggregation: { type: 'sum' as const } },
  { key: 'delivery.pending', label: '等待', layer: 'server' as const, aggregation: { type: 'sum' as const } },
  { key: 'delivery.retryExhausted', label: '重试耗尽', layer: 'server' as const, aggregation: { type: 'sum' as const } },
]
const evidenceLayers = [
  { label: '站内事实', detail: '联系与完成注册', class: 'bg-emerald-50 text-emerald-800', dot: '#047857' },
  { label: 'Pixel 尝试', detail: '浏览器已尝试发送', class: 'bg-amber-50 text-amber-800', dot: '#d97706' },
  { label: 'Server API 接收', detail: 'API 已接收，不代表广告归因', class: 'bg-blue-50 text-blue-800', dot: '#2563eb' },
  { label: '平台质量', detail: '仅展示平台已提供的质量证据', class: 'bg-rose-50 text-rose-800', dot: '#be123c' },
]

watch(rangeState.queryKey, () => void refreshAll())
watch(selectedProvider, async () => {
  await Promise.all(platformSources.map(source => source.refresh()))
})
onMounted(() => void refreshAll())

async function refreshAll() {
  await Promise.all(sources.map(source => source.refresh()))
}

function metricRate(metric: { availability: string; rate: number | null }) {
  return metric.availability === 'available' && metric.rate !== null
    ? `${Math.round(metric.rate * 10_000) / 100}%`
    : '暂无可发送样本'
}

function platformQualityValue() {
  const value = platformQuality.value?.latest?.value
  if (value === null || value === undefined) return ''
  return value >= 0 && value <= 1 ? `${Math.round(value * 10_000) / 100}%` : String(value)
}

function formatCount(value: unknown) {
  const number = Number(value ?? 0)
  return new Intl.NumberFormat('zh-CN').format(Number.isFinite(number) ? number : 0)
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="归因总览"
    description="按单一平台核对站内转化、浏览器投递、服务器接收和匹配质量。"
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
          <p class="text-sm font-semibold text-gray-900">{{ platform.label }} 连接 {{ attributionConnectionStateLabel(selectedConnection) }}</p>
          <p class="mt-0.5 truncate text-xs text-gray-500">
            {{ selectedConnection?.mode || 'disabled' }} · {{ selectedConnection?.browserEnabled ? platform.browserLabel : 'Browser 关闭' }} · {{ selectedConnection?.serverEnabled ? platform.serverLabel : 'Server 关闭' }}
          </p>
        </div>
      </div>
      <NuxtLink :to="platformRoute" class="w-fit shrink-0 text-sm font-medium text-blue-700 hover:text-blue-900">管理平台连接</NuxtLink>
    </section>

    <div data-evidence-rail class="min-w-0 overflow-x-auto border-b border-gray-200 bg-white py-2">
      <div class="flex min-w-max gap-2 px-3 sm:px-5">
        <div v-for="layer in evidenceLayers" :key="layer.label" :class="['flex items-center gap-2 rounded-md px-3 py-2 text-xs', layer.class]">
          <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: layer.dot }" />
          <strong class="font-semibold">{{ layer.label }}</strong>
          <span class="opacity-70">{{ layer.detail }}</span>
        </div>
      </div>
    </div>

    <div class="space-y-0 bg-white">
      <section data-attribution-section="business" class="min-w-0 border-b border-gray-200 px-3 py-5 sm:px-5">
        <div v-if="routing.mismatchCount > 0" class="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800" role="alert">
          检测到 {{ formatCount(routing.mismatchCount) }} 条来源与投递平台不一致的数据，后续跨平台写入已阻断。
        </div>
        <div class="mb-4 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="text-xs font-medium text-gray-400">01 · 站内转化</p>
            <h2 class="mt-1 text-base font-semibold text-gray-900">{{ platform.label }} 归因事实</h2>
            <p class="mt-1 text-sm text-gray-500">只统计明确归属于当前平台的有效联系与完成注册；未识别来源 {{ formatCount(routing.unroutedActionCount) }} 条。</p>
          </div>
          <NuxtLink :to="linkRoute" class="text-sm font-medium text-emerald-700 hover:text-emerald-900">查看投放链接</NuxtLink>
        </div>
        <dl class="mb-5 grid grid-cols-2 border-y border-gray-200 md:grid-cols-3">
          <div class="px-3 py-3 md:border-r"><dt class="text-xs text-gray-500">有效联系</dt><dd class="mt-1 text-xl font-semibold tabular-nums text-emerald-800">{{ formatCount(business.contactCount) }}</dd></div>
          <div class="px-3 py-3 md:border-r"><dt class="text-xs text-gray-500">完成注册</dt><dd class="mt-1 text-xl font-semibold tabular-nums text-emerald-800">{{ formatCount(business.completeRegistrationCount) }}</dd></div>
          <div class="col-span-2 px-3 py-3 md:col-span-1"><dt class="text-xs text-gray-500">转化事实</dt><dd class="mt-1 text-xl font-semibold tabular-nums text-gray-900">{{ formatCount(business.actionCount) }}</dd></div>
        </dl>
        <AttributionTrendPanel title="转化趋势" description="按业务日展示站内事实，不混入平台投递数量。" :rows="trends.data.value?.rows || []" :series="businessSeries" />
        <div class="mt-5 min-w-0">
          <h3 class="text-sm font-semibold text-gray-900">Campaign 表现</h3>
          <div class="mt-2 overflow-x-auto">
            <table class="w-full min-w-[42rem] text-left text-sm">
              <thead class="border-y border-gray-200 bg-gray-50 text-xs text-gray-500"><tr><th class="px-3 py-2 font-medium">Campaign</th><th class="px-3 py-2 font-medium">转化</th><th class="px-3 py-2 font-medium">有效联系</th><th class="px-3 py-2 font-medium">完成注册</th><th class="px-3 py-2 font-medium">Pixel 尝试</th><th class="px-3 py-2 font-medium">Server 接收</th></tr></thead>
              <tbody class="divide-y divide-gray-100"><tr v-for="row in breakdown.data.value?.rows || []" :key="row.value"><td class="px-3 py-2.5 font-medium text-gray-900">{{ row.value }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.actionCount }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.contactCount }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.completeRegistrationCount }}</td><td class="px-3 py-2.5 tabular-nums text-amber-700">{{ row.delivery.pixelAttempted }}</td><td class="px-3 py-2.5 tabular-nums text-blue-700">{{ row.delivery.serverSent }}</td></tr><tr v-if="!breakdown.data.value?.rows.length"><td colspan="6" class="px-3 py-6 text-center text-gray-500">当前范围没有 Campaign 转化</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section data-attribution-section="delivery" class="min-w-0 border-b border-gray-200 px-3 py-5 sm:px-5">
        <div class="mb-4">
          <p class="text-xs font-medium text-gray-400">02 · 平台投递</p>
          <h2 class="mt-1 text-base font-semibold text-gray-900">{{ platform.browserLabel }} 与 {{ platform.serverLabel }}</h2>
          <p class="mt-1 text-sm text-gray-500">Server API 接收只表示平台接口已接收，不表示广告已完成归因。</p>
        </div>
        <dl class="mb-5 grid grid-cols-2 border-y border-gray-200 md:grid-cols-3 xl:grid-cols-6">
          <div class="px-3 py-3"><dt class="text-xs text-amber-700">Pixel 尝试</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.pixelAttempted }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-blue-700">{{ platform.serverLabel }} 接收</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.serverSent }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">失败</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.failed }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">跳过</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.skipped }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">等待</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.pending }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">重试耗尽</dt><dd :class="delivery.retryExhausted ? 'text-red-700' : 'text-gray-900'" class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.retryExhausted }}</dd></div>
        </dl>
        <AttributionTrendPanel title="投递趋势" description="六种投递状态独立统计，Pixel pending 不计为尝试。" :rows="trends.data.value?.rows || []" :series="deliverySeries" />
      </section>

      <section data-attribution-section="quality" class="min-w-0 px-3 py-5 sm:px-5">
        <div class="mb-4">
          <p class="text-xs font-medium text-gray-400">03 · 匹配质量</p>
          <h2 class="mt-1 text-base font-semibold text-gray-900">{{ platform.label }} 匹配覆盖与平台质量</h2>
        </div>
        <div class="grid grid-cols-2 border-y border-gray-200 lg:grid-cols-5">
          <div v-for="item in matchEntries" :key="item.key" class="min-w-0 px-3 py-3 lg:border-r">
            <p class="text-xs text-gray-500">{{ item.label }} coverage</p>
            <p class="mt-1 text-base font-semibold text-rose-700">{{ metricRate(item.metric) }}</p>
            <p v-if="item.metric.availability === 'available'" class="mt-1 text-xs tabular-nums text-gray-400">{{ item.metric.numerator }} / {{ item.metric.denominator }}</p>
          </div>
          <div class="col-span-2 min-w-0 px-3 py-3 lg:col-span-1">
            <p class="text-xs text-gray-500">{{ platform.label }} 平台质量</p>
            <p v-if="platformQuality?.availability === 'available'" class="mt-1 text-base font-semibold text-rose-700">{{ platformQualityValue() }}</p>
            <p v-else-if="platformQuality?.availability === 'error'" class="mt-1 text-sm font-medium text-red-700">平台质量数据采集失败</p>
            <p v-else-if="platformQuality?.source === 'not_supported'" class="mt-1 text-sm font-medium text-gray-600">当前平台未接入质量诊断 API</p>
            <p v-else class="mt-1 text-sm font-medium text-gray-600">尚未取得平台质量数据</p>
          </div>
        </div>
        <AttributionTrendPanel v-if="qualitySeries.length" class="mt-5" title="匹配质量趋势" description="分母只取当前平台可发送或已规划的 Server API 样本。" :rows="qualityRows" :series="qualitySeries" />
        <div class="mt-5 border-t border-gray-200 pt-4">
          <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div><h3 class="text-sm font-semibold text-gray-900">重复诊断</h3><p class="mt-1 text-xs text-gray-500">只检查当前平台，重复事件不计入活动转化。</p></div>
            <p :class="Number(duplicates.data.value?.duplicateRate || 0) >= 0.1 ? 'text-amber-700' : 'text-gray-500'" class="text-sm font-medium">重复率 {{ Math.round(Number(duplicates.data.value?.duplicateRate || 0) * 1000) / 10 }}%</p>
          </div>
          <div class="mt-3 overflow-x-auto">
            <AnalyticsDataTable
              empty-title="暂无重复样本"
              empty-text="当前平台在所选范围内没有重复转化样本。"
              :columns="[
                { key: 'occurred_at', label: '时间' },
                { key: 'action_type', label: '动作' },
                { key: 'source_name', label: '来源' },
                { key: 'utm_campaign', label: 'Campaign' },
                { key: 'utm_content', label: 'Content' },
                { key: 'duplicate_of', label: '重复于' },
              ]"
              :rows="duplicates.data.value?.samples || []"
              compact
            />
          </div>
        </div>
      </section>
    </div>
  </AttributionPageShell>
</template>
