<script setup lang="ts">
import {
  adminIncidentSeverityClass,
  adminIncidentSeverityLabel,
  adminIncidentStatusClass,
  adminIncidentStatusLabel,
  adminMetricQualityClass,
  adminOperationTime,
  type AdminOperationsOverview,
  type AdminOperationsOverviewMetric,
} from '~/types/admin-app-operations'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()
const actionBusy = ref<'refresh' | 'detect' | ''>('')
const actionError = ref('')
const successMessage = ref('')

const { data, status, refresh } = await useAsyncData('admin-app-operations-overview', async () => {
  return api<{ data: AdminOperationsOverview }>('/api/admin/app/operations/overview')
})

const overview = computed(() => data.value?.data ?? null)
const pausedControls = computed(() => overview.value?.controls.filter(item => item.state === 'paused') ?? [])

async function refreshSnapshot() {
  if (!isOwner.value || actionBusy.value) return
  if (import.meta.client && !window.confirm('确认生成新的运营指标快照？本操作会读取跨域聚合事实并写入不可变快照与审计。')) return
  actionBusy.value = 'refresh'
  actionError.value = ''
  successMessage.value = ''
  try {
    await api('/api/admin/app/operations/overview/refresh', {
      method: 'POST',
      headers: operationHeaders('overview.refresh'),
    })
    successMessage.value = '运营指标快照已生成。未知、延迟和未配置数据仍会保持原质量状态。'
    await refresh()
  }
  catch (error) {
    actionError.value = resolveApiErrorMessage(error, '运营指标快照生成失败，请核对数据源与权限。')
  }
  finally {
    actionBusy.value = ''
  }
}

async function runDetection() {
  if (!isOwner.value || actionBusy.value) return
  if (import.meta.client && !window.confirm('确认运行运营异常检测？钱包快照不一致时会冻结对应钱包，并创建或刷新事件及审计记录。')) return
  actionBusy.value = 'detect'
  actionError.value = ''
  successMessage.value = ''
  try {
    const response = await api<{
      data: { findingCount: number; incidentCreatedCount: number; incidentRefreshedCount: number; unavailableDetectorCount: number }
    }>('/api/admin/app/operations/detections', {
      method: 'POST',
      headers: operationHeaders('detection.run'),
    })
    successMessage.value = `检测完成：${response.data.findingCount} 项发现，新增 ${response.data.incidentCreatedCount} 个事件，刷新 ${response.data.incidentRefreshedCount} 个事件；${response.data.unavailableDetectorCount} 类检测器仍未接入。`
    await refresh()
  }
  catch (error) {
    actionError.value = resolveApiErrorMessage(error, '运营异常检测失败，请稍后重试。')
  }
  finally {
    actionBusy.value = ''
  }
}

function operationHeaders(prefix: string) {
  return { 'Idempotency-Key': `${prefix}.${crypto.randomUUID().replaceAll('-', '')}` }
}

function overallClass(state: AdminOperationsOverview['overall']['state']) {
  return {
    critical: 'border-red-200 bg-red-50 text-red-950',
    attention: 'border-orange-200 bg-orange-50 text-orange-950',
    partial: 'border-violet-200 bg-violet-50 text-violet-950',
    healthy: 'border-emerald-200 bg-emerald-50 text-emerald-950',
  }[state]
}

function overallDotClass(state: AdminOperationsOverview['overall']['state']) {
  return {
    critical: 'bg-red-500',
    attention: 'bg-orange-500',
    partial: 'bg-violet-500',
    healthy: 'bg-emerald-500',
  }[state]
}

function topicStateLabel(value: string) {
  return {
    known: '数据可用',
    unknown: '数据不完整',
    delayed: '数据延迟',
    invalid: '口径异常',
    paused: '能力已暂停',
  }[value] ?? value
}

function metricValue(metric: AdminOperationsOverviewMetric) {
  if (metric.quality.state !== 'known' || metric.value === null) return '—'
  if (metric.unit === 'ratio' && typeof metric.value === 'number') return `${(metric.value * 100).toFixed(2)}%`
  if (metric.unit === 'milliseconds' && typeof metric.value === 'number') return `${Math.round(metric.value)} ms`
  if (metric.unit === 'status' || typeof metric.value === 'string') return metric.value
  return new Intl.NumberFormat('zh-CN').format(metric.value)
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-OV-01" route="/admin/app" title="运营总览" description="按权限范围汇总供给、发现、消息、会员、钱包、安全与平台健康；未知、延迟和未配置不会伪装成 0。" :state="status === 'pending' ? '加载中' : status === 'error' ? '质量异常' : overview?.overall.label || '正常'" :figma-state="status === 'error' || overview?.overall.state === 'critical' ? '质量异常' : overview?.overall.state === 'partial' ? '部分无权限' : overview?.overall.unknownMetricCount ? '数据延迟' : '正常'" :state-tone="status === 'error' ? 'danger' : status === 'pending' ? 'warning' : overview?.overall.state === 'healthy' ? 'success' : 'info'">
      <template #actions>
        <NuxtLink to="/admin/app/incidents" class="inline-flex min-h-11 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">
          进入事件中心
        </NuxtLink>
        <button v-if="isOwner" type="button" :disabled="Boolean(actionBusy)" class="inline-flex min-h-11 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50" @click="runDetection">
          {{ actionBusy === 'detect' ? '正在检测…' : '运行异常检测' }}
        </button>
        <button v-if="isOwner" type="button" :disabled="Boolean(actionBusy)" class="inline-flex min-h-11 items-center justify-center rounded-lg bg-gray-950 px-4 text-sm font-medium text-white hover:bg-black disabled:opacity-50" @click="refreshSnapshot">
          {{ actionBusy === 'refresh' ? '正在生成…' : '生成指标快照' }}
        </button>
      </template>
    </AdminAppPageHeader>

    <p v-if="actionError" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ actionError }}</p>
    <p v-if="successMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-800">{{ successMessage }}</p>
    <p v-if="status === 'pending'" class="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">正在读取运营状态…</p>
    <p v-else-if="status === 'error' || !overview" class="rounded-xl border border-red-200 bg-red-50 p-5 text-sm leading-6 text-red-700">运营总览暂时不可用。当前阶段尚未执行 0092 migration 时属于预期关闭态；完成全部开发后再统一配置和迁移。</p>

    <template v-else>
      <section class="rounded-2xl border p-5" :class="overallClass(overview.overall.state)">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="h-2.5 w-2.5 rounded-full" :class="overallDotClass(overview.overall.state)" />
              <p class="text-base font-semibold">{{ overview.overall.label }}</p>
            </div>
            <p class="mt-2 text-sm leading-6 opacity-80">
              范围：{{ overview.scope.label }} · 当前有 {{ overview.overall.unknownMetricCount }} 项指标不是可用新鲜状态
            </p>
          </div>
          <div class="shrink-0 text-sm leading-6 lg:text-right">
            <p class="font-medium">快照：{{ overview.snapshot ? adminOperationTime(overview.snapshot.completedAt) : '尚未生成' }}</p>
            <p class="opacity-75">{{ overview.snapshot ? `${overview.snapshot.knownCount}/${overview.snapshot.metricCount} 项已知 · ${overview.snapshot.version}` : '请由 Owner 生成首个受控快照' }}</p>
          </div>
        </div>
      </section>

      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">未关闭事件</p><p class="mt-1 text-2xl font-semibold text-gray-950">{{ overview.incidents.open }}</p><p class="mt-1 text-xs text-gray-500">全部事件 {{ overview.incidents.total }}</p></div>
        <div class="rounded-xl border border-red-200 bg-red-50 p-4"><p class="text-xs text-red-700">P0 紧急</p><p class="mt-1 text-2xl font-semibold text-red-950">{{ overview.incidents.p0 }}</p><p class="mt-1 text-xs text-red-700">需立即响应</p></div>
        <div class="rounded-xl border border-orange-200 bg-orange-50 p-4"><p class="text-xs text-orange-700">P1 高优</p><p class="mt-1 text-2xl font-semibold text-orange-950">{{ overview.incidents.p1 }}</p><p class="mt-1 text-xs text-orange-700">需明确负责人</p></div>
        <div class="rounded-xl border border-amber-200 bg-amber-50 p-4"><p class="text-xs text-amber-700">未分配</p><p class="mt-1 text-2xl font-semibold text-amber-950">{{ overview.incidents.unassigned }}</p><p class="mt-1 text-xs text-amber-700">未关闭事件</p></div>
        <div class="rounded-xl border border-violet-200 bg-violet-50 p-4"><p class="text-xs text-violet-700">已暂停能力</p><p class="mt-1 text-2xl font-semibold text-violet-950">{{ pausedControls.length }}</p><p class="mt-1 text-xs text-violet-700">恢复需验证证据</p></div>
      </section>

      <section class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 class="text-base font-semibold text-gray-950">跨域安全控制</h2><p class="mt-1 text-xs leading-5 text-gray-500">“可用”只表示未因运营事件暂停，不代表对应产品 capability 已开放。</p></div>
          <span class="mt-2 text-xs text-gray-500 sm:mt-0">仅 Owner 可切换</span>
        </div>
        <div class="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <article v-for="control in overview.controls" :key="control.key" class="min-w-0 rounded-xl border p-4" :class="control.state === 'paused' ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'">
            <div class="flex items-start justify-between gap-2">
              <p class="min-w-0 text-sm font-medium text-gray-950">{{ control.displayName }}</p>
              <span class="shrink-0 rounded-full px-2 py-1 text-[11px] font-medium" :class="control.state === 'paused' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'">{{ control.state === 'paused' ? '已暂停' : '可用' }}</span>
            </div>
            <p class="mt-3 break-all font-mono text-[10px] leading-5 text-gray-500">{{ control.key }} · v{{ control.version }}</p>
            <p v-if="control.reasonSummary" class="mt-2 text-xs leading-5 text-red-700">{{ control.reasonSummary }}</p>
            <NuxtLink v-if="control.incidentId" :to="`/admin/app/incidents/${control.incidentId}`" class="mt-2 inline-flex text-xs font-medium text-red-700 underline underline-offset-4">查看关联事件</NuxtLink>
          </article>
        </div>
      </section>

      <section class="grid gap-4 xl:grid-cols-3">
        <article v-for="topic in overview.topics" :key="topic.key" class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <div class="flex items-center justify-between gap-3">
            <h2 class="text-base font-semibold text-gray-950">{{ topic.label }}</h2>
            <span class="rounded-full px-2 py-1 text-[11px] font-medium" :class="topic.state === 'known' ? 'bg-emerald-50 text-emerald-700' : topic.state === 'paused' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'">{{ topicStateLabel(topic.state) }}</span>
          </div>
          <div class="mt-4 divide-y divide-gray-100">
            <div v-for="metric in topic.metrics" :key="metric.key" class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-3 py-3 first:pt-0 last:pb-0">
              <div class="min-w-0">
                <p class="text-sm font-medium text-gray-900">{{ metric.name }}</p>
                <p class="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{{ metric.description }}</p>
                <div class="mt-2 flex flex-wrap items-center gap-1.5">
                  <span class="rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset" :class="adminMetricQualityClass(metric.quality.state)">{{ metric.quality.label }}</span>
                  <span v-if="!metric.governance.productionReady" class="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700">生产口径未就绪</span>
                </div>
              </div>
              <p class="self-start text-right text-xl font-semibold tabular-nums text-gray-950">{{ metricValue(metric) }}</p>
            </div>
          </div>
        </article>
      </section>

      <section class="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div class="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-4 sm:px-5">
          <div><h2 class="text-base font-semibold text-gray-950">高优事件</h2><p class="mt-1 text-xs text-gray-500">按严重级别与最近信号展示，不包含个人级排行。</p></div>
          <NuxtLink to="/admin/app/incidents" class="shrink-0 text-sm font-medium text-gray-700 underline underline-offset-4">查看全部</NuxtLink>
        </div>
        <div v-if="overview.incidents.recent.length" class="divide-y divide-gray-100">
          <article v-for="incident in overview.incidents.recent" :key="incident.incidentId" class="grid min-w-0 gap-3 p-4 sm:p-5 xl:grid-cols-[100px_minmax(0,1fr)_160px_120px] xl:items-center">
            <div><span class="inline-flex rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="adminIncidentSeverityClass(incident.severity)">{{ adminIncidentSeverityLabel(incident.severity) }}</span></div>
            <div class="min-w-0"><p class="text-sm font-medium text-gray-950">{{ incident.title }}</p><p class="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">{{ incident.summary }}</p><p class="mt-1 text-[11px] text-gray-400">最后信号 {{ adminOperationTime(incident.lastSeenAt) }}</p></div>
            <div class="min-w-0"><span class="inline-flex rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="adminIncidentStatusClass(incident.status)">{{ adminIncidentStatusLabel(incident.status) }}</span><p class="mt-2 truncate text-xs text-gray-500">{{ incident.owner?.label || '尚未分配' }}</p></div>
            <div class="xl:text-right"><NuxtLink :to="`/admin/app/incidents/${incident.incidentId}`" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50">进入处置</NuxtLink></div>
          </article>
        </div>
        <div v-else class="p-10 text-center"><p class="text-sm font-medium text-gray-700">当前没有未关闭事件</p><p class="mt-2 text-xs text-gray-500">尚未运行检测不等于没有异常，请同时查看快照与数据质量。</p></div>
      </section>
    </template>
  </div>
</template>
