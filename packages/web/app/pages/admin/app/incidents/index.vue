<script setup lang="ts">
import {
  adminIncidentDomainLabel,
  adminIncidentSeverityClass,
  adminIncidentSeverityLabel,
  adminIncidentStatusClass,
  adminIncidentStatusLabel,
  adminIncidentTypeLabel,
  adminOperationTime,
  type AdminOperationalIncidentList,
  type AdminOperationalIncidentSummary,
} from '~/types/admin-app-operations'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const statusFilter = ref('')
const severityFilter = ref('')
const domainFilter = ref('')
const typeFilter = ref('')
const ownerFilter = ref('all')
const loading = ref(false)
const loadingMore = ref(false)
const errorMessage = ref('')
const result = ref<AdminOperationalIncidentList | null>(null)
const incidents = ref<AdminOperationalIncidentSummary[]>([])
const appliedFilters = ref<IncidentFilters | null>(null)

type IncidentFilters = {
  status?: string
  severity?: string
  domain?: string
  type?: string
  owner: string
  limit: number
}

const domainOptions = [
  'supply', 'discovery', 'messaging', 'membership', 'wallet',
  'notification', 'safety', 'audit', 'platform',
]
const typeOptions = [
  'unauthorized_publication',
  'operator_identity_anomaly',
  'membership_expiry_not_revoked',
  'duplicate_membership_grant',
  'wallet_balance_mismatch',
  'unreviewed_wallet_adjustment',
  'audit_integrity_gap',
  'internal_note_exposure',
  'notification_backlog',
  'data_rights_overdue',
  'platform_health_anomaly',
]

const filtersDirty = computed(() => JSON.stringify(buildFilters()) !== JSON.stringify(appliedFilters.value))

onMounted(() => loadIncidents(true))

async function loadIncidents(reset: boolean) {
  if (reset) loading.value = true
  else loadingMore.value = true
  errorMessage.value = ''
  try {
    const filters = reset ? buildFilters() : appliedFilters.value
    if (!filters) return
    const response = await api<{ data: AdminOperationalIncidentList }>('/api/admin/app/operations/incidents', {
      query: {
        ...filters,
        cursor: reset ? undefined : result.value?.nextCursor ?? undefined,
      },
    })
    result.value = response.data
    incidents.value = reset ? response.data.incidents : [...incidents.value, ...response.data.incidents]
    if (reset) appliedFilters.value = filters
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '运营事件加载失败，请检查筛选条件或稍后重试。')
  }
  finally {
    loading.value = false
    loadingMore.value = false
  }
}

function buildFilters(): IncidentFilters {
  return {
    status: statusFilter.value || undefined,
    severity: severityFilter.value || undefined,
    domain: domainFilter.value || undefined,
    type: typeFilter.value || undefined,
    owner: ownerFilter.value,
    limit: 40,
  }
}

function resetFilters() {
  statusFilter.value = ''
  severityFilter.value = ''
  domainFilter.value = ''
  typeFilter.value = ''
  ownerFilter.value = 'all'
  loadIncidents(true)
}

function impactLabel(incident: AdminOperationalIncidentSummary) {
  return incident.impact.count === null ? '影响范围未知' : `影响 ${new Intl.NumberFormat('zh-CN').format(incident.impact.count)} 项`
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-OV-02" route="/admin/app/incidents" title="异常中心" description="集中处理跨领域异常、优先级、责任人与 Runbook；事件数量只来自已运行检测。" :state="loading ? '加载中' : errorMessage ? '加载失败' : '正常'" figma-state="正常" :state-tone="errorMessage ? 'danger' : loading ? 'warning' : 'info'">
      <template #actions><NuxtLink to="/admin/app" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-[#eaded8] bg-white px-4 text-sm font-medium text-stone-700 hover:bg-[#fff7f2]">返回运营总览</NuxtLink></template>
    </AdminAppPageHeader>

    <section class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
      <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <label class="min-w-0 text-sm font-medium text-gray-700">状态
          <select v-model="statusFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm">
            <option value="">全部状态</option>
            <option value="open">待响应</option><option value="acknowledged">已确认</option><option value="investigating">调查中</option>
            <option value="mitigated">已缓解</option><option value="resolved">已解决</option><option value="false_positive">误报</option>
          </select>
        </label>
        <label class="min-w-0 text-sm font-medium text-gray-700">严重级别
          <select v-model="severityFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm">
            <option value="">全部级别</option><option value="p0">P0 紧急</option><option value="p1">P1 高优</option><option value="p2">P2 中优</option><option value="p3">P3 观察</option>
          </select>
        </label>
        <label class="min-w-0 text-sm font-medium text-gray-700">业务域
          <select v-model="domainFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm">
            <option value="">全部业务域</option><option v-for="domain in domainOptions" :key="domain" :value="domain">{{ adminIncidentDomainLabel(domain) }}</option>
          </select>
        </label>
        <label class="min-w-0 text-sm font-medium text-gray-700">事件类型
          <select v-model="typeFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm">
            <option value="">全部类型</option><option v-for="type in typeOptions" :key="type" :value="type">{{ adminIncidentTypeLabel(type) }}</option>
          </select>
        </label>
        <label class="min-w-0 text-sm font-medium text-gray-700">负责人
          <select v-model="ownerFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm">
            <option value="all">全部负责人</option><option value="mine">只看我领取</option><option value="unassigned">尚未分配</option><option value="assigned">已分配</option>
          </select>
        </label>
      </div>
      <div class="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button type="button" class="min-h-11 w-full rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:w-auto" @click="resetFilters">清除筛选</button>
        <button type="button" :disabled="loading" class="min-h-11 w-full rounded-lg bg-gray-950 px-5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto" @click="loadIncidents(true)">{{ loading ? '查询中…' : filtersDirty ? '应用新筛选' : '重新查询' }}</button>
      </div>
    </section>

    <section v-if="result" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">筛选结果</p><p class="mt-1 text-2xl font-semibold text-gray-950">{{ result.summary.total }}</p></article>
      <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">未关闭</p><p class="mt-1 text-2xl font-semibold text-gray-950">{{ result.summary.open }}</p></article>
      <article class="rounded-xl border border-red-200 bg-red-50 p-4"><p class="text-xs text-red-700">P0 紧急</p><p class="mt-1 text-2xl font-semibold text-red-950">{{ result.summary.p0 }}</p></article>
      <article class="rounded-xl border border-orange-200 bg-orange-50 p-4"><p class="text-xs text-orange-700">P1 高优</p><p class="mt-1 text-2xl font-semibold text-orange-950">{{ result.summary.p1 }}</p></article>
      <article class="rounded-xl border border-amber-200 bg-amber-50 p-4"><p class="text-xs text-amber-700">未分配</p><p class="mt-1 text-2xl font-semibold text-amber-950">{{ result.summary.unassigned }}</p></article>
    </section>

    <p v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ errorMessage }}</p>
    <div v-if="loading" class="rounded-xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">正在读取事件…</div>

    <section v-else class="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div class="hidden grid-cols-[88px_120px_minmax(240px,1fr)_150px_150px_110px] gap-3 border-b border-gray-200 bg-gray-50 px-5 py-3 text-xs font-medium text-gray-500 xl:grid">
        <span>级别</span><span>业务域</span><span>事件</span><span>状态 / 负责人</span><span>最后信号</span><span class="text-right">操作</span>
      </div>
      <div v-if="incidents.length" class="divide-y divide-gray-100">
        <article v-for="incident in incidents" :key="incident.incidentId" class="grid min-w-0 gap-3 p-4 sm:p-5 xl:grid-cols-[88px_120px_minmax(240px,1fr)_150px_150px_110px] xl:items-center">
          <div><span class="inline-flex rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="adminIncidentSeverityClass(incident.severity)">{{ adminIncidentSeverityLabel(incident.severity) }}</span></div>
          <div class="min-w-0"><p class="text-sm font-medium text-gray-800">{{ adminIncidentDomainLabel(incident.domain) }}</p><p class="mt-1 truncate font-mono text-[10px] text-gray-400" :title="incident.domain">{{ incident.domain }}</p></div>
          <div class="min-w-0"><p class="break-words text-sm font-semibold text-gray-950">{{ incident.title }}</p><p class="mt-1 line-clamp-2 break-words text-xs leading-5 text-gray-500">{{ incident.summary }}</p><div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-400"><span>{{ adminIncidentTypeLabel(incident.type) }}</span><span>{{ impactLabel(incident) }}</span><span>信号 {{ incident.signalCount }}</span></div></div>
          <div class="min-w-0"><span class="inline-flex rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="adminIncidentStatusClass(incident.status)">{{ adminIncidentStatusLabel(incident.status) }}</span><p class="mt-2 truncate text-xs text-gray-500" :title="incident.owner?.label || '尚未分配'">{{ incident.owner?.label || '尚未分配' }}</p></div>
          <div class="text-xs leading-5 text-gray-500"><p>{{ adminOperationTime(incident.lastSeenAt) }}</p><p class="mt-1 text-[11px] text-gray-400">v{{ incident.version }}</p></div>
          <div class="xl:text-right"><NuxtLink :to="`/admin/app/incidents/${incident.incidentId}`" class="inline-flex min-h-10 w-full items-center justify-center rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 xl:w-auto">进入处置</NuxtLink></div>
        </article>
      </div>
      <div v-else class="p-12 text-center"><p class="text-sm font-medium text-gray-700">当前筛选下没有事件</p><p class="mt-2 text-xs leading-5 text-gray-500">尚未运行或尚未接入检测器不代表对应异常数量为 0。</p></div>
    </section>

    <div v-if="result?.nextCursor" class="text-center">
      <button type="button" :disabled="loadingMore" class="min-h-11 rounded-lg border border-gray-300 bg-white px-6 text-sm font-medium text-gray-700 disabled:opacity-50" @click="loadIncidents(false)">{{ loadingMore ? '加载中…' : '加载更多事件' }}</button>
    </div>
  </div>
</template>
