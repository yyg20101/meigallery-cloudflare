<script setup lang="ts">
import type {
  AdminConversationQualitySampleDetail,
  AdminConversationQualitySampleSummary,
  AdminConversationQualitySnapshot,
  AdminConversationQualityTask,
  QualityOutcome,
  QualityRating,
} from '~/types/admin-app-conversation-quality'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const activeTab = ref<'samples' | 'selection' | 'tasks' | 'runs'>('samples')
const statusFilter = ref('open')
const groupFilter = ref('')
const selectedSampleId = ref<string | null>(null)
const detail = ref<AdminConversationQualitySampleDetail | null>(null)
const detailLoading = ref(false)
const pageError = ref('')
const detailError = ref('')
const operationError = ref('')
const successMessage = ref('')
const busyAction = ref('')
const reviewReasonCode = ref('routine_quality_review')
const selectedTaskId = ref<string | null>(null)
const taskCompletionNote = ref('')

const tabs = [
  { key: 'samples', label: '抽检样本' },
  { key: 'selection', label: '选择样本' },
  { key: 'tasks', label: '改进任务' },
  { key: 'runs', label: '抽样批次' },
] as const

const issueOptions = [
  ['disclosure_missing', '披露缺失或不一致'],
  ['impersonation_or_identity_confusion', '身份混淆或冒充暗示'],
  ['prohibited_promise', '禁止承诺'],
  ['privacy_exposure', '隐私暴露'],
  ['harassment_or_disrespect', '骚扰或不尊重'],
  ['inaccurate_public_information', '公开信息不准确'],
  ['unresolved_viewer_need', '用户需求未解决'],
  ['unsafe_language', '不安全话术'],
  ['process_noncompliance', '流程不合规'],
  ['other', '其他问题'],
] as const

const decisionForm = reactive({
  identityDisclosureRating: 'pass' as 'pass' | 'fail',
  serviceQualityRating: 'pass' as QualityRating,
  policyLanguageRating: 'pass' as QualityRating,
  overallScore: 90,
  outcome: 'pass' as QualityOutcome,
  issueCodes: [] as string[],
  reviewerSummary: '',
})

const taskDraft = reactive({
  assigneeAdminId: '' as number | '',
  issueCode: '',
  title: '',
  guidance: '',
  dueAt: toShanghaiInput(new Date(Date.now() + 7 * 24 * 60 * 60_000)),
})

const safetyDraft = reactive({
  reasonCode: 'other',
  priority: 'p2' as 'p0' | 'p1' | 'p2' | 'p3',
  summary: '',
})

const selectionForm = reactive({
  groupId: '',
  windowStart: toShanghaiInput(new Date(Date.now() - 7 * 24 * 60 * 60_000)),
  windowEnd: toShanghaiInput(new Date()),
  sampleSize: 10,
  reasonCode: 'routine_quality_review',
})

const { data, status, refresh } = await useAsyncData(
  'admin-app-conversation-quality',
  async () => {
    pageError.value = ''
    try {
      return await api<{ data: AdminConversationQualitySnapshot }>('/api/admin/app/conversation-quality', {
        query: {
          status: statusFilter.value,
          groupId: groupFilter.value || undefined,
          limit: 100,
        },
      })
    }
    catch (error) {
      pageError.value = apiErrorMessage(error, '会话质量工作台加载失败。')
      return null
    }
  },
  { watch: [statusFilter, groupFilter] },
)

const snapshot = computed(() => data.value?.data ?? null)
const samples = computed(() => snapshot.value?.samples ?? [])
const tasks = computed(() => snapshot.value?.tasks ?? [])
const selectedSample = computed(() => samples.value.find(sample => sample.sampleId === selectedSampleId.value) ?? null)
const selectedTask = computed(() => tasks.value.find(task => task.taskId === selectedTaskId.value) ?? null)
const selectedGroupOperators = computed(() => {
  const groupId = selectedSample.value?.group.groupId
  if (!groupId) return snapshot.value?.operators ?? []
  return snapshot.value?.operators.filter(operator => operator.groupIds.includes(groupId)) ?? []
})

watch(snapshot, (value) => {
  if (!value) return
  if (!selectionForm.groupId) {
    selectionForm.groupId = value.groups[0]?.groupId ?? (value.permissions.canReviewUnscoped ? 'unscoped' : '')
  }
  if (selectedSampleId.value && value.samples.some(sample => sample.sampleId === selectedSampleId.value)) return
  selectedSampleId.value = value.samples[0]?.sampleId ?? null
}, { immediate: true })

watch(() => {
  const sample = selectedSample.value
  return sample
    ? `${sample.sampleId}:${sample.status}:${sample.review.status}:${sample.version}`
    : ''
}, async () => {
  const sample = selectedSample.value
  detail.value = null
  detailError.value = ''
  operationError.value = ''
  resetDecision(sample)
  if (sample && (sample.review.status === 'mine' || sample.status === 'completed' || sample.status === 'voided')) {
    await loadDetail(sample.sampleId)
  }
})

watch(tasks, (items) => {
  if (selectedTaskId.value && items.some(task => task.taskId === selectedTaskId.value)) return
  selectedTaskId.value = items[0]?.taskId ?? null
}, { immediate: true })

watch(() => decisionForm.outcome, (outcome) => {
  if (outcome === 'pass') {
    decisionForm.identityDisclosureRating = 'pass'
    decisionForm.serviceQualityRating = 'pass'
    decisionForm.policyLanguageRating = 'pass'
    decisionForm.overallScore = Math.max(80, decisionForm.overallScore)
    decisionForm.issueCodes = []
  }
  if (outcome === 'coaching_required' && !taskDraft.issueCode) {
    taskDraft.issueCode = decisionForm.issueCodes[0] ?? ''
  }
})

watch(() => decisionForm.issueCodes, (codes) => {
  if (decisionForm.outcome === 'coaching_required' && !codes.includes(taskDraft.issueCode)) {
    taskDraft.issueCode = codes[0] ?? ''
  }
}, { deep: true })

async function loadDetail(sampleId = selectedSampleId.value) {
  if (!sampleId) return
  detailLoading.value = true
  detailError.value = ''
  try {
    const response = await api<{ data: AdminConversationQualitySampleDetail }>(
      `/api/admin/app/conversation-quality/samples/${sampleId}`,
      { query: { accessReason: 'quality_review' } },
    )
    if (selectedSampleId.value === sampleId) detail.value = response.data
  }
  catch (error) {
    detailError.value = apiErrorMessage(error, '抽检详情加载失败，请重新领取或刷新。')
  }
  finally {
    detailLoading.value = false
  }
}

async function claimSample() {
  const sample = selectedSample.value
  if (!sample || busyAction.value) return
  busyAction.value = 'claim'
  operationError.value = ''
  successMessage.value = ''
  try {
    await api(`/api/admin/app/conversation-quality/samples/${sample.sampleId}/claim`, {
      method: 'POST',
      headers: idempotencyHeaders('quality.claim'),
      body: { reviewReasonCode: reviewReasonCode.value },
    })
    successMessage.value = '样本已领取，正文授权将在 60 分钟后失效。'
    await refresh()
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '样本领取失败，请刷新后重试。')
  }
  finally {
    busyAction.value = ''
  }
}

async function submitDecision() {
  const sample = selectedSample.value
  const currentDetail = detail.value
  if (!sample || !currentDetail?.evidence || busyAction.value) return
  if (!currentDetail.evidence.integrityMatches) {
    operationError.value = '证据完整性不一致，不能提交评分；请作废样本并保留审计。'
    return
  }
  if (!window.confirm(decisionConfirmText(decisionForm.outcome))) return
  busyAction.value = 'decision'
  operationError.value = ''
  successMessage.value = ''
  try {
    await api(`/api/admin/app/conversation-quality/samples/${sample.sampleId}/decision`, {
      method: 'POST',
      headers: idempotencyHeaders('quality.decision'),
      body: {
        expectedVersion: sample.version,
        ...decisionForm,
        improvementTask: decisionForm.outcome === 'coaching_required'
          ? {
              assigneeAdminId: taskDraft.assigneeAdminId,
              issueCode: taskDraft.issueCode,
              title: taskDraft.title,
              guidance: taskDraft.guidance,
              dueAt: shanghaiInputToIso(taskDraft.dueAt),
            }
          : null,
        safetyReferral: decisionForm.outcome === 'safety_referral' ? { ...safetyDraft } : null,
      },
    })
    successMessage.value = decisionForm.outcome === 'safety_referral'
      ? '抽检结论已记录，独立安全案件已进入安全队列。'
      : decisionForm.outcome === 'coaching_required'
        ? '抽检结论和改进任务已原子保存。'
        : '抽检结论已记录为通过。'
    await refresh()
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '抽检结论提交失败，请核对评分、任务与最新版本。')
  }
  finally {
    busyAction.value = ''
  }
}

async function voidSample() {
  const sample = selectedSample.value
  if (!sample || busyAction.value) return
  const reasonCode = detailError.value.includes('不可用') || detail.value?.evidence?.integrityMatches === false
    ? 'evidence_unavailable'
    : 'scope_invalid'
  if (!window.confirm('确认作废该样本？样本和审计会保留，但不能再记录评分。')) return
  busyAction.value = 'void'
  operationError.value = ''
  successMessage.value = ''
  try {
    await api(`/api/admin/app/conversation-quality/samples/${sample.sampleId}/void`, {
      method: 'POST',
      headers: idempotencyHeaders('quality.void'),
      body: { expectedVersion: sample.version, reasonCode },
    })
    successMessage.value = '样本已作废并保留审计。'
    detail.value = null
    await refresh()
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '样本作废失败，请刷新后重试。')
  }
  finally {
    busyAction.value = ''
  }
}

async function createSelectionRun() {
  if (busyAction.value || !selectionForm.groupId) return
  if (!selectionForm.windowStart || !selectionForm.windowEnd) {
    pageError.value = '请选择完整的抽样时间范围。'
    return
  }
  if (!window.confirm('确认创建抽样批次？系统会按实际操作员轮转并从最早未抽样回复中确定性选择，不读取正文。')) return
  busyAction.value = 'selection'
  pageError.value = ''
  successMessage.value = ''
  try {
    const response = await api<{ message: string }>('/api/admin/app/conversation-quality/selection-runs', {
      method: 'POST',
      headers: idempotencyHeaders('quality.selection'),
      body: {
        groupId: selectionForm.groupId,
        windowStart: shanghaiInputToIso(selectionForm.windowStart),
        windowEnd: shanghaiInputToIso(selectionForm.windowEnd),
        sampleSize: selectionForm.sampleSize,
        reasonCode: selectionForm.reasonCode,
      },
    })
    successMessage.value = response.message
    statusFilter.value = 'open'
    groupFilter.value = selectionForm.groupId
    activeTab.value = 'samples'
    await refresh()
  }
  catch (error) {
    pageError.value = apiErrorMessage(error, '创建抽样批次失败，请核对范围、权限和候选状态。')
  }
  finally {
    busyAction.value = ''
  }
}

async function updateTask(task: AdminConversationQualityTask, nextStatus: 'in_progress' | 'completed' | 'cancelled') {
  if (busyAction.value) return
  if (nextStatus === 'completed' && !taskCompletionNote.value.trim()) {
    operationError.value = '完成任务前请填写完成说明。'
    selectedTaskId.value = task.taskId
    return
  }
  if (nextStatus === 'cancelled' && !window.confirm('确认取消该改进任务？取消会保留完整审计。')) return
  busyAction.value = `task:${task.taskId}`
  operationError.value = ''
  successMessage.value = ''
  try {
    await api(`/api/admin/app/conversation-quality/tasks/${task.taskId}`, {
      method: 'PATCH',
      headers: idempotencyHeaders('quality.task'),
      body: {
        expectedVersion: task.version,
        status: nextStatus,
        reasonCode: nextStatus === 'in_progress'
          ? 'assignee_started'
          : nextStatus === 'completed' ? 'improvement_completed' : 'supervisor_cancelled',
        completionNote: nextStatus === 'completed' ? taskCompletionNote.value : undefined,
      },
    })
    taskCompletionNote.value = ''
    successMessage.value = nextStatus === 'completed'
      ? '改进任务已完成并留痕。'
      : nextStatus === 'cancelled' ? '改进任务已取消。' : '改进任务已进入处理中。'
    await refresh()
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '改进任务更新失败，请刷新后重试。')
  }
  finally {
    busyAction.value = ''
  }
}

function resetDecision(sample: AdminConversationQualitySampleSummary | null) {
  const disclosureFailed = sample?.disclosureIntegrityStatus === 'missing' || sample?.disclosureIntegrityStatus === 'mismatch'
  decisionForm.identityDisclosureRating = disclosureFailed ? 'fail' : 'pass'
  decisionForm.serviceQualityRating = 'pass'
  decisionForm.policyLanguageRating = 'pass'
  decisionForm.overallScore = disclosureFailed ? 60 : 90
  decisionForm.outcome = disclosureFailed ? 'coaching_required' : 'pass'
  decisionForm.issueCodes = disclosureFailed ? ['disclosure_missing'] : []
  decisionForm.reviewerSummary = ''
  taskDraft.assigneeAdminId = sample?.actualOperator.adminId ?? ''
  taskDraft.issueCode = disclosureFailed ? 'disclosure_missing' : ''
  taskDraft.title = disclosureFailed ? '复核平台身份披露流程' : ''
  taskDraft.guidance = ''
  taskDraft.dueAt = toShanghaiInput(new Date(Date.now() + 7 * 24 * 60 * 60_000))
  safetyDraft.reasonCode = 'other'
  safetyDraft.priority = 'p2'
  safetyDraft.summary = ''
}

function idempotencyHeaders(prefix: string) {
  return { 'Idempotency-Key': `${prefix}.${crypto.randomUUID().replaceAll('-', '')}` }
}

function decisionConfirmText(outcome: QualityOutcome) {
  if (outcome === 'safety_referral') return '确认提交质检结论并创建独立安全案件？不会自动处罚或向用户披露内部说明。'
  if (outcome === 'coaching_required') return '确认提交质检结论并创建改进任务？任务将分配给所选负责人。'
  return '确认将该样本记录为通过？提交后正文授权立即关闭。'
}

function toggleIssue(code: string, checked: boolean) {
  if (checked && !decisionForm.issueCodes.includes(code)) decisionForm.issueCodes.push(code)
  if (!checked) decisionForm.issueCodes = decisionForm.issueCodes.filter(item => item !== code)
}

function toShanghaiInput(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`
}

function shanghaiInputToIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value)
  if (!match) throw new Error('上海时间格式无效')
  const [, year, month, day, hour, minute] = match
  return new Date(Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - 8,
    Number(minute),
  )).toISOString()
}

function formatTime(value: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value))
}

function sampleStatusLabel(sample: AdminConversationQualitySampleSummary) {
  if (sample.status === 'completed') return sample.conclusion?.outcome === 'pass' ? '已通过' : sample.conclusion?.outcome === 'safety_referral' ? '已转安全' : '需改进'
  if (sample.status === 'voided') return '已作废'
  if (sample.review.status === 'mine') return '由我审核'
  if (sample.review.status === 'other') return '审核中'
  return '待领取'
}

function disclosureLabel(value: AdminConversationQualitySampleSummary['disclosureIntegrityStatus']) {
  return value === 'verified' ? '披露完整' : value === 'missing' ? '披露缺失' : value === 'mismatch' ? '披露不一致' : '版本待核验'
}

function outcomeLabel(value: QualityOutcome) {
  return value === 'pass' ? '通过' : value === 'coaching_required' ? '需要改进' : '转安全审核'
}

function ratingLabel(value: string) {
  return value === 'pass' ? '通过' : value === 'needs_improvement' ? '需改进' : '失败'
}

function taskStatusLabel(value: AdminConversationQualityTask['status']) {
  return value === 'open' ? '待开始' : value === 'in_progress' ? '处理中' : value === 'completed' ? '已完成' : '已取消'
}

function isTaskOverdue(task: AdminConversationQualityTask) {
  const generatedAt = snapshot.value?.generatedAt
  return Boolean(
    generatedAt
    && ['open', 'in_progress'].includes(task.status)
    && new Date(task.dueAt).getTime() < new Date(generatedAt).getTime(),
  )
}

function diagnosticClass(severity: string) {
  return severity === 'critical'
    ? 'border-rose-200 bg-rose-50 text-rose-900'
    : severity === 'warning'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-sky-200 bg-sky-50 text-sky-900'
}
</script>

<template>
  <div class="mx-auto max-w-[1500px] space-y-6 p-4 sm:p-6 lg:p-8">
    <section class="overflow-hidden rounded-2xl border border-[#eaded8] bg-white p-5 shadow-sm sm:p-6">
      <AdminAppPageHeader page-id="ADM-MSG-04" route="/admin/app/conversation-quality" title="会话质量与抽检" description="领取并记录目的后才限时开放最小正文证据；抽检人与实际回复操作员强制隔离。" :state="pageError ? '加载失败' : status === 'pending' ? '加载中' : '正常'" figma-state="正常" :state-tone="pageError ? 'danger' : status === 'pending' ? 'warning' : 'info'">
        <template #actions><NuxtLink to="/admin/app/conversations" class="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-rose-300 hover:text-rose-700">会话队列</NuxtLink><NuxtLink to="/admin/app/conversation-groups" class="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:border-rose-300 hover:text-rose-700">运营组与班次</NuxtLink></template>
      </AdminAppPageHeader>
    </section>

    <div v-if="successMessage" class="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{{ successMessage }}</div>
    <div v-if="pageError" class="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{{ pageError }}</div>

    <section v-if="snapshot" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <div v-for="item in [['待领取', snapshot.counters.pending], ['审核中', snapshot.counters.inReview], ['已完成', snapshot.counters.completed], ['披露关注', snapshot.counters.disclosureAttention], ['逾期任务', snapshot.counters.overdueTasks]]" :key="String(item[0])" class="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><p class="text-xs text-slate-500">{{ item[0] }}</p><p class="mt-2 text-2xl font-bold text-slate-950">{{ item[1] }}</p></div>
    </section>

    <section v-if="snapshot?.diagnostics.length" class="grid gap-3 lg:grid-cols-2"><div v-for="diagnostic in snapshot.diagnostics" :key="diagnostic.code" class="rounded-2xl border px-4 py-3 text-sm" :class="diagnosticClass(diagnostic.severity)"><div class="flex items-start justify-between gap-3"><p class="leading-6">{{ diagnostic.message }}</p><span v-if="diagnostic.count" class="rounded-full bg-white/70 px-2 py-0.5 text-xs font-semibold">{{ diagnostic.count }}</span></div></div></section>

    <nav class="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1 shadow-sm"><button v-for="tab in tabs" :key="tab.key" type="button" class="min-w-max rounded-xl px-4 py-2.5 text-sm font-medium transition" :class="activeTab === tab.key ? 'bg-slate-950 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-50'" @click="activeTab = tab.key">{{ tab.label }}</button></nav>

    <section v-if="activeTab === 'samples'" class="space-y-4">
      <div class="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center"><select v-model="statusFilter" class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"><option value="open">待处理</option><option value="pending">待领取</option><option value="in_review">审核中</option><option value="completed">已完成</option><option value="voided">已作废</option><option value="all">全部</option></select><select v-model="groupFilter" class="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"><option value="">全部授权范围</option><option v-for="group in snapshot?.groups ?? []" :key="group.groupId" :value="group.groupId">{{ group.name }}</option><option v-if="snapshot?.permissions.canReviewUnscoped" value="unscoped">未归组（Owner）</option></select><button type="button" class="ml-auto rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50" @click="refresh()">刷新权威状态</button></div>
      <div v-if="status === 'pending'" class="rounded-3xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">正在加载抽检队列…</div>
      <div v-else class="grid min-h-[620px] gap-5 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.4fr)]">
        <aside class="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div class="border-b border-slate-100 px-5 py-4"><h2 class="font-semibold text-slate-950">无正文样本队列</h2><p class="mt-1 text-xs text-slate-500">{{ samples.length }} 个当前结果；不会显示用户昵称或消息摘要</p></div><div v-if="!samples.length" class="p-10 text-center text-sm leading-6 text-slate-500">当前范围没有样本。具有质检范围的账号可前往“选择样本”创建可复现批次。</div><div v-else class="max-h-[760px] divide-y divide-slate-100 overflow-y-auto"><button v-for="sample in samples" :key="sample.sampleId" type="button" class="block w-full p-4 text-left transition hover:bg-slate-50" :class="selectedSampleId === sample.sampleId ? 'bg-rose-50/70' : ''" @click="selectedSampleId = sample.sampleId"><div class="flex items-start justify-between gap-3"><div class="min-w-0"><p class="truncate text-sm font-semibold text-slate-900">{{ sample.profile.displayName }}</p><p class="mt-1 truncate text-xs text-slate-500">{{ sample.group.name ?? '未归组' }} · {{ sample.actualOperator.displayName }}</p></div><span class="shrink-0 rounded-full px-2 py-1 text-[11px] font-medium" :class="sample.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : sample.status === 'voided' ? 'bg-slate-100 text-slate-600' : sample.review.status === 'other' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'">{{ sampleStatusLabel(sample) }}</span></div><div class="mt-3 flex flex-wrap gap-2 text-[11px]"><span class="rounded-full bg-slate-100 px-2 py-1 text-slate-600">#{{ sample.messageId.slice(-8) }}</span><span class="rounded-full px-2 py-1" :class="sample.disclosureIntegrityStatus === 'verified' ? 'bg-emerald-50 text-emerald-700' : sample.disclosureIntegrityStatus === 'unverifiable' ? 'bg-sky-50 text-sky-700' : 'bg-rose-50 text-rose-700'">{{ disclosureLabel(sample.disclosureIntegrityStatus) }}</span><span class="px-1 py-1 text-slate-400">{{ formatTime(sample.messageCreatedAt) }}</span></div></button></div></aside>
        <main class="rounded-3xl border border-slate-200 bg-white shadow-sm"><div v-if="!selectedSample" class="flex min-h-[620px] items-center justify-center p-8 text-sm text-slate-500">请选择一个抽检样本。</div><template v-else><div class="border-b border-slate-100 p-5 sm:p-6"><div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><div class="flex flex-wrap items-center gap-2"><h2 class="text-lg font-semibold text-slate-950">{{ selectedSample.profile.displayName }}</h2><span class="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{{ selectedSample.group.name ?? '未归组' }}</span></div><p class="mt-2 text-sm text-slate-600">实际回复：{{ selectedSample.actualOperator.displayName }} · 样本版本 {{ selectedSample.version }}</p><p class="mt-1 text-xs text-slate-400">披露 {{ selectedSample.disclosureVersion }} · 审核话术 {{ selectedSample.approvedScriptVersionId ?? '未使用' }}</p></div><span class="self-start rounded-full bg-slate-950 px-3 py-1.5 text-xs font-medium text-white">{{ sampleStatusLabel(selectedSample) }}</span></div></div>
          <div class="space-y-5 p-5 sm:p-6"><div v-if="operationError" class="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{{ operationError }}</div><div v-if="detailError" class="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{{ detailError }}</div><div v-if="selectedSample.disclosureIntegrityStatus === 'missing' || selectedSample.disclosureIntegrityStatus === 'mismatch'" class="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"><p class="font-semibold">披露缺失状态</p><p class="mt-1 leading-6">该样本不能记录为通过。身份披露必须判定失败，并至少选择“披露缺失或不一致”问题。</p></div>
            <div v-if="selectedSample.status === 'pending' || (selectedSample.status === 'in_review' && selectedSample.review.status === 'unassigned')" class="rounded-2xl border border-sky-200 bg-sky-50 p-5"><h3 class="font-semibold text-sky-950">无正文授权</h3><p class="mt-2 text-sm leading-6 text-sky-800">当前只允许查看回复事实。领取时必须留下稳定目的；授权 60 分钟后自动失效，且实际回复操作员不能领取本人样本。</p><div class="mt-4 flex flex-col gap-3 sm:flex-row"><select v-model="reviewReasonCode" class="min-w-0 flex-1 rounded-xl border border-sky-200 bg-white px-3 py-2 text-sm"><option value="routine_quality_review">例行质量复核</option><option value="disclosure_investigation">披露异常核查</option><option value="coaching_follow_up">改进跟进复核</option></select><button v-if="snapshot?.permissions.isOwner" type="button" class="rounded-xl border border-sky-300 bg-white px-4 py-2 text-sm font-medium text-sky-800 disabled:opacity-50" :disabled="Boolean(busyAction)" @click="voidSample">作废范围错误样本</button><button type="button" class="rounded-xl bg-sky-700 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50" :disabled="!selectedSample.review.canClaim || Boolean(busyAction)" @click="claimSample">{{ busyAction === 'claim' ? '领取中…' : selectedSample.review.canClaim ? '领取并限时查看正文' : '不可领取本人样本' }}</button></div></div>
            <div v-else-if="selectedSample.review.status === 'other'" class="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">该样本正由 {{ selectedSample.review.reviewerDisplayName ?? '其他质检员' }} 审核，租约到 {{ formatTime(selectedSample.review.leaseExpiresAt) }}。正文不会对你开放。</div>
            <div v-if="detailLoading" class="rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500">正在读取受控证据…</div>
            <template v-if="detail?.evidence"><section class="rounded-2xl border border-slate-200 bg-slate-50/60 p-4"><div class="flex items-center justify-between gap-3"><div><h3 class="font-semibold text-slate-900">最小正文证据</h3><p class="mt-1 text-xs text-slate-500">仅目标消息、前后一条与披露卡；访问已审计</p></div><span class="rounded-full px-2 py-1 text-xs" :class="detail.evidence.integrityMatches ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'">{{ detail.evidence.integrityMatches ? '完整性通过' : '完整性异常' }}</span></div><div class="mt-4 space-y-3"><div v-for="message in detail.evidence.messages" :key="message.messageId" class="rounded-xl border p-3" :class="message.role === 'target' ? 'border-rose-200 bg-white ring-2 ring-rose-100' : 'border-slate-200 bg-white/80'"><div class="mb-2 flex items-center justify-between text-xs text-slate-500"><span>{{ message.role === 'target' ? '抽检目标' : message.role === 'before' ? '上一条上下文' : '下一条上下文' }} · {{ message.senderType === 'viewer' ? '观看者' : message.senderType === 'platform_operator' ? '平台运营' : '系统' }}</span><span>#{{ message.sequence }}</span></div><p class="whitespace-pre-wrap break-words text-sm leading-6 text-slate-800">{{ message.text }}</p></div><div v-if="detail.evidence.disclosure" class="rounded-xl border border-indigo-200 bg-indigo-50 p-3"><p class="text-xs font-semibold text-indigo-800">不可删除的平台披露卡</p><p class="mt-2 whitespace-pre-wrap text-sm leading-6 text-indigo-950">{{ detail.evidence.disclosure.text }}</p></div><div v-else class="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">未固定到有效披露卡。</div></div></section>
              <section class="space-y-5 rounded-2xl border border-slate-200 p-4 sm:p-5"><div><h3 class="font-semibold text-slate-950">记录抽检结论</h3><p class="mt-1 text-xs text-slate-500">提交后正文授权立即关闭，结论不可在本页直接改写。</p></div><div class="grid gap-4 md:grid-cols-3"><label class="space-y-1 text-sm text-slate-700">身份披露<select v-model="decisionForm.identityDisclosureRating" class="w-full rounded-xl border border-slate-200 px-3 py-2"><option value="pass">通过</option><option value="fail">失败</option></select></label><label class="space-y-1 text-sm text-slate-700">服务质量<select v-model="decisionForm.serviceQualityRating" class="w-full rounded-xl border border-slate-200 px-3 py-2"><option value="pass">通过</option><option value="needs_improvement">需改进</option><option value="fail">失败</option></select></label><label class="space-y-1 text-sm text-slate-700">话术合规<select v-model="decisionForm.policyLanguageRating" class="w-full rounded-xl border border-slate-200 px-3 py-2"><option value="pass">通过</option><option value="needs_improvement">需改进</option><option value="fail">失败</option></select></label></div><div class="grid gap-4 md:grid-cols-[160px_1fr]"><label class="space-y-1 text-sm text-slate-700">综合评分<input v-model.number="decisionForm.overallScore" type="number" min="0" max="100" class="w-full rounded-xl border border-slate-200 px-3 py-2"></label><label class="space-y-1 text-sm text-slate-700">结论<select v-model="decisionForm.outcome" class="w-full rounded-xl border border-slate-200 px-3 py-2"><option value="pass">通过</option><option value="coaching_required">需要改进并创建任务</option><option value="safety_referral">转独立安全审核</option></select></label></div>
                <fieldset v-if="decisionForm.outcome !== 'pass'" class="space-y-2"><legend class="text-sm font-medium text-slate-700">问题分类</legend><div class="grid gap-2 sm:grid-cols-2"><label v-for="option in issueOptions" :key="option[0]" class="flex items-start gap-2 rounded-xl border border-slate-200 p-3 text-sm text-slate-700"><input type="checkbox" class="mt-0.5" :checked="decisionForm.issueCodes.includes(option[0])" @change="toggleIssue(option[0], ($event.target as HTMLInputElement).checked)"><span>{{ option[1] }}</span></label></div></fieldset><label class="block space-y-1 text-sm text-slate-700">质检结论说明<textarea v-model="decisionForm.reviewerSummary" rows="4" maxlength="1000" class="w-full rounded-xl border border-slate-200 px-3 py-2" placeholder="说明判断依据，不复制无关隐私信息。" /></label>
                <div v-if="decisionForm.outcome === 'coaching_required'" class="space-y-4 rounded-2xl border border-amber-200 bg-amber-50 p-4"><h4 class="font-semibold text-amber-950">改进任务</h4><div class="grid gap-4 md:grid-cols-2"><label class="space-y-1 text-sm text-amber-950">负责人<select v-model="taskDraft.assigneeAdminId" class="w-full rounded-xl border border-amber-200 bg-white px-3 py-2"><option value="">请选择</option><option v-for="operator in selectedGroupOperators" :key="operator.adminId" :value="operator.adminId">{{ operator.displayName }}</option></select></label><label class="space-y-1 text-sm text-amber-950">对应问题<select v-model="taskDraft.issueCode" class="w-full rounded-xl border border-amber-200 bg-white px-3 py-2"><option value="">请选择</option><option v-for="code in decisionForm.issueCodes" :key="code" :value="code">{{ issueOptions.find(option => option[0] === code)?.[1] ?? code }}</option></select></label><label class="space-y-1 text-sm text-amber-950">任务标题<input v-model="taskDraft.title" maxlength="120" class="w-full rounded-xl border border-amber-200 bg-white px-3 py-2"></label><label class="space-y-1 text-sm text-amber-950">截止时间<input v-model="taskDraft.dueAt" type="datetime-local" class="w-full rounded-xl border border-amber-200 bg-white px-3 py-2"></label></div><label class="block space-y-1 text-sm text-amber-950">改进指导<textarea v-model="taskDraft.guidance" rows="3" maxlength="1000" class="w-full rounded-xl border border-amber-200 bg-white px-3 py-2" /></label></div>
                <div v-if="decisionForm.outcome === 'safety_referral'" class="space-y-4 rounded-2xl border border-rose-200 bg-rose-50 p-4"><div><h4 class="font-semibold text-rose-950">独立安全转介</h4><p class="mt-1 text-xs text-rose-700">只创建未分配安全案件，不自动处罚、不复用质检结论替代安全审核。</p></div><div class="grid gap-4 md:grid-cols-2"><label class="space-y-1 text-sm text-rose-950">安全原因<select v-model="safetyDraft.reasonCode" class="w-full rounded-xl border border-rose-200 bg-white px-3 py-2"><option value="suspected_impersonation">疑似冒充</option><option value="harassment_threat">骚扰威胁</option><option value="fraud_inducement">诈骗诱导</option><option value="privacy_exposure">隐私暴露</option><option value="minor_safety">未成年人安全</option><option value="imminent_danger">紧迫危险</option><option value="other">其他</option></select></label><label class="space-y-1 text-sm text-rose-950">优先级<select v-model="safetyDraft.priority" class="w-full rounded-xl border border-rose-200 bg-white px-3 py-2"><option value="p0">P0</option><option value="p1">P1</option><option value="p2">P2</option><option value="p3">P3</option></select></label></div><label class="block space-y-1 text-sm text-rose-950">内部转介说明<textarea v-model="safetyDraft.summary" rows="3" maxlength="1000" class="w-full rounded-xl border border-rose-200 bg-white px-3 py-2" /></label></div>
                <div class="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between"><button v-if="snapshot?.permissions.isOwner || !detail.evidence.integrityMatches" type="button" class="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50" :disabled="Boolean(busyAction)" @click="voidSample">{{ detail.evidence.integrityMatches ? '作废范围错误样本' : '证据异常，作废样本' }}</button><span v-else /><button type="button" class="rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50" :disabled="Boolean(busyAction) || !decisionForm.reviewerSummary.trim()" @click="submitDecision">{{ busyAction === 'decision' ? '提交中…' : '记录抽检结论' }}</button></div></section></template>
            <section v-if="detail && !detail.evidence && selectedSample.status === 'completed'" class="rounded-2xl border border-emerald-200 bg-emerald-50 p-5"><h3 class="font-semibold text-emerald-950">抽检已完成，正文授权已关闭</h3><div v-if="selectedSample.conclusion" class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><div><p class="text-xs text-emerald-700">结论</p><p class="mt-1 font-semibold">{{ outcomeLabel(selectedSample.conclusion.outcome) }}</p></div><div><p class="text-xs text-emerald-700">综合评分</p><p class="mt-1 font-semibold">{{ selectedSample.conclusion.overallScore }}</p></div><div><p class="text-xs text-emerald-700">身份披露</p><p class="mt-1 font-semibold">{{ ratingLabel(selectedSample.conclusion.identityDisclosureRating) }}</p></div><div><p class="text-xs text-emerald-700">完成时间</p><p class="mt-1 font-semibold">{{ formatTime(selectedSample.conclusion.completedAt) }}</p></div></div><p v-if="detail.reviewerSummary" class="mt-4 rounded-xl bg-white/70 p-3 text-sm leading-6 text-emerald-950">{{ detail.reviewerSummary }}</p><NuxtLink v-if="selectedSample.conclusion?.linkedSafetyEscalationId" :to="`/admin/app/safety?tab=escalations&escalationId=${selectedSample.conclusion.linkedSafetyEscalationId}`" class="mt-4 inline-flex rounded-xl bg-rose-700 px-4 py-2 text-sm font-medium text-white">查看独立安全案件</NuxtLink></section><section v-if="selectedSample.status === 'voided'" class="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-700">样本已作废：{{ selectedSample.voidReasonCode ?? '未记录原因' }}。不会再次开放正文或生成评分。</section>
          </div></template></main>
      </div>
    </section>

    <section v-else-if="activeTab === 'selection'" class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]"><div class="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"><h2 class="text-lg font-semibold text-slate-950">创建可复现抽样批次</h2><p class="mt-2 text-sm leading-6 text-slate-600">系统不读取正文，按实际操作员轮转、从每人最早未抽样回复中选择；同一回复最多进入一个样本。</p><div v-if="!snapshot?.permissions.canCreateSelection" class="mt-5 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">当前账号没有运营组长或质检成员范围，不能创建抽样批次。</div><form v-else class="mt-6 grid gap-5 md:grid-cols-2" @submit.prevent="createSelectionRun"><label class="space-y-1 text-sm text-slate-700">抽样范围<select v-model="selectionForm.groupId" required class="w-full rounded-xl border border-slate-200 px-3 py-2"><option value="" disabled>请选择运营组</option><option v-for="group in snapshot.groups" :key="group.groupId" :value="group.groupId">{{ group.name }} · {{ group.activeOperatorCount }} 人</option><option v-if="snapshot.permissions.canReviewUnscoped" value="unscoped">未归组回复（Owner）</option></select></label><label class="space-y-1 text-sm text-slate-700">抽样原因<select v-model="selectionForm.reasonCode" class="w-full rounded-xl border border-slate-200 px-3 py-2"><option value="routine_quality_review">例行质量抽检</option><option value="disclosure_focus">身份披露专项</option><option value="coaching_follow_up">改进跟进</option><option value="policy_follow_up">政策专项</option></select></label><label class="space-y-1 text-sm text-slate-700">开始时间（上海时间）<input v-model="selectionForm.windowStart" type="datetime-local" required class="w-full rounded-xl border border-slate-200 px-3 py-2"></label><label class="space-y-1 text-sm text-slate-700">结束时间（上海时间）<input v-model="selectionForm.windowEnd" type="datetime-local" required class="w-full rounded-xl border border-slate-200 px-3 py-2"></label><label class="space-y-1 text-sm text-slate-700">样本数量<input v-model.number="selectionForm.sampleSize" type="number" min="1" max="50" required class="w-full rounded-xl border border-slate-200 px-3 py-2"><span class="text-xs text-slate-400">单批 1—50 个，时间范围最多 31 天</span></label><div class="flex items-end"><button type="submit" class="w-full rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50" :disabled="Boolean(busyAction)">{{ busyAction === 'selection' ? '正在确定样本…' : '确认并创建样本' }}</button></div></form></div><aside class="rounded-3xl border border-slate-200 bg-slate-950 p-6 text-white shadow-sm"><h3 class="font-semibold">抽样边界</h3><ul class="mt-4 space-y-3 text-sm leading-6 text-slate-300"><li>• 只选择新版本已固定回复元数据的消息，不静默回填历史正文。</li><li>• 抽样人可以参与复核，但实际回复操作员不能领取自己的样本。</li><li>• 无候选也会保存 0 样本批次，便于核对范围与时间。</li><li>• 正文仅在样本领取后按最小证据窗口开放。</li></ul></aside></section>

    <section v-else-if="activeTab === 'tasks'" class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]"><div class="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div class="border-b border-slate-100 p-5"><h2 class="font-semibold text-slate-950">改进任务</h2><p class="mt-1 text-xs text-slate-500">普通运营仅能看到分配给自己的任务，不获得抽检正文权限</p></div><div v-if="!tasks.length" class="p-12 text-center text-sm text-slate-500">当前没有可见改进任务。</div><div v-else class="divide-y divide-slate-100"><button v-for="task in tasks" :key="task.taskId" type="button" class="w-full p-5 text-left hover:bg-slate-50" :class="selectedTaskId === task.taskId ? 'bg-amber-50/70' : ''" @click="selectedTaskId = task.taskId"><div class="flex items-start justify-between gap-3"><div><p class="font-semibold text-slate-900">{{ task.title }}</p><p class="mt-1 text-xs text-slate-500">{{ task.assignee.displayName }} · {{ task.group.name ?? '未归组' }}</p></div><span class="rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600">{{ taskStatusLabel(task.status) }}</span></div><p class="mt-3 line-clamp-2 text-sm leading-6 text-slate-600">{{ task.guidance }}</p><p class="mt-2 text-xs" :class="isTaskOverdue(task) ? 'text-rose-600' : 'text-slate-400'">截止 {{ formatTime(task.dueAt) }}</p></button></div></div><aside class="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><div v-if="!selectedTask" class="py-12 text-center text-sm text-slate-500">请选择任务。</div><template v-else><div class="flex items-start justify-between gap-3"><div><h3 class="font-semibold text-slate-950">{{ selectedTask.title }}</h3><p class="mt-1 text-xs text-slate-500">样本 {{ selectedTask.sampleId }}</p></div><span class="rounded-full bg-slate-100 px-2 py-1 text-xs">{{ taskStatusLabel(selectedTask.status) }}</span></div><div class="mt-5 space-y-4 text-sm"><div><p class="text-xs text-slate-500">改进指导</p><p class="mt-1 whitespace-pre-wrap leading-6 text-slate-800">{{ selectedTask.guidance }}</p></div><div class="grid grid-cols-2 gap-3"><div><p class="text-xs text-slate-500">负责人</p><p class="mt-1">{{ selectedTask.assignee.displayName }}</p></div><div><p class="text-xs text-slate-500">截止时间</p><p class="mt-1">{{ formatTime(selectedTask.dueAt) }}</p></div></div><div v-if="selectedTask.completionNote"><p class="text-xs text-slate-500">完成说明</p><p class="mt-1 whitespace-pre-wrap leading-6">{{ selectedTask.completionNote }}</p></div></div><div v-if="selectedTask.canUpdate" class="mt-6 space-y-3"><textarea v-model="taskCompletionNote" rows="3" maxlength="1000" class="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" placeholder="完成任务时填写具体改进内容" /><div class="flex flex-wrap gap-2"><button v-if="selectedTask.status === 'open'" type="button" class="rounded-xl border border-slate-200 px-3 py-2 text-sm" :disabled="Boolean(busyAction)" @click="updateTask(selectedTask, 'in_progress')">开始处理</button><button type="button" class="rounded-xl bg-emerald-700 px-3 py-2 text-sm font-medium text-white" :disabled="Boolean(busyAction)" @click="updateTask(selectedTask, 'completed')">标记完成</button><button v-if="selectedTask.canCancel" type="button" class="rounded-xl border border-rose-200 px-3 py-2 text-sm text-rose-700" :disabled="Boolean(busyAction)" @click="updateTask(selectedTask, 'cancelled')">取消任务</button></div></div></template></aside></section>

    <section v-else class="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div class="border-b border-slate-100 p-5"><h2 class="font-semibold text-slate-950">抽样批次</h2><p class="mt-1 text-xs text-slate-500">记录范围、候选数量与实际样本数，不展示正文</p></div><div v-if="!snapshot?.selectionRuns.length" class="p-12 text-center text-sm text-slate-500">尚无可见抽样批次。</div><div v-else class="overflow-x-auto"><table class="min-w-full text-left text-sm"><thead class="bg-slate-50 text-xs text-slate-500"><tr><th class="px-5 py-3">范围</th><th class="px-5 py-3">时间窗</th><th class="px-5 py-3">候选 / 选中</th><th class="px-5 py-3">原因</th><th class="px-5 py-3">操作人</th><th class="px-5 py-3">创建时间</th></tr></thead><tbody class="divide-y divide-slate-100"><tr v-for="run in snapshot.selectionRuns" :key="run.selectionRunId"><td class="px-5 py-4 font-medium text-slate-900">{{ run.groupName ?? '未归组' }}</td><td class="px-5 py-4 text-slate-600">{{ formatTime(run.windowStart) }} — {{ formatTime(run.windowEnd) }}</td><td class="px-5 py-4 text-slate-600">{{ run.eligibleCount }} / {{ run.selectedCount }}</td><td class="px-5 py-4 text-slate-600">{{ run.reasonCode }}</td><td class="px-5 py-4 text-slate-600">{{ run.selectedByDisplayName }}</td><td class="px-5 py-4 text-slate-500">{{ formatTime(run.createdAt) }}</td></tr></tbody></table></div></section>
  </div>
</template>
