<script setup lang="ts">
import type {
  AdminConversationSafetyEscalationDetail,
  AdminConversationSafetyEscalationSummary,
  AdminMessagingRuntimeControl,
  AdminSafetyReportDetail,
  AdminSafetyReportSummary,
} from '~/types/admin-app-safety'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()
const route = useRoute()
const activeTab = ref<'reports' | 'escalations' | 'runtime'>(route.query.tab === 'escalations' ? 'escalations' : 'reports')
const statusFilter = ref('open')
const priorityFilter = ref('')
const targetFilter = ref('')
const selectedId = ref<string | null>(null)
const detail = ref<AdminSafetyReportDetail | null>(null)
const listError = ref('')
const detailError = ref('')
const operationError = ref('')
const detailLoading = ref(false)
const claiming = ref(false)
const deciding = ref(false)
const escalationStatusFilter = ref('open')
const escalationPriorityFilter = ref('')
const escalations = ref<AdminConversationSafetyEscalationSummary[]>([])
const escalationListLoading = ref(false)
const escalationListError = ref('')
const selectedEscalationId = ref<string | null>(typeof route.query.escalationId === 'string' ? route.query.escalationId : null)
const escalationDetail = ref<AdminConversationSafetyEscalationDetail | null>(null)
const escalationDetailLoading = ref(false)
const escalationDetailError = ref('')
const escalationOperationError = ref('')
const escalationClaiming = ref(false)
const escalationDeciding = ref(false)

const escalationDecisionForm = reactive({
  outcome: 'no_action' as 'actioned' | 'no_action',
  actionType: 'none' as 'none' | 'conversation_restricted' | 'conversation_closed',
  decisionReasonCode: 'review_no_action',
  decisionSummary: '',
})

const decisionForm = reactive({
  outcome: 'no_violation' as 'actioned' | 'no_violation',
  actionType: 'none' as 'none' | 'conversation_restricted' | 'conversation_closed' | 'profile_publication_paused',
  decisionReasonCode: 'review_no_violation',
  userVisibleMessage: '平台已完成审核，当前未发现违规。',
})

const runtimeDraft = reactive({
  newConversationsPaused: false,
  viewerSendsPaused: false,
  operatorSendsPaused: false,
  reasonCode: '',
  userVisibleMessage: '',
  maxOpenConversations: 100,
  maxActiveAssignmentsPerOperator: 10,
  assignmentLeaseMinutes: 30,
})
const runtimeError = ref('')
const runtimeSaving = ref(false)

const { data: reportData, status: reportStatus, refresh: refreshReports } = await useAsyncData(
  'admin-app-safety-reports',
  async () => {
    listError.value = ''
    try {
      return await api<{ data: AdminSafetyReportSummary[] }>('/api/admin/app/safety/reports', {
        query: {
          status: statusFilter.value || undefined,
          priority: priorityFilter.value || undefined,
          targetType: targetFilter.value || undefined,
          limit: 100,
        },
      })
    }
    catch (error) {
      listError.value = apiErrorMessage(error, '举报队列加载失败。')
      return { data: [] }
    }
  },
  { watch: [statusFilter, priorityFilter, targetFilter] },
)

const { data: runtimeData, refresh: refreshRuntime } = await useAsyncData(
  'admin-app-safety-runtime-control',
  async () => {
    runtimeError.value = ''
    try {
      return await api<{ data: AdminMessagingRuntimeControl }>('/api/admin/app/safety/runtime-control')
    }
    catch (error) {
      runtimeError.value = apiErrorMessage(error, '运行控制加载失败。')
      return null
    }
  },
)

const reports = computed(() => reportData.value?.data ?? [])
const selectedSummary = computed(() => reports.value.find(report => report.reportId === selectedId.value) ?? null)
const runtimeControl = computed(() => runtimeData.value?.data ?? null)
const selectedEscalationSummary = computed(() => (
  escalations.value.find(item => item.escalationId === selectedEscalationId.value) ?? null
))

watch(reports, (items) => {
  if (selectedId.value && items.some(item => item.reportId === selectedId.value)) return
  selectedId.value = items[0]?.reportId ?? null
}, { immediate: true })

watch(selectedId, async (reportId) => {
  detail.value = null
  detailError.value = ''
  operationError.value = ''
  if (reportId && selectedSummary.value?.assignment.status === 'mine') await loadDetail(reportId)
})

watch(escalations, (items) => {
  if (selectedEscalationId.value && items.some(item => item.escalationId === selectedEscalationId.value)) return
  selectedEscalationId.value = items[0]?.escalationId ?? null
})

watch(selectedEscalationSummary, async (summary) => {
  escalationDetail.value = null
  escalationDetailError.value = ''
  escalationOperationError.value = ''
  escalationDecisionForm.outcome = 'no_action'
  escalationDecisionForm.actionType = 'none'
  escalationDecisionForm.decisionReasonCode = 'review_no_action'
  escalationDecisionForm.decisionSummary = ''
  if (summary?.assignment.status === 'mine') {
    await loadEscalationDetail(summary.escalationId)
  }
})

watch([activeTab, escalationStatusFilter, escalationPriorityFilter], async ([tab]) => {
  if (tab === 'escalations') await loadEscalations()
})

watch(runtimeControl, (control) => {
  if (!control) return
  runtimeDraft.newConversationsPaused = control.newConversationsPaused
  runtimeDraft.viewerSendsPaused = control.viewerSendsPaused
  runtimeDraft.operatorSendsPaused = control.operatorSendsPaused
  runtimeDraft.reasonCode = control.emergencyReasonCode ?? 'routine_capacity_update'
  runtimeDraft.userVisibleMessage = control.userVisibleMessage
  runtimeDraft.maxOpenConversations = control.maxOpenConversations
  runtimeDraft.maxActiveAssignmentsPerOperator = control.maxActiveAssignmentsPerOperator
  runtimeDraft.assignmentLeaseMinutes = control.assignmentLeaseMinutes
}, { immediate: true })

watch(() => decisionForm.outcome, (outcome) => {
  if (outcome === 'no_violation') {
    decisionForm.actionType = 'none'
    decisionForm.decisionReasonCode = 'review_no_violation'
    decisionForm.userVisibleMessage = '平台已完成审核，当前未发现违规。'
    return
  }
  if (selectedSummary.value?.target.type === 'conversation' || selectedSummary.value?.target.type === 'message') {
    decisionForm.actionType = 'conversation_restricted'
  }
  else {
    decisionForm.actionType = 'profile_publication_paused'
  }
  decisionForm.decisionReasonCode = 'review_action_completed'
  decisionForm.userVisibleMessage = '平台已完成审核，并采取了必要的安全措施。'
})

watch(() => escalationDecisionForm.outcome, (outcome) => {
  if (outcome === 'no_action') {
    escalationDecisionForm.actionType = 'none'
    escalationDecisionForm.decisionReasonCode = 'review_no_action'
    return
  }
  escalationDecisionForm.actionType = 'conversation_restricted'
  escalationDecisionForm.decisionReasonCode = 'review_action_completed'
})

async function loadDetail(reportId = selectedId.value) {
  if (!reportId) return
  detailLoading.value = true
  detailError.value = ''
  try {
    const response = await api<{ data: AdminSafetyReportDetail }>(
      `/api/admin/app/safety/reports/${reportId}`,
      { query: { accessReason: 'safety_review' } },
    )
    if (selectedId.value === reportId) detail.value = response.data
  }
  catch (error) {
    detailError.value = apiErrorMessage(error, '最小证据加载失败，请重试。')
  }
  finally {
    detailLoading.value = false
  }
}

async function claimReport() {
  const reportId = selectedId.value
  if (!reportId || claiming.value) return
  claiming.value = true
  operationError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    await api(`/api/admin/app/safety/reports/${reportId}/claim`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `safety.claim.${operationId}` },
    })
    await refreshReports()
    await loadDetail(reportId)
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '举报领取失败，请刷新队列后重试。')
  }
  finally {
    claiming.value = false
  }
}

async function submitDecision() {
  const reportId = selectedId.value
  if (!reportId || !detail.value || deciding.value) return
  const actionLabel = decisionForm.outcome === 'no_violation'
    ? '记录“未发现违规”结论'
    : decisionForm.actionType === 'conversation_closed'
      ? '关闭关联话题并形成已处置结论'
      : decisionForm.actionType === 'conversation_restricted'
        ? '将关联话题转为只读并形成已处置结论'
        : '引用已执行的人物暂停结果并形成已处置结论'
  if (!window.confirm(`确认${actionLabel}？用户将看到你填写的说明，提交后本阶段不支持在此页面改判。`)) return
  deciding.value = true
  operationError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    await api(`/api/admin/app/safety/reports/${reportId}/decision`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `safety.decision.${operationId}` },
      body: {
        expectedVersion: detail.value.version,
        ...decisionForm,
      },
    })
    detail.value = null
    await refreshReports()
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '审核结论提交失败，请刷新证据和版本后重试。')
  }
  finally {
    deciding.value = false
  }
}

async function loadEscalations() {
  escalationListLoading.value = true
  escalationListError.value = ''
  try {
    const response = await api<{ data: AdminConversationSafetyEscalationSummary[] }>('/api/admin/app/safety/escalations', {
      query: {
        status: escalationStatusFilter.value || undefined,
        priority: escalationPriorityFilter.value || undefined,
        limit: 100,
      },
    })
    escalations.value = response.data
  }
  catch (error) {
    escalationListError.value = apiErrorMessage(error, '内部升级案件队列加载失败。')
    escalations.value = []
  }
  finally {
    escalationListLoading.value = false
  }
}

async function loadEscalationDetail(escalationId = selectedEscalationId.value) {
  if (!escalationId) return
  escalationDetailLoading.value = true
  escalationDetailError.value = ''
  try {
    const response = await api<{ data: AdminConversationSafetyEscalationDetail }>(
      `/api/admin/app/safety/escalations/${escalationId}`,
      { query: { accessReason: 'safety_escalation_review' } },
    )
    if (selectedEscalationId.value === escalationId) escalationDetail.value = response.data
  }
  catch (error) {
    escalationDetailError.value = apiErrorMessage(error, '内部升级说明和最小证据加载失败，请重试。')
  }
  finally {
    escalationDetailLoading.value = false
  }
}

async function claimEscalation() {
  const escalationId = selectedEscalationId.value
  if (!escalationId || escalationClaiming.value) return
  escalationClaiming.value = true
  escalationOperationError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    await api(`/api/admin/app/safety/escalations/${escalationId}/claim`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `safety.escalation.claim.${operationId}` },
    })
    await loadEscalations()
  }
  catch (error) {
    escalationOperationError.value = apiErrorMessage(error, '内部升级案件领取失败，请刷新后重试。')
  }
  finally {
    escalationClaiming.value = false
  }
}

async function submitEscalationDecision() {
  const escalationId = selectedEscalationId.value
  const current = escalationDetail.value
  const summary = escalationDecisionForm.decisionSummary.trim()
  if (!escalationId || !current || !summary || escalationDeciding.value) return
  const actionLabel = escalationDecisionForm.outcome === 'no_action'
    ? '记录“无需安全动作”结论'
    : escalationDecisionForm.actionType === 'conversation_closed'
      ? '关闭关联话题'
      : '将关联话题转为只读'
  if (!window.confirm(`确认${actionLabel}并结束内部案件？内部审核说明不会对用户展示；实际话题动作会写入用户可见系统消息。`)) return
  escalationDeciding.value = true
  escalationOperationError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    await api(`/api/admin/app/safety/escalations/${escalationId}/decision`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `safety.escalation.decision.${operationId}` },
      body: {
        expectedVersion: current.version,
        ...escalationDecisionForm,
        decisionSummary: summary,
      },
    })
    escalationDetail.value = null
    escalationDecisionForm.decisionSummary = ''
    selectedEscalationId.value = null
    await loadEscalations()
  }
  catch (error) {
    escalationOperationError.value = apiErrorMessage(error, '内部升级结论提交失败，请刷新证据和版本后重试。')
  }
  finally {
    escalationDeciding.value = false
  }
}

async function saveRuntimeControl() {
  const control = runtimeControl.value
  if (!control || runtimeSaving.value || !isOwner.value) return
  if (!window.confirm('确认更新全局话题运行控制？新建话题和双方发送权限会在后续请求中立即按新状态执行。')) return
  runtimeSaving.value = true
  runtimeError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    await api('/api/admin/app/safety/runtime-control', {
      method: 'PATCH',
      headers: { 'Idempotency-Key': `safety.runtime.${operationId}` },
      body: {
        expectedVersion: control.version,
        ...runtimeDraft,
      },
    })
    await refreshRuntime()
  }
  catch (error) {
    runtimeError.value = apiErrorMessage(error, '运行控制更新失败，请刷新当前版本后重试。')
  }
  finally {
    runtimeSaving.value = false
  }
}

function priorityClass(priority: AdminSafetyReportSummary['priority'] | AdminConversationSafetyEscalationSummary['priority']) {
  if (priority === 'p0') return 'bg-red-100 text-red-800 ring-red-200'
  if (priority === 'p1') return 'bg-orange-100 text-orange-800 ring-orange-200'
  if (priority === 'p2') return 'bg-amber-100 text-amber-800 ring-amber-200'
  return 'bg-gray-100 text-gray-700 ring-gray-200'
}

function escalationStatusLabel(value: AdminConversationSafetyEscalationSummary['status']) {
  if (value === 'investigating') return '审核中'
  if (value === 'actioned') return '已采取安全动作'
  if (value === 'no_action') return '无需安全动作'
  return '待领取'
}

function targetLabel(type: AdminSafetyReportSummary['target']['type']) {
  if (type === 'person_profile') return '人物资料'
  if (type === 'media') return '媒体'
  if (type === 'conversation') return '话题'
  return '消息'
}

function assignmentLabel(value: AdminSafetyReportSummary['assignment']['status']) {
  if (value === 'mine') return '由我审核'
  if (value === 'other') return '其他审核员处理中'
  return '待领取'
}

function messageRoleLabel(role: 'before' | 'target' | 'after') {
  if (role === 'target') return '目标消息'
  return role === 'before' ? '前一条上下文' : '后一条上下文'
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(date)
}

function apiErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object') return fallback
  const candidate = error as { data?: { message?: unknown }; message?: unknown }
  if (typeof candidate.data?.message === 'string') return candidate.data.message
  if (typeof candidate.message === 'string' && candidate.message.length < 180) return candidate.message
  return fallback
}

if (activeTab.value === 'escalations') await loadEscalations()
</script>

<template>
  <div class="min-w-0 space-y-5">
    <div>
      <h1 class="text-xl font-bold text-gray-950">App 安全审核</h1>
      <p class="mt-1 max-w-4xl text-sm leading-6 text-gray-600">
        用户举报与平台运营内部升级严格分队列；审核员领取后才可按对应业务目的读取最小证据，内部说明不会返回给观看者。
      </p>
    </div>

    <div class="flex flex-wrap gap-2 border-b border-gray-200">
      <button class="border-b-2 px-4 py-2.5 text-sm font-medium" :class="activeTab === 'reports' ? 'border-rose-500 text-rose-700' : 'border-transparent text-gray-500'" @click="activeTab = 'reports'">举报队列</button>
      <button class="border-b-2 px-4 py-2.5 text-sm font-medium" :class="activeTab === 'escalations' ? 'border-red-600 text-red-700' : 'border-transparent text-gray-500'" @click="activeTab = 'escalations'">内部升级</button>
      <button class="border-b-2 px-4 py-2.5 text-sm font-medium" :class="activeTab === 'runtime' ? 'border-rose-500 text-rose-700' : 'border-transparent text-gray-500'" @click="activeTab = 'runtime'">运行控制</button>
    </div>

    <template v-if="activeTab === 'reports'">
      <div class="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-3">
        <label class="text-sm text-gray-700">状态
          <select v-model="statusFilter" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-3">
            <option value="open">全部待处理</option><option value="submitted">待分级</option><option value="triaged">已领取</option><option value="investigating">调查中</option><option value="actioned">已处置</option><option value="no_violation">未发现违规</option><option value="closed">已关闭</option><option value="all">全部状态（最多 100 条）</option>
          </select>
        </label>
        <label class="text-sm text-gray-700">优先级
          <select v-model="priorityFilter" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-3">
            <option value="">全部优先级</option><option value="p0">P0</option><option value="p1">P1</option><option value="p2">P2</option><option value="p3">P3</option>
          </select>
        </label>
        <label class="text-sm text-gray-700">目标类型
          <select v-model="targetFilter" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-3">
            <option value="">全部目标</option><option value="person_profile">人物资料</option><option value="media">媒体</option><option value="conversation">话题</option><option value="message">消息</option>
          </select>
        </label>
      </div>

      <div class="grid min-w-0 gap-4 xl:grid-cols-[minmax(19rem,24rem)_minmax(0,1fr)]">
        <section class="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div v-if="listError" class="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ listError }}</div>
          <div v-else-if="reportStatus === 'pending'" class="p-10 text-center text-sm text-gray-500">正在加载举报队列…</div>
          <div v-else-if="!reports.length" class="p-10 text-center text-sm text-gray-500">当前筛选下没有举报。</div>
          <div v-else class="max-h-[48rem] divide-y divide-gray-100 overflow-y-auto">
            <button v-for="report in reports" :key="report.reportId" class="block min-h-28 w-full p-4 text-left hover:bg-gray-50" :class="selectedId === report.reportId ? 'bg-rose-50 ring-1 ring-inset ring-rose-200' : ''" @click="selectedId = report.reportId">
              <span class="flex items-start justify-between gap-3">
                <span class="min-w-0">
                  <span class="block truncate text-sm font-semibold text-gray-950">{{ report.reasonLabel }}</span>
                  <span class="mt-1 block truncate text-xs text-gray-500">{{ targetLabel(report.target.type) }} · {{ report.target.profileId }}</span>
                </span>
                <span class="rounded-full px-2 py-1 text-xs font-semibold ring-1 ring-inset" :class="priorityClass(report.priority)">{{ report.priority.toUpperCase() }}</span>
              </span>
              <span class="mt-3 flex justify-between gap-3 text-xs text-gray-500"><span>{{ assignmentLabel(report.assignment.status) }}</span><span>{{ formatDate(report.submittedAt) }}</span></span>
            </button>
          </div>
        </section>

        <section class="min-h-[42rem] overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div v-if="!selectedSummary" class="grid min-h-[42rem] place-items-center p-8 text-sm text-gray-500">选择一条举报。</div>
          <template v-else>
            <header class="border-b border-gray-200 p-5">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0"><h2 class="text-base font-semibold text-gray-950">{{ selectedSummary.reasonLabel }}</h2><p class="mt-1 break-all text-xs text-gray-500">{{ selectedSummary.reportId }}</p></div>
                <div class="flex gap-2"><span class="rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset" :class="priorityClass(selectedSummary.priority)">{{ selectedSummary.priority.toUpperCase() }}</span><span class="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">{{ targetLabel(selectedSummary.target.type) }}</span></div>
              </div>
            </header>
            <div v-if="operationError" class="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ operationError }}</div>
            <div v-if="detailError" class="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ detailError }} <button class="underline" @click="loadDetail()">重试</button></div>
            <div v-else-if="detailLoading" class="p-10 text-center text-sm text-gray-500">正在读取最小证据并记录审计…</div>
            <div v-else-if="selectedSummary.assignment.status !== 'mine'" class="grid min-h-[34rem] place-items-center p-8 text-center">
              <div class="max-w-md"><h3 class="font-semibold text-gray-950">{{ selectedSummary.assignment.status === 'other' ? '其他审核员正在处理' : '领取后才能查看敏感证据' }}</h3><p class="mt-2 text-sm leading-6 text-gray-600">领取前仅展示目标 ID、原因、优先级和时间，不显示用户说明或消息正文。</p><button v-if="selectedSummary.assignment.canClaim" class="mt-5 min-h-10 rounded-lg bg-rose-500 px-5 text-sm font-medium text-white disabled:opacity-50" :disabled="claiming" @click="claimReport">{{ claiming ? '领取中…' : '领取并查看证据' }}</button></div>
            </div>
            <div v-else-if="detail" class="space-y-5 p-4 sm:p-5">
              <section class="rounded-lg border border-gray-200 p-4"><h3 class="text-sm font-semibold text-gray-950">举报说明</h3><p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-700">{{ detail.description || '用户未填写补充说明。' }}</p></section>
              <section class="rounded-lg border border-gray-200 p-4"><h3 class="text-sm font-semibold text-gray-950">最小证据</h3><dl class="mt-3 grid gap-2 text-xs text-gray-600 sm:grid-cols-2"><div><dt>人物内容版本</dt><dd class="font-medium text-gray-900">{{ detail.evidence.profileContentVersion ?? '—' }}</dd></div><div><dt>公开投影版本</dt><dd class="font-medium text-gray-900">{{ detail.evidence.profileProjectionVersion ?? '—' }}</dd></div><div class="sm:col-span-2"><dt>证据摘要</dt><dd class="break-all font-mono text-[11px] text-gray-700">{{ detail.evidence.evidenceDigest }}</dd></div></dl><div v-if="detail.evidence.messages.length" class="mt-4 space-y-3"><article v-for="message in detail.evidence.messages" :key="message.messageId" class="rounded-lg p-3 ring-1" :class="message.role === 'target' ? 'bg-rose-50 ring-rose-200' : 'bg-gray-50 ring-gray-200'"><div class="flex flex-wrap justify-between gap-2 text-xs text-gray-500"><span>{{ messageRoleLabel(message.role) }} · {{ message.senderType }}</span><span>sequence {{ message.sequence }}</span></div><p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-900">{{ message.text }}</p><p v-if="message.role === 'target'" class="mt-2 text-xs" :class="message.snapshotIntegrityMatches ? 'text-emerald-700' : 'text-red-700'">{{ message.snapshotIntegrityMatches ? '目标正文摘要与提交时证据一致' : '目标正文摘要发生变化，停止处置并复核' }}</p></article></div><p v-else class="mt-3 text-sm text-gray-500">该目标没有消息正文证据。</p></section>
              <form v-if="!['actioned', 'no_violation', 'closed'].includes(detail.status)" class="space-y-4 rounded-lg border border-amber-200 bg-amber-50 p-4" @submit.prevent="submitDecision"><h3 class="text-sm font-semibold text-amber-950">形成审核结论</h3><label class="block text-sm text-gray-700">结论<select v-model="decisionForm.outcome" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3"><option value="no_violation">未发现违规</option><option value="actioned">已采取安全措施</option></select></label><label v-if="decisionForm.outcome === 'actioned'" class="block text-sm text-gray-700">安全动作<select v-model="decisionForm.actionType" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3"><template v-if="detail.target.type === 'conversation' || detail.target.type === 'message'"><option value="conversation_restricted">关联话题转为只读</option><option value="conversation_closed">关闭关联话题</option></template><option v-else value="profile_publication_paused">引用已执行的人物暂停结果</option></select></label><p v-if="decisionForm.actionType === 'profile_publication_paused'" class="text-xs leading-5 text-amber-900">必须先通过既有“人物供给 → 暂停公开”流程完成暂停；本页只验证并引用结果，不创建第二套人物状态。</p><label class="block text-sm text-gray-700">内部原因码<input v-model.trim="decisionForm.decisionReasonCode" pattern="[a-z0-9_]{3,80}" required class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3" /></label><label class="block text-sm text-gray-700">用户可见说明<textarea v-model="decisionForm.userVisibleMessage" maxlength="300" required rows="3" class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2" /></label><button type="submit" class="min-h-10 rounded-lg bg-amber-700 px-5 text-sm font-medium text-white disabled:opacity-50" :disabled="deciding">{{ deciding ? '提交中…' : '确认结论与影响' }}</button></form>
            </div>
          </template>
        </section>
      </div>
    </template>

    <template v-else-if="activeTab === 'escalations'">
      <div class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-950">
        <span class="font-semibold">独立复核：</span>内部升级由当前话题运营发起，但发起人不能领取或审核本人案件。队列列表不返回升级说明或消息正文，P0/P1 也不会绕过人工判断自动处置。
      </div>

      <div class="grid gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:grid-cols-2">
        <label class="text-sm text-gray-700">状态
          <select v-model="escalationStatusFilter" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-3">
            <option value="open">全部待处理</option>
            <option value="submitted">待领取</option>
            <option value="investigating">审核中</option>
            <option value="actioned">已采取安全动作</option>
            <option value="no_action">无需安全动作</option>
            <option value="all">全部状态（最多 100 条）</option>
          </select>
        </label>
        <label class="text-sm text-gray-700">优先级
          <select v-model="escalationPriorityFilter" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-3">
            <option value="">全部优先级</option>
            <option value="p0">P0</option>
            <option value="p1">P1</option>
            <option value="p2">P2</option>
            <option value="p3">P3</option>
          </select>
        </label>
      </div>

      <div class="grid min-w-0 gap-4 xl:grid-cols-[minmax(19rem,24rem)_minmax(0,1fr)]">
        <section class="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div v-if="escalationListError" class="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ escalationListError }}</div>
          <div v-else-if="escalationListLoading" class="p-10 text-center text-sm text-gray-500">正在加载内部升级队列…</div>
          <div v-else-if="!escalations.length" class="p-10 text-center text-sm text-gray-500">当前筛选下没有内部升级案件。</div>
          <div v-else class="max-h-[48rem] divide-y divide-gray-100 overflow-y-auto">
            <button
              v-for="escalation in escalations"
              :key="escalation.escalationId"
              class="block min-h-28 w-full min-w-0 p-4 text-left hover:bg-gray-50"
              :class="selectedEscalationId === escalation.escalationId ? 'bg-red-50 ring-1 ring-inset ring-red-200' : ''"
              @click="selectedEscalationId = escalation.escalationId"
            >
              <span class="flex min-w-0 items-start justify-between gap-3">
                <span class="min-w-0">
                  <span class="block truncate text-sm font-semibold text-gray-950">{{ escalation.reasonLabel }}</span>
                  <span class="mt-1 block truncate text-xs text-gray-500">{{ escalation.profileId }} · {{ escalation.conversationId }}</span>
                </span>
                <span class="rounded-full px-2 py-1 text-xs font-semibold ring-1 ring-inset" :class="priorityClass(escalation.priority)">{{ escalation.priority.toUpperCase() }}</span>
              </span>
              <span class="mt-3 flex min-w-0 items-center justify-between gap-3 text-xs text-gray-500">
                <span class="min-w-0 truncate">{{ escalationStatusLabel(escalation.status) }} · {{ escalation.assignment.isolationBlocked ? '本人发起，需独立复核' : assignmentLabel(escalation.assignment.status) }}</span>
                <span class="shrink-0">{{ formatDate(escalation.createdAt) }}</span>
              </span>
            </button>
          </div>
        </section>

        <section class="min-h-[42rem] overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div v-if="!selectedEscalationSummary" class="grid min-h-[42rem] place-items-center p-8 text-sm text-gray-500">选择一条内部升级案件。</div>
          <template v-else>
            <header class="border-b border-gray-200 p-5">
              <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <h2 class="truncate text-base font-semibold text-gray-950">{{ selectedEscalationSummary.reasonLabel }}</h2>
                  <p class="mt-1 break-all text-xs text-gray-500">{{ selectedEscalationSummary.escalationId }}</p>
                </div>
                <div class="flex flex-wrap gap-2">
                  <span class="rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset" :class="priorityClass(selectedEscalationSummary.priority)">{{ selectedEscalationSummary.priority.toUpperCase() }}</span>
                  <span class="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">{{ escalationStatusLabel(selectedEscalationSummary.status) }}</span>
                </div>
              </div>
            </header>

            <div v-if="escalationOperationError" class="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ escalationOperationError }}</div>
            <div v-if="escalationDetailError" class="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
              {{ escalationDetailError }} <button class="underline" @click="loadEscalationDetail()">重试</button>
            </div>
            <div v-else-if="escalationDetailLoading" class="p-10 text-center text-sm text-gray-500">正在读取内部说明和最小证据并记录审计…</div>
            <div v-else-if="selectedEscalationSummary.assignment.status !== 'mine'" class="grid min-h-[34rem] place-items-center p-8 text-center">
              <div class="max-w-md">
                <h3 class="font-semibold text-gray-950">
                  {{ selectedEscalationSummary.assignment.isolationBlocked ? '你是该案件发起人' : selectedEscalationSummary.assignment.status === 'other' ? '其他审核员正在处理' : '领取后才能查看内部说明与证据' }}
                </h3>
                <p class="mt-2 text-sm leading-6 text-gray-600">
                  {{ selectedEscalationSummary.assignment.isolationBlocked ? '职责分离要求由另一名管理员独立复核；当前仅可查看无正文摘要。' : '领取前只显示稳定原因、优先级、人物和话题 ID。' }}
                </p>
                <button
                  v-if="selectedEscalationSummary.assignment.canClaim"
                  class="mt-5 min-h-10 rounded-lg bg-red-700 px-5 text-sm font-medium text-white disabled:opacity-50"
                  :disabled="escalationClaiming"
                  @click="claimEscalation"
                >
                  {{ escalationClaiming ? '领取中…' : '领取并独立复核' }}
                </button>
              </div>
            </div>
            <div v-else-if="escalationDetail" class="space-y-5 p-4 sm:p-5">
              <section class="rounded-lg border border-red-200 bg-red-50/50 p-4">
                <h3 class="text-sm font-semibold text-red-950">内部升级说明</h3>
                <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">{{ escalationDetail.summaryText }}</p>
              </section>
              <section class="rounded-lg border border-gray-200 p-4">
                <h3 class="text-sm font-semibold text-gray-950">最小消息证据</h3>
                <dl class="mt-3 grid gap-2 text-xs text-gray-600 sm:grid-cols-2">
                  <div><dt>捕获时话题 sequence</dt><dd class="font-medium text-gray-900">{{ escalationDetail.evidence.conversationLastSequence }}</dd></div>
                  <div><dt>目标消息</dt><dd class="font-medium text-gray-900">{{ escalationDetail.evidence.targetMessageId || '整个话题' }}</dd></div>
                  <div class="sm:col-span-2"><dt>证据摘要</dt><dd class="break-all font-mono text-[11px] text-gray-700">{{ escalationDetail.evidence.evidenceDigest }}</dd></div>
                </dl>
                <div v-if="escalationDetail.evidence.messages.length" class="mt-4 space-y-3">
                  <article
                    v-for="message in escalationDetail.evidence.messages"
                    :key="message.messageId"
                    class="rounded-lg p-3 ring-1"
                    :class="message.role === 'target' ? 'bg-red-50 ring-red-200' : 'bg-gray-50 ring-gray-200'"
                  >
                    <div class="flex flex-wrap justify-between gap-2 text-xs text-gray-500"><span>{{ messageRoleLabel(message.role) }} · {{ message.senderType }}</span><span>sequence {{ message.sequence }}</span></div>
                    <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-900">{{ message.text }}</p>
                    <p v-if="message.role === 'target'" class="mt-2 text-xs" :class="message.snapshotIntegrityMatches ? 'text-emerald-700' : 'text-red-700'">{{ message.snapshotIntegrityMatches ? '目标正文摘要与升级时一致' : '目标正文摘要发生变化，停止处置并复核' }}</p>
                  </article>
                </div>
                <p v-else class="mt-3 text-sm text-gray-500">发起人按整个话题升级，没有指定单条消息。</p>
              </section>

              <form v-if="!['actioned', 'no_action'].includes(escalationDetail.status)" class="space-y-4 rounded-lg border border-amber-200 bg-amber-50 p-4" @submit.prevent="submitEscalationDecision">
                <h3 class="text-sm font-semibold text-amber-950">形成独立审核结论</h3>
                <label class="block text-sm text-gray-700">结论
                  <select v-model="escalationDecisionForm.outcome" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3">
                    <option value="no_action">无需安全动作</option>
                    <option value="actioned">采取话题安全动作</option>
                  </select>
                </label>
                <label v-if="escalationDecisionForm.outcome === 'actioned'" class="block text-sm text-gray-700">安全动作
                  <select v-model="escalationDecisionForm.actionType" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3">
                    <option value="conversation_restricted">关联话题转为只读</option>
                    <option value="conversation_closed">关闭关联话题</option>
                  </select>
                </label>
                <label class="block text-sm text-gray-700">内部原因码
                  <input v-model.trim="escalationDecisionForm.decisionReasonCode" pattern="[a-z0-9_]{3,80}" required class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3">
                </label>
                <label class="block text-sm text-gray-700">内部审核说明
                  <textarea v-model="escalationDecisionForm.decisionSummary" maxlength="1000" required rows="4" class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2" placeholder="记录证据判断、结论依据和已执行动作；不会展示给用户。" />
                </label>
                <button type="submit" class="min-h-10 rounded-lg bg-amber-700 px-5 text-sm font-medium text-white disabled:opacity-50" :disabled="escalationDeciding || !escalationDecisionForm.decisionSummary.trim()">{{ escalationDeciding ? '提交中…' : '确认内部结论与影响' }}</button>
              </form>

              <section v-else-if="escalationDetail.decision" class="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                <h3 class="text-sm font-semibold text-emerald-950">已形成内部结论</h3>
                <p class="mt-2 text-sm text-emerald-900">{{ escalationDetail.decision.actionType }} · {{ escalationDetail.decision.reasonCode }}</p>
                <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">{{ escalationDetail.decision.summaryText }}</p>
              </section>
            </div>
          </template>
        </section>
      </div>
    </template>

    <section v-else class="space-y-4 rounded-xl border border-gray-200 bg-white p-5">
      <div><h2 class="text-base font-semibold text-gray-950">全局话题运行控制</h2><p class="mt-1 text-sm leading-6 text-gray-600">历史读取和举报不受暂停影响；开关只阻止后续新建或发送请求。仅 Owner 可以修改。</p></div>
      <div v-if="runtimeError" class="rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ runtimeError }}</div>
      <template v-if="runtimeControl">
        <div class="rounded-lg border p-4 text-sm" :class="runtimeControl.retentionDecisionStatus === 'approved' && runtimeControl.retentionProductionReady ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-950'"><span class="font-semibold">保留策略门禁：</span>{{ runtimeControl.retentionPolicyId }} · {{ runtimeControl.retentionDecisionStatus }} · production-ready={{ runtimeControl.retentionProductionReady }} · purge={{ runtimeControl.purgeEnabled }}。未决状态不得开放生产。</div>
        <form class="grid gap-4 sm:grid-cols-2" @submit.prevent="saveRuntimeControl">
          <label class="flex min-h-12 items-center gap-3 rounded-lg border border-gray-200 p-3"><input v-model="runtimeDraft.newConversationsPaused" type="checkbox" :disabled="!isOwner"><span class="text-sm">暂停新建话题</span></label>
          <label class="flex min-h-12 items-center gap-3 rounded-lg border border-gray-200 p-3"><input v-model="runtimeDraft.viewerSendsPaused" type="checkbox" :disabled="!isOwner"><span class="text-sm">暂停观看者发送</span></label>
          <label class="flex min-h-12 items-center gap-3 rounded-lg border border-gray-200 p-3"><input v-model="runtimeDraft.operatorSendsPaused" type="checkbox" :disabled="!isOwner"><span class="text-sm">暂停运营发送</span></label>
          <label class="text-sm text-gray-700">运行原因码<input v-model.trim="runtimeDraft.reasonCode" pattern="[a-z0-9_]{3,80}" required :disabled="!isOwner" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-3 disabled:bg-gray-100"></label>
          <label class="text-sm text-gray-700">平台最大开放话题数<input v-model.number="runtimeDraft.maxOpenConversations" type="number" min="1" max="100000" required :disabled="!isOwner" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-3 disabled:bg-gray-100"></label>
          <label class="text-sm text-gray-700">每名运营最大活跃领取数<input v-model.number="runtimeDraft.maxActiveAssignmentsPerOperator" type="number" min="1" max="1000" required :disabled="!isOwner" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-3 disabled:bg-gray-100"></label>
          <label class="text-sm text-gray-700">领取租约（分钟）<input v-model.number="runtimeDraft.assignmentLeaseMinutes" type="number" min="5" max="1440" required :disabled="!isOwner" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-3 disabled:bg-gray-100"></label>
          <label class="text-sm text-gray-700 sm:col-span-2">
            用户可见说明
            <textarea
              v-model="runtimeDraft.userVisibleMessage"
              maxlength="300"
              rows="3"
              required
              :disabled="!isOwner"
              class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-100"
            />
          </label>
          <div class="flex flex-wrap items-center justify-between gap-3 sm:col-span-2"><p class="text-xs text-gray-500">当前版本 {{ runtimeControl.version }} · 更新于 {{ formatDate(runtimeControl.updatedAt) }}</p><button v-if="isOwner" type="submit" class="min-h-10 rounded-lg bg-gray-950 px-5 text-sm font-medium text-white disabled:opacity-50" :disabled="runtimeSaving">{{ runtimeSaving ? '保存中…' : '确认更新运行控制' }}</button></div>
        </form>
      </template>
    </section>
  </div>
</template>
