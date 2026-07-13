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
  AttributionDashboardProvider,
  AdPlatformConnectionStatusData,
  MetaIncident,
  MetaStatusData,
} from '~/composables/useAdminAttribution'
import { attributionRouteQuery } from '~/composables/useAdminAttribution'

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
const { api } = useApi()
const route = useRoute()
const router = useRouter()
const rangeState = useAdminAttributionRange('7d')
const metaTestEventCode = ref('')
const selectedProvider = ref<AttributionDashboardProvider>(normalizeDashboardProvider(route.query.provider))
const dashboardProviderOptions: AttributionDashboardProvider[] = ['meta', 'tiktok']
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
const metaStatus = useAdminAttribution<MetaStatusData>('/api/admin/attribution/meta/status', requestOptions)
const platforms = useAdminAttribution<AdPlatformConnectionStatusData[]>('/api/admin/attribution/platforms', requestOptions)
const readiness = useAdminAttribution<AttributionReadinessData>('/api/admin/attribution/readiness', requestOptions)
const duplicates = useAdminAttribution<DuplicateData>('/api/admin/attribution/duplicates', requestOptions)
const incidents = useAdminAttribution<IncidentData>('/api/admin/attribution/meta/incidents', {
  ...requestOptions,
  query: { status: 'all', limit: 20 },
})

const sources = [summary, trends, quality, breakdown, platforms, metaStatus, readiness, duplicates, incidents]
const platformSources = [summary, trends, quality, breakdown]
const loading = computed(() => sources.some(source => source.loading.value))
const error = computed(() => sources.map(source => source.error.value).find(Boolean) || '')
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
const platformLabel = computed(() => selectedProvider.value === 'meta' ? 'Meta' : 'TikTok')
const blockerCount = computed(() => readiness.data.value?.checks.filter(check => check.level === 'blocker' && !check.ok).length ?? 0)
const warningCount = computed(() => readiness.data.value?.checks.filter(check => check.level === 'warning' && !check.ok).length ?? 0)
const connectionSaving = ref(false)
const connectionMessage = ref('')
const metaConnectionForm = reactive({
  enabled: false,
  browserEnabled: false,
  serverEnabled: false,
  destinationId: '',
  debugEnabled: false,
  mode: 'disabled' as 'disabled' | 'test' | 'production',
  rolloutPercentage: 0 as 0 | 10 | 50 | 100,
})
const tiktokConnectionSaving = ref(false)
const tiktokConnectionVerifying = ref(false)
const tiktokConnectionMessage = ref('')
const tiktokTestEventCode = ref('')
const tiktokConnectionForm = reactive({
  enabled: false,
  browserEnabled: false,
  serverEnabled: false,
  destinationId: '',
  debugEnabled: false,
  mode: 'disabled' as 'disabled' | 'test' | 'production',
  rolloutPercentage: 0 as 0 | 10 | 50 | 100,
})
watch(() => platforms.data.value?.find(item => item.provider === 'meta'), (connection) => {
  if (!connection) return
  Object.assign(metaConnectionForm, {
    enabled: connection.enabled,
    browserEnabled: connection.browserEnabled,
    serverEnabled: connection.serverEnabled,
    destinationId: connection.destinationId,
    debugEnabled: connection.debugEnabled,
    mode: connection.mode,
    rolloutPercentage: connection.rolloutPercentage,
  })
}, { immediate: true })
watch(() => platforms.data.value?.find(item => item.provider === 'tiktok'), (connection) => {
  if (!connection) return
  Object.assign(tiktokConnectionForm, {
    enabled: connection.enabled,
    browserEnabled: connection.browserEnabled,
    serverEnabled: connection.serverEnabled,
    destinationId: connection.destinationId,
    debugEnabled: connection.debugEnabled,
    mode: connection.mode,
    rolloutPercentage: connection.rolloutPercentage,
  })
}, { immediate: true })
const linkRoute = computed(() => ({ path: '/admin/attribution/links', query: attributionRouteQuery(rangeState.range.value, rangeState.date.value) }))

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

async function refreshAll() {
  await Promise.all(sources.map(source => source.refresh()))
}

async function saveMetaConnection() {
  connectionSaving.value = true
  connectionMessage.value = ''
  try {
    await api('/api/admin/attribution/platforms/meta', {
      method: 'PATCH',
      body: { ...metaConnectionForm },
    })
    connectionMessage.value = 'Meta 连接已保存'
    await refreshAll()
  }
  catch (error) {
    connectionMessage.value = resolveApiErrorMessage(error, 'Meta 连接保存失败')
  }
  finally {
    connectionSaving.value = false
  }
}

async function saveTikTokConnection() {
  tiktokConnectionSaving.value = true
  tiktokConnectionMessage.value = ''
  try {
    await api('/api/admin/attribution/platforms/tiktok', {
      method: 'PATCH',
      body: { ...tiktokConnectionForm },
    })
    tiktokConnectionMessage.value = 'TikTok 连接已保存'
    await refreshAll()
  }
  catch (error) {
    tiktokConnectionMessage.value = resolveApiErrorMessage(error, 'TikTok 连接保存失败')
  }
  finally {
    tiktokConnectionSaving.value = false
  }
}

async function verifyTikTokConnection() {
  tiktokConnectionVerifying.value = true
  tiktokConnectionMessage.value = ''
  try {
    await api('/api/admin/attribution/platforms/tiktok/verify', {
      method: 'POST',
      body: { testEventCode: tiktokTestEventCode.value },
    })
    tiktokTestEventCode.value = ''
    tiktokConnectionMessage.value = 'TikTok Events API 已验证'
    await refreshAll()
  }
  catch (error) {
    tiktokConnectionMessage.value = resolveApiErrorMessage(error, 'TikTok Events API 验证失败')
  }
  finally {
    tiktokConnectionVerifying.value = false
  }
}

watch(rangeState.queryKey, () => void refreshAll())
watch(() => route.query.provider, (value) => {
  const provider = normalizeDashboardProvider(value)
  if (provider !== selectedProvider.value) selectedProvider.value = provider
})
watch(selectedProvider, async (provider) => {
  if (route.query.provider !== provider) {
    await router.replace({ query: { ...route.query, provider } })
  }
  await Promise.all(platformSources.map(source => source.refresh()))
})
onMounted(() => void refreshAll())

function normalizeDashboardProvider(value: unknown): AttributionDashboardProvider {
  const raw = Array.isArray(value) ? value[0] : value
  return raw === 'tiktok' ? 'tiktok' : 'meta'
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
    title="广告归因质量"
    description="按平台比较站内事实、浏览器尝试、服务器接收与平台质量，定位投放和投递问题。"
    :loading="loading"
    :error="error"
    :usage="summary.usage.value"
    @refresh="refreshAll"
  >
    <div class="flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-3 py-3 sm:px-5">
      <div>
        <p class="text-xs font-medium text-gray-500">当前分析平台</p>
        <p class="mt-0.5 text-sm font-semibold text-gray-900">{{ platformLabel }}</p>
      </div>
      <div class="inline-flex border border-gray-300 bg-gray-50 p-0.5" role="group" aria-label="选择归因平台">
        <button
          v-for="provider in dashboardProviderOptions"
          :key="provider"
          type="button"
          :aria-pressed="selectedProvider === provider"
          :class="selectedProvider === provider ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-white'"
          class="min-w-20 px-3 py-1.5 text-sm font-medium"
          @click="selectedProvider = provider"
        >
          {{ provider === 'meta' ? 'Meta' : 'TikTok' }}
        </button>
      </div>
    </div>

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
          <h2 class="mt-1 text-base font-semibold text-gray-900">广告平台连接</h2>
          <p class="mt-1 text-sm text-gray-500">ID 与凭证状态按同一连接展示，凭证值不会返回前端。</p>
        </div>
        <div class="mb-5 divide-y divide-gray-200 border-y border-gray-200">
          <div v-for="connection in platforms.data.value || []" :key="connection.provider" class="grid gap-2 px-1 py-3 text-sm sm:grid-cols-[8rem_1fr_auto] sm:items-center">
            <strong class="uppercase text-gray-900">{{ connection.provider }}</strong>
            <span class="text-gray-500">目标 ID {{ connection.destinationConfigured ? '已配置' : '未配置' }} · Server 凭证 {{ connection.serverCredentialConfigured ? '已配置' : '未配置' }} · {{ connection.mode }}</span>
            <span :class="connection.state === 'verified' ? 'text-emerald-700' : 'text-amber-700'" class="font-medium">{{ connection.state === 'verified' ? '已验证' : '待验证' }}</span>
          </div>
          <p v-if="!platforms.data.value?.length" class="px-1 py-4 text-sm text-gray-500">尚未取得平台连接状态</p>
        </div>
        <form v-if="isOwner" class="mb-6 grid gap-4 border-b border-gray-200 pb-6 sm:grid-cols-2 lg:grid-cols-4" @submit.prevent="saveMetaConnection">
          <label class="sm:col-span-2">
            <span class="mb-1 block text-xs font-medium text-gray-600">Meta Dataset ID</span>
            <input v-model="metaConnectionForm.destinationId" inputmode="numeric" pattern="[0-9]{5,30}" required class="w-full border border-gray-300 px-3 py-2 text-sm" />
          </label>
          <label>
            <span class="mb-1 block text-xs font-medium text-gray-600">运行模式</span>
            <select v-model="metaConnectionForm.mode" class="w-full border border-gray-300 px-3 py-2 text-sm">
              <option value="disabled">关闭</option>
              <option value="test">测试</option>
              <option value="production">生产</option>
            </select>
          </label>
          <label>
            <span class="mb-1 block text-xs font-medium text-gray-600">Server 放量</span>
            <select v-model="metaConnectionForm.rolloutPercentage" class="w-full border border-gray-300 px-3 py-2 text-sm">
              <option :value="0">0%</option>
              <option :value="10">10%</option>
              <option :value="50">50%</option>
              <option :value="100">100%</option>
            </select>
          </label>
          <label class="flex items-center gap-2 text-sm"><input v-model="metaConnectionForm.enabled" type="checkbox" />启用连接</label>
          <label class="flex items-center gap-2 text-sm"><input v-model="metaConnectionForm.browserEnabled" type="checkbox" />Browser Pixel</label>
          <label class="flex items-center gap-2 text-sm"><input v-model="metaConnectionForm.serverEnabled" type="checkbox" />Server API</label>
          <label class="flex items-center gap-2 text-sm"><input v-model="metaConnectionForm.debugEnabled" type="checkbox" />调试日志</label>
          <div class="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
            <button type="submit" :disabled="connectionSaving" class="bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">保存连接</button>
            <span class="text-sm text-gray-500">{{ connectionMessage }}</span>
          </div>
        </form>
        <form v-if="isOwner" class="mb-6 grid gap-4 border-b border-gray-200 pb-6 sm:grid-cols-2 lg:grid-cols-4" @submit.prevent="saveTikTokConnection">
          <label class="sm:col-span-2">
            <span class="mb-1 block text-xs font-medium text-gray-600">TikTok Pixel ID</span>
            <input v-model.trim="tiktokConnectionForm.destinationId" autocomplete="off" pattern="[A-Za-z0-9]{10,30}" required class="w-full border border-gray-300 px-3 py-2 text-sm uppercase" />
          </label>
          <label>
            <span class="mb-1 block text-xs font-medium text-gray-600">运行模式</span>
            <select v-model="tiktokConnectionForm.mode" class="w-full border border-gray-300 px-3 py-2 text-sm">
              <option value="disabled">关闭</option>
              <option value="test">测试</option>
              <option value="production">生产</option>
            </select>
          </label>
          <label>
            <span class="mb-1 block text-xs font-medium text-gray-600">Server 放量</span>
            <select v-model="tiktokConnectionForm.rolloutPercentage" class="w-full border border-gray-300 px-3 py-2 text-sm">
              <option :value="0">0%</option>
              <option :value="10">10%</option>
              <option :value="50">50%</option>
              <option :value="100">100%</option>
            </select>
          </label>
          <label class="flex items-center gap-2 text-sm"><input v-model="tiktokConnectionForm.enabled" type="checkbox" />启用连接</label>
          <label class="flex items-center gap-2 text-sm"><input v-model="tiktokConnectionForm.browserEnabled" type="checkbox" />Browser Pixel</label>
          <label class="flex items-center gap-2 text-sm"><input v-model="tiktokConnectionForm.serverEnabled" type="checkbox" />Events API</label>
          <label class="flex items-center gap-2 text-sm"><input v-model="tiktokConnectionForm.debugEnabled" type="checkbox" />调试日志</label>
          <div class="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
            <button type="submit" :disabled="tiktokConnectionSaving" class="bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">保存 TikTok</button>
            <span class="text-sm text-gray-500">{{ tiktokConnectionMessage }}</span>
          </div>
          <div class="grid gap-3 border-t border-gray-200 pt-4 sm:col-span-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:col-span-4">
            <label>
              <span class="mb-1 block text-xs font-medium text-gray-600">Test Event Code</span>
              <input v-model.trim="tiktokTestEventCode" type="password" autocomplete="new-password" maxlength="128" class="w-full border border-gray-300 px-3 py-2 text-sm" />
            </label>
            <button type="button" :disabled="tiktokConnectionVerifying || !tiktokTestEventCode" class="self-end border border-gray-900 px-4 py-2 text-sm font-medium text-gray-900 disabled:opacity-50" @click="verifyTikTokConnection">验证 Events API</button>
          </div>
        </form>
        <h3 class="mb-3 text-sm font-semibold text-gray-900">Meta 运维状态</h3>
        <MetaConnectionStatus
          v-model:test-event-code="metaTestEventCode"
          :connection="metaStatus.data.value?.connection || null"
          :activity="metaStatus.data.value?.activity || null"
          :is-owner="isOwner"
          @refreshed="refreshAll"
        />
      </section>

      <section data-attribution-section="business" class="min-w-0 border-b border-gray-200 px-3 py-5 sm:px-5">
        <div
          v-if="routing.mismatchCount > 0"
          class="mb-4 border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800"
          role="alert"
        >
          检测到 {{ formatCount(routing.mismatchCount) }} 条来源与投递平台不一致的数据，已阻断后续跨平台写入。
        </div>
        <div class="mb-4 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p class="text-xs font-medium text-gray-400">02 · 业务转化趋势</p>
            <h2 class="mt-1 text-base font-semibold text-gray-900">站内事实</h2>
            <p class="mt-1 text-sm text-gray-500">仅统计归属于当前平台的有效联系与完成注册；未识别来源 {{ formatCount(routing.unroutedActionCount) }} 条。</p>
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
              <thead class="border-y border-gray-200 bg-gray-50 text-xs text-gray-500"><tr><th class="px-3 py-2 font-medium">campaign</th><th class="px-3 py-2 font-medium">action</th><th class="px-3 py-2 font-medium">有效联系</th><th class="px-3 py-2 font-medium">完成注册</th><th class="px-3 py-2 font-medium">Pixel 尝试</th><th class="px-3 py-2 font-medium">Server API 接收</th></tr></thead>
              <tbody class="divide-y divide-gray-100"><tr v-for="row in breakdown.data.value?.rows || []" :key="row.value"><td class="px-3 py-2.5 font-medium text-gray-900">{{ row.value }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.actionCount }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.contactCount }}</td><td class="px-3 py-2.5 tabular-nums">{{ row.completeRegistrationCount }}</td><td class="px-3 py-2.5 tabular-nums text-amber-700">{{ row.delivery.pixelAttempted }}</td><td class="px-3 py-2.5 tabular-nums text-blue-700">{{ row.delivery.serverSent }}</td></tr><tr v-if="!breakdown.data.value?.rows.length"><td colspan="6" class="px-3 py-6 text-center text-gray-500">当前范围没有 campaign 转化</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section data-attribution-section="delivery" class="min-w-0 border-b border-gray-200 px-3 py-5 sm:px-5">
        <div class="mb-4">
          <p class="text-xs font-medium text-gray-400">03 · 投递趋势</p>
          <h2 class="mt-1 text-base font-semibold text-gray-900">{{ platformLabel }} Pixel 与 Server API delivery</h2>
          <p class="mt-1 text-sm text-gray-500">Server API 接收只表示平台 API 已接收，不表示广告已完成归因。</p>
        </div>
        <dl class="mb-5 grid grid-cols-2 border-y border-gray-200 md:grid-cols-3 xl:grid-cols-6">
          <div class="px-3 py-3"><dt class="text-xs text-amber-700">Pixel 尝试</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.pixelAttempted }}</dd></div>
          <div class="px-3 py-3"><dt class="text-xs text-blue-700">Server API 接收</dt><dd class="mt-1 text-lg font-semibold tabular-nums">{{ delivery.serverSent }}</dd></div>
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
          <h2 class="mt-1 text-base font-semibold text-gray-900">{{ platformLabel }} 匹配覆盖与平台质量</h2>
        </div>
        <div class="grid grid-cols-2 border-y border-gray-200 lg:grid-cols-5">
          <div v-for="item in matchEntries" :key="item.key" class="min-w-0 px-3 py-3 lg:border-r">
            <p class="text-xs text-gray-500">{{ item.label }} coverage</p>
            <p class="mt-1 text-base font-semibold text-rose-700">{{ metricRate(item.metric) }}</p>
            <p v-if="item.metric.availability === 'available'" class="mt-1 text-xs tabular-nums text-gray-400">{{ item.metric.numerator }} / {{ item.metric.denominator }}</p>
          </div>
          <div class="col-span-2 min-w-0 px-3 py-3 lg:col-span-1">
            <p class="text-xs text-gray-500">{{ platformLabel }} 平台质量</p>
            <p v-if="platformQuality?.availability === 'available'" class="mt-1 text-base font-semibold text-rose-700">{{ platformQualityValue() }}</p>
            <p v-else-if="platformQuality?.availability === 'error'" class="mt-1 text-sm font-medium text-red-700">平台质量数据采集失败</p>
            <p v-else-if="platformQuality?.source === 'not_supported'" class="mt-1 text-sm font-medium text-gray-600">当前未接入平台质量诊断 API</p>
            <p v-else class="mt-1 text-sm font-medium text-gray-600">尚未取得平台质量数据</p>
          </div>
        </div>
        <AttributionTrendPanel v-if="qualitySeries.length" class="mt-5" title="匹配质量趋势" description="分母只取对应可发送或已规划的 Server API 样本。" :rows="qualityRows" :series="qualitySeries" />
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
