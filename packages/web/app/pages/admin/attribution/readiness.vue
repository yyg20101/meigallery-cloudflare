<script setup lang="ts">
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionProviderSwitch from '~/components/admin/attribution/AttributionProviderSwitch.vue'
import MetaIncidentList from '~/components/admin/attribution/MetaIncidentList.vue'
import MetaRolloutControl from '~/components/admin/attribution/MetaRolloutControl.vue'
import type {
  AdPlatformConnectionStatusData,
  AttributionReadinessData,
  AttributionSummaryData,
  MetaIncident,
  MetaStatusData,
} from '~/composables/useAdminAttribution'
import { attributionRouteQuery } from '~/composables/useAdminAttribution'
import { serializeReadinessSettingRows, serializeReadinessVerificationRows } from '~/utils/attributionReadiness'
import { attributionConnectionStateLabel, attributionPlatformDefinition } from '~/utils/attributionPlatforms'

definePageMeta({ layout: 'admin' })

type ReadinessCheck = AttributionReadinessData['checks'][number]

interface IncidentData {
  items: MetaIncident[]
  pagination: { hasMore: boolean }
}

const { isOwner } = useAuth()
const rangeState = useAdminAttributionRange('7d')
const selectedProvider = useAttributionProvider()
const providerQuery = computed(() => ({ provider: selectedProvider.value }))
const requestOptions = { rangeState, autoRefresh: false }
const platforms = useAdminAttribution<AdPlatformConnectionStatusData[]>('/api/admin/attribution/platforms', requestOptions)
const summary = useAdminAttribution<AttributionSummaryData>('/api/admin/attribution/summary', {
  ...requestOptions,
  query: providerQuery,
})
const metaReadiness = useAdminAttribution<AttributionReadinessData>('/api/admin/attribution/readiness', requestOptions)
const metaStatus = useAdminAttribution<MetaStatusData>('/api/admin/attribution/meta/status', requestOptions)
const incidents = useAdminAttribution<IncidentData>('/api/admin/attribution/meta/incidents', {
  ...requestOptions,
  query: { status: 'all', limit: 50 },
})

const platform = computed(() => attributionPlatformDefinition(selectedProvider.value))
const connection = computed(() => platforms.data.value?.find(item => item.provider === selectedProvider.value) ?? null)
const selectedChecks = computed<ReadinessCheck[]>(() => {
  if (selectedProvider.value === 'meta') return metaReadiness.data.value?.checks ?? []
  const item = connection.value
  const activity = summary.data.value
  return [
    {
      key: 'connection_verified',
      label: 'TikTok 连接已验证',
      level: 'blocker',
      ok: item?.state === 'verified',
      detail: item?.state === 'verified' ? 'Pixel ID 与 Events API 凭证已经过一次性测试。' : '请先在平台接入中完成 TikTok Events API 验证。',
    },
    {
      key: 'production_mode',
      label: '生产模式已开启',
      level: 'blocker',
      ok: item?.enabled === true && item.mode === 'production',
      detail: item?.enabled === true && item.mode === 'production' ? 'TikTok 连接已处于生产运行模式。' : '连接需要同时启用并切换为 production。',
    },
    {
      key: 'channel_configuration',
      label: 'Pixel 与 Events API 资源完整',
      level: 'blocker',
      ok: item?.browserEnabled === true
        && item.serverEnabled === true
        && item.destinationConfigured
        && item.serverCredentialConfigured
        && item.serverQueueConfigured
        && item.serverDataKeyConfigured,
      detail: '要求 Pixel ID、Events API token、Queue 和数据密钥全部配置。',
    },
    {
      key: 'routing_isolation',
      label: '跨平台路由隔离',
      level: 'blocker',
      ok: Number(activity?.routing.mismatchCount ?? 0) === 0,
      detail: Number(activity?.routing.mismatchCount ?? 0) === 0 ? '当前范围没有跨平台投递。' : `发现 ${activity?.routing.mismatchCount ?? 0} 条跨平台投递。`,
    },
    {
      key: 'delivery_failures',
      label: 'Events API 投递失败',
      level: 'warning',
      ok: Number(activity?.delivery.failed ?? 0) === 0 && Number(activity?.delivery.retryExhausted ?? 0) === 0,
      detail: `失败 ${activity?.delivery.failed ?? 0} 条，重试耗尽 ${activity?.delivery.retryExhausted ?? 0} 条。`,
    },
    {
      key: 'unrouted_actions',
      label: '未识别广告来源',
      level: 'warning',
      ok: Number(activity?.routing.unroutedActionCount ?? 0) === 0,
      detail: `当前范围有 ${activity?.routing.unroutedActionCount ?? 0} 条活动转化未识别平台来源。`,
    },
  ]
})
const blockerChecks = computed(() => selectedChecks.value.filter(check => check.level === 'blocker'))
const warningChecks = computed(() => selectedChecks.value.filter(check => check.level === 'warning'))
const ready = computed(() => blockerChecks.value.length > 0 && blockerChecks.value.every(check => check.ok))
const settingRows = computed(() => {
  if (selectedProvider.value === 'meta') return serializeReadinessSettingRows(metaReadiness.data.value?.settings ?? {})
  const item = connection.value
  return [
    { key: 'enabled', label: 'TikTok 连接', value: item?.enabled ? '已开启' : '关闭' },
    { key: 'browser_enabled', label: platform.value.browserLabel, value: item?.browserEnabled ? '已开启' : '关闭' },
    { key: 'server_enabled', label: platform.value.serverLabel, value: item?.serverEnabled ? '已开启' : '关闭' },
    { key: 'destination_configured', label: platform.value.destinationLabel, value: item?.destinationConfigured ? '已配置' : '未配置' },
    { key: 'mode', label: '运行模式', value: item?.mode || 'disabled' },
  ]
})
const verificationRows = computed(() => serializeReadinessVerificationRows(metaReadiness.data.value?.verifications ?? {}))
const activeSources = computed(() => selectedProvider.value === 'meta'
  ? [platforms, summary, metaReadiness, metaStatus, incidents]
  : [platforms, summary])
const loading = computed(() => activeSources.value.some(source => source.loading.value))
const error = computed(() => activeSources.value.map(source => source.error.value).find(Boolean) || '')
const platformConfigRoute = computed(() => ({
  path: '/admin/attribution/platforms',
  query: { provider: selectedProvider.value },
}))
const overviewRoute = computed(() => ({
  path: '/admin/attribution',
  query: { ...attributionRouteQuery(rangeState.range.value, rangeState.date.value), provider: selectedProvider.value },
}))

watch(rangeState.queryKey, () => void refreshAll())
watch(selectedProvider, () => void refreshAll())
onMounted(() => void refreshAll())

async function refreshAll() {
  const requests = [platforms.refresh(), summary.refresh()]
  if (selectedProvider.value === 'meta') {
    requests.push(metaReadiness.refresh(), metaStatus.refresh(), incidents.refresh())
  }
  await Promise.all(requests)
}

function checkClass(check: ReadinessCheck) {
  if (check.ok) return 'border-emerald-100 bg-emerald-50 text-emerald-900'
  return check.level === 'blocker'
    ? 'border-red-200 bg-red-50 text-red-900'
    : 'border-amber-200 bg-amber-50 text-amber-900'
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="发布与诊断"
    description="按平台执行生产门禁、放量控制和故障诊断；任何检查都不会跨平台复用结果。"
    :loading="loading"
    :error="error"
    :usage="summary.usage.value"
    @refresh="refreshAll"
  >
    <AttributionProviderSwitch v-model="selectedProvider" />

    <section :class="['min-w-0 border-y px-4 py-3 text-sm font-medium', ready ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900']">
      {{ ready ? `${platform.label} 生产阻断项已通过` : `${platform.label} 生产阻断项仍需处理` }}
    </section>

    <section class="min-w-0 space-y-3 bg-white px-3 py-5 sm:px-5" aria-label="阻断项">
      <div>
        <h2 class="text-sm font-semibold text-gray-900">阻断项</h2>
        <p class="mt-1 text-sm text-gray-500">任一未通过都会阻止 {{ platform.serverLabel }} 正式放量。</p>
      </div>
      <div class="grid min-w-0 gap-3 md:grid-cols-2">
        <article v-for="check in blockerChecks" :key="check.key" :class="['min-w-0 rounded-md border p-4', checkClass(check)]">
          <div class="flex min-w-0 items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="text-sm font-semibold [overflow-wrap:anywhere]">{{ check.label }}</h3>
              <p class="mt-1 text-xs leading-5 opacity-80 [overflow-wrap:anywhere]">{{ check.detail }}</p>
              <p class="mt-1 break-all font-mono text-xs opacity-60">{{ check.key }}</p>
            </div>
            <span class="shrink-0 text-xs font-medium">{{ check.ok ? '通过' : '阻断' }}</span>
          </div>
        </article>
      </div>
    </section>

    <section class="min-w-0 space-y-3 border-t border-gray-200 bg-white px-3 py-5 sm:px-5" aria-label="警告项">
      <div>
        <h2 class="text-sm font-semibold text-gray-900">警告项</h2>
        <p class="mt-1 text-sm text-gray-500">提示质量和稳定性风险，不改变顶部生产阻断状态。</p>
      </div>
      <div class="grid min-w-0 gap-3 md:grid-cols-2">
        <article v-for="check in warningChecks" :key="check.key" :class="['min-w-0 rounded-md border p-4', checkClass(check)]">
          <div class="flex min-w-0 items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="text-sm font-semibold [overflow-wrap:anywhere]">{{ check.label }}</h3>
              <p class="mt-1 text-xs leading-5 opacity-80 [overflow-wrap:anywhere]">{{ check.detail }}</p>
            </div>
            <span class="shrink-0 text-xs font-medium">{{ check.ok ? '正常' : '警告' }}</span>
          </div>
        </article>
      </div>
    </section>

    <section class="min-w-0 border-t border-gray-200 bg-white px-3 py-5 sm:px-5">
      <div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-sm font-semibold text-gray-900">发布控制</h2>
          <p class="mt-1 text-sm text-gray-500">{{ platform.supportsManagedRollout ? '受控放量会结合连接验证、live evidence 与 incident。' : '放量比例由平台连接统一管理，此处只展示诊断结果。' }}</p>
        </div>
        <NuxtLink :to="platformConfigRoute" class="text-sm font-medium text-gray-700 hover:text-gray-950">管理平台连接</NuxtLink>
      </div>
      <MetaRolloutControl v-if="selectedProvider === 'meta'" :rollout="metaStatus.data.value?.rollout || null" :is-owner="isOwner" @refreshed="refreshAll" />
      <dl v-else class="grid grid-cols-2 border-y border-gray-200 md:grid-cols-4">
        <div class="px-3 py-3"><dt class="text-xs text-gray-500">连接状态</dt><dd class="mt-1 text-sm font-semibold">{{ attributionConnectionStateLabel(connection?.state || 'not_configured') }}</dd></div>
        <div class="px-3 py-3"><dt class="text-xs text-gray-500">目标放量</dt><dd class="mt-1 text-sm font-semibold">{{ connection?.rolloutPercentage ?? 0 }}%</dd></div>
        <div class="px-3 py-3"><dt class="text-xs text-gray-500">跨平台投递</dt><dd class="mt-1 text-sm font-semibold">{{ summary.data.value?.routing.mismatchCount ?? 0 }}</dd></div>
        <div class="px-3 py-3"><dt class="text-xs text-gray-500">重试耗尽</dt><dd class="mt-1 text-sm font-semibold">{{ summary.data.value?.delivery.retryExhausted ?? 0 }}</dd></div>
      </dl>
    </section>

    <section v-if="selectedProvider === 'meta'" class="min-w-0 border-t border-gray-200 bg-white px-3 py-5 sm:px-5">
      <h2 class="mb-4 text-sm font-semibold text-gray-900">Incident 记录</h2>
      <MetaIncidentList :incidents="incidents.data.value?.items || []" :is-owner="isOwner" @refreshed="refreshAll" />
    </section>

    <section class="min-w-0 space-y-3 border-t border-gray-200 bg-white px-3 py-5 sm:px-5">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-sm font-semibold text-gray-900">相关配置</h2>
          <p class="mt-1 text-sm text-gray-500">这里只展示脱敏状态，ID 与凭证不在诊断页面编辑。</p>
        </div>
        <NuxtLink :to="overviewRoute" class="text-sm font-medium text-gray-700 hover:text-gray-950">返回归因总览</NuxtLink>
      </div>
      <div class="grid min-w-0 border-y border-gray-200 md:grid-cols-2">
        <div v-for="item in settingRows" :key="item.key" class="min-w-0 border-b border-gray-100 px-3 py-3 md:odd:border-r">
          <p class="text-xs font-medium text-gray-500">{{ item.label }}</p>
          <p class="mt-1 break-all font-mono text-xs text-gray-400">{{ item.key }}</p>
          <p class="mt-1 break-all text-sm font-medium text-gray-900">{{ item.value || '-' }}</p>
        </div>
      </div>
    </section>

    <section v-if="selectedProvider === 'meta'" class="min-w-0 space-y-3 border-t border-gray-200 bg-white px-3 py-5 sm:px-5">
      <div>
        <h2 class="text-sm font-semibold text-gray-900">发布验证摘要</h2>
        <p class="mt-1 text-sm text-gray-500">只展示当前有效记录的存在状态与时间，不返回资源 ID 或凭证。</p>
      </div>
      <div class="grid min-w-0 border-y border-gray-200 md:grid-cols-2">
        <div v-for="item in verificationRows" :key="item.key" class="min-w-0 border-b border-gray-100 px-3 py-3 md:odd:border-r">
          <div class="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <p class="text-sm font-medium text-gray-900">{{ item.label }}</p>
            <span :class="item.present ? 'text-emerald-700' : 'text-red-700'" class="shrink-0 text-xs font-medium">{{ item.present ? '已确认' : '未确认' }}</span>
          </div>
          <p class="mt-2 text-xs text-gray-500">验证时间：{{ formatAnalyticsDateTime(item.verifiedAt) }}</p>
          <p class="mt-1 text-xs text-gray-500">有效期至：{{ formatAnalyticsDateTime(item.expiresAt) }}</p>
        </div>
      </div>
    </section>
  </AttributionPageShell>
</template>
