<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionTrendPanel from '~/components/admin/attribution/AttributionTrendPanel.vue'
import MetaConnectionStatus from '~/components/admin/attribution/MetaConnectionStatus.vue'
import MetaIncidentList from '~/components/admin/attribution/MetaIncidentList.vue'
import MetaRolloutControl from '~/components/admin/attribution/MetaRolloutControl.vue'
import type {
  AttributionQualityData,
  AttributionReadinessData,
  AttributionSummaryData,
  AttributionTrendsData,
  MetaIncident,
  MetaStatusData,
} from '~/composables/useAdminAttribution'
import { attributionRouteQuery } from '~/composables/useAdminAttribution'

definePageMeta({ layout: 'admin' })

interface BreakdownData {
  dimension: string
  rows: Array<{
    value: string
    actionCount: number
    contactCount: number
    completeRegistrationCount: number
    delivery: { pixelAttempted: number; capiSent: number; failed: number }
  }>
}

interface DuplicateData {
  duplicateSuppressedCount: number
  duplicateActionCount: number
  duplicateRate: number
  samples: Array<Record<string, unknown>>
}

interface IncidentData {
  items: MetaIncident[]
  pagination: { limit?: number; offset?: number; hasMore: boolean }
}

const { isOwner } = useAuth()
const rangeState = useAdminAttributionRange('7d')
const requestOptions = { rangeState, autoRefresh: false }
const summary = useAdminAttribution<AttributionSummaryData>('/api/admin/attribution/summary', requestOptions)
const trends = useAdminAttribution<AttributionTrendsData>('/api/admin/attribution/trends', {
  ...requestOptions,
  query: { granularity: 'day' },
})
const quality = useAdminAttribution<AttributionQualityData>('/api/admin/attribution/quality', requestOptions)
const breakdown = useAdminAttribution<BreakdownData>('/api/admin/attribution/breakdown', {
  ...requestOptions,
  query: { dimension: 'utm_campaign', limit: 8 },
})
const metaStatus = useAdminAttribution<MetaStatusData>('/api/admin/attribution/meta/status', requestOptions)
const readiness = useAdminAttribution<AttributionReadinessData>('/api/admin/attribution/readiness', requestOptions)
const duplicates = useAdminAttribution<DuplicateData>('/api/admin/attribution/duplicates', requestOptions)
const incidents = useAdminAttribution<IncidentData>('/api/admin/attribution/meta/incidents', {
  ...requestOptions,
  query: { status: 'all', limit: 20 },
})

const sources = [summary, trends, quality, breakdown, metaStatus, readiness, duplicates, incidents]
const loading = computed(() => sources.some(source => source.loading.value))
const error = computed(() => sources.map(source => source.error.value).find(Boolean) || '')
const business = computed(() => summary.data.value?.business ?? { contactCount: 0, completeRegistrationCount: 0, actionCount: 0 })
const delivery = computed(() => summary.data.value?.delivery ?? { pixelAttempted: 0, capiSent: 0, failed: 0, skipped: 0, pending: 0, retryExhausted: 0 })
const matchEntries = computed(() => {
  const values = quality.data.value?.match.summary
  if (!values) return []
  return [
    { key: 'fbp', label: 'fbp', metric: values.fbp },
    { key: 'fbc', label: 'fbc', metric: values.fbc },
    { key: 'email', label: 'email', metric: values.email },
    { key: 'externalId', label: 'external_id', metric: values.externalId },
  ]
})
const qualitySeries = computed(() => matchEntries.value
  .filter(item => item.metric.availability === 'available')
  .map(item => ({ key: `${item.key}.rate`, label: item.label, layer: 'quality' as const, format: 'percent' as const })))
const qualityRows = computed(() => quality.data.value?.match.rows as unknown as Array<Record<string, unknown>> ?? [])
const datasetQuality = computed(() => quality.data.value?.datasetQuality)
const blockerCount = computed(() => readiness.data.value?.checks.filter(check => check.level === 'blocker' && !check.ok).length ?? 0)
const warningCount = computed(() => readiness.data.value?.checks.filter(check => check.level === 'warning' && !check.ok).length ?? 0)
const linkRoute = computed(() => ({ path: '/admin/attribution/links', query: attributionRouteQuery(rangeState.range.value, rangeState.date.value) }))

const businessSeries = [
  { key: 'business.contactCount', label: '有效联系', layer: 'business' as const },
  { key: 'business.completeRegistrationCount', label: '完成注册', layer: 'business' as const },
]
const deliverySeries = [
  { key: 'delivery.pixelAttempted', label: 'Pixel 尝试', layer: 'pixel' as const },
  { key: 'delivery.capiSent', label: 'CAPI 接收', layer: 'capi' as const },
  { key: 'delivery.failed', label: '失败', layer: 'capi' as const },
  { key: 'delivery.skipped', label: '跳过', layer: 'capi' as const },
  { key: 'delivery.pending', label: '等待', layer: 'capi' as const },
  { key: 'delivery.retryExhausted', label: '重试耗尽', layer: 'capi' as const },
]
const evidenceLayers = [
  { label: '站内事实', detail: '联系与完成注册', class: 'bg-emerald-50 text-emerald-800', dot: '#047857' },
  { label: 'Pixel 尝试', detail: '浏览器已尝试发送', class: 'bg-amber-50 text-amber-800', dot: '#d97706' },
  { label: 'CAPI 接收', detail: 'API 已接收，不代表广告归因', class: 'bg-blue-50 text-blue-800', dot: '#2563eb' },
  { label: 'Meta 质量', detail: '仅使用已取得的 Meta 快照', class: 'bg-rose-50 text-rose-800', dot: '#be123c' },
]

async function refreshAll() {
  await Promise.all(sources.map(source => source.refresh()))
}

watch(rangeState.queryKey, () => void refreshAll())
onMounted(() => void refreshAll())

function metricRate(metric: { availability: string; rate: number | null }) {
  return metric.availability === 'available' && metric.rate !== null
    ? `${Math.round(metric.rate * 10_000) / 100}%`
    : '暂无可发送样本'
}

function datasetQualityValue() {
  const value = datasetQuality.value?.latest?.value
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
    title="Meta 归因质量"
    description="按时间比较站内事实、Pixel 尝试、CAPI 接收与 Meta 质量，定位投放和投递问题。"
    :loading="loading"
    :error="error"
    :usage="summary.usage.value"
    @refresh="refreshAll"
  >
    <div data-evidence-rail class="min-w-0 overflow-x-auto border-y border-gray-200 bg-white py-2">
      <div class="flex min-w-max gap-2 px-3">
        <div v-for="layer in evidenceLayers" :key="layer.label" :class="['flex items-center gap-2 rounded-md px-3 py-2 text-xs', layer.class]">
          <span class="h-2.5 w-2.5 rounded-full" :style="{ backgroundColor: layer.dot }" />
          <strong class="font-semibold">{{ layer.label }}</strong>
          <span class="text-current opacity-70">{{ layer.detail }}</span>
        </div>
      </div>
    </div>

    <div class="space-y-0 bg-white">
      <section data-attribution-section="connection" class="min-w-0 border-b border-gray-200 px-3 py-5 sm:px-5">
        <div class="mb-4">
          <p class="text-xs font-medium text-gray-400">01 · 连接状态</p>
          <h2 class="mt-1 text-base font-semibold text-gray-900">Meta 连接与当前活动</h2>
        </div>
        <MetaConnectionStatus
          :connection="metaStatus.data.value?.connection || null"
          :activity="metaStatus.data.value?.activity || null"
          :is-owner="isOwner"
          @refreshed="refreshAll"
        />
      </section>

      <section data-attribution-section="business" class="min-w-0 border-b border-gray-200 px-3 py-5 sm:px-5">
        <div class="mb-4 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="text-xs font-medium text-gray-400">02 · 业务转化趋势</p>
            <h2 class="mt-1 text-base font-semibold text-gray-900">站内事实</h2>
            <p class="mt-1 text-sm text-gray-500">活动口径仅包含有效联系与完成注册；历史 Lead 只作对照。</p>
          </div>
          <NuxtLink :to="linkRoute" class="text-sm font-medium text-emerald-700 hover:text-emerald-900">查看当前范围投放链接</NuxtLink>
        </div>
        <dl class="mb-5 grid grid-cols-2 border-y border-gray-200 md:grid-cols-4">
          <div class="px-3 py-3 md:border-r"><dt class="text-xs text-gray-500">有效联系</dt><dd class="mt-1 text-xl font-semibold tabular-nums text-emerald-800">{{ formatCount(business.contactCount) }}</dd></div>
          <div class="px-3 py-3 md:border-r"><dt class="text-xs text-gray-500">完成注册</dt><dd class="mt-1 text-xl font-semibold tabular-nums text-emerald-800">{{ formatCount(business.completeRegistrationCount) }}</dd></div>
          <div class="px-3 py-3 md:border-r"><dt class="text-xs text-gray-500">活动 action</dt><dd class="mt-1 text-xl font-semibold tabular-nums text-gray-900">{{ formatCount(business.actionCount) }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">历史 Lead</dt><dd class="mt-1 text-xl font-semibold tabular-nums text-gray-500">{{ formatCount(summary.data.value?.historical.leadCount) }}</dd></div>
        </dl>
        <AttributionTrendPanel title="业务转化趋势" description="每个业务日的站内事实，不混入 delivery 数。" :rows="trends.data.value?.rows || []" :series="businessSeries" />
        <div class="mt-5 min-w-0">
          <h3 class="text-sm font-semibold text-gray-900">campaign 拆分</h3>
          <div class="mt-2 overflow-x-auto">
            <table class="w-full min-w-[42rem] text-left text-sm">
              <thead class="border-y border-gray-200 bg-gray-50 text-xs text-gray-500"><tr><th class="px-3 py-2 font-medium">campaign</th><th class="px-3 py-2 font-medium">action</th><th class="px-3 py-2 font-medium">有效联系</th><th class="px-3 py-2 font-medium">完成注册</th><th class="px-3 py-2 font-medium">Pixel 尝试</th><th class="px-3 py-2 font-medium">CAPI 接收</th></tr></thead>
              <tbody class="divide-y divide-gray-100"><tr v-for="row in breakdown.data.value?.rows || []" :key="row.value"><td class="px-3 py-2.5 font-medium text-gray-900">{{ row.value }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.actionCount }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.contactCount }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.completeRegistrationCount }}</td><td class="px-3 py-2.5 tabular-nums text-amber-700">{{ row.delivery.pixelAttempted }}</td><td class="px-3 py-2.5 tabular-nums text-blue-700">{{ row.delivery.capiSent }}</td></tr><tr v-if="!breakdown.data.value?.rows.length"><td colspan="6" class="px-3 py-6 text-center text-gray-500">当前范围没有 campaign 转化</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section data-attribution-section="delivery" class="min-w-0 border-b border-gray-200 px-3 py-5 sm:px-5">
        <div class="mb-4">
          <p class="text-xs font-medium text-gray-400">03 · 投递趋势</p>
          <h2 class="mt-1 text-base font-semibold text-gray-900">Pixel 与 CAPI delivery</h2>
          <p class="mt-1 text-sm text-gray-500">CAPI 接收只表示 API 接收，不表示 Meta 已归因。</p>
        </div>
        <dl class="mb-5 grid grid-cols-2 border-y border-gray-200 md:grid-cols-3 xl:grid-cols-6">
          <div class="px-3 py-3"><dt class="text-xs text-amber-700">Pixel 尝试</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.pixelAttempted }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-blue-700">CAPI 接收</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.capiSent }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">失败</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.failed }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">跳过</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.skipped }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">等待</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.pending }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-gray-500">重试耗尽</dt><dd :class="delivery.retryExhausted ? 'text-red-700' : 'text-gray-900'" class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.retryExhausted }}</dd></div>
        </dl>
        <AttributionTrendPanel title="投递趋势" description="Pixel pending 不计入尝试；六种状态分别呈现。" :rows="trends.data.value?.rows || []" :series="deliverySeries" />
      </section>

      <section data-attribution-section="quality" class="min-w-0 border-b border-gray-200 px-3 py-5 sm:px-5">
        <div class="mb-4">
          <p class="text-xs font-medium text-gray-400">04 · 质量趋势</p>
          <h2 class="mt-1 text-base font-semibold text-gray-900">匹配覆盖与 Meta 质量</h2>
        </div>
        <div class="grid grid-cols-2 border-y border-gray-200 lg:grid-cols-5">
          <div v-for="item in matchEntries" :key="item.key" class="min-w-0 px-3 py-3 lg:border-r">
            <p class="text-xs text-gray-500">{{ item.label }} coverage</p>
            <p class="mt-1 text-base font-semibold text-rose-700">{{ metricRate(item.metric) }}</p>
            <p v-if="item.metric.availability === 'available'" class="mt-1 text-xs tabular-nums text-gray-400">{{ item.metric.numerator }} / {{ item.metric.denominator }}</p>
          </div>
          <div class="col-span-2 min-w-0 px-3 py-3 lg:col-span-1">
            <p class="text-xs text-gray-500">Meta Dataset Quality</p>
            <p v-if="datasetQuality?.availability === 'available'" class="mt-1 text-base font-semibold text-rose-700">{{ datasetQualityValue() }}</p>
            <p v-else class="mt-1 text-sm font-medium text-gray-600">尚未取得 Meta 质量数据</p>
          </div>
        </div>
        <AttributionTrendPanel v-if="qualitySeries.length" class="mt-5" title="匹配质量趋势" description="分母只取对应可发送或已规划的 CAPI 样本。" :rows="qualityRows" :series="qualitySeries" />
        <div class="mt-5 border-t border-gray-200 pt-4">
          <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div><h3 class="text-sm font-semibold text-gray-900">重复诊断</h3><p class="mt-1 text-xs text-gray-500">重复 warning 与样本已合并到质量区，不计入活动转化。</p></div>
            <p :class="Number(duplicates.data.value?.duplicateRate || 0) >= 0.1 ? 'text-amber-700' : 'text-gray-500'" class="text-sm font-medium">重复率 {{ Math.round(Number(duplicates.data.value?.duplicateRate || 0) * 1000) / 10 }}%</p>
          </div>
          <div class="mt-3 overflow-x-auto">
            <AnalyticsDataTable
              empty-title="暂无重复样本"
              empty-text="当前范围没有站内重复转化样本。"
              :columns="[
                { key: 'occurred_at', label: '时间' },
                { key: 'action_type', label: '动作' },
                { key: 'source_name', label: '来源' },
                { key: 'utm_campaign', label: 'campaign' },
                { key: 'utm_content', label: 'content' },
                { key: 'duplicate_of', label: '重复于' },
              ]"
              :rows="duplicates.data.value?.samples || []"
              compact
            />
          </div>
        </div>
      </section>

      <section data-attribution-section="rollout" class="min-w-0 px-3 py-5 sm:px-5">
        <div class="mb-4 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="text-xs font-medium text-gray-400">05 · 发布控制</p>
            <h2 class="mt-1 text-base font-semibold text-gray-900">CAPI rollout 与 incident</h2>
          </div>
          <p :class="blockerCount ? 'text-red-700' : warningCount ? 'text-amber-700' : 'text-emerald-700'" class="text-sm font-medium">{{ blockerCount }} 个阻断 · {{ warningCount }} 个警告</p>
        </div>
        <MetaRolloutControl :rollout="metaStatus.data.value?.rollout || null" :is-owner="isOwner" @refreshed="refreshAll" />
        <div class="mt-5 border-t border-gray-200 pt-4">
          <h3 class="mb-3 text-sm font-semibold text-gray-900">incident 记录</h3>
          <MetaIncidentList :incidents="incidents.data.value?.items || []" :is-owner="isOwner" @refreshed="refreshAll" />
        </div>
        <div class="mt-5 border-t border-gray-200 pt-4">
          <div class="flex items-center justify-between gap-3"><h3 class="text-sm font-semibold text-gray-900">发布检查</h3><NuxtLink :to="{ path: '/admin/attribution/readiness', query: attributionRouteQuery(rangeState.range.value, rangeState.date.value) }" class="text-sm font-medium text-blue-700">查看全部检查</NuxtLink></div>
          <div class="mt-3 grid gap-2 md:grid-cols-2">
            <div v-for="check in readiness.data.value?.checks.slice(0, 6) || []" :key="check.key" class="flex min-w-0 items-start justify-between gap-3 border-b border-gray-100 px-2 py-2 text-sm"><span class="min-w-0 text-gray-700">{{ check.label }}</span><span :class="check.ok ? 'text-emerald-700' : check.level === 'blocker' ? 'text-red-700' : 'text-amber-700'" class="shrink-0 font-medium">{{ check.ok ? '通过' : check.level === 'blocker' ? '阻断' : '警告' }}</span></div>
          </div>
        </div>
      </section>
    </div>
  </AttributionPageShell>
</template>
