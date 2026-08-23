<script setup lang="ts">
import type {
  WalletReconciliationCase,
  WalletReconciliationRecoveryPreview,
  WalletReconciliationRun,
  WalletRecovery,
} from '~/types/admin-app-wallet-reconciliation'
import {
  WALLET_RECONCILIATION_STATUS_LABELS,
  WALLET_RECONCILIATION_TYPE_LABELS,
} from '~/types/admin-app-wallet-reconciliation'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()
const loading = ref(true)
const operatingId = ref('')
const errorMessage = ref('')
const errorCode = ref('')
const successMessage = ref('')
const runs = ref<WalletReconciliationRun[]>([])
const cases = ref<WalletReconciliationCase[]>([])
const statusFilter = ref('')
const scanLimit = ref(500)
const notes = reactive<Record<string, {
  userVisible: string
  internal: string
  resolution: string
  recoveryResolution: string
  recoveryEvidence: string
}>>({})
const scanIdempotencyKey = ref('')
const recoveryPreviews = ref<Record<string, WalletReconciliationRecoveryPreview>>({})
const recoveryIdempotencyKeys = reactive<Record<string, string>>({})

const pageState = computed(() => {
  if (errorMessage.value) return '操作失败'
  if (loading.value || operatingId.value) return '处理中'
  if (cases.value.some(item => item.walletStatus === 'frozen')) return '钱包冻结待恢复'
  if (cases.value.some(item => item.status === 'open')) return '存在未认领差异'
  if (cases.value.some(item => item.status === 'claimed' || item.status === 'forward_fix_requested')) return '处置中'
  return cases.value.length ? '已完成核查' : '暂无差异'
})
const pageTone = computed(() => {
  if (
    errorMessage.value
    || cases.value.some(item => item.walletStatus === 'frozen')
    || cases.value.some(item => item.severity === 'p0' && item.status === 'open')
  ) return 'danger' as const
  if (loading.value || operatingId.value || cases.value.some(item => ['claimed', 'forward_fix_requested'].includes(item.status))) return 'warning' as const
  return 'success' as const
})
const figmaState = computed(() => {
  if (
    errorCode.value === 'WALLET_FROZEN'
    || cases.value.some(item => item.walletStatus === 'frozen')
    || cases.value.some(item => item.severity === 'p0' && item.status !== 'resolved' && item.status !== 'dismissed')
  ) return '钱包冻结'
  if (
    errorCode.value === 'WALLET_RECONCILIATION_STILL_MISMATCHED'
    || cases.value.some(item => item.status === 'open' || item.status === 'claimed' || item.status === 'creating_forward_fix')
  ) return '差异未解释'
  return '正常'
})

await refreshAll()

watch(statusFilter, refreshCases)

async function refreshAll() {
  loading.value = true
  errorMessage.value = ''
  errorCode.value = ''
  try { await Promise.all([refreshRuns(), refreshCases()]) }
  catch (error) {
    errorCode.value = apiErrorCode(error)
    errorMessage.value = resolveApiErrorMessage(error, '钱包对账工作台加载失败。')
  }
  finally { loading.value = false }
}

async function refreshRuns() {
  const response = await api<{ data: WalletReconciliationRun[] }>('/api/admin/app/wallets/reconciliation/runs')
  runs.value = response.data
}

async function refreshCases() {
  const response = await api<{ data: WalletReconciliationCase[] }>('/api/admin/app/wallets/reconciliation/cases', { query: { status: statusFilter.value || undefined } })
  cases.value = response.data
  recoveryPreviews.value = {}
  for (const item of cases.value) {
    notes[item.caseId] ??= {
      userVisible: '平台已完成账务纠正，金币余额以最新明细为准。',
      internal: '',
      resolution: '',
      recoveryResolution: '',
      recoveryEvidence: '',
    }
  }
}

async function scanWallets() {
  if (!scanIdempotencyKey.value) scanIdempotencyKey.value = `wallet.reconciliation.scan:${crypto.randomUUID()}`
  await operate('scan', async () => {
    const response = await api<{ data: { run: WalletReconciliationRun; cases: WalletReconciliationCase[] } }>('/api/admin/app/wallets/reconciliation/scans', {
      method: 'POST',
      headers: { 'Idempotency-Key': scanIdempotencyKey.value },
      body: { limit: scanLimit.value },
    })
    await Promise.all([refreshRuns(), refreshCases()])
    scanIdempotencyKey.value = ''
    successMessage.value = `扫描完成：核查 ${response.data.run.walletCount} 个钱包，识别 ${response.data.run.differenceCount} 条差异。`
  })
}

async function claimCase(item: WalletReconciliationCase) {
  await operate(item.caseId, async () => {
    await api(`/api/admin/app/wallets/reconciliation/cases/${item.caseId}/claim`, {
      method: 'POST',
      body: { expectedVersion: item.version },
    })
    await refreshCases()
    successMessage.value = '对账差异已认领；请先核对证据，再决定是否创建 forward-fix。'
  })
}

async function createForwardFix(item: WalletReconciliationCase) {
  const note = notes[item.caseId]
  if (!note || note.internal.trim().length < 2 || note.userVisible.trim().length < 2) {
    errorMessage.value = '请填写用户可见说明和至少 2 个字符的内部处置依据。'
    return
  }
  if (!window.confirm(`确认创建 ${item.forwardFix.direction === 'credit' ? '加币' : '扣币'} ${item.forwardFix.amount} 的追加式纠正申请？仍需另一位管理员独立复核。`)) return
  await operate(item.caseId, async () => {
    await api(`/api/admin/app/wallets/reconciliation/cases/${item.caseId}/forward-fix`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `wallet.reconciliation.fix:${crypto.randomUUID()}` },
      body: { expectedVersion: item.version, userVisibleNote: note.userVisible, internalNote: note.internal },
    })
    await refreshCases()
    successMessage.value = '追加式纠正申请已创建；须由另一位管理员在调币复核页批准后才会入账。'
  })
}

async function verifyResolution(item: WalletReconciliationCase) {
  const resolutionNote = notes[item.caseId]?.resolution.trim() ?? ''
  if (resolutionNote.length < 2) {
    errorMessage.value = '请填写重建验证说明。'
    return
  }
  await operate(item.caseId, async () => {
    await api(`/api/admin/app/wallets/reconciliation/cases/${item.caseId}/verify`, {
      method: 'POST',
      body: { expectedVersion: item.version, resolutionNote },
    })
    await refreshCases()
    successMessage.value = '当前钱包快照与最新不可变分录已重新验证一致，案件已关闭。'
  })
}

async function inspectRecovery(item: WalletReconciliationCase) {
  await operate(`${item.caseId}:recovery-preview`, async () => {
    const response = await api<{ data: WalletReconciliationRecoveryPreview }>(`/api/admin/app/wallets/reconciliation/cases/${item.caseId}/recovery-preview`)
    recoveryPreviews.value = { ...recoveryPreviews.value, [item.caseId]: response.data }
    if (response.data.eligible) successMessage.value = '恢复条件已重验；填写证据后可原子重建快照并解冻。'
  })
}

async function recoverWallet(item: WalletReconciliationCase) {
  const preview = recoveryPreviews.value[item.caseId]
  const note = notes[item.caseId]
  if (!preview || !preview.eligible) {
    errorMessage.value = '请先检查并通过钱包恢复条件。'
    return
  }
  if (!note || note.recoveryResolution.trim().length < 2 || note.recoveryEvidence.trim().length < 3) {
    errorMessage.value = '请填写至少 2 个字符的恢复结论和至少 3 个字符的证据引用。'
    return
  }
  if (!window.confirm(`确认把钱包快照从 ${preview.walletBalance}/${preview.walletSequence} 重建为 ${preview.rebuiltBalance}/${preview.rebuiltSequence}，关闭 ${preview.coveredCases.length} 个对账案件并解冻？`)) return
  recoveryIdempotencyKeys[item.caseId] ??= `wallet.recovery:${crypto.randomUUID()}`
  await operate(`${item.caseId}:recover`, async () => {
    const response = await api<{ data: { recovery: WalletRecovery; reconciliationCase: WalletReconciliationCase; replayed: boolean } }>(`/api/admin/app/wallets/reconciliation/cases/${item.caseId}/recover`, {
      method: 'POST',
      headers: { 'Idempotency-Key': recoveryIdempotencyKeys[item.caseId] },
      body: {
        expectedVersion: preview.anchorVersion,
        caseSetDigest: preview.caseSetDigest,
        resolutionNote: note.recoveryResolution,
        evidenceReference: note.recoveryEvidence,
      },
    })
    delete recoveryIdempotencyKeys[item.caseId]
    await refreshCases()
    successMessage.value = `钱包已恢复：快照 ${response.data.recovery.rebuiltSnapshot.balance}/${response.data.recovery.rebuiltSnapshot.sequence}，覆盖 ${response.data.recovery.coveredCaseCount} 个案件。`
  })
}

async function operate(id: string, operation: () => Promise<void>) {
  operatingId.value = id
  errorMessage.value = ''
  errorCode.value = ''
  successMessage.value = ''
  try { await operation() }
  catch (error) {
    errorCode.value = apiErrorCode(error)
    errorMessage.value = resolveApiErrorMessage(error, '对账操作失败，请刷新后重试。')
    if (id === 'scan' && errorCode.value === 'WALLET_RECONCILIATION_SCAN_EXPIRED') scanIdempotencyKey.value = ''
  }
  finally { operatingId.value = '' }
}

function statusClass(item: WalletReconciliationCase) {
  if (item.status === 'resolved') return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (item.severity === 'p0' && item.status === 'open') return 'bg-red-50 text-red-700 ring-red-200'
  if (item.status === 'claimed' || item.status === 'forward_fix_requested') return 'bg-amber-50 text-amber-800 ring-amber-200'
  return 'bg-stone-100 text-stone-700 ring-stone-200'
}

function isRecoveryAnchor(item: WalletReconciliationCase) {
  if (!isOwner.value || item.walletStatus !== 'frozen' || (item.status !== 'claimed' && item.status !== 'resolved')) return false
  return cases.value.find(candidate => (
    candidate.accountId === item.accountId
    && candidate.walletStatus === 'frozen'
    && (candidate.status === 'claimed' || candidate.status === 'resolved')
  ))?.caseId === item.caseId
}

function formatTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function apiErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return ''
  const candidate = error as { data?: unknown }
  let data = candidate.data
  if (typeof data === 'string') {
    try { data = JSON.parse(data) }
    catch { return '' }
  }
  if (!data || typeof data !== 'object') return ''
  const code = (data as { error?: { code?: unknown } }).error?.code
  return typeof code === 'string' ? code : ''
}
</script>

<template>
  <div class="min-w-0 space-y-6">
    <AdminAppPageHeader page-id="ADM-WAL-06" route="/admin/app/reconciliation" title="钱包对账差异" description="识别余额、sequence 和有效分录差异，通过 forward-fix 或受控快照重建恢复。" :state="pageState" :figma-state="figmaState" :state-tone="pageTone">
      <template #actions>
        <button v-if="isOwner" type="button" class="min-h-10 rounded-xl bg-[#2f2622] px-4 text-sm font-medium text-white hover:bg-black disabled:opacity-50" :disabled="Boolean(operatingId)" @click="scanWallets">{{ operatingId === 'scan' ? '扫描中…' : '运行对账扫描' }}</button>
      </template>
    </AdminAppPageHeader>

    <p v-if="successMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">{{ successMessage }}</p>
    <p v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">{{ errorMessage }}</p>

    <section class="rounded-2xl border border-[#eaded8] bg-white p-5 shadow-sm">
      <div class="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div class="min-w-0"><h2 class="font-semibold text-[#2f2622]">不可变账本核查</h2><p class="mt-1 max-w-3xl text-sm leading-6 text-stone-600">比较钱包快照、最新分录和 sequence 连续性。扫描不会冻结或修改钱包；发现 P0/P1 后由 Owner 认领并按 Runbook 处置。</p></div>
        <div class="flex flex-col gap-3 sm:flex-row"><label class="text-sm text-stone-700">扫描上限<input v-model.number="scanLimit" type="number" min="1" max="500" class="ml-2 w-24 rounded-lg border border-[#dccbc3] px-2 py-2" /></label><select v-model="statusFilter" class="min-h-10 rounded-xl border border-[#dccbc3] bg-white px-3 text-sm text-stone-700"><option value="">全部状态</option><option value="open">待认领</option><option value="claimed">处理中</option><option value="forward_fix_requested">等待纠正入账</option><option value="resolved">已解决</option></select></div>
      </div>
    </section>

    <section class="grid min-w-0 gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside class="min-w-0 rounded-2xl border border-[#eaded8] bg-white p-4 shadow-sm">
        <div class="flex items-center justify-between gap-3"><h2 class="font-semibold text-[#2f2622]">扫描记录</h2><span class="text-xs text-stone-500">{{ runs.length }} 次</span></div>
        <div v-if="runs.length" class="mt-4 space-y-2"><article v-for="run in runs" :key="run.runId" class="rounded-xl border border-[#eee1db] p-3"><div class="flex items-start justify-between gap-2"><p class="break-all text-xs font-medium text-[#2f2622]">{{ run.runId }}</p><span class="shrink-0 rounded-full bg-stone-100 px-2 py-0.5 text-[10px] text-stone-600">{{ run.status === 'completed' ? '已完成' : run.status === 'running' ? '运行中' : '执行失败' }}</span></div><p class="mt-2 text-sm text-stone-600">钱包 {{ run.walletCount }} · 差异 {{ run.differenceCount }}</p><p v-if="run.failureCode" class="mt-1 break-all text-xs text-red-600">{{ run.failureCode }}</p><p class="mt-1 text-xs text-stone-400">{{ formatTime(run.createdAt) }}</p></article></div>
        <p v-else class="mt-4 rounded-xl bg-[#fff9f5] px-3 py-8 text-center text-sm text-stone-500">尚无扫描记录</p>
      </aside>

      <section class="min-w-0 overflow-hidden rounded-2xl border border-[#eaded8] bg-white shadow-sm">
        <div class="border-b border-[#eee1db] px-5 py-4"><h2 class="font-semibold text-[#2f2622]">差异案件</h2><p class="mt-1 text-xs leading-5 text-stone-500">只有余额差异且 sequence 可安全续接时，才可创建普通调币纠正申请；其他类型必须人工 Runbook。</p></div>
        <div v-if="loading" class="p-12 text-center text-sm text-stone-500">正在读取对账结果…</div>
        <div v-else-if="cases.length" class="divide-y divide-[#f2e8e3]">
          <article v-for="item in cases" :key="item.caseId" class="min-w-0 p-5">
            <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><span class="rounded-full bg-red-50 px-2 py-1 text-xs font-semibold uppercase text-red-700">{{ item.severity }}</span><span class="inline-flex rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="statusClass(item)">{{ WALLET_RECONCILIATION_STATUS_LABELS[item.status] }}</span><span v-if="item.walletStatus" class="inline-flex rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="item.walletStatus === 'frozen' ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-emerald-50 text-emerald-700 ring-emerald-200'">{{ item.walletStatus === 'frozen' ? '钱包冻结' : '钱包可用' }}</span></div><h3 class="mt-3 break-all font-semibold text-[#2f2622]">{{ WALLET_RECONCILIATION_TYPE_LABELS[item.differenceType] }} · {{ item.accountId }}</h3><p class="mt-1 break-all text-xs text-stone-500">{{ item.caseId }} · 证据 {{ item.evidenceSha256 }}</p><p v-if="item.latestRecovery" class="mt-1 break-all text-xs text-emerald-700">最近恢复 {{ item.latestRecovery.commandId }} · {{ formatTime(item.latestRecovery.appliedAt) }}</p></div>
              <button v-if="item.status === 'open' && isOwner" type="button" class="min-h-10 shrink-0 rounded-xl bg-[#d62f65] px-4 text-sm font-medium text-white disabled:opacity-50" :disabled="operatingId === item.caseId" @click="claimCase(item)">认领差异</button>
            </div>
            <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><div class="rounded-xl bg-[#fff9f5] p-3"><p class="text-xs text-stone-500">钱包余额</p><p class="mt-1 text-lg font-semibold text-[#2f2622]">{{ item.walletBalance }}</p></div><div class="rounded-xl bg-[#fff9f5] p-3"><p class="text-xs text-stone-500">分录期望余额</p><p class="mt-1 text-lg font-semibold text-[#2f2622]">{{ item.expectedBalance }}</p></div><div class="rounded-xl bg-[#fff9f5] p-3"><p class="text-xs text-stone-500">钱包 sequence</p><p class="mt-1 text-lg font-semibold text-[#2f2622]">{{ item.walletSequence }}</p></div><div class="rounded-xl bg-[#fff9f5] p-3"><p class="text-xs text-stone-500">期望 sequence</p><p class="mt-1 text-lg font-semibold text-[#2f2622]">{{ item.expectedSequence }}</p></div></div>
            <p class="mt-4 rounded-xl px-4 py-3 text-sm leading-6" :class="item.forwardFix.eligible ? 'border border-emerald-200 bg-emerald-50 text-emerald-800' : 'border border-amber-200 bg-amber-50 text-amber-900'">{{ item.forwardFix.reason }}<template v-if="item.forwardFix.eligible">：{{ item.forwardFix.direction === 'credit' ? '加币' : '扣币' }} {{ item.forwardFix.amount }}</template></p>
            <div v-if="item.status === 'claimed' && item.forwardFix.eligible" class="mt-4 grid gap-3 lg:grid-cols-2"><label class="text-sm text-stone-700">用户可见说明<textarea v-model.trim="notes[item.caseId].userVisible" rows="2" maxlength="160" class="mt-1 w-full min-w-0 resize-y rounded-xl border border-[#dccbc3] px-3 py-2" /></label><label class="text-sm text-stone-700">内部处置依据<textarea v-model.trim="notes[item.caseId].internal" rows="2" maxlength="320" class="mt-1 w-full min-w-0 resize-y rounded-xl border border-[#dccbc3] px-3 py-2" placeholder="说明差异原因、证据和 Runbook 步骤" /></label><div class="lg:col-span-2"><button type="button" class="min-h-10 rounded-xl bg-[#2f2622] px-4 text-sm font-medium text-white disabled:opacity-50" :disabled="operatingId === item.caseId" @click="createForwardFix(item)">创建追加式纠正申请</button></div></div>
            <div v-else-if="item.status === 'forward_fix_requested'" class="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]"><div class="min-w-0"><NuxtLink :to="`/admin/app/coin-adjustments/${item.forwardFixAdjustmentId}/review`" class="break-all text-sm font-medium text-[#c52e61] underline underline-offset-2">查看纠正申请 {{ item.forwardFixAdjustmentId }}</NuxtLink><textarea v-model.trim="notes[item.caseId].resolution" rows="2" maxlength="500" class="mt-3 w-full min-w-0 resize-y rounded-xl border border-[#dccbc3] px-3 py-2 text-sm" :disabled="!isOwner" placeholder="调币独立复核入账后，填写重建验证说明" /></div><button v-if="isOwner" type="button" class="min-h-10 self-end rounded-xl border border-[#dccbc3] bg-white px-4 text-sm font-medium text-stone-700 disabled:opacity-50" :disabled="operatingId === item.caseId" @click="verifyResolution(item)">重建并验证</button></div>
            <p v-else-if="item.assignedTo" class="mt-4 text-sm text-stone-500">负责人：{{ item.assignedTo.label }} · {{ formatTime(item.claimedAt) }}<template v-if="item.resolutionNote"> · {{ item.resolutionNote }}</template></p>
            <section v-if="isRecoveryAnchor(item)" class="mt-4 rounded-xl border border-red-200 bg-red-50 p-4">
              <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div class="min-w-0"><h4 class="font-semibold text-red-900">受控快照恢复</h4><p class="mt-1 text-sm leading-6 text-red-800">只以不可变分录末态重建快照；同一钱包全部未终结案件必须由当前 Owner 认领，分录链断裂时硬阻断。</p></div>
                <button type="button" class="min-h-10 shrink-0 rounded-xl border border-red-300 bg-white px-4 text-sm font-medium text-red-800 disabled:opacity-50" :disabled="Boolean(operatingId)" @click="inspectRecovery(item)">{{ operatingId === `${item.caseId}:recovery-preview` ? '检查中…' : '检查恢复条件' }}</button>
              </div>
              <template v-if="recoveryPreviews[item.caseId]">
                <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><div class="rounded-lg bg-white p-3"><p class="text-xs text-stone-500">当前余额 / sequence</p><p class="mt-1 font-semibold text-[#2f2622]">{{ recoveryPreviews[item.caseId].walletBalance }} / {{ recoveryPreviews[item.caseId].walletSequence }}</p></div><div class="rounded-lg bg-white p-3"><p class="text-xs text-stone-500">重建余额 / sequence</p><p class="mt-1 font-semibold text-[#2f2622]">{{ recoveryPreviews[item.caseId].rebuiltBalance }} / {{ recoveryPreviews[item.caseId].rebuiltSequence }}</p></div><div class="rounded-lg bg-white p-3"><p class="text-xs text-stone-500">覆盖案件</p><p class="mt-1 font-semibold text-[#2f2622]">{{ recoveryPreviews[item.caseId].coveredCases.length }}</p></div><div class="rounded-lg bg-white p-3"><p class="text-xs text-stone-500">恢复动作</p><p class="mt-1 font-semibold text-[#2f2622]">{{ recoveryPreviews[item.caseId].snapshotChangeRequired ? '重建并解冻' : '验证后解冻' }}</p></div></div>
                <ul v-if="!recoveryPreviews[item.caseId].eligible" class="mt-3 list-disc space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-8 py-3 text-sm text-amber-900"><li v-for="blocker in recoveryPreviews[item.caseId].blockers" :key="blocker">{{ blocker }}</li></ul>
                <div v-else class="mt-4 grid gap-3 lg:grid-cols-2">
                  <label class="text-sm text-red-950">恢复结论<textarea v-model.trim="notes[item.caseId].recoveryResolution" rows="2" maxlength="500" class="mt-1 w-full min-w-0 resize-y rounded-xl border border-red-200 bg-white px-3 py-2" placeholder="说明核对结果和快照重建理由" /></label>
                  <label class="text-sm text-red-950">证据引用<textarea v-model.trim="notes[item.caseId].recoveryEvidence" rows="2" maxlength="300" class="mt-1 w-full min-w-0 resize-y rounded-xl border border-red-200 bg-white px-3 py-2" placeholder="事件、Runbook、工单或受控证据引用" /></label>
                  <div class="lg:col-span-2"><button type="button" class="min-h-10 rounded-xl bg-red-700 px-4 text-sm font-medium text-white disabled:opacity-50" :disabled="Boolean(operatingId)" @click="recoverWallet(item)">{{ operatingId === `${item.caseId}:recover` ? '恢复中…' : '重建快照并解冻' }}</button></div>
                </div>
              </template>
            </section>
          </article>
        </div>
        <div v-else class="p-12 text-center"><h2 class="font-semibold text-[#2f2622]">当前筛选范围没有对账差异</h2><p class="mt-2 text-sm text-stone-500">可运行新扫描重新核对钱包快照与不可变分录。</p></div>
      </section>
    </section>
  </div>
</template>
