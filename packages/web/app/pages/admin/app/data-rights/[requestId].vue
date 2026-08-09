<script setup lang="ts">
import {
  adminDataRightsActionLabel,
  adminDataRightsStatusClass,
  adminDataRightsStatusLabel,
  adminDataRightsTime,
  adminDataRightsTypeLabel,
  type AdminDataRightsAction,
  type AdminDataRightsOverview,
  type AdminDataRightsRequestDetail,
  type AdminDataRightsTimelineEvent,
} from '~/types/admin-app-data-rights'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const { isOwner } = useAuth()
const requestId = computed(() => String(route.params.requestId || ''))
const actionBusy = ref('')
const actionError = ref('')
const successMessage = ref('')
const selectedAction = ref<AdminDataRightsAction | ''>('')
const actionForm = reactive({
  reasonCode: 'privacy_request_processed',
  userMessage: '平台已更新本次申请的处理状态，请在数据权利页面查看最新进度。',
  internalNote: '',
  evidenceReference: '',
  failureCode: 'processing_dependency_unavailable',
})

const { data, status, error, refresh } = await useAsyncData(
  () => `admin-app-data-rights-${requestId.value}`,
  () => api<{ data: AdminDataRightsRequestDetail }>(`/api/admin/app/data-rights/requests/${encodeURIComponent(requestId.value)}`),
)
const { data: overviewData } = await useAsyncData(
  'admin-app-data-rights-overview-detail',
  () => api<{ data: AdminDataRightsOverview }>('/api/admin/app/data-rights/overview'),
)

const detail = computed(() => data.value?.data ?? null)
const overview = computed(() => overviewData.value?.data ?? null)
const detailError = computed(() => error.value
  ? resolveApiErrorMessage(error.value, '数据权利申请详情加载失败，请返回队列重试。')
  : '')
const timeline = computed(() => detail.value ? [...detail.value.timeline].reverse() : [])
const actionOptions = computed(() => detail.value?.availableActions ?? [])
const selectedActionBlocked = computed(() => {
  const request = detail.value
  const policy = overview.value?.policy
  if (!request || !selectedAction.value || !policy) return false
  if (!['begin_processing', 'retry'].includes(selectedAction.value)) return false
  return !policy.productionReady
    || (request.type === 'export' ? !policy.capabilities.exportProcessing : !policy.capabilities.deletionProcessing)
})

watch(detail, (value) => {
  if (!value) return
  if (!value.availableActions.includes(selectedAction.value as AdminDataRightsAction)) {
    selectedAction.value = value.availableActions[0] ?? ''
  }
}, { immediate: true })

watch(selectedAction, (action) => {
  if (action === 'cancel_verified') {
    actionForm.reasonCode = 'verified_account_request'
    actionForm.userMessage = '平台已根据核验结果取消本次申请；账号恢复后需要重新登录。'
  }
  else if (action === 'fail') {
    actionForm.reasonCode = 'processing_failed'
    actionForm.userMessage = '本次申请处理失败，平台已记录原因并将继续跟进。'
  }
  else if (action === 'retry') {
    actionForm.reasonCode = 'processing_retry'
    actionForm.userMessage = '本次申请已重新进入处理队列。'
  }
  else if (action === 'begin_processing') {
    actionForm.reasonCode = 'processing_started'
    actionForm.userMessage = '平台已开始处理本次申请。'
  }
})

async function claimRequest() {
  if (!detail.value?.permissions.canClaim || actionBusy.value) return
  if (import.meta.client && !window.confirm('确认领取该数据权利申请？领取后仅当前 Owner 可以执行本轮处置。')) return
  await performAction('claim', '申请已领取。', async () => {
    const response = await api<{ data: AdminDataRightsRequestDetail }>(
      `/api/admin/app/data-rights/requests/${encodeURIComponent(requestId.value)}/claim`,
      {
        method: 'POST',
        headers: operationHeaders('privacy.claim'),
        body: { expectedVersion: detail.value!.version },
      },
    )
    data.value = response
  })
}

async function submitAction() {
  const request = detail.value
  const action = selectedAction.value
  if (!request || !action || !request.permissions.canAct || actionBusy.value || selectedActionBlocked.value) return
  if (!actionForm.userMessage.trim()) {
    actionError.value = '必须填写用户可见说明。'
    return
  }
  if (action === 'cancel_verified' && !actionForm.evidenceReference.trim()) {
    actionError.value = '代用户取消必须填写已核验请求的证据引用。'
    return
  }
  if (action === 'fail' && !actionForm.failureCode.trim()) {
    actionError.value = '记录失败必须填写稳定失败代码。'
    return
  }
  if (import.meta.client && !window.confirm(`确认执行“${adminDataRightsActionLabel(action)}”？用户会立即看到本次说明，动作将写入不可变时间线和审计日志。`)) return
  await performAction('transition', '申请状态已更新。', async () => {
    const response = await api<{ data: AdminDataRightsRequestDetail }>(
      `/api/admin/app/data-rights/requests/${encodeURIComponent(requestId.value)}/actions`,
      {
        method: 'POST',
        headers: operationHeaders(`privacy.${action}`),
        body: {
          action,
          expectedVersion: request.version,
          reasonCode: actionForm.reasonCode.trim(),
          userMessage: actionForm.userMessage.trim(),
          internalNote: actionForm.internalNote.trim() || undefined,
          evidenceReference: actionForm.evidenceReference.trim() || undefined,
          failureCode: action === 'fail' ? actionForm.failureCode.trim() : undefined,
        },
      },
    )
    data.value = response
    actionForm.internalNote = ''
    actionForm.evidenceReference = ''
  })
}

async function performAction(key: string, success: string, operation: () => Promise<void>) {
  actionBusy.value = key
  actionError.value = ''
  successMessage.value = ''
  try {
    await operation()
    successMessage.value = success
    await refresh()
  }
  catch (operationError) {
    actionError.value = resolveApiErrorMessage(operationError, '申请操作失败，数据可能已变化，请刷新后重试。')
    await refresh().catch(() => undefined)
  }
  finally {
    actionBusy.value = ''
  }
}

function operationHeaders(prefix: string) {
  return { 'Idempotency-Key': `${prefix}.${crypto.randomUUID().replaceAll('-', '')}` }
}

function eventTypeLabel(value: string) {
  return ({
    requested: '申请已提交',
    account_access_restricted: '账号进入注销等待状态',
    assigned: '负责人已领取',
    processing_started: '开始受控处理',
    processing_failed: '记录处理失败',
    retry_scheduled: '重新排入处理',
    cancelled: '申请已取消',
    internal_note_added: '追加内部处置说明',
  } as Record<string, string>)[value] ?? value
}

function safeSummary(event: AdminDataRightsTimelineEvent) {
  return Object.entries(event.safeSummary)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(' · ')
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <header class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2"><h1 class="text-xl font-bold text-gray-950">数据权利申请处置</h1><span class="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">ADM-PRI-02</span></div>
        <p class="mt-1 break-all font-mono text-xs leading-5 text-gray-500">{{ requestId }}</p>
      </div>
      <NuxtLink to="/admin/app/data-rights" class="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:w-auto">返回申请队列</NuxtLink>
    </header>

    <p v-if="actionError" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ actionError }}</p>
    <p v-if="successMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-800">{{ successMessage }}</p>
    <div v-if="status === 'pending'" class="rounded-xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">正在读取申请详情…</div>
    <p v-else-if="detailError || !detail" class="rounded-xl border border-red-200 bg-red-50 p-5 text-sm leading-6 text-red-700">{{ detailError || '申请不存在或当前不可访问。' }}</p>

    <template v-else>
      <section class="rounded-2xl border border-gray-200 bg-white p-4 sm:p-6">
        <div class="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="rounded-full px-2 py-1 text-xs font-medium" :class="detail.type === 'deletion' ? 'bg-red-50 text-red-700' : 'bg-blue-50 text-blue-700'">{{ adminDataRightsTypeLabel(detail.type) }}</span>
              <span class="rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="adminDataRightsStatusClass(detail.status)">{{ adminDataRightsStatusLabel(detail.status) }}</span>
              <span v-if="detail.overdue" class="rounded-full bg-red-100 px-2 py-1 text-xs font-semibold text-red-800">已超过策略时限</span>
            </div>
            <h2 class="mt-3 break-words text-xl font-semibold text-gray-950">{{ detail.account.nickname }}</h2>
            <p class="mt-1 break-all text-sm text-gray-600">{{ detail.account.emailMasked }} · {{ detail.account.accountId }}</p>
            <p class="mt-2 text-xs leading-5 text-gray-500">账号当前状态：{{ detail.account.status }} · 申请 v{{ detail.version }} · 策略 {{ detail.policy.version }}</p>
          </div>
          <button v-if="detail.permissions.canClaim && isOwner" type="button" :disabled="Boolean(actionBusy)" class="min-h-11 w-full shrink-0 rounded-lg bg-gray-950 px-5 text-sm font-medium text-white disabled:opacity-50 sm:w-auto" @click="claimRequest">{{ actionBusy === 'claim' ? '领取中…' : '领取申请' }}</button>
        </div>
        <dl class="mt-5 grid min-w-0 gap-4 border-t border-gray-100 pt-5 text-sm sm:grid-cols-2 xl:grid-cols-5">
          <div><dt class="text-xs text-gray-500">负责人</dt><dd class="mt-1 truncate font-medium text-gray-900" :title="detail.assignee?.label || '尚未领取'">{{ detail.assignee?.label || '尚未领取' }}</dd></div>
          <div><dt class="text-xs text-gray-500">提交时间</dt><dd class="mt-1 text-gray-900">{{ adminDataRightsTime(detail.requestedAt) }}</dd></div>
          <div><dt class="text-xs text-gray-500">处理期限</dt><dd class="mt-1" :class="detail.overdue ? 'font-semibold text-red-700' : 'text-gray-900'">{{ adminDataRightsTime(detail.deadlineAt) }}</dd></div>
          <div><dt class="text-xs text-gray-500">注销执行时间</dt><dd class="mt-1 text-gray-900">{{ adminDataRightsTime(detail.scheduledFor) }}</dd></div>
          <div><dt class="text-xs text-gray-500">失败代码</dt><dd class="mt-1 break-all font-mono text-xs text-gray-900">{{ detail.failureCode || '—' }}</dd></div>
        </dl>
      </section>

      <section class="rounded-xl border border-amber-200 bg-amber-50 p-4 sm:p-5">
        <h2 class="text-sm font-semibold text-amber-950">不可逆动作保持封闭</h2>
        <p class="mt-1 text-sm leading-6 text-amber-800">Privacy-1 不显示或生成用户导出内容，也不提供“完成导出”或“执行删除”动作。开始处理与失败重试还会由服务端复核策略、生产门禁和执行器开关。</p>
      </section>

      <section class="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        <section class="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div class="border-b border-gray-200 px-4 py-4 sm:px-5"><h2 class="text-base font-semibold text-gray-950">不可变申请时间线</h2><p class="mt-1 text-xs text-gray-500">最新记录优先；用户可见说明与内部说明分开保存。</p></div>
          <div v-if="timeline.length" class="divide-y divide-gray-100">
            <article v-for="event in timeline" :key="event.eventId" class="grid min-w-0 gap-3 p-4 sm:p-5 lg:grid-cols-[145px_minmax(0,1fr)_155px]">
              <div><p class="text-sm font-medium text-gray-900">{{ eventTypeLabel(event.eventType) }}</p><p class="mt-1 text-xs text-gray-500">申请 v{{ event.requestVersion }} · #{{ event.sequence }}</p><span class="mt-2 inline-flex rounded-full px-2 py-1 text-[10px] font-medium" :class="event.visibility === 'user' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-700'">{{ event.visibility === 'user' ? '用户可见' : '仅后台可见' }}</span></div>
              <div class="min-w-0"><p class="text-sm text-gray-700">{{ adminDataRightsStatusLabel(event.status) }}</p><p v-if="event.userMessage" class="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-gray-700">{{ event.userMessage }}</p><p v-if="event.internalNote" class="mt-2 whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">{{ event.internalNote }}</p><p v-if="safeSummary(event)" class="mt-2 break-all font-mono text-[10px] leading-5 text-gray-400">{{ safeSummary(event) }}</p><p class="mt-2 break-all font-mono text-[10px] text-gray-500">原因：{{ event.reasonCode }}</p></div>
              <div class="text-xs leading-5 text-gray-500 lg:text-right"><p>{{ event.actor.label }}</p><p>{{ adminDataRightsTime(event.createdAt) }}</p></div>
            </article>
          </div>
          <div v-else class="p-10 text-center text-sm text-gray-500">暂无时间线记录。</div>
        </section>

        <aside class="min-w-0 space-y-5">
          <form class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5" @submit.prevent="submitAction">
            <h2 class="text-base font-semibold text-gray-950">受控处置动作</h2>
            <p class="mt-1 text-xs leading-5 text-gray-500">只有领取该申请的 Owner 可以操作；每次提交必须携带申请版本和幂等键。</p>
            <fieldset :disabled="!detail.permissions.canAct || !isOwner || Boolean(actionBusy)" class="mt-4 grid min-w-0 gap-4 disabled:opacity-60">
              <label class="min-w-0 text-sm font-medium text-gray-700">动作
                <select v-model="selectedAction" required class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm"><option value="" disabled>当前无可用动作</option><option v-for="action in actionOptions" :key="action" :value="action">{{ adminDataRightsActionLabel(action) }}</option></select>
              </label>
              <p v-if="selectedActionBlocked" class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">该处理动作已预留，但 Privacy-2 执行器或生产策略门禁尚未开放，当前不能提交。</p>
              <label class="min-w-0 text-sm font-medium text-gray-700">稳定原因码<input v-model.trim="actionForm.reasonCode" required pattern="[a-z0-9_]{3,80}" maxlength="80" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" /></label>
              <label v-if="selectedAction === 'fail'" class="min-w-0 text-sm font-medium text-gray-700">稳定失败代码<input v-model.trim="actionForm.failureCode" required pattern="[a-z0-9_]{3,80}" maxlength="80" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" /></label>
              <label class="min-w-0 text-sm font-medium text-gray-700">用户可见说明<textarea v-model.trim="actionForm.userMessage" required minlength="2" maxlength="300" rows="4" class="mt-1 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6" /></label>
              <label class="min-w-0 text-sm font-medium text-gray-700">内部处置说明（可选）<textarea v-model.trim="actionForm.internalNote" maxlength="1000" rows="3" class="mt-1 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6" placeholder="不得填写密码、状态凭证或导出内容。" /></label>
              <label class="min-w-0 text-sm font-medium text-gray-700">证据引用{{ selectedAction === 'cancel_verified' ? '（必填）' : '（可选）' }}<input v-model.trim="actionForm.evidenceReference" :required="selectedAction === 'cancel_verified'" maxlength="192" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" placeholder="ticket:... 或 case:..." /></label>
              <button type="submit" :disabled="!selectedAction || selectedActionBlocked || !actionForm.userMessage.trim() || Boolean(actionBusy)" class="min-h-11 w-full rounded-lg bg-gray-950 px-5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{{ actionBusy === 'transition' ? '提交中…' : selectedAction ? adminDataRightsActionLabel(selectedAction) : '当前无可用动作' }}</button>
            </fieldset>
            <p v-if="!isOwner" class="mt-3 text-xs leading-5 text-amber-700">当前角色为只读；数据权利处置暂只允许 Owner。</p>
            <p v-else-if="!detail.permissions.canAct && !detail.permissions.canClaim" class="mt-3 text-xs leading-5 text-gray-500">申请已由其他 Owner 领取或已进入终态。</p>
          </form>
        </aside>
      </section>
    </template>
  </div>
</template>
