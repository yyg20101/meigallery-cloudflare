<script setup lang="ts">
import type { AdminWalletBatch, AdminWalletBatchItem } from '~/types/admin-app-wallet-batches'
import {
  WALLET_BATCH_ITEM_STATUS_LABELS,
  WALLET_BATCH_STATUS_LABELS,
} from '~/types/admin-app-wallet-batches'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const route = useRoute()
const router = useRouter()
const loading = ref(true)
const operating = ref(false)
const errorMessage = ref('')
const errorCode = ref('')
const successMessage = ref('')
const batches = ref<AdminWalletBatch[]>([])
const selectedBatch = ref<AdminWalletBatch | null>(null)
const selectedBatchId = ref(typeof route.query.batch === 'string' ? route.query.batch : '')
const sourceName = ref('wallet-adjustments.csv')
const csvText = ref('account_id,action_type,amount,reason_code,user_visible_note,internal_note,business_reference\n')
const submitIdempotencyKey = ref('')

const pageState = computed(() => {
  if (errorMessage.value) return '操作失败'
  if (loading.value || operating.value) return '处理中'
  if (!selectedBatch.value) return batches.value.length ? '选择任务' : '尚无任务'
  return WALLET_BATCH_STATUS_LABELS[selectedBatch.value.status]
})
const pageTone = computed(() => {
  if (errorMessage.value || selectedBatch.value?.status === 'partial_failed') return 'danger' as const
  if (loading.value || operating.value) return 'warning' as const
  if (selectedBatch.value?.status === 'completed') return 'success' as const
  return 'neutral' as const
})
const canSubmit = computed(() => Boolean(
  selectedBatch.value
  && !selectedBatch.value.riskCodes.includes('TOTAL_AMOUNT_HIGH')
  && (
    ['draft', 'partial_failed'].includes(selectedBatch.value.status)
    || selectedBatch.value.processingRecoverable
  )
  && (selectedBatch.value.items?.some(item => (
    item.status === 'valid' || item.status === 'submit_failed'
    || (selectedBatch.value?.processingRecoverable && item.status === 'submitting')
  )) ?? false),
))
const figmaState = computed(() => {
  if (
    errorCode.value === 'WALLET_BATCH_TOTAL_AMOUNT_EXCEEDED'
    || selectedBatch.value?.riskCodes.includes('TOTAL_AMOUNT_HIGH')
  ) return '总额异常'
  if (
    selectedBatch.value?.riskCodes.includes('DUPLICATE_ROW')
    || selectedBatch.value?.items?.some(item => item.error?.code === 'BATCH_DUPLICATE_BUSINESS_REFERENCE')
  ) return '重复项'
  if (selectedBatch.value?.status === 'partial_failed') return '部分成功'
  return '正常'
})

await loadInitial()

async function loadInitial() {
  loading.value = true
  errorMessage.value = ''
  errorCode.value = ''
  try {
    await refreshBatches()
    if (selectedBatchId.value) await selectBatch(selectedBatchId.value, false)
  }
  catch (error) {
    errorCode.value = apiErrorCode(error)
    errorMessage.value = resolveApiErrorMessage(error, '批量调币工作台加载失败。')
  }
  finally {
    loading.value = false
  }
}

async function refreshBatches() {
  const response = await api<{ data: AdminWalletBatch[] }>('/api/admin/app/wallets/batches')
  batches.value = response.data
}

async function selectBatch(batchId: string, updateRoute = true) {
  loading.value = true
  errorMessage.value = ''
  errorCode.value = ''
  try {
    const response = await api<{ data: AdminWalletBatch }>(`/api/admin/app/wallets/batches/${batchId}`)
    selectedBatch.value = response.data
    selectedBatchId.value = batchId
    submitIdempotencyKey.value = ''
    if (updateRoute) await router.replace({ query: { ...route.query, batch: batchId } })
  }
  catch (error) {
    errorCode.value = apiErrorCode(error)
    errorMessage.value = resolveApiErrorMessage(error, '批量任务详情加载失败。')
  }
  finally {
    loading.value = false
  }
}

async function readCsvFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (file.size > 500_000) {
    errorMessage.value = 'CSV 不能超过 500 KB。'
    input.value = ''
    return
  }
  sourceName.value = file.name
  csvText.value = await file.text()
}

async function previewBatch() {
  if (!csvText.value.trim()) {
    errorMessage.value = '请粘贴 CSV 或选择文件。'
    return
  }
  await runOperation(async () => {
    const response = await api<{ data: AdminWalletBatch }>('/api/admin/app/wallets/batches/preview', {
      method: 'POST',
      headers: { 'Idempotency-Key': `wallet.batch.preview:${crypto.randomUUID()}` },
      body: { sourceName: sourceName.value, csvText: csvText.value },
    })
    selectedBatch.value = response.data
    selectedBatchId.value = response.data.batchId
    submitIdempotencyKey.value = ''
    await refreshBatches()
    await router.replace({ query: { ...route.query, batch: selectedBatchId.value } })
    successMessage.value = 'CSV 已逐行校验；当前没有任何金币余额发生变化。'
  })
}

async function submitBatch() {
  if (!selectedBatch.value || !canSubmit.value) return
  const recovering = selectedBatch.value.processingRecoverable
  if (!window.confirm(recovering
    ? '确认接管已超时的批量提交？系统将沿用逐行幂等凭证，仅继续未确认的行。'
    : '确认提交所有有效行？每行只会创建普通调币申请，仍需另一位管理员逐项复核后才能入账。')) return
  if (!submitIdempotencyKey.value) submitIdempotencyKey.value = `wallet.batch.submit:${crypto.randomUUID()}`
  await runOperation(async () => {
    const response = await api<{ data: AdminWalletBatch }>(`/api/admin/app/wallets/batches/${selectedBatch.value!.batchId}/submit`, {
      method: 'POST',
      headers: { 'Idempotency-Key': submitIdempotencyKey.value },
      body: { expectedVersion: selectedBatch.value!.version },
    })
    selectedBatch.value = response.data
    submitIdempotencyKey.value = ''
    await refreshBatches()
    successMessage.value = '有效行已创建为独立调币申请；请到单笔复核队列由另一位管理员处理。'
  })
}

async function runOperation(operation: () => Promise<void>) {
  operating.value = true
  errorMessage.value = ''
  errorCode.value = ''
  successMessage.value = ''
  try { await operation() }
  catch (error) {
    errorCode.value = apiErrorCode(error)
    errorMessage.value = resolveApiErrorMessage(error, '操作失败，请刷新后重试。')
  }
  finally { operating.value = false }
}

function rowClass(item: AdminWalletBatchItem) {
  if (item.status === 'submitted') return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (item.status === 'submitting') return 'bg-amber-50 text-amber-800 ring-amber-200'
  if (item.status === 'invalid' || item.status === 'submit_failed') return 'bg-red-50 text-red-700 ring-red-200'
  return 'bg-[#fff1f5] text-[#b92d5c] ring-[#f0cad6]'
}

function actionLabel(value: AdminWalletBatchItem['actionType']) {
  return { admin_credit: '管理员加币', admin_debit: '管理员扣币', compensation: '服务补偿', reversal: '冲正' }[value ?? ''] ?? '—'
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
    <AdminAppPageHeader page-id="ADM-WAL-05" route="/admin/app/coin-adjustment-batches" title="批量调币任务" description="上传、校验和复核批量调币，逐项返回结果并允许重试失败项。" :state="pageState" :figma-state="figmaState" :state-tone="pageTone">
      <template #actions>
        <button v-if="canSubmit" type="button" class="min-h-10 rounded-xl bg-[#2f2622] px-4 text-sm font-medium text-white hover:bg-black disabled:opacity-50" :disabled="operating" @click="submitBatch">{{ selectedBatch?.processingRecoverable ? '恢复提交' : '提交批量复核' }}</button>
      </template>
    </AdminAppPageHeader>

    <p v-if="successMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">{{ successMessage }}</p>
    <p v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">{{ errorMessage }}</p>

    <section class="rounded-2xl border border-[#eaded8] bg-white p-5 shadow-sm">
      <div class="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div class="min-w-0"><h2 class="font-semibold text-[#2f2622]">导入 CSV 并校验</h2><p class="mt-1 max-w-3xl text-sm leading-6 text-stone-600">最多 200 行、500 KB；列顺序固定。校验不会入账，提交只创建逐行独立复核申请。</p></div>
        <label class="inline-flex min-h-10 cursor-pointer items-center justify-center rounded-xl border border-[#dccbc3] bg-white px-4 text-sm font-medium text-stone-700 hover:bg-[#fff9f5]">选择 CSV<input type="file" accept=".csv,text/csv" class="sr-only" @change="readCsvFile" /></label>
      </div>
      <div class="mt-5 grid min-w-0 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <label class="min-w-0 text-sm text-stone-700">文件名<input v-model.trim="sourceName" maxlength="120" class="mt-1.5 w-full min-w-0 rounded-xl border border-[#dccbc3] px-3 py-2.5" /></label>
        <label class="min-w-0 text-sm text-stone-700">CSV 内容<textarea v-model="csvText" rows="7" class="mt-1.5 w-full min-w-0 resize-y rounded-xl border border-[#dccbc3] px-3 py-2.5 font-mono text-xs leading-5" /></label>
      </div>
      <div class="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><p class="break-all text-xs text-stone-500">表头：account_id, action_type, amount, reason_code, user_visible_note, internal_note, business_reference</p><button type="button" class="min-h-10 shrink-0 rounded-xl bg-[#d62f65] px-4 text-sm font-medium text-white hover:bg-[#bd2756] disabled:opacity-50" :disabled="operating" @click="previewBatch">{{ operating ? '校验中…' : '上传并校验' }}</button></div>
    </section>

    <section class="grid min-w-0 gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside class="min-w-0 rounded-2xl border border-[#eaded8] bg-white p-4 shadow-sm">
        <div class="flex items-center justify-between gap-3"><h2 class="font-semibold text-[#2f2622]">批量任务</h2><span class="text-xs text-stone-500">{{ batches.length }} 项</span></div>
        <div v-if="batches.length" class="mt-4 space-y-2"><button v-for="batch in batches" :key="batch.batchId" type="button" class="w-full min-w-0 rounded-xl border p-3 text-left" :class="batch.batchId === selectedBatchId ? 'border-[#d62f65] bg-[#fff5f7]' : 'border-[#eee1db] hover:border-[#d9b7c3]'" @click="selectBatch(batch.batchId)"><span class="block truncate text-sm font-medium text-[#2f2622]">{{ batch.sourceName }}</span><span class="mt-1 block text-xs text-stone-500">{{ WALLET_BATCH_STATUS_LABELS[batch.status] }} · {{ batch.validCount }}/{{ batch.totalCount }} 有效</span><span class="mt-2 block break-all text-[10px] text-stone-400">{{ batch.batchId }}</span></button></div>
        <p v-else class="mt-4 rounded-xl bg-[#fff9f5] px-3 py-8 text-center text-sm text-stone-500">尚无批量任务</p>
      </aside>

      <div class="min-w-0">
        <section v-if="loading" class="rounded-2xl border border-[#eaded8] bg-white p-10 text-center text-sm text-stone-500">正在读取批量任务…</section>
        <section v-else-if="selectedBatch" class="overflow-hidden rounded-2xl border border-[#eaded8] bg-white shadow-sm">
          <div class="border-b border-[#eee1db] p-5">
            <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between"><div class="min-w-0"><p class="break-all text-xs font-medium text-[#b92d5c]">{{ selectedBatch.batchId }}</p><h2 class="mt-2 text-lg font-semibold text-[#2f2622]">{{ selectedBatch.sourceName }}</h2><p class="mt-1 text-sm text-stone-500">{{ WALLET_BATCH_STATUS_LABELS[selectedBatch.status] }} · 创建 {{ formatTime(selectedBatch.createdAt) }} · 版本 {{ selectedBatch.version }}</p></div><NuxtLink to="/admin/app/wallets" class="inline-flex min-h-10 items-center justify-center rounded-xl border border-[#dccbc3] bg-white px-4 text-sm text-stone-700">查看单笔复核队列</NuxtLink></div>
            <div class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><div v-for="metric in [{ label: '总行数', value: selectedBatch.totalCount }, { label: '校验通过', value: selectedBatch.validCount }, { label: '校验失败', value: selectedBatch.invalidCount }, { label: '总金币', value: selectedBatch.totalAmount }]" :key="metric.label" class="rounded-xl bg-[#fff9f5] p-4"><p class="text-xs text-stone-500">{{ metric.label }}</p><p class="mt-2 text-2xl font-semibold text-[#2f2622]">{{ metric.value }}</p></div></div>
            <div v-if="selectedBatch.riskCodes.length" class="mt-4 flex flex-wrap gap-2"><span v-for="risk in selectedBatch.riskCodes" :key="risk" class="rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">{{ risk }}</span></div>
            <p v-if="selectedBatch.riskCodes.includes('TOTAL_AMOUNT_HIGH')" class="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">批量金币总额超过治理上限，当前任务仅保留校验证据，不允许提交。请拆分 CSV 后重新校验。</p>
            <p v-else-if="selectedBatch.processingRecoverable" class="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">上次提交租约已超时，可由任务创建人恢复。已成功创建的单笔申请会通过逐行幂等键复用，不会重复创建。</p>
          </div>
          <div class="overflow-x-auto"><table class="w-full min-w-[1080px] table-fixed text-left text-sm"><thead class="bg-[#fffaf7] text-xs text-stone-500"><tr><th class="w-[8%] px-4 py-3 font-medium">行</th><th class="w-[19%] px-4 py-3 font-medium">账号</th><th class="w-[18%] px-4 py-3 font-medium">操作</th><th class="w-[21%] px-4 py-3 font-medium">业务单号</th><th class="w-[14%] px-4 py-3 font-medium">状态</th><th class="w-[20%] px-4 py-3 font-medium">结果</th></tr></thead><tbody class="divide-y divide-[#f2e8e3]"><tr v-for="item in selectedBatch.items" :key="item.itemId" class="align-top"><td class="px-4 py-4 text-stone-500">{{ item.rowNumber }}</td><td class="break-all px-4 py-4 font-medium text-[#2f2622]">{{ item.accountId || '无法解析' }}</td><td class="px-4 py-4"><p>{{ actionLabel(item.actionType) }}</p><p class="mt-1 text-xs text-stone-500">{{ item.amount ?? '—' }} 金币</p></td><td class="break-all px-4 py-4 text-stone-600">{{ item.businessReference || '—' }}</td><td class="px-4 py-4"><span class="inline-flex rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="rowClass(item)">{{ WALLET_BATCH_ITEM_STATUS_LABELS[item.status] }}</span></td><td class="px-4 py-4"><NuxtLink v-if="item.adjustmentId" :to="`/admin/app/coin-adjustments/${item.adjustmentId}/review`" class="break-all text-[#c52e61] underline underline-offset-2">{{ item.adjustmentId }}</NuxtLink><p v-else-if="item.error" class="break-words text-xs leading-5 text-red-700"><span class="font-medium">{{ item.error.code }}</span><br />{{ item.error.summary }}</p><p v-else class="text-xs text-stone-400">等待提交</p></td></tr></tbody></table></div>
        </section>
        <section v-else class="rounded-2xl border border-dashed border-[#dccbc3] bg-white p-12 text-center"><h2 class="font-semibold text-[#2f2622]">选择或创建批量任务</h2><p class="mt-2 text-sm text-stone-500">校验结果与单笔调币申请一一对应，不存在批量直接入账。</p></section>
      </div>
    </section>
  </div>
</template>
