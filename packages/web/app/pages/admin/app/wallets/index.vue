<script setup lang="ts">
import type {
  AdminWalletAccountSummary,
  AdminWalletAdjustment,
  AdminWalletAdjustmentPreview,
  AdminWalletAdjustmentStatus,
  AdminWalletEntryType,
  AdminWalletReasonCode,
  AdminWalletState,
} from '~/types/admin-app-wallet'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const query = ref('')
const accounts = ref<AdminWalletAccountSummary[]>([])
const selected = ref<AdminWalletState | null>(null)
const adjustments = ref<AdminWalletAdjustment[]>([])
const queueStatus = ref<AdminWalletAdjustmentStatus | ''>('pending_review')
const searching = ref(false)
const loadingAccount = ref(false)
const loadingQueue = ref(false)
const previewing = ref(false)
const submitting = ref(false)
const reviewingId = ref<string | null>(null)
const errorMessage = ref('')
const successMessage = ref('')
const preview = ref<AdminWalletAdjustmentPreview | null>(null)
const reviewNotes = reactive<Record<string, string>>({})

const form = reactive({
  actionType: 'admin_credit' as AdminWalletEntryType,
  amount: 100 as number | null,
  reasonCode: 'manual_adjustment' as AdminWalletReasonCode,
  userVisibleNote: '',
  internalNote: '',
  businessReference: '',
  originalEntryId: '',
})

const actionOptions: Array<{ value: AdminWalletEntryType; label: string }> = [
  { value: 'admin_credit', label: '管理员加币' },
  { value: 'admin_debit', label: '管理员扣币' },
  { value: 'compensation', label: '平台服务补偿' },
  { value: 'reversal', label: '完整冲正原分录' },
]
const reasonOptions: Array<{ value: AdminWalletReasonCode; label: string }> = [
  { value: 'manual_adjustment', label: '管理员调整' },
  { value: 'service_compensation', label: '平台服务补偿' },
  { value: 'correction', label: '账务纠正' },
]
const statusOptions: Array<{ value: AdminWalletAdjustmentStatus | ''; label: string }> = [
  { value: 'pending_review', label: '待独立复核' },
  { value: 'applied', label: '已入账' },
  { value: 'rejected', label: '已拒绝' },
  { value: '', label: '全部申请' },
]

watch(() => form.actionType, (value) => {
  preview.value = null
  if (value === 'compensation') form.reasonCode = 'service_compensation'
  else if (value !== 'reversal' && form.reasonCode === 'service_compensation') form.reasonCode = 'manual_adjustment'
})
watch(form, () => { preview.value = null }, { deep: true })
watch(queueStatus, () => refreshQueue())

onMounted(() => refreshQueue())

async function searchAccounts() {
  searching.value = true
  clearMessages()
  try {
    const response = await api<{ data: AdminWalletAccountSummary[] }>('/api/admin/app/wallets/accounts', {
      query: { query: query.value.trim() || undefined },
    })
    accounts.value = response.data
    if (accounts.value.length === 1) await openAccount(accounts.value[0]!.accountId)
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '账号查询失败。')
  }
  finally {
    searching.value = false
  }
}

async function openAccount(accountId: string) {
  loadingAccount.value = true
  clearMessages()
  preview.value = null
  try {
    const response = await api<{ data: AdminWalletState }>(`/api/admin/app/wallets/accounts/${accountId}`)
    selected.value = response.data
    form.businessReference = suggestedBusinessReference(accountId)
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '钱包详情读取失败。')
  }
  finally {
    loadingAccount.value = false
  }
}

async function refreshQueue() {
  loadingQueue.value = true
  try {
    const response = await api<{ data: AdminWalletAdjustment[] }>('/api/admin/app/wallets/adjustments', {
      query: { status: queueStatus.value || undefined },
    })
    adjustments.value = response.data
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '金币管理能力当前不可用。')
  }
  finally {
    loadingQueue.value = false
  }
}

function adjustmentBody() {
  if (!selected.value) throw new Error('请先选择账号')
  return {
    accountId: selected.value.account.accountId,
    actionType: form.actionType,
    amount: form.actionType === 'reversal' ? undefined : form.amount,
    reasonCode: form.actionType === 'reversal' ? undefined : form.reasonCode,
    userVisibleNote: form.userVisibleNote,
    internalNote: form.internalNote,
    businessReference: form.businessReference,
    originalEntryId: form.actionType === 'reversal' ? form.originalEntryId : undefined,
  }
}

async function previewAdjustment() {
  previewing.value = true
  clearMessages()
  try {
    const response = await api<{ data: AdminWalletAdjustmentPreview }>('/api/admin/app/wallets/adjustments/preview', {
      method: 'POST',
      body: adjustmentBody(),
    })
    preview.value = response.data
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '调币预览失败，请检查必填项。')
  }
  finally {
    previewing.value = false
  }
}

async function submitAdjustment() {
  if (!preview.value?.canSubmit || !selected.value) return
  if (import.meta.client && !window.confirm('确认提交调币申请？提交后不会立即改余额，必须由另一位管理员复核。')) return
  submitting.value = true
  clearMessages()
  try {
    await api('/api/admin/app/wallets/adjustments', {
      method: 'POST',
      headers: { 'Idempotency-Key': `wallet.request.${crypto.randomUUID()}` },
      body: adjustmentBody(),
    })
    successMessage.value = '调币申请已提交，等待另一位管理员独立复核。'
    preview.value = null
    resetNotes()
    await Promise.all([refreshQueue(), openAccount(selected.value.account.accountId)])
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '调币申请提交失败。')
  }
  finally {
    submitting.value = false
  }
}

async function reviewAdjustment(item: AdminWalletAdjustment, decision: 'approve' | 'reject') {
  const reviewNote = reviewNotes[item.adjustmentId]?.trim() ?? ''
  if (reviewNote.length < 2) {
    errorMessage.value = '复核说明至少填写 2 个字符。'
    return
  }
  const label = decision === 'approve' ? '批准并入账' : '拒绝申请'
  if (import.meta.client && !window.confirm(`确认${label}？该操作会写入不可变审计记录。`)) return
  reviewingId.value = item.adjustmentId
  clearMessages()
  try {
    await api(`/api/admin/app/wallets/adjustments/${item.adjustmentId}/${decision}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `wallet.review.${crypto.randomUUID()}` },
      body: { expectedVersion: item.version, reviewNote },
    })
    successMessage.value = decision === 'approve' ? '复核通过，金币分录已入账。' : '调币申请已拒绝。'
    reviewNotes[item.adjustmentId] = ''
    await refreshQueue()
    if (selected.value?.account.accountId === item.account.accountId) {
      await openAccount(item.account.accountId)
    }
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '复核失败，请刷新后重试。')
  }
  finally {
    reviewingId.value = null
  }
}

function resetNotes() {
  form.userVisibleNote = ''
  form.internalNote = ''
  form.originalEntryId = ''
  if (selected.value) form.businessReference = suggestedBusinessReference(selected.value.account.accountId)
}

function clearMessages() {
  errorMessage.value = ''
  successMessage.value = ''
}

function suggestedBusinessReference(accountId: string) {
  const compact = new Date().toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)
  return `ADMIN-${accountId.slice(-8).toUpperCase()}-${compact}`
}

function statusLabel(status: AdminWalletAdjustmentStatus) {
  return {
    pending_review: '待独立复核',
    executing: '入账处理中',
    applied: '已入账',
    rejected: '已拒绝',
    cancelled: '已取消',
    failed: '处理失败',
  }[status]
}

function actionLabel(value: AdminWalletEntryType) {
  return actionOptions.find(item => item.value === value)?.label ?? value
}

function riskLabel(value: string) {
  return {
    POLICY_UNRESOLVED_ALL_REVIEW: '当前策略要求全部申请独立复核',
    NEGATIVE_BALANCE: '扣币后余额不能小于 0',
    WALLET_FROZEN: '钱包已冻结',
    DUPLICATE_BUSINESS_REFERENCE: '业务单号已使用',
    ORIGINAL_ENTRY_NOT_REVERSIBLE: '原分录不存在、已冲正或不可再次冲正',
  }[value] ?? value
}

function formatTime(value: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
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
    <section class="min-w-0">
      <h1 class="text-xl font-semibold text-gray-900">App 金币钱包</h1>
      <p class="mt-1 max-w-4xl text-sm leading-6 text-gray-600">
        查询账号权威余额与追加式明细，创建单笔加币、扣币、补偿或完整冲正申请。所有申请必须由另一位管理员复核；金币当前不可购买、消费、转赠、兑换或提现。
      </p>
    </section>

    <div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
      Wallet-1 默认关闭且尚未通过生产门禁。此页面不提供批量调币、直接改余额、自动修账或绕过独立复核的入口。
    </div>
    <p v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 [overflow-wrap:anywhere]">{{ errorMessage }}</p>
    <p v-if="successMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 [overflow-wrap:anywhere]">{{ successMessage }}</p>

    <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
      <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
        <label class="min-w-0 flex-1 text-sm font-medium text-gray-700">
          账号查询
          <input v-model="query" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2.5 text-sm" placeholder="稳定账号 ID、邮箱或昵称" @keyup.enter="searchAccounts">
        </label>
        <button class="w-full rounded-lg bg-gray-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50 sm:w-auto" :disabled="searching" @click="searchAccounts">
          {{ searching ? '查询中…' : '查询账号' }}
        </button>
      </div>
      <div v-if="accounts.length" class="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
        <button v-for="account in accounts" :key="account.accountId" class="min-w-0 rounded-xl border p-4 text-left hover:border-gray-400" :class="selected?.account.accountId === account.accountId ? 'border-gray-900 bg-gray-50' : 'border-gray-200'" @click="openAccount(account.accountId)">
          <span class="block truncate font-medium text-gray-900">{{ account.nickname || '未设置昵称' }}</span>
          <span class="mt-1 block break-all text-xs text-gray-500">{{ account.accountId }} · {{ account.emailMasked }}</span>
          <span class="mt-3 block text-sm text-gray-700">余额 {{ account.balance }} · 账本版本 {{ account.ledgerVersion }}</span>
        </button>
      </div>
    </section>

    <section v-if="loadingAccount" class="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">钱包详情读取中…</section>

    <template v-if="selected && !loadingAccount">
      <section class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-xl border border-pink-200 bg-gradient-to-br from-pink-50 to-white p-4">
          <p class="text-xs text-pink-700">当前金币</p><p class="mt-2 break-all text-3xl font-semibold text-gray-900">{{ selected.wallet.balance }}</p>
        </article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">账本版本</p><p class="mt-2 text-xl font-semibold text-gray-900">{{ selected.wallet.ledgerVersion }}</p></article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">钱包状态</p><p class="mt-2 text-xl font-semibold" :class="selected.wallet.status === 'active' ? 'text-emerald-700' : 'text-red-700'">{{ selected.wallet.status === 'active' ? '正常' : '已冻结' }}</p></article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">最近入账</p><p class="mt-2 text-sm font-medium text-gray-900">{{ formatTime(selected.wallet.lastEntryAt) }}</p></article>
      </section>

      <section class="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)]">
        <div class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <h2 class="font-semibold text-gray-900">创建调币申请</h2>
          <p class="mt-1 text-xs leading-5 text-gray-500">所见余额只是预览快照；复核入账时会再次执行版本、余额、账号状态和冲正关系校验。</p>
          <div class="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
            <label class="text-sm text-gray-700">操作类型<select v-model="form.actionType" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2.5"><option v-for="option in actionOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
            <label v-if="form.actionType !== 'reversal'" class="text-sm text-gray-700">金币数量<input v-model.number="form.amount" type="number" min="1" max="1000000" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2.5"></label>
            <label v-else class="text-sm text-gray-700">原分录 ID<input v-model.trim="form.originalEntryId" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2.5" placeholder="wle_..."></label>
            <label v-if="form.actionType !== 'reversal'" class="text-sm text-gray-700">标准原因<select v-model="form.reasonCode" :disabled="form.actionType === 'compensation'" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2.5 disabled:bg-gray-100"><option v-for="option in reasonOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
            <label class="text-sm text-gray-700">业务单号<input v-model.trim="form.businessReference" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2.5" maxlength="80"></label>
            <label class="text-sm text-gray-700 sm:col-span-2">用户可见说明<textarea v-model.trim="form.userVisibleNote" rows="2" maxlength="160" class="mt-1 w-full min-w-0 resize-y rounded-lg border border-gray-300 px-3 py-2.5" placeholder="说明本次余额变化原因，不填写内部信息" /></label>
            <label class="text-sm text-gray-700 sm:col-span-2">内部审计说明<textarea v-model.trim="form.internalNote" rows="3" maxlength="500" class="mt-1 w-full min-w-0 resize-y rounded-lg border border-gray-300 px-3 py-2.5" placeholder="记录依据、工单或操作背景；不会展示给用户" /></label>
          </div>
          <div class="mt-4 flex min-w-0 flex-col gap-2 sm:flex-row">
            <button class="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 disabled:opacity-50 sm:w-auto" :disabled="previewing || submitting" @click="previewAdjustment">{{ previewing ? '校验中…' : '预览并校验' }}</button>
            <button class="w-full rounded-lg bg-pink-600 px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto" :disabled="!preview?.canSubmit || submitting" @click="submitAdjustment">{{ submitting ? '提交中…' : '提交复核' }}</button>
          </div>
          <div v-if="preview" class="mt-4 min-w-0 rounded-xl border p-4" :class="preview.canSubmit ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'">
            <p class="font-medium" :class="preview.canSubmit ? 'text-emerald-900' : 'text-red-900'">余额预览：{{ preview.balanceBefore }} → {{ preview.balanceAfter }}</p>
            <p class="mt-1 text-sm" :class="preview.canSubmit ? 'text-emerald-800' : 'text-red-800'">{{ actionLabel(preview.actionType) }} {{ preview.amount }} 金币 · 快照版本 {{ preview.ledgerVersion }}</p>
            <ul class="mt-2 space-y-1 text-xs leading-5" :class="preview.canSubmit ? 'text-emerald-700' : 'text-red-700'"><li v-for="risk in preview.riskCodes" :key="risk">• {{ riskLabel(risk) }}</li></ul>
          </div>
        </div>

        <div class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <h2 class="font-semibold text-gray-900">最近金币明细</h2>
          <div v-if="selected.entries.length" class="mt-3 divide-y divide-gray-100">
            <article v-for="entry in selected.entries" :key="entry.entryId" class="min-w-0 py-3 first:pt-0">
              <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><p class="font-medium text-gray-900">{{ entry.reason.label }}</p><p class="mt-1 [overflow-wrap:anywhere] text-xs text-gray-500">{{ entry.publicReference }}</p></div><p class="shrink-0 font-semibold" :class="entry.direction === 'credit' ? 'text-emerald-700' : 'text-red-700'">{{ entry.direction === 'credit' ? '+' : '-' }}{{ entry.amount }}</p></div>
              <p class="mt-2 text-sm leading-5 text-gray-600 [overflow-wrap:anywhere]">{{ entry.userVisibleNote }}</p>
              <p class="mt-1 text-xs text-gray-400">余额 {{ entry.balanceAfter }} · {{ formatTime(entry.postedAt) }}</p>
            </article>
          </div>
          <p v-else class="mt-4 rounded-lg bg-gray-50 px-4 py-8 text-center text-sm text-gray-500">该账号暂无已入账金币明细</p>
        </div>
      </section>
    </template>

    <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div class="flex min-w-0 flex-col gap-3 border-b border-gray-200 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0"><h2 class="font-semibold text-gray-900">调币复核队列</h2><p class="mt-1 text-xs text-gray-500">发起人与复核人必须不同；批准时才追加分录并更新余额。</p></div>
        <select v-model="queueStatus" class="w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm sm:w-auto"><option v-for="option in statusOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select>
      </div>
      <div v-if="loadingQueue" class="p-8 text-center text-sm text-gray-500">复核队列读取中…</div>
      <div v-else-if="adjustments.length" class="grid min-w-0 gap-3 p-4 xl:grid-cols-2">
        <article v-for="item in adjustments" :key="item.adjustmentId" class="min-w-0 rounded-xl border border-gray-200 p-4">
          <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div class="min-w-0"><p class="font-medium text-gray-900">{{ actionLabel(item.actionType) }} · {{ item.amount }} 金币</p><p class="mt-1 break-all text-xs text-gray-500">{{ item.account.accountId }} · {{ item.businessReference }}</p></div><span class="w-fit shrink-0 rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">{{ statusLabel(item.status) }}</span></div>
          <dl class="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-gray-50 p-3 text-sm"><div><dt class="text-xs text-gray-500">余额预览</dt><dd class="mt-1 text-gray-900">{{ item.balanceBefore }} → {{ item.balanceAfter }}</dd></div><div><dt class="text-xs text-gray-500">当前余额</dt><dd class="mt-1 text-gray-900">{{ item.currentBalance }}</dd></div></dl>
          <p class="mt-3 text-sm leading-6 text-gray-700 [overflow-wrap:anywhere]">用户可见：{{ item.userVisibleNote }}</p>
          <p class="mt-1 text-xs leading-5 text-gray-500 [overflow-wrap:anywhere]">内部说明：{{ item.internalNote }}</p>
          <p class="mt-2 text-xs text-gray-400">发起：{{ item.requestedBy.label }} · {{ formatTime(item.createdAt) }}</p>
          <div v-if="item.status === 'pending_review'" class="mt-4 min-w-0 border-t border-gray-100 pt-4">
            <textarea v-model="reviewNotes[item.adjustmentId]" rows="2" maxlength="300" class="w-full min-w-0 resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="填写独立复核说明（必填）" />
            <div class="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row">
              <button class="w-full rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 sm:w-auto" :disabled="reviewingId === item.adjustmentId" @click="reviewAdjustment(item, 'approve')">批准并入账</button>
              <button class="w-full rounded-lg border border-red-300 bg-white px-4 py-2.5 text-sm font-medium text-red-700 disabled:opacity-50 sm:w-auto" :disabled="reviewingId === item.adjustmentId" @click="reviewAdjustment(item, 'reject')">拒绝申请</button>
            </div>
          </div>
          <p v-else-if="item.reviewedBy" class="mt-3 text-xs text-gray-500 [overflow-wrap:anywhere]">复核：{{ item.reviewedBy.label }} · {{ item.reviewNote }}</p>
        </article>
      </div>
      <p v-else class="p-10 text-center text-sm text-gray-500">当前筛选条件下暂无调币申请</p>
    </section>
  </div>
</template>
