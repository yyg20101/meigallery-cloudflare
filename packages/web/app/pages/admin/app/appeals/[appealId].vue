<script setup lang="ts">
import type { AdminSafetyAppealDetail, AdminSafetyAppealSummary } from '~/types/admin-app-safety'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const appealId = computed(() => String(route.params.appealId ?? ''))
const summary = ref<AdminSafetyAppealSummary | null>(null)
const detail = ref<AdminSafetyAppealDetail | null>(null)
const loading = ref(true)
const claiming = ref(false)
const deciding = ref(false)
const updatingWorkflow = ref(false)
const errorMessage = ref('')
const outcome = ref<'upheld' | 'changed'>('upheld')
const reasonCode = ref('independent_review_upheld')
const userVisibleMessage = ref('独立复核已完成，维持原举报结论。')

const isServiceAppeal = computed(() => summary.value?.type !== 'report_no_violation_review')
const figmaState = computed(() => {
  if (summary.value?.reviewState === 'needs_escalation') return '需要升级'
  if (summary.value?.reviewState === 'evidence_insufficient') return '证据不足'
  return '正常'
})

watch(outcome, (value) => {
  if (value === 'upheld') {
    reasonCode.value = 'independent_review_upheld'
    userVisibleMessage.value = isServiceAppeal.value
      ? '独立复核已完成，维持原业务记录；当前状态以原业务页面为准。'
      : '独立复核已完成，维持原举报结论。'
  }
  else {
    reasonCode.value = 'independent_review_changed'
    userVisibleMessage.value = isServiceAppeal.value
      ? '独立复核确认申诉成立；账号限制或金币记录需要由原业务流程另行处理，当前状态以原业务页面为准。'
      : '独立复核后，举报已重新进入审核。'
  }
})

watch(() => summary.value?.type, () => {
  outcome.value = 'upheld'
  reasonCode.value = 'independent_review_upheld'
  userVisibleMessage.value = isServiceAppeal.value
    ? '独立复核已完成，维持原业务记录；当前状态以原业务页面为准。'
    : '独立复核已完成，维持原举报结论。'
})

await load()

async function load() {
  loading.value = true
  errorMessage.value = ''
  detail.value = null
  try {
    const response = await api<{ data: AdminSafetyAppealSummary }>(
      `/api/admin/app/safety/appeals/${appealId.value}/summary`,
    )
    summary.value = response.data
    if (summary.value.assignedToMe) await loadDetail()
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '申诉摘要加载失败。')
  }
  finally {
    loading.value = false
  }
}

async function loadDetail() {
  const response = await api<{ data: AdminSafetyAppealDetail }>(
    `/api/admin/app/safety/appeals/${appealId.value}`,
    { query: { accessReason: 'appeal_review' } },
  )
  detail.value = response.data
  summary.value = response.data
}

async function claimAppeal() {
  if (!summary.value?.canClaim || claiming.value) return
  claiming.value = true
  errorMessage.value = ''
  try {
    const operationId = crypto.randomUUID().replaceAll('-', '')
    await api(`/api/admin/app/safety/appeals/${appealId.value}/claim`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `appeal.claim.${operationId}` },
    })
    await load()
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '申诉领取失败，请刷新后重试。')
  }
  finally {
    claiming.value = false
  }
}

async function submitDecision() {
  if (!detail.value || deciding.value || isFinal.value || detail.value.reviewState !== 'normal') return
  const action = outcome.value === 'upheld'
    ? (isServiceAppeal.value ? '维持原业务记录' : '维持原“未发现违规”结论')
    : (isServiceAppeal.value ? '判定申诉成立并标记原业务待处理' : '把原举报重新打开并交由当前复核人继续审核')
  const boundary = isServiceAppeal.value
    ? '本操作不会直接修改账号限制或金币账本。'
    : '历史结论不会被删除。'
  if (!window.confirm(`确认${action}？用户会看到填写的说明；${boundary}`)) return
  deciding.value = true
  errorMessage.value = ''
  try {
    const operationId = crypto.randomUUID().replaceAll('-', '')
    await api(`/api/admin/app/safety/appeals/${appealId.value}/decision`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `appeal.decision.${operationId}` },
      body: {
        expectedVersion: detail.value.version,
        outcome: outcome.value,
        reasonCode: reasonCode.value,
        userVisibleMessage: userVisibleMessage.value,
      },
    })
    await load()
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '复核结论提交失败，请刷新案件版本后重试。')
  }
  finally {
    deciding.value = false
  }
}

async function updateReviewState(action: 'request-supplement' | 'escalate') {
  if (!detail.value || updatingWorkflow.value || isFinal.value) return
  const requestingSupplement = action === 'request-supplement'
  const message = requestingSupplement
    ? '当前材料不足以形成结论，请在申诉页补充与原业务对象直接相关的必要说明。'
    : '案件包含需要更高权限或联合判断的事实，已进入升级复核；原业务状态不自动改变。'
  if (!window.confirm(requestingSupplement ? '确认请求用户补充必要说明？' : '确认将案件升级复核？')) return
  updatingWorkflow.value = true
  errorMessage.value = ''
  try {
    const operationId = crypto.randomUUID().replaceAll('-', '')
    await api(`/api/admin/app/safety/appeals/${appealId.value}/${action}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `appeal.${action}.${operationId}` },
      body: {
        expectedVersion: detail.value.version,
        reasonCode: requestingSupplement ? 'evidence_insufficient' : 'sensitive_review_required',
        userVisibleMessage: message,
      },
    })
    await load()
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, requestingSupplement ? '请求补充失败，请刷新后重试。' : '升级复核失败，请刷新后重试。')
  }
  finally {
    updatingWorkflow.value = false
  }
}

const isFinal = computed(() => summary.value ? ['upheld', 'changed', 'closed'].includes(summary.value.status) : false)
const detailChecklist = computed(() => {
  const item = detail.value
  const summaryItem = summary.value
  return [
    {
      label: '服务端权限已确认',
      value: item ? '已通过' : summaryItem?.assignedToMe ? '读取中' : '领取后检查',
      passed: Boolean(item),
    },
    {
      label: '对象版本未变化',
      value: item ? `关联版本 ${sourceVersion(item)}` : '提交时再次校验',
      passed: Boolean(item),
    },
    {
      label: '来源证据完整',
      value: item?.report || item?.sourceFacts ? '提交时再次校验' : '领取后检查',
      passed: Boolean(item?.report || item?.sourceFacts),
    },
    {
      label: '风险标记已复核',
      value: item ? '提交时再次校验' : '领取后检查',
      passed: false,
    },
    {
      label: '审计原因已填写',
      value: reasonCode.value ? '已填写' : '待填写',
      passed: Boolean(reasonCode.value),
    },
  ]
})

function statusLabel(value: AdminSafetyAppealSummary['status']) {
  if (value === 'submitted') return '待领取'
  if (value === 'processing') return '独立复核中'
  if (value === 'upheld') return '维持原结论'
  if (value === 'changed') return isServiceAppeal.value ? '申诉成立待原业务处理' : '已重开调查'
  return '已关闭'
}

function sourceLabel(item: AdminSafetyAppealSummary) {
  if (item.type === 'account_restriction_review') return '账号限制'
  if (item.type === 'wallet_entry_review') return '金币分录'
  return '举报结论'
}

function sourceReference(item: AdminSafetyAppealSummary) {
  return item.source?.reference ?? item.reportId ?? '—'
}

function sourceVersion(item: AdminSafetyAppealSummary) {
  return item.source?.sourceVersion ?? String(item.originalReportVersion ?? '—')
}

function sourceFactLabel(key: string) {
  return {
    status: '来源状态',
    reasonCategory: '原因类别',
    restrictedUntil: '限制截止',
    actionType: '分录类型',
    direction: '方向',
    amount: '金币数量',
    reasonCode: '原因码',
    userVisibleNote: '用户可见说明',
    balanceBefore: '调整前余额',
    balanceAfter: '调整后余额',
    postedAt: '入账时间',
    originalEntryId: '原分录引用',
  }[key] ?? key
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
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
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-SAF-04" :route="`/admin/app/appeals/${appealId}`" title="申诉详情" :description="`独立复核事实、原业务对象和用户说明 · ${appealId}`" :state="errorMessage ? '操作失败' : loading ? '加载中' : isFinal ? '终态只读' : figmaState" :figma-state="figmaState" :state-tone="errorMessage || summary?.reviewState === 'needs_escalation' ? 'danger' : loading || summary?.reviewState === 'evidence_insufficient' ? 'warning' : isFinal ? 'neutral' : 'success'">
      <template #actions><NuxtLink to="/admin/app/appeals" class="inline-flex min-h-10 items-center rounded-lg border border-gray-300 bg-white px-4 text-sm text-gray-700">返回申诉队列</NuxtLink><button class="min-h-10 rounded-lg border border-gray-300 bg-white px-4 text-sm text-gray-700" @click="load()">刷新</button></template>
    </AdminAppPageHeader>

    <section v-if="!errorMessage" class="flex min-w-0 items-start gap-3 rounded-xl border border-[#b2ddff] bg-[#d1e9ff] px-4 py-3 text-[#175cd3]">
      <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-current text-xs">i</span>
      <div class="min-w-0"><p class="text-sm font-medium">当前数据可用</p><p class="mt-0.5 break-words text-xs leading-5">数据来自服务端权限规则；详细说明与业务快照只在领取并通过职责隔离检查后读取。</p></div>
    </section>

    <div v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{{ errorMessage }}</div>
    <div v-if="loading" class="rounded-xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">正在加载申诉…</div>

    <template v-else-if="summary">
      <section class="grid gap-4 rounded-xl border border-[#f2ddd6] bg-white p-5 sm:grid-cols-2 xl:grid-cols-5">
        <div><p class="text-xs text-gray-500">当前状态</p><p class="mt-1 text-sm font-semibold text-gray-950">{{ statusLabel(summary.status) }}</p></div>
        <div><p class="text-xs text-gray-500">关联业务对象</p><p class="mt-1 break-all text-sm font-medium text-gray-950">{{ sourceLabel(summary) }} · {{ sourceReference(summary) }}</p></div>
        <div><p class="text-xs text-gray-500">关联版本</p><p class="mt-1 text-sm font-medium text-gray-950">{{ sourceVersion(summary) }}</p></div>
        <div><p class="text-xs text-gray-500">申诉人</p><p class="mt-1 break-all text-sm font-medium text-gray-950">{{ summary.accountPublicId || '账号引用不可用' }}</p></div>
        <div><p class="text-xs text-gray-500">提交时间</p><p class="mt-1 text-sm text-gray-700">{{ formatDate(summary.submittedAt) }}</p></div>
      </section>

      <section v-if="summary.isolationBlocked" class="rounded-xl border border-red-200 bg-red-50 p-5">
        <h2 class="font-semibold text-red-900">职责隔离：你不能领取此申诉</h2>
        <p class="mt-2 text-sm leading-6 text-red-800">你是原业务结论的审核人。请返回队列，由其他具备权限的审核人员独立复核。</p>
      </section>
      <section v-else-if="summary.reviewState === 'evidence_insufficient'" class="rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-950">
        <h2 class="font-semibold">证据不足，等待用户补充</h2>
        <p class="mt-2 text-sm leading-6">当前复核被安全暂停，不能直接形成结论。{{ summary.supplementDueAt ? `补充目标时间：${formatDate(summary.supplementDueAt)}` : '当前策略未配置正式补充 SLA。' }}</p>
      </section>
      <section v-else-if="summary.reviewState === 'needs_escalation'" class="rounded-xl border border-red-200 bg-red-50 p-5 text-red-900">
        <h2 class="font-semibold">需要升级复核</h2>
        <p class="mt-2 text-sm leading-6">案件已停止在当前复核层级；不得绕过升级流程直接提交结论。</p>
      </section>
      <section v-else-if="!summary.assignedToMe && !isFinal" class="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <h2 class="font-semibold text-amber-950">领取后才能读取说明与证据</h2>
        <p class="mt-2 text-sm leading-6 text-amber-900">领取前只展示案件安全引用。领取会写入审计，并由服务端再次检查原审核人隔离。</p>
        <button v-if="summary.canClaim" class="mt-4 min-h-10 rounded-lg bg-amber-800 px-5 text-sm font-medium text-white disabled:opacity-50" :disabled="claiming" @click="claimAppeal">{{ claiming ? '领取中…' : '领取并开始独立复核' }}</button>
        <p v-else class="mt-4 text-sm font-medium text-amber-900">该案件已由其他复核人领取。</p>
      </section>

      <template v-if="detail">
        <div class="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.58fr)]">
          <div class="min-w-0 space-y-5">
            <section class="rounded-xl border border-gray-200 bg-white p-5"><h2 class="text-sm font-semibold text-gray-950">用户申诉说明</h2><p class="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-gray-700">{{ detail.statement }}</p></section>
            <section v-if="detail.report" class="rounded-xl border border-gray-200 bg-white p-5"><h2 class="text-sm font-semibold text-gray-950">原举报与最小证据</h2><dl class="mt-4 grid gap-4 text-sm sm:grid-cols-2"><div><dt class="text-xs text-gray-500">举报原因</dt><dd class="mt-1 font-medium text-gray-950">{{ detail.report.reasonLabel }}</dd></div><div><dt class="text-xs text-gray-500">当前举报状态</dt><dd class="mt-1 text-gray-800">{{ detail.report.status }} · v{{ detail.report.version }}</dd></div><div><dt class="text-xs text-gray-500">人物资料</dt><dd class="mt-1 break-all text-gray-800">{{ detail.report.profileId }}</dd></div><div><dt class="text-xs text-gray-500">目标类型</dt><dd class="mt-1 text-gray-800">{{ detail.report.targetType }}</dd></div><div class="sm:col-span-2"><dt class="text-xs text-gray-500">原举报说明</dt><dd class="mt-1 whitespace-pre-wrap break-words leading-6 text-gray-800">{{ detail.report.description || '未填写' }}</dd></div><div class="sm:col-span-2"><dt class="text-xs text-gray-500">证据摘要</dt><dd class="mt-1 break-all font-mono text-xs text-gray-700">{{ detail.report.evidence.evidenceDigest }}</dd></div></dl></section>
            <section v-else-if="detail.sourceFacts" class="rounded-xl border border-gray-200 bg-white p-5"><h2 class="text-sm font-semibold text-gray-950">提交时业务快照</h2><p class="mt-1 text-xs leading-5 text-gray-500">该快照用于独立复核，不代表当前实时状态；完整性摘要 <span class="break-all">{{ detail.sourceSnapshotSha256 }}</span></p><dl class="mt-4 grid gap-4 text-sm sm:grid-cols-2"><div v-for="(value, key) in detail.sourceFacts" :key="key"><dt class="text-xs text-gray-500">{{ sourceFactLabel(String(key)) }}</dt><dd class="mt-1 break-words text-gray-800">{{ value ?? '无' }}</dd></div></dl></section>
            <section class="rounded-xl border border-gray-200 bg-white p-5"><h2 class="text-sm font-semibold text-gray-950">用户可见时间线</h2><ol class="mt-4 space-y-4"><li v-for="event in detail.timeline" :key="event.sequence" class="border-l-2 border-rose-200 pl-4"><div class="flex flex-wrap justify-between gap-2"><strong class="text-sm text-gray-950">{{ statusLabel(event.status) }}</strong><span class="text-xs text-gray-500">{{ formatDate(event.createdAt) }}</span></div><p class="mt-1 text-sm leading-6 text-gray-600">{{ event.message }}</p></li></ol></section>
            <section v-if="detail.supplements?.length" class="rounded-xl border border-gray-200 bg-white p-5"><h2 class="text-sm font-semibold text-gray-950">补充说明</h2><ol class="mt-4 space-y-3"><li v-for="item in detail.supplements" :key="item.sequence" class="rounded-lg bg-[#fff5f1] p-3"><p class="whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">{{ item.note }}</p><p class="mt-2 text-xs text-gray-500">第 {{ item.sequence }} 次补充 · {{ formatDate(item.createdAt) }}</p></li></ol></section>
          </div>

          <aside class="min-w-0 space-y-5">
            <section class="rounded-xl border border-[#f2ddd6] bg-white p-5">
              <h2 class="text-lg font-bold text-[#2c2421]">操作检查清单</h2>
              <ul class="mt-4 space-y-3">
                <li v-for="item in detailChecklist" :key="item.label" class="flex min-w-0 items-start gap-3 rounded-[10px] bg-[#fff5f1] px-3 py-3">
                  <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border text-xs" :class="item.passed ? 'border-emerald-500 text-emerald-600' : 'border-[#8d817b] text-[#6a5f5a]'">{{ item.passed ? '✓' : 'i' }}</span>
                  <div class="min-w-0"><p class="break-words text-sm font-medium text-[#2c2421]">{{ item.label }}</p><p class="mt-0.5 break-words text-xs text-[#8d817b]">{{ item.value }}</p></div>
                </li>
              </ul>
            </section>

            <section class="h-fit rounded-xl border p-5" :class="isFinal ? 'border-gray-200 bg-white' : 'border-rose-200 bg-rose-50'">
            <h2 class="font-semibold text-gray-950">{{ isFinal ? '复核结论' : '形成复核结论' }}</h2>
            <p v-if="isFinal" class="mt-3 text-sm leading-6 text-gray-700">{{ summary.userVisibleMessage }}</p>
            <form v-else class="mt-4 space-y-4" @submit.prevent="submitDecision">
              <div class="grid gap-2 sm:grid-cols-2">
                <button type="button" class="min-h-10 rounded-lg border border-amber-300 bg-amber-50 px-3 text-sm font-medium text-amber-900 disabled:opacity-50" :disabled="updatingWorkflow || detail.reviewState !== 'normal'" @click="updateReviewState('request-supplement')">请求补充</button>
                <button type="button" class="min-h-10 rounded-lg border border-red-300 bg-red-50 px-3 text-sm font-medium text-red-800 disabled:opacity-50" :disabled="updatingWorkflow || detail.reviewState === 'needs_escalation'" @click="updateReviewState('escalate')">升级复核</button>
              </div>
              <label class="block text-sm text-gray-700">结论<select v-model="outcome" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3"><option value="upheld">维持原结论</option><option value="changed">{{ isServiceAppeal ? '申诉成立，标记原业务待处理' : '重新进入举报审核' }}</option></select></label>
              <p class="rounded-lg bg-white p-3 text-xs leading-5 text-gray-600 ring-1 ring-gray-200">{{ isServiceAppeal ? (outcome === 'changed' ? '申诉结论只标记需要后续处理，不直接解除账号限制或改写金币余额；须回到原业务流程执行。' : '维持结论不会删除申诉或原业务历史。') : (outcome === 'changed' ? '改判不会自动执行封禁或下架，只会把原举报恢复为调查中并交由你继续审核。' : '维持结论不会删除申诉或原举报历史。') }}</p>
              <label class="block text-sm text-gray-700">原因码<input v-model.trim="reasonCode" pattern="[a-z0-9_]{3,80}" required class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3"></label>
              <label class="block text-sm text-gray-700">用户可见说明<textarea v-model="userVisibleMessage" maxlength="300" rows="4" required class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"></textarea><span class="mt-1 block text-right text-xs text-gray-500">{{ userVisibleMessage.length }}/300</span></label>
              <button type="submit" class="min-h-10 w-full rounded-lg bg-rose-600 px-5 text-sm font-medium text-white disabled:opacity-50" :disabled="deciding || updatingWorkflow || detail.reviewState !== 'normal'">{{ deciding ? '提交中…' : detail.reviewState === 'evidence_insufficient' ? '等待用户补充' : detail.reviewState === 'needs_escalation' ? '已升级复核' : '确认并提交复核结论' }}</button>
            </form>
            </section>
          </aside>
        </div>
      </template>
    </template>
  </div>
</template>
