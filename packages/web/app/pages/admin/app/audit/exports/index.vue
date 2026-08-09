<script setup lang="ts">
import {
  adminAuditExportEventLabel,
  adminAuditExportStatusClass,
  adminAuditExportStatusLabel,
  adminAuditPurposeLabel,
  formatAdminAuditFileSize,
  formatAdminAuditTime,
  type AdminAppAuditExportActionScope,
  type AdminAppAuditExportDetail,
  type AdminAppAuditExportRequest,
  type AdminAppAuditExportStatus,
  type AdminAppAuditPurpose,
} from '~/types/admin-app-audit'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const { api, apiResponse } = useApi()
const { isOwner } = useAuth()
const now = new Date()
const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000)

const loading = ref(false)
const detailLoading = ref(false)
const actionLoading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const statusFilter = ref('')
const requests = ref<AdminAppAuditExportRequest[]>([])
const visibility = ref<'all' | 'self'>('self')
const detail = ref<AdminAppAuditExportDetail | null>(null)

const purpose = ref<AdminAppAuditPurpose>('operational_investigation')
const caseReference = ref('')
const requestExplanation = ref('')
const from = ref(toLocalDateTime(sevenDaysAgo))
const to = ref(toLocalDateTime(now))
const action = ref('')
const domain = ref('')
const riskLevel = ref('')
const result = ref('')
const targetType = ref('')
const targetId = ref('')
const actorId = ref('')
const requestIdFilter = ref('')
const traceId = ref('')
const businessReference = ref('')
const showAdvanced = ref(false)

const reviewDecision = ref<'approve' | 'reject'>('approve')
const reviewReasonCode = ref('approved_business_need')
const reviewNote = ref('')

type PendingAction =
  | { type: 'create'; scope: AdminAppAuditExportActionScope }
  | { type: 'review'; scope: AdminAppAuditExportActionScope; request: AdminAppAuditExportRequest }
  | { type: 'download'; scope: AdminAppAuditExportActionScope; request: AdminAppAuditExportRequest }

const pendingAction = ref<PendingAction | null>(null)
const password = ref('')
const passwordError = ref('')
let passwordTrigger: HTMLElement | null = null

const statusOptions: AdminAppAuditExportStatus[] = [
  'pending_review',
  'generating',
  'ready',
  'rejected',
  'scope_changed',
  'failed',
  'expired',
  'revoked',
]

const purposeOptions: AdminAppAuditPurpose[] = [
  'operational_investigation',
  'security_review',
  'financial_reconciliation',
  'compliance_audit',
]

const rejectReasons = [
  { value: 'insufficient_business_need', label: '业务必要性不足' },
  { value: 'scope_too_broad', label: '申请范围过宽' },
  { value: 'wrong_scope', label: '筛选范围错误' },
  { value: 'policy_restriction', label: '策略限制' },
]

watch(reviewDecision, (value) => {
  reviewReasonCode.value = value === 'approve' ? 'approved_business_need' : 'insufficient_business_need'
})

onMounted(() => {
  window.addEventListener('keydown', handlePasswordEscape)
  loadRequests()
})
onBeforeUnmount(() => window.removeEventListener('keydown', handlePasswordEscape))

async function loadRequests() {
  loading.value = true
  errorMessage.value = ''
  try {
    const response = await api<{
      data: { requests: AdminAppAuditExportRequest[]; visibility: 'all' | 'self' }
    }>('/api/admin/app/audit/exports', {
      query: { status: statusFilter.value || undefined, limit: 100 },
    })
    requests.value = response.data.requests
    visibility.value = response.data.visibility
    if (detail.value) {
      const current = requests.value.find(item => item.requestId === detail.value?.request.requestId)
      if (current) detail.value.request = current
    }
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '导出申请列表读取失败')
  }
  finally {
    loading.value = false
  }
}

async function loadDetail(requestId: string) {
  detailLoading.value = true
  errorMessage.value = ''
  try {
    const response = await api<{ data: AdminAppAuditExportDetail }>(
      `/api/admin/app/audit/exports/${encodeURIComponent(requestId)}`,
    )
    detail.value = response.data
    reviewDecision.value = 'approve'
    reviewReasonCode.value = 'approved_business_need'
    reviewNote.value = ''
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '导出申请详情读取失败')
  }
  finally {
    detailLoading.value = false
  }
}

function requestCreate() {
  openPassword({ type: 'create', scope: 'request' })
}

function requestReview(request: AdminAppAuditExportRequest) {
  if (Array.from(reviewNote.value.trim()).length < 2) {
    errorMessage.value = '复核说明至少填写 2 个字符'
    return
  }
  openPassword({ type: 'review', scope: 'review', request })
}

function requestDownload(request: AdminAppAuditExportRequest) {
  openPassword({ type: 'download', scope: 'download_ticket', request })
}

function openPassword(action: PendingAction) {
  passwordTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
  pendingAction.value = action
  password.value = ''
  passwordError.value = ''
  successMessage.value = ''
  nextTick(() => document.querySelector<HTMLInputElement>('[data-audit-step-up-password]')?.focus())
}

function closePassword() {
  if (actionLoading.value) return
  pendingAction.value = null
  password.value = ''
  passwordError.value = ''
  nextTick(() => passwordTrigger?.focus())
}

function handlePasswordEscape(event: KeyboardEvent) {
  if (event.key === 'Escape' && pendingAction.value && !actionLoading.value) closePassword()
}

async function confirmPasswordAndContinue() {
  if (!pendingAction.value) return
  if (!password.value) {
    passwordError.value = '请输入当前账户密码'
    return
  }
  actionLoading.value = true
  passwordError.value = ''
  errorMessage.value = ''
  successMessage.value = ''
  const actionToRun = pendingAction.value
  let passwordVerified = false
  try {
    const stepUp = await api<{
      data: { token: string; actionScope: AdminAppAuditExportActionScope; expiresAt: string }
    }>('/api/admin/app/audit/exports/step-up', {
      method: 'POST',
      body: { password: password.value, actionScope: actionToRun.scope },
    })
    passwordVerified = true
    password.value = ''
    if (actionToRun.type === 'create') await createRequest(stepUp.data.token)
    else if (actionToRun.type === 'review') await reviewRequest(actionToRun.request, stepUp.data.token)
    else await downloadRequest(actionToRun.request, stepUp.data.token)
    pendingAction.value = null
    nextTick(() => passwordTrigger?.focus())
  }
  catch (error) {
    const message = resolveApiErrorMessage(error, '当前操作失败，请核对密码和申请状态')
    if (passwordVerified) {
      pendingAction.value = null
      errorMessage.value = message
      nextTick(() => passwordTrigger?.focus())
    }
    else {
      passwordError.value = message
    }
  }
  finally {
    actionLoading.value = false
  }
}

async function createRequest(stepUpToken: string) {
  const response = await api<{ data: AdminAppAuditExportRequest; replayed: boolean }>(
    '/api/admin/app/audit/exports',
    {
      method: 'POST',
      headers: {
        'Idempotency-Key': createIdempotencyKey('request'),
        'X-Audit-Step-Up': stepUpToken,
      },
      body: {
        purpose: purpose.value,
        caseReference: caseReference.value,
        requestExplanation: requestExplanation.value,
        query: {
          from: new Date(from.value).toISOString(),
          to: new Date(to.value).toISOString(),
          action: optional(action.value),
          domain: optional(domain.value),
          riskLevel: optional(riskLevel.value),
          result: optional(result.value),
          targetType: optional(targetType.value),
          targetId: optional(targetId.value),
          actorId: optional(actorId.value),
          requestId: optional(requestIdFilter.value),
          traceId: optional(traceId.value),
          businessReference: optional(businessReference.value),
        },
      },
    },
  )
  successMessage.value = `导出申请 ${response.data.requestId} 已提交，等待独立 Owner 复核。`
  caseReference.value = ''
  requestExplanation.value = ''
  await loadRequests()
  await loadDetail(response.data.requestId)
}

async function reviewRequest(request: AdminAppAuditExportRequest, stepUpToken: string) {
  const response = await api<{ data: AdminAppAuditExportRequest; replayed: boolean }>(
    `/api/admin/app/audit/exports/${encodeURIComponent(request.requestId)}/review`,
    {
      method: 'POST',
      headers: {
        'Idempotency-Key': createIdempotencyKey('review'),
        'X-Audit-Step-Up': stepUpToken,
      },
      body: {
        expectedVersion: request.version,
        decision: reviewDecision.value,
        reasonCode: reviewReasonCode.value,
        note: reviewNote.value,
      },
    },
  )
  successMessage.value = response.data.status === 'ready'
    ? '独立复核完成，脱敏导出文件已生成。'
    : `复核完成，当前状态：${adminAuditExportStatusLabel(response.data.status)}。`
  await loadRequests()
  await loadDetail(request.requestId)
}

async function downloadRequest(request: AdminAppAuditExportRequest, stepUpToken: string) {
  const issued = await api<{
    data: { token: string; requestId: string; expiresAt: string }
    replayed: boolean
  }>(`/api/admin/app/audit/exports/${encodeURIComponent(request.requestId)}/download-tickets`, {
    method: 'POST',
    headers: {
      'Idempotency-Key': createIdempotencyKey('ticket'),
      'X-Audit-Step-Up': stepUpToken,
    },
  })
  const response = await apiResponse('/api/admin/app/audit/exports/download', {
    method: 'POST',
    headers: { 'X-Audit-Download-Ticket': issued.data.token },
  })
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `meigallery-audit-${request.requestId}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
  successMessage.value = '文件已通过一次性票据下载；该票据不能再次使用。'
  await loadRequests()
  await loadDetail(request.requestId)
}

function optional(value: string) {
  const normalized = value.trim()
  return normalized || undefined
}

function createIdempotencyKey(kind: string) {
  return `${kind}:${crypto.randomUUID()}`
}

function toLocalDateTime(value: Date) {
  const offset = value.getTimezoneOffset() * 60_000
  return new Date(value.getTime() - offset).toISOString().slice(0, 16)
}

function shortDigest(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-8)}`
}

function summaryEntries(summary: Record<string, unknown>) {
  return Object.entries(summary).filter(([, value]) => value !== null && value !== undefined)
}
</script>

<template>
  <div class="mx-auto w-full max-w-[1500px] space-y-6 p-4 sm:p-6">
    <header class="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <NuxtLink to="/admin/app/audit" class="font-medium text-gray-600 hover:text-gray-950">← 返回审计查询</NuxtLink>
          <NuxtLink to="/admin/app/audit/integrity" class="font-medium text-gray-600 hover:text-gray-950">完整性检查</NuxtLink>
        </div>
        <h1 class="mt-3 text-2xl font-semibold text-gray-950">受控审计导出</h1>
        <p class="mt-2 max-w-3xl text-sm leading-6 text-gray-600">先冻结可见范围，再由不同的 Owner 独立复核。文件只保存在私有 R2，申请人重新验证密码后才能取得五分钟内有效的一次性下载票据。</p>
      </div>
      <div class="grid shrink-0 gap-2 text-xs sm:grid-cols-3 xl:w-[470px]">
        <div class="rounded-xl border border-blue-200 bg-blue-50 p-3 text-blue-900"><strong class="block">1. 强认证</strong><span class="mt-1 block leading-5">申请、复核、下载分别验证密码</span></div>
        <div class="rounded-xl border border-violet-200 bg-violet-50 p-3 text-violet-900"><strong class="block">2. 独立复核</strong><span class="mt-1 block leading-5">申请人不能审批自己的申请</span></div>
        <div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-900"><strong class="block">3. 私有交付</strong><span class="mt-1 block leading-5">无公开 URL，票据消费后失效</span></div>
      </div>
    </header>

    <p v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ errorMessage }}</p>
    <p v-if="successMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-800">{{ successMessage }}</p>

    <section class="rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-gray-950">新建导出申请</h2>
          <p class="mt-1 text-xs leading-5 text-gray-500">普通管理员只能冻结本人操作；Owner 可按条件冻结全部管理员操作。单次最多 31 天、5,000 条、25 MB。</p>
        </div>
        <span class="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-700">当前可见：{{ visibility === 'all' ? '全部管理员' : '仅本人' }}</span>
      </div>

      <form class="mt-5 space-y-4" @submit.prevent="requestCreate">
        <div class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label class="min-w-0 text-sm text-gray-700">审计用途
            <select v-model="purpose" required class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
              <option v-for="item in purposeOptions" :key="item" :value="item">{{ adminAuditPurposeLabel(item) }}</option>
            </select>
          </label>
          <label class="min-w-0 text-sm text-gray-700">案件 / 工单号
            <input v-model="caseReference" required minlength="3" maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{2,99}" placeholder="例如 SEC-2026-0810" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" />
          </label>
          <label class="min-w-0 text-sm text-gray-700">开始时间
            <input v-model="from" type="datetime-local" required class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" />
          </label>
          <label class="min-w-0 text-sm text-gray-700">结束时间
            <input v-model="to" type="datetime-local" required class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" />
          </label>
        </div>

        <label class="block min-w-0 text-sm text-gray-700">申请说明
          <textarea v-model="requestExplanation" required minlength="10" maxlength="500" rows="3" placeholder="说明为什么必须导出、使用范围、接收人和后续处置方式。" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 leading-6" />
        </label>

        <div class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label class="min-w-0 text-sm text-gray-700">业务域
            <input v-model="domain" maxlength="48" placeholder="例如 wallet" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" />
          </label>
          <label class="min-w-0 text-sm text-gray-700">操作 action
            <input v-model="action" maxlength="128" placeholder="例如 app.wallet.adjust" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" />
          </label>
          <label class="min-w-0 text-sm text-gray-700">风险等级
            <select v-model="riskLevel" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
              <option value="">全部风险</option><option value="critical">关键</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option>
            </select>
          </label>
          <label class="min-w-0 text-sm text-gray-700">执行结果
            <select v-model="result" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
              <option value="">全部结果</option><option value="succeeded">成功</option><option value="denied">拒绝</option><option value="failed">失败</option>
            </select>
          </label>
        </div>

        <button type="button" class="text-sm font-medium text-gray-700 underline underline-offset-4" @click="showAdvanced = !showAdvanced">{{ showAdvanced ? '收起精确筛选' : '展开精确筛选' }}</button>
        <div v-if="showAdvanced" class="grid min-w-0 gap-3 rounded-xl bg-gray-50 p-3 md:grid-cols-2 xl:grid-cols-3">
          <label class="min-w-0 text-sm text-gray-700">目标类型<input v-model="targetType" maxlength="96" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" /></label>
          <label class="min-w-0 text-sm text-gray-700">目标 ID<input v-model="targetId" maxlength="192" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" /></label>
          <label v-if="isOwner" class="min-w-0 text-sm text-gray-700">操作者数字 ID<input v-model="actorId" inputmode="numeric" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" /></label>
          <label class="min-w-0 text-sm text-gray-700">业务单号<input v-model="businessReference" maxlength="192" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" /></label>
          <label class="min-w-0 text-sm text-gray-700">Request ID<input v-model="requestIdFilter" maxlength="192" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" /></label>
          <label class="min-w-0 text-sm text-gray-700">Trace ID<input v-model="traceId" maxlength="192" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" /></label>
        </div>

        <button type="submit" :disabled="actionLoading" class="inline-flex min-h-11 items-center justify-center rounded-lg bg-gray-950 px-5 text-sm font-medium text-white hover:bg-black disabled:opacity-50">提交并验证密码</button>
      </form>
    </section>

    <div class="grid min-w-0 gap-6 2xl:grid-cols-[minmax(420px,0.85fr)_minmax(0,1.5fr)]">
      <section class="min-w-0 overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-4">
          <div><h2 class="text-base font-semibold text-gray-950">申请队列</h2><p class="mt-1 text-xs text-gray-500">{{ requests.length }} 条可见申请</p></div>
          <select v-model="statusFilter" class="min-h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm" @change="loadRequests">
            <option value="">全部状态</option>
            <option v-for="item in statusOptions" :key="item" :value="item">{{ adminAuditExportStatusLabel(item) }}</option>
          </select>
        </div>
        <p v-if="loading" class="p-10 text-center text-sm text-gray-500">正在读取申请队列…</p>
        <div v-else-if="requests.length" class="divide-y divide-gray-100">
          <button v-for="item in requests" :key="item.requestId" type="button" class="block w-full min-w-0 p-4 text-left hover:bg-gray-50" :class="detail?.request.requestId === item.requestId ? 'bg-blue-50/60' : ''" @click="loadDetail(item.requestId)">
            <div class="flex min-w-0 items-start justify-between gap-3">
              <div class="min-w-0"><p class="truncate font-mono text-xs font-semibold text-gray-900">{{ item.requestId }}</p><p class="mt-1 truncate text-sm font-medium text-gray-950">{{ item.caseReference }} · {{ adminAuditPurposeLabel(item.purpose) }}</p></div>
              <span class="shrink-0 rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="adminAuditExportStatusClass(item.status)">{{ adminAuditExportStatusLabel(item.status) }}</span>
            </div>
            <p class="mt-2 line-clamp-2 text-xs leading-5 text-gray-600">{{ item.requestExplanation }}</p>
            <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-500"><span>{{ item.requester.label }}</span><span>{{ item.scope.eventCount }} 条</span><span>{{ formatAdminAuditTime(item.requestedAt) }}</span></div>
          </button>
        </div>
        <p v-else class="p-10 text-center text-sm text-gray-500">当前筛选下没有申请</p>
      </section>

      <section class="min-w-0">
        <p v-if="detailLoading" class="rounded-2xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">正在读取申请详情…</p>
        <div v-else-if="detail" class="space-y-5">
          <article class="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
            <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div class="min-w-0"><p class="break-all font-mono text-xs text-gray-500">{{ detail.request.requestId }}</p><h2 class="mt-1 break-words text-lg font-semibold text-gray-950">{{ detail.request.caseReference }}</h2><p class="mt-2 text-sm leading-6 text-gray-600">{{ detail.request.requestExplanation }}</p></div>
              <span class="rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset" :class="adminAuditExportStatusClass(detail.request.status)">{{ adminAuditExportStatusLabel(detail.request.status) }}</span>
            </div>

            <dl class="mt-5 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div class="rounded-xl bg-gray-50 p-3"><dt class="text-xs text-gray-500">申请人</dt><dd class="mt-1 break-words text-sm font-medium text-gray-900">{{ detail.request.requester.label }} · #{{ detail.request.requester.id }}</dd></div>
              <div class="rounded-xl bg-gray-50 p-3"><dt class="text-xs text-gray-500">用途 / 版本</dt><dd class="mt-1 text-sm font-medium text-gray-900">{{ adminAuditPurposeLabel(detail.request.purpose) }} · v{{ detail.request.version }}</dd></div>
              <div class="rounded-xl bg-gray-50 p-3"><dt class="text-xs text-gray-500">事件范围</dt><dd class="mt-1 text-sm font-medium text-gray-900">{{ detail.request.scope.eventCount }} 条 · #{{ detail.request.scope.firstSequence }}–#{{ detail.request.scope.lastSequence }}</dd></div>
              <div class="rounded-xl bg-gray-50 p-3"><dt class="text-xs text-gray-500">时间范围</dt><dd class="mt-1 text-xs leading-5 text-gray-900">{{ formatAdminAuditTime(detail.request.range.from) }}<br />至 {{ formatAdminAuditTime(detail.request.range.to) }}</dd></div>
            </dl>

            <div class="mt-4 grid min-w-0 gap-3 xl:grid-cols-2">
              <div class="min-w-0 rounded-xl border border-gray-200 p-3"><p class="text-xs font-medium text-gray-500">范围摘要 SHA-256</p><p class="mt-1 break-all font-mono text-xs text-gray-800" :title="detail.request.scope.digest">{{ shortDigest(detail.request.scope.digest) }}</p><p class="mt-2 text-[11px] text-gray-500">复核与下载签发前都会重新计算，任一事件或授权变化都会使文件失效。</p></div>
              <div class="min-w-0 rounded-xl border border-gray-200 p-3"><p class="text-xs font-medium text-gray-500">实际筛选</p><div class="mt-2 flex flex-wrap gap-1.5 text-[11px]"><span v-for="(value, key) in detail.request.scope.query" v-show="value !== null" :key="key" class="max-w-full break-all rounded bg-gray-100 px-2 py-1 text-gray-700">{{ key }}={{ value }}</span></div></div>
            </div>

            <div v-if="detail.request.review" class="mt-4 rounded-xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-950"><p class="font-medium">独立复核：{{ detail.request.review.decision === 'approve' ? '通过' : '驳回' }}</p><p class="mt-1 leading-6">{{ detail.request.review.note }}</p><p class="mt-2 text-xs text-violet-700">{{ detail.request.review.reviewer.label }} · {{ formatAdminAuditTime(detail.request.review.reviewedAt) }} · {{ detail.request.review.reasonCode }}</p></div>

            <div v-if="detail.request.file" class="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <div class="flex flex-wrap items-start justify-between gap-3"><div><p class="text-sm font-medium text-emerald-950">脱敏 CSV 文件</p><p class="mt-1 text-xs leading-5 text-emerald-800">{{ detail.request.file.rowCount }} 行 · {{ formatAdminAuditFileSize(detail.request.file.size) }} · {{ formatAdminAuditTime(detail.request.file.generatedAt) }}</p><p class="mt-1 break-all font-mono text-[11px] text-emerald-700">SHA-256 {{ shortDigest(detail.request.file.sha256) }}</p><p class="mt-1 text-xs text-emerald-800">有效至 {{ formatAdminAuditTime(detail.request.file.expiresAt) }}</p></div><button v-if="detail.request.canDownload" type="button" :disabled="actionLoading" class="inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-700 px-4 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50" @click="requestDownload(detail.request)">验证密码并下载</button></div>
            </div>
            <p v-if="detail.request.failureCode" class="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">终止代码：<span class="font-mono">{{ detail.request.failureCode }}</span></p>
          </article>

          <article v-if="detail.request.canReview" class="rounded-2xl border border-blue-200 bg-blue-50 p-4 sm:p-5">
            <h3 class="text-base font-semibold text-blue-950">Owner 独立复核</h3>
            <p class="mt-1 text-xs leading-5 text-blue-800">通过时服务端会按申请人的当前权限重新计算精确事件集合。范围不同不会继续生成，而会进入“范围已变化”。</p>
            <div class="mt-4 grid gap-3 md:grid-cols-2">
              <label class="text-sm text-blue-950">复核结论<select v-model="reviewDecision" class="mt-1 min-h-11 w-full rounded-lg border border-blue-300 bg-white px-3"><option value="approve">通过并生成脱敏文件</option><option value="reject">驳回申请</option></select></label>
              <label class="text-sm text-blue-950">原因代码<select v-model="reviewReasonCode" class="mt-1 min-h-11 w-full rounded-lg border border-blue-300 bg-white px-3"><option v-if="reviewDecision === 'approve'" value="approved_business_need">业务必要性已确认</option><option v-for="item in reviewDecision === 'reject' ? rejectReasons : []" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
            </div>
            <label class="mt-3 block text-sm text-blue-950">复核说明<textarea v-model="reviewNote" required minlength="2" maxlength="500" rows="3" class="mt-1 w-full rounded-lg border border-blue-300 px-3 py-2 leading-6" placeholder="记录判断依据；该说明只对授权后台人员可见。" /></label>
            <button type="button" :disabled="actionLoading" class="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg bg-blue-800 px-5 text-sm font-medium text-white hover:bg-blue-900 disabled:opacity-50" @click="requestReview(detail.request)">提交复核并验证密码</button>
          </article>

          <article class="rounded-2xl border border-gray-200 bg-white p-4 sm:p-5">
            <h3 class="text-base font-semibold text-gray-950">不可变流程时间线</h3>
            <ol class="mt-4 space-y-3">
              <li v-for="event in detail.timeline" :key="event.eventId" class="grid min-w-0 grid-cols-[32px_minmax(0,1fr)] gap-3">
                <span class="flex h-8 w-8 items-center justify-center rounded-full bg-gray-950 text-xs font-semibold text-white">{{ event.sequence }}</span>
                <div class="min-w-0 rounded-xl bg-gray-50 p-3"><div class="flex flex-wrap items-start justify-between gap-2"><p class="text-sm font-medium text-gray-950">{{ adminAuditExportEventLabel(event.eventType) }}</p><time class="text-xs text-gray-500">{{ formatAdminAuditTime(event.createdAt) }}</time></div><p class="mt-1 text-xs text-gray-600">{{ event.actor?.label || '系统' }} · {{ event.resultCode }}</p><div v-if="summaryEntries(event.summary).length" class="mt-2 flex flex-wrap gap-1.5"><span v-for="([key, value]) in summaryEntries(event.summary)" :key="key" class="max-w-full break-all rounded bg-white px-2 py-1 font-mono text-[10px] text-gray-600">{{ key }}={{ value }}</span></div></div>
              </li>
            </ol>
          </article>
        </div>
        <div v-else class="rounded-2xl border border-dashed border-gray-300 bg-white p-12 text-center"><p class="text-sm font-medium text-gray-700">选择一条申请查看范围、复核、文件和完整时间线</p></div>
      </section>
    </div>

    <Teleport to="body">
      <div v-if="pendingAction" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" role="presentation" @click.self="closePassword">
        <form class="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="audit-step-up-title" @submit.prevent="confirmPasswordAndContinue">
          <h2 id="audit-step-up-title" class="text-lg font-semibold text-gray-950">重新验证当前账户</h2>
          <p class="mt-2 text-sm leading-6 text-gray-600">{{ pendingAction.type === 'create' ? '提交受控导出申请' : pendingAction.type === 'review' ? '执行独立复核并可能生成文件' : '签发一次性下载票据' }}属于高风险操作。密码不会写入日志或数据库。</p>
          <label class="mt-4 block text-sm text-gray-700">当前账户密码<input v-model="password" data-audit-step-up-password type="password" autocomplete="current-password" required maxlength="256" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3" /></label>
          <p v-if="passwordError" class="mt-3 rounded-lg bg-red-50 p-3 text-sm leading-5 text-red-700">{{ passwordError }}</p>
          <div class="mt-5 flex flex-wrap justify-end gap-2"><button type="button" :disabled="actionLoading" class="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 disabled:opacity-50" @click="closePassword">取消</button><button type="submit" :disabled="actionLoading" class="min-h-11 rounded-lg bg-gray-950 px-5 text-sm font-medium text-white disabled:opacity-50">{{ actionLoading ? '正在安全处理…' : '验证并继续' }}</button></div>
        </form>
      </div>
    </Teleport>
  </div>
</template>
