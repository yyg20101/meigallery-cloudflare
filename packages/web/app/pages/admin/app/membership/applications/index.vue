<script setup lang="ts">
definePageMeta({ layout: 'admin' })

type ApplicationStatus = 'submitted' | 'processing' | 'needs_information' | 'approved' | 'rejected' | 'cancelled' | 'expired'

interface MembershipTierSummary {
  tierId: string
  code: string
  displayName: string
  rank: number
  accentToken: string
}

interface MembershipApplication {
  applicationId: string
  catalogVersionId: string
  intendedTier: MembershipTierSummary
  contact: { method: 'verified_email'; maskedValue: string }
  preferredContactWindow: 'anytime' | 'morning' | 'afternoon' | 'evening'
  statement: string | null
  disclosureVersion: string
  status: ApplicationStatus
  statusMessage: string
  version: number
  canCancel: boolean
  canResubmit: boolean
  grantId: string | null
  submittedAt: string
  updatedAt: string
  resolvedAt: string | null
  timeline: Array<{ sequence: number; status: ApplicationStatus; message: string; createdAt: string }>
}

interface ApplicationView {
  application: MembershipApplication
  account: {
    userId: number
    accountId: string | null
    email: string
    emailMasked: string
    status: string
  }
  assignedTo: number | null
  currentMembership: {
    status: 'free' | 'active'
    tier: MembershipTierSummary | null
    grant: { expiresAt: string } | null
  }
  grantReview: null | {
    requestId: string
    status: 'pending_review' | 'executing' | 'approved' | 'rejected' | 'stale' | 'cancelled'
    version: number
    requestedBy: number
    createdAt: string
    reviewedAt: string | null
  }
}

interface MembershipCatalog {
  catalogVersionId: string
  productionReady: boolean
  state: string
  tiers: MembershipTierSummary[]
}

const { api } = useApi()
const toast = useToast()
const statusFilter = ref('submitted')
const tierFilter = ref('')
const selectedId = ref<string | null>(null)
const detail = ref<ApplicationView | null>(null)
const listError = ref('')
const detailError = ref('')
const operationError = ref('')
const detailLoading = ref(false)
const operating = ref(false)
const approvalIdempotencyKey = ref('')

const actionMode = ref<'request-information' | 'reject' | 'expire' | 'cancel' | 'approve'>('request-information')
const actionModes = [
  { value: 'request-information', label: '要求补充' },
  { value: 'reject', label: '拒绝' },
  { value: 'expire', label: '标记过期' },
  { value: 'cancel', label: '平台取消' },
  { value: 'approve', label: '提交发放复核' },
] as const
const reasonOptions = computed(() => {
  if (actionMode.value === 'request-information') {
    return [
      { value: 'contact_window', label: '联系时段需要确认' },
      { value: 'application_statement', label: '申请说明需要补充' },
      { value: 'account_confirmation', label: '账号信息需要确认' },
      { value: 'other', label: '其他补充项' },
    ]
  }
  if (actionMode.value === 'reject') {
    return [
      { value: 'requirements_not_met', label: '暂未满足服务条件' },
      { value: 'tier_unavailable', label: '意向等级当前不可用' },
      { value: 'account_restricted', label: '账号状态受限' },
      { value: 'unable_to_verify', label: '信息无法核验' },
      { value: 'other', label: '其他原因' },
    ]
  }
  if (actionMode.value === 'expire') {
    return [
      { value: 'application_stale', label: '申请长期未完成' },
      { value: 'other', label: '其他原因' },
    ]
  }
  return [{ value: 'other', label: '平台取消' }]
})
const actionForm = reactive({
  reasonCode: 'application_statement',
  message: '请补充希望使用的主要会员服务。',
  durationDays: 30,
  userVisibleNote: '会员申请审核通过，会员权益已由平台正式发放。',
  internalNote: '',
})

const { data: catalogData } = await useAsyncData('admin-app-membership-catalog', async () => {
  try {
    return await api<{ data: MembershipCatalog }>('/api/admin/app/memberships/catalog')
  }
  catch (error) {
    listError.value = apiErrorMessage(error, 'App 会员管理当前不可用。')
    return null
  }
})

const { data: applicationData, status: listStatus, refresh: refreshList } = await useAsyncData(
  'admin-app-membership-applications',
  async () => {
    listError.value = ''
    try {
      return await api<{ data: ApplicationView[] }>('/api/admin/app/memberships/applications', {
        query: {
          status: statusFilter.value || undefined,
          tierId: tierFilter.value || undefined,
          limit: 30,
        },
      })
    }
    catch (error) {
      listError.value = apiErrorMessage(error, '会员申请队列加载失败。')
      return { data: [] }
    }
  },
  { watch: [statusFilter, tierFilter] },
)

const catalog = computed(() => catalogData.value?.data ?? null)
const applications = computed(() => applicationData.value?.data ?? [])

watch(applications, (items) => {
  if (selectedId.value && items.some(item => item.application.applicationId === selectedId.value)) return
  selectedId.value = items[0]?.application.applicationId ?? null
}, { immediate: true })

watch(selectedId, async (id) => {
  detail.value = null
  detailError.value = ''
  operationError.value = ''
  approvalIdempotencyKey.value = ''
  if (id) await loadDetail(id)
})

watch(actionMode, (mode) => {
  if (mode === 'request-information') {
    actionForm.reasonCode = 'application_statement'
    actionForm.message = '请补充希望使用的主要会员服务。'
  }
  else if (mode === 'reject') {
    actionForm.reasonCode = 'requirements_not_met'
    actionForm.message = '本次申请暂未满足会员服务条件，你可以核对说明后重新申请。'
  }
  else if (mode === 'expire') {
    actionForm.reasonCode = 'application_stale'
    actionForm.message = '本次申请因长期未完成处理已过期，你可以重新提交。'
  }
  else if (mode === 'cancel') {
    actionForm.reasonCode = 'other'
    actionForm.message = '平台已取消本次申请；如有需要，你可以重新提交。'
  }
})

async function loadDetail(id = selectedId.value) {
  if (!id) return
  detailLoading.value = true
  detailError.value = ''
  try {
    const response = await api<{ data: ApplicationView }>(`/api/admin/app/memberships/applications/${id}`)
    if (selectedId.value === id) detail.value = response.data
  }
  catch (error) {
    detailError.value = apiErrorMessage(error, '会员申请详情加载失败。')
  }
  finally {
    detailLoading.value = false
  }
}

async function refreshCurrent() {
  const id = selectedId.value
  await refreshList()
  if (id) await loadDetail(id)
}

async function showMutationResult(applicationId: string, status: ApplicationStatus) {
  statusFilter.value = status
  await refreshList()
  selectedId.value = applicationId
  await loadDetail(applicationId)
}

async function claimApplication() {
  const current = detail.value
  if (!current || operating.value) return
  if (!window.confirm('确认领取该会员申请？领取后只有你可以继续本轮处理和发放。')) return
  operating.value = true
  operationError.value = ''
  try {
    await api(`/api/admin/app/memberships/applications/${current.application.applicationId}/claim`, {
      method: 'POST',
      body: { expectedVersion: current.application.version },
    })
    await showMutationResult(current.application.applicationId, 'processing')
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '申请领取失败，请刷新版本后重试。')
  }
  finally {
    operating.value = false
  }
}

async function submitTransition() {
  const current = detail.value
  if (!current || operating.value || actionMode.value === 'approve') return
  if (!actionForm.message.trim()) {
    operationError.value = '必须填写用户可见说明。'
    return
  }
  const label = actionMode.value === 'request-information'
    ? '要求用户补充信息'
    : actionMode.value === 'reject'
      ? '拒绝该申请'
      : actionMode.value === 'expire'
        ? '将申请标记为过期'
        : '由平台取消申请'
  if (!window.confirm(`确认${label}？用户将立即看到当前说明，操作会写入审计日志。`)) return
  operating.value = true
  operationError.value = ''
  try {
    await api(`/api/admin/app/memberships/applications/${current.application.applicationId}/${actionMode.value}`, {
      method: 'POST',
      body: {
        expectedVersion: current.application.version,
        reasonCode: actionForm.reasonCode,
        message: actionForm.message.trim(),
      },
    })
    const targetStatus: ApplicationStatus = actionMode.value === 'request-information'
      ? 'needs_information'
      : actionMode.value === 'reject'
        ? 'rejected'
        : actionMode.value === 'expire'
          ? 'expired'
          : 'cancelled'
    await showMutationResult(current.application.applicationId, targetStatus)
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '申请状态更新失败，请刷新后重试。')
  }
  finally {
    operating.value = false
  }
}

async function approveApplication() {
  const current = detail.value
  if (!current || operating.value) return
  if (!catalog.value || current.application.catalogVersionId !== catalog.value.catalogVersionId) {
    operationError.value = '该申请来自旧目录版本，不能直接发放；请结束旧申请并让用户按当前目录重新提交。'
    return
  }
  if (!Number.isInteger(actionForm.durationDays) || actionForm.durationDays < 1 || actionForm.durationDays > 366) {
    operationError.value = '有效期必须为 1–366 天。'
    return
  }
  if (!window.confirm(`确认把 ${current.application.intendedTier.displayName} 会员 ${actionForm.durationDays} 天的发放方案提交独立复核？提交后不会立即产生会员权限。`)) return
  operating.value = true
  operationError.value = ''
  if (!approvalIdempotencyKey.value) {
    approvalIdempotencyKey.value = `membership.application.approve.${crypto.randomUUID().replaceAll('-', '')}`
  }
  try {
    const response = await api<{ message: string; data: { review: { requestId: string } } }>(`/api/admin/app/memberships/applications/${current.application.applicationId}/approve`, {
      method: 'POST',
      headers: { 'Idempotency-Key': approvalIdempotencyKey.value },
      body: {
        expectedVersion: current.application.version,
        durationDays: actionForm.durationDays,
        userVisibleNote: actionForm.userVisibleNote.trim(),
        internalNote: actionForm.internalNote.trim() || undefined,
      },
    })
    approvalIdempotencyKey.value = ''
    toast.add({ title: response.message, color: 'success' })
    await showMutationResult(current.application.applicationId, 'processing')
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '发放复核提交失败；请保留当前页面并按提示安全重试。')
  }
  finally {
    operating.value = false
  }
}

function statusLabel(status: ApplicationStatus) {
  const labels: Record<ApplicationStatus, string> = {
    submitted: '待处理', processing: '处理中', needs_information: '待补充', approved: '已发放',
    rejected: '已拒绝', cancelled: '已取消', expired: '已过期',
  }
  return labels[status]
}

function statusClass(status: ApplicationStatus) {
  if (status === 'approved') return 'bg-green-100 text-green-800'
  if (status === 'rejected' || status === 'expired') return 'bg-red-100 text-red-800'
  if (status === 'processing') return 'bg-blue-100 text-blue-800'
  if (status === 'needs_information') return 'bg-amber-100 text-amber-800'
  return 'bg-gray-100 text-gray-700'
}

function contactWindowLabel(value: MembershipApplication['preferredContactWindow']) {
  return { anytime: '时间不限', morning: '上午', afternoon: '下午', evening: '晚间' }[value]
}

function formatDate(value: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function apiErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object') return fallback
  const candidate = error as { data?: { message?: unknown }; message?: unknown }
  if (typeof candidate.data?.message === 'string') return candidate.data.message
  if (typeof candidate.message === 'string' && candidate.message.length < 180) return candidate.message
  return fallback
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-MBR-03" route="/admin/app/membership/applications" title="会员申请与发放队列" description="处理用户申请、搜索账号并查看发放时间线；批准后仍进入独立复核。" :state="listError ? '加载失败' : listStatus === 'pending' ? '加载中' : '待处理'" figma-state="待处理" :state-tone="listError ? 'danger' : listStatus === 'pending' ? 'warning' : 'success'">
      <template #actions>
        <span v-if="catalog" class="rounded-full px-3 py-1 text-xs font-medium" :class="catalog.productionReady ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'">
          {{ catalog.productionReady ? '生产目录' : '开发目录 · 禁止上线' }}
        </span>
        <NuxtLink to="/admin/app/membership/reviews" class="inline-flex min-h-10 items-center rounded-lg border border-violet-200 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-800 hover:bg-violet-100">独立复核队列</NuxtLink>
        <NuxtLink to="/admin/app/membership/grants/new" class="inline-flex min-h-10 items-center rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-black">创建会员变更</NuxtLink>
      </template>
    </AdminAppPageHeader>

    <div class="flex flex-wrap gap-3 rounded-xl border border-gray-200 bg-white p-4">
      <select v-model="statusFilter" class="min-w-36 rounded-lg border border-gray-300 px-3 py-2 text-sm">
        <option value="">全部状态</option>
        <option value="submitted">待处理</option>
        <option value="processing">处理中</option>
        <option value="needs_information">待补充</option>
        <option value="approved">已发放</option>
        <option value="rejected">已拒绝</option>
        <option value="cancelled">已取消</option>
        <option value="expired">已过期</option>
      </select>
      <select v-model="tierFilter" class="min-w-36 rounded-lg border border-gray-300 px-3 py-2 text-sm">
        <option value="">全部意向等级</option>
        <option v-for="tier in catalog?.tiers ?? []" :key="tier.tierId" :value="tier.tierId">{{ tier.displayName }} · Rank {{ tier.rank }}</option>
      </select>
      <button class="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50" @click="refreshCurrent">刷新队列</button>
    </div>

    <p v-if="listError" class="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{{ listError }}</p>

    <div class="grid min-w-0 gap-5 xl:grid-cols-[minmax(300px,0.85fr)_minmax(440px,1.4fr)]">
      <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div class="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900">申请队列 · {{ applications.length }}</div>
        <div v-if="listStatus === 'pending'" class="p-8 text-center text-sm text-gray-400">正在加载申请队列…</div>
        <button
          v-for="item in applications"
          :key="item.application.applicationId"
          class="block w-full min-w-0 border-b border-gray-100 p-4 text-left last:border-b-0 hover:bg-gray-50"
          :class="selectedId === item.application.applicationId ? 'bg-rose-50' : ''"
          @click="selectedId = item.application.applicationId"
        >
          <div class="flex min-w-0 items-center justify-between gap-2">
            <span class="truncate text-sm font-semibold text-gray-900">{{ item.application.intendedTier.displayName }} · {{ item.account.emailMasked }}</span>
            <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" :class="statusClass(item.application.status)">{{ statusLabel(item.application.status) }}</span>
          </div>
          <p class="mt-2 truncate font-mono text-[11px] text-gray-500">{{ item.application.applicationId }}</p>
          <div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
            <span>{{ formatDate(item.application.submittedAt) }}</span>
            <span>{{ item.assignedTo ? `处理人 #${item.assignedTo}` : '未领取' }}</span>
          </div>
        </button>
        <p v-if="listStatus !== 'pending' && applications.length === 0" class="p-8 text-center text-sm text-gray-400">当前筛选下没有会员申请</p>
      </section>

      <section class="min-w-0 space-y-4">
        <p v-if="detailLoading" class="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">正在加载申请详情…</p>
        <p v-else-if="detailError" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{{ detailError }}</p>
        <template v-else-if="detail">
          <div class="rounded-xl border border-gray-200 bg-white p-5">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="statusClass(detail.application.status)">{{ statusLabel(detail.application.status) }}</span>
                <h2 class="mt-3 text-lg font-bold text-gray-900">{{ detail.application.intendedTier.displayName }} · Rank {{ detail.application.intendedTier.rank }}</h2>
                <p class="mt-1 break-all font-mono text-xs text-gray-500">{{ detail.application.applicationId }} · v{{ detail.application.version }}</p>
              </div>
              <button v-if="detail.application.status === 'submitted'" :disabled="operating" class="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50" @click="claimApplication">领取申请</button>
            </div>
            <p class="mt-4 rounded-lg bg-rose-50 p-3 text-sm leading-6 text-rose-900">{{ detail.application.statusMessage }}</p>
            <dl class="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt class="text-gray-500">账号</dt><dd class="mt-1 break-all text-gray-900">{{ detail.account.email }}</dd></div>
              <div><dt class="text-gray-500">账号 ID</dt><dd class="mt-1 font-mono text-xs text-gray-900">{{ detail.account.accountId ?? detail.account.userId }}</dd></div>
              <div><dt class="text-gray-500">联系偏好</dt><dd class="mt-1 text-gray-900">已验证邮箱 · {{ contactWindowLabel(detail.application.preferredContactWindow) }}</dd></div>
              <div><dt class="text-gray-500">当前会员</dt><dd class="mt-1 text-gray-900">{{ detail.currentMembership.tier?.displayName ?? '普通用户' }}</dd></div>
              <div><dt class="text-gray-500">处理人</dt><dd class="mt-1 text-gray-900">{{ detail.assignedTo ? `管理员 #${detail.assignedTo}` : '未领取' }}</dd></div>
              <div><dt class="text-gray-500">提交时间</dt><dd class="mt-1 text-gray-900">{{ formatDate(detail.application.submittedAt) }}</dd></div>
              <div><dt class="text-gray-500">申请目录版本</dt><dd class="mt-1 break-all font-mono text-xs text-gray-900">{{ detail.application.catalogVersionId }}</dd></div>
            </dl>
            <div class="mt-4 rounded-lg border border-gray-200 p-3">
              <p class="text-xs font-medium text-gray-500">用户申请说明</p>
              <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">{{ detail.application.statement || '用户未填写申请说明。' }}</p>
            </div>
            <NuxtLink :to="`/admin/users/${detail.account.userId}`" class="mt-4 inline-block text-sm font-medium text-blue-600 hover:underline">查看账号与既有 grant</NuxtLink>
          </div>

          <div v-if="detail.application.status === 'processing' && detail.assignedTo" class="rounded-xl border border-gray-200 bg-white p-5">
            <h3 class="font-semibold text-gray-900">处理申请</h3>
            <div v-if="detail.grantReview" class="mt-3 rounded-lg border p-3 text-sm leading-6" :class="detail.grantReview.status === 'pending_review' || detail.grantReview.status === 'executing' ? 'border-violet-200 bg-violet-50 text-violet-900' : detail.grantReview.status === 'rejected' || detail.grantReview.status === 'stale' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'">
              <p class="font-semibold">发放复核：{{ detail.grantReview.status === 'pending_review' ? '待另一位管理员复核' : detail.grantReview.status === 'executing' ? '正在执行' : detail.grantReview.status === 'rejected' ? '已拒绝，可修正后重新提交' : detail.grantReview.status === 'stale' ? '账号状态已变化，可重新提交' : detail.grantReview.status === 'approved' ? '已通过并生效' : '已取消' }}</p>
              <NuxtLink :to="`/admin/app/membership/reviews/${detail.grantReview.requestId}`" class="mt-1 inline-block font-medium underline">查看独立复核详情</NuxtLink>
            </div>
            <p v-if="catalog && detail.application.catalogVersionId !== catalog.catalogVersionId" class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-800">该申请绑定旧目录 {{ detail.application.catalogVersionId }}。可要求补充、拒绝、过期或取消，但不能静默按当前目录发放；请结束旧申请并让用户重新提交。</p>
            <div v-if="!detail.grantReview || !['pending_review', 'executing'].includes(detail.grantReview.status)" class="mt-4 flex flex-wrap gap-2">
              <button v-for="item in actionModes" :key="item.value" class="rounded-full border px-3 py-1.5 text-xs" :class="actionMode === item.value ? 'border-rose-500 bg-rose-50 text-rose-700' : 'border-gray-300 text-gray-600'" @click="actionMode = item.value">{{ item.label }}</button>
            </div>

            <template v-if="(!detail.grantReview || !['pending_review', 'executing'].includes(detail.grantReview.status)) && actionMode === 'approve'">
              <div class="mt-4 grid gap-3 sm:grid-cols-2">
                <label class="text-sm text-gray-700">有效天数<input v-model.number="actionForm.durationDays" type="number" min="1" max="366" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
                <label class="text-sm text-gray-700 sm:col-span-2">用户可见发放说明<textarea v-model="actionForm.userVisibleNote" maxlength="240" rows="2" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
                <label class="text-sm text-gray-700 sm:col-span-2">内部备注（不会进入申请审计正文）<textarea v-model="actionForm.internalNote" maxlength="1000" rows="2" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
              </div>
              <button :disabled="operating || !catalog || detail.application.catalogVersionId !== catalog.catalogVersionId" class="mt-4 rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="approveApplication">{{ operating ? '提交中…' : '提交独立复核' }}</button>
            </template>
            <template v-else-if="!detail.grantReview || !['pending_review', 'executing'].includes(detail.grantReview.status)">
              <div class="mt-4 grid gap-3">
                <label class="text-sm text-gray-700">处理原因<select v-model="actionForm.reasonCode" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"><option v-for="option in reasonOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
                <label class="text-sm text-gray-700">用户可见说明<textarea v-model="actionForm.message" maxlength="240" rows="3" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label>
              </div>
              <button :disabled="operating" class="mt-4 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="submitTransition">{{ operating ? '提交中…' : '确认处理结果' }}</button>
            </template>
            <p v-if="operationError" class="mt-3 text-sm text-red-600">{{ operationError }}</p>
          </div>

          <div class="rounded-xl border border-gray-200 bg-white p-5">
            <h3 class="font-semibold text-gray-900">用户可见时间线</h3>
            <ol class="mt-4 space-y-4">
              <li v-for="item in detail.application.timeline" :key="item.sequence" class="flex gap-3">
                <span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-rose-500"></span>
                <div class="min-w-0">
                  <p class="text-sm font-medium text-gray-900">{{ statusLabel(item.status) }}</p>
                  <p class="mt-1 break-words text-sm leading-6 text-gray-600">{{ item.message }}</p>
                  <p class="mt-1 text-xs text-gray-400">{{ formatDate(item.createdAt) }}</p>
                </div>
              </li>
            </ol>
          </div>
        </template>
        <p v-else class="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">选择一条会员申请查看详情</p>
      </section>
    </div>
  </div>
</template>
