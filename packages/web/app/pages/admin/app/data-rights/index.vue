<script setup lang="ts">
import {
  adminDataRightsStatusClass,
  adminDataRightsStatusLabel,
  adminDataRightsTime,
  adminDataRightsTypeLabel,
  type AdminDataRightsOverview,
  type AdminDataRightsRequestList,
  type AdminDataRightsRequestStatus,
  type AdminDataRightsRequestType,
} from '~/types/admin-app-data-rights'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()
const typeFilter = ref<AdminDataRightsRequestType | ''>('')
const statusFilter = ref<AdminDataRightsRequestStatus | ''>('')
const assignmentFilter = ref<'all' | 'mine' | 'unassigned'>('all')
const loading = ref(false)
const errorMessage = ref('')
const overview = ref<AdminDataRightsOverview | null>(null)
const queue = ref<AdminDataRightsRequestList | null>(null)

const statusOptions: AdminDataRightsRequestStatus[] = [
  'requested', 'verification_required', 'collecting', 'ready', 'scheduled',
  'processing', 'failed', 'completed', 'cancelled', 'expired',
]

const governanceReady = computed(() => {
  const policy = overview.value?.policy
  return Boolean(
    policy
    && policy.governance.retention === 'approved'
    && policy.governance.ownerAndSla === 'approved'
    && policy.governance.region === 'approved',
  )
})

onMounted(loadData)

async function loadData() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [overviewResponse, queueResponse] = await Promise.all([
      api<{ data: AdminDataRightsOverview }>('/api/admin/app/data-rights/overview'),
      api<{ data: AdminDataRightsRequestList }>('/api/admin/app/data-rights/requests', {
        query: {
          type: typeFilter.value || undefined,
          status: statusFilter.value || undefined,
          assignment: assignmentFilter.value,
          limit: 80,
        },
      }),
    ])
    overview.value = overviewResponse.data
    queue.value = queueResponse.data
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '数据权利控制面加载失败；请确认开发 migration 已就绪后重试。')
  }
  finally {
    loading.value = false
  }
}

function clearFilters() {
  typeFilter.value = ''
  statusFilter.value = ''
  assignmentFilter.value = 'all'
  loadData()
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <header class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-xl font-bold text-gray-950">App 数据权利控制面</h1>
          <span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">ADM-PRI-01</span>
        </div>
        <p class="mt-1 max-w-4xl text-sm leading-6 text-gray-600">集中处理账号数据导出与注销申请。列表仅展示最小账号信息，不展示导出内容、密码、状态凭证或用户私密正文。</p>
      </div>
      <button type="button" :disabled="loading" class="min-h-11 w-full shrink-0 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 sm:w-auto" @click="loadData">{{ loading ? '刷新中…' : '刷新权威状态' }}</button>
    </header>

    <p v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ errorMessage }}</p>

    <section v-if="overview" class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-6">
      <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">全部申请</p><p class="mt-1 text-2xl font-semibold text-gray-950">{{ overview.metrics.total }}</p></article>
      <article class="rounded-xl border border-blue-200 bg-blue-50 p-4"><p class="text-xs text-blue-700">处理中</p><p class="mt-1 text-2xl font-semibold text-blue-950">{{ overview.metrics.open }}</p></article>
      <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">导出进行中</p><p class="mt-1 text-2xl font-semibold text-gray-950">{{ overview.metrics.exportOpen }}</p></article>
      <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">注销进行中</p><p class="mt-1 text-2xl font-semibold text-gray-950">{{ overview.metrics.deletionOpen }}</p></article>
      <article class="rounded-xl border border-amber-200 bg-amber-50 p-4"><p class="text-xs text-amber-700">未领取</p><p class="mt-1 text-2xl font-semibold text-amber-950">{{ overview.metrics.unassigned }}</p></article>
      <article class="rounded-xl border border-red-200 bg-red-50 p-4"><p class="text-xs text-red-700">已逾期</p><p class="mt-1 text-2xl font-semibold text-red-950">{{ overview.metrics.overdue }}</p></article>
    </section>

    <section v-if="overview" class="rounded-xl border p-4 sm:p-5" :class="overview.policy?.productionReady && governanceReady ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'">
      <div class="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div class="min-w-0">
          <h2 class="text-sm font-semibold" :class="overview.policy?.productionReady && governanceReady ? 'text-emerald-950' : 'text-amber-950'">{{ overview.policy?.productionReady && governanceReady ? '策略已通过生产门禁' : 'Privacy-1 开发门禁保持关闭' }}</h2>
          <p class="mt-1 break-words text-sm leading-6" :class="overview.policy?.productionReady && governanceReady ? 'text-emerald-800' : 'text-amber-800'">当前阶段只交付二次验证、申请、状态查询、撤回和人工控制面。导出包生成、下载与不可逆删除必须在保留期、地区、责任人与 SLA 决策批准并完成 Privacy-2 后启用。</p>
        </div>
        <div class="shrink-0 text-xs leading-5" :class="overview.policy?.productionReady && governanceReady ? 'text-emerald-800' : 'text-amber-800'">
          <p class="break-all font-mono">{{ overview.policy?.version || overview.runtime.configuredPolicyId || '未选择策略' }}</p>
          <p>后台开关：{{ overview.runtime.adminRequested ? '已请求开启' : '关闭' }} · 生产门禁：{{ overview.policy?.productionReady ? '通过' : '未通过' }}</p>
        </div>
      </div>
      <div v-if="overview.policy" class="mt-4 grid gap-2 text-xs sm:grid-cols-3">
        <p class="rounded-lg bg-white/70 p-3">保留策略：{{ overview.policy.governance.retention === 'approved' ? '已批准' : '待决策' }}</p>
        <p class="rounded-lg bg-white/70 p-3">责任人与 SLA：{{ overview.policy.governance.ownerAndSla === 'approved' ? '已批准' : '待决策' }}</p>
        <p class="rounded-lg bg-white/70 p-3">地区规则：{{ overview.policy.governance.region === 'approved' ? '已批准' : '待决策' }}</p>
      </div>
    </section>

    <section class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
      <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_auto_auto] xl:items-end">
        <label class="min-w-0 text-sm font-medium text-gray-700">申请类型
          <select v-model="typeFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm"><option value="">全部类型</option><option value="export">数据导出</option><option value="deletion">账号注销</option></select>
        </label>
        <label class="min-w-0 text-sm font-medium text-gray-700">处理状态
          <select v-model="statusFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm"><option value="">全部状态</option><option v-for="item in statusOptions" :key="item" :value="item">{{ adminDataRightsStatusLabel(item) }}</option></select>
        </label>
        <label class="min-w-0 text-sm font-medium text-gray-700">负责人
          <select v-model="assignmentFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm"><option value="all">全部申请</option><option value="mine">只看我领取</option><option value="unassigned">尚未领取</option></select>
        </label>
        <button type="button" class="min-h-11 w-full rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:w-auto" @click="clearFilters">清除</button>
        <button type="button" :disabled="loading" class="min-h-11 w-full rounded-lg bg-gray-950 px-5 text-sm font-medium text-white disabled:opacity-50 sm:w-auto" @click="loadData">应用筛选</button>
      </div>
      <p v-if="!isOwner" class="mt-3 text-xs leading-5 text-amber-700">当前角色可查看最小队列；领取、代用户取消和处置动作仅 Owner 可执行。</p>
    </section>

    <div v-if="loading && !queue" class="rounded-xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">正在读取数据权利队列…</div>
    <section v-else class="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div class="hidden grid-cols-[112px_130px_minmax(220px,1fr)_155px_160px_110px] gap-3 border-b border-gray-200 bg-gray-50 px-5 py-3 text-xs font-medium text-gray-500 xl:grid">
        <span>类型</span><span>状态</span><span>账号 / 申请</span><span>负责人</span><span>时限</span><span class="text-right">操作</span>
      </div>
      <div v-if="queue?.items.length" class="divide-y divide-gray-100">
        <article v-for="request in queue.items" :key="request.requestId" class="grid min-w-0 gap-3 p-4 sm:p-5 xl:grid-cols-[112px_130px_minmax(220px,1fr)_155px_160px_110px] xl:items-center">
          <div><span class="inline-flex rounded-full px-2 py-1 text-xs font-medium" :class="request.type === 'deletion' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'">{{ adminDataRightsTypeLabel(request.type) }}</span></div>
          <div class="flex flex-wrap items-center gap-2"><span class="inline-flex rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="adminDataRightsStatusClass(request.status)">{{ adminDataRightsStatusLabel(request.status) }}</span><span v-if="request.overdue" class="text-xs font-semibold text-red-700">已逾期</span></div>
          <div class="min-w-0"><p class="truncate text-sm font-semibold text-gray-950" :title="request.account.nickname">{{ request.account.nickname }}</p><p class="mt-1 truncate text-xs text-gray-500" :title="request.account.emailMasked">{{ request.account.emailMasked }}</p><p class="mt-1 break-all font-mono text-[10px] text-gray-400">{{ request.requestId }}</p></div>
          <div class="min-w-0 text-xs leading-5 text-gray-600"><p class="truncate" :title="request.assignee?.label || '尚未领取'">{{ request.assignee?.label || '尚未领取' }}</p><p>申请 v{{ request.version }}</p></div>
          <div class="text-xs leading-5" :class="request.overdue ? 'font-medium text-red-700' : 'text-gray-500'"><p>{{ request.deadlineAt ? adminDataRightsTime(request.deadlineAt) : '未配置 SLA' }}</p><p class="mt-1 text-[11px] text-gray-400">提交 {{ adminDataRightsTime(request.requestedAt) }}</p></div>
          <div class="xl:text-right"><NuxtLink :to="`/admin/app/data-rights/${request.requestId}`" class="inline-flex min-h-10 w-full items-center justify-center rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50 xl:w-auto">查看详情</NuxtLink></div>
        </article>
      </div>
      <div v-else class="p-12 text-center"><p class="text-sm font-medium text-gray-700">当前筛选下没有申请</p><p class="mt-2 text-xs leading-5 text-gray-500">功能门禁关闭或尚未执行 migration 不等于生产数据权利流程已经完成配置。</p></div>
    </section>
  </div>
</template>
