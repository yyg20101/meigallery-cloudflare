<script setup lang="ts">
import type { MembershipCatalogDetail, MembershipCatalogSummary } from '~/types/admin-app-membership-catalog'
import type {
  MembershipLegacyItem,
  MembershipLegacyJob,
  MembershipLegacyWorkspace,
} from '~/types/admin-app-membership-migrations'
import {
  MEMBERSHIP_LEGACY_ITEM_LABELS,
  MEMBERSHIP_LEGACY_JOB_LABELS,
} from '~/types/admin-app-membership-migrations'
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
const jobs = ref<MembershipLegacyJob[]>([])
const workspace = ref<MembershipLegacyWorkspace | null>(null)
const catalogs = ref<MembershipCatalogSummary[]>([])
const selectedCatalogId = ref('')
const catalog = ref<MembershipCatalogDetail | null>(null)
const selectedJobId = ref(typeof route.query.job === 'string' ? route.query.job : '')
const reviewNotes = reactive<Record<string, string>>({})
const mappingRows = ref([
  { legacyLevelCode: 'vip', targetTierId: '' },
  { legacyLevelCode: 'svip', targetTierId: '' },
])
const dryRunLimit = ref(50)
const executeIdempotencyKey = ref('')

const pageState = computed(() => {
  if (errorMessage.value) return '操作失败'
  if (loading.value || operating.value) return '处理中'
  if (!workspace.value) return jobs.value.length ? '选择任务' : '尚无任务'
  return MEMBERSHIP_LEGACY_JOB_LABELS[workspace.value.job.status]
})
const pageTone = computed(() => {
  if (errorMessage.value) return 'danger' as const
  if (loading.value || operating.value || workspace.value?.job.status === 'pending_review') return 'warning' as const
  if (workspace.value?.job.status === 'partial_failed') return 'danger' as const
  if (workspace.value?.job.status === 'completed') return 'success' as const
  return 'neutral' as const
})
const availableTiers = computed(() => catalog.value?.tiers ?? [])
const figmaState = computed(() => {
  const items = workspace.value?.items ?? []
  if (
    errorCode.value === 'MEMBERSHIP_MIGRATION_MAPPING_INVALID'
    || errorCode.value === 'MEMBERSHIP_MIGRATION_MAPPING_DUPLICATE'
    || errorCode.value === 'MEMBERSHIP_MIGRATION_TARGET_INVALID'
    || items.some(item => item.status === 'conflict')
  ) return '映射冲突'
  if (
    errorCode.value === 'MEMBERSHIP_MIGRATION_SOURCE_EMPTY'
    || errorCode.value === 'MEMBERSHIP_MIGRATION_EVIDENCE_INVALID'
    || errorCode.value === 'MEMBERSHIP_MIGRATION_DATA_INVALID'
    || items.some(item => item.status === 'evidence_insufficient' || item.status === 'stale')
  ) return '证据不足'
  return '正常'
})

await loadInitial()

async function loadInitial() {
  loading.value = true
  errorMessage.value = ''
  errorCode.value = ''
  try {
    const catalogResponse = await api<{ data: MembershipCatalogSummary[] }>('/api/admin/app/memberships/catalogs')
    catalogs.value = catalogResponse.data
    selectedCatalogId.value = catalogs.value.find(item => item.activeRuntimeReference)?.catalogVersionId
      ?? catalogs.value.find(item => item.state === 'published')?.catalogVersionId
      ?? catalogs.value[0]?.catalogVersionId
      ?? ''
    if (selectedCatalogId.value) {
      const detail = await api<{ data: MembershipCatalogDetail }>(`/api/admin/app/memberships/catalogs/${selectedCatalogId.value}`)
      catalog.value = detail.data
    }
    await refreshJobs()
    if (selectedJobId.value) await selectJob(selectedJobId.value, false)
  }
  catch (error) {
    errorCode.value = apiErrorCode(error)
    errorMessage.value = resolveApiErrorMessage(error, '旧会员迁移工作台加载失败。')
  }
  finally {
    loading.value = false
  }
}

async function refreshJobs() {
  const response = await api<{ data: MembershipLegacyJob[] }>('/api/admin/app/memberships/migrations')
  jobs.value = response.data
}

async function selectJob(jobId: string, updateRoute = true) {
  loading.value = true
  errorMessage.value = ''
  errorCode.value = ''
  try {
    const response = await api<{ data: MembershipLegacyWorkspace }>(`/api/admin/app/memberships/migrations/${jobId}`)
    workspace.value = response.data
    selectedJobId.value = jobId
    executeIdempotencyKey.value = ''
    if (updateRoute) await router.replace({ query: { ...route.query, job: jobId } })
  }
  catch (error) {
    errorCode.value = apiErrorCode(error)
    errorMessage.value = resolveApiErrorMessage(error, '迁移任务详情加载失败。')
  }
  finally {
    loading.value = false
  }
}

async function createDryRun() {
  const mappings = mappingRows.value
    .map(row => ({ legacyLevelCode: row.legacyLevelCode.trim(), targetTierId: row.targetTierId }))
    .filter(row => row.legacyLevelCode && row.targetTierId)
  if (!mappings.length) {
    errorMessage.value = '至少填写一条旧等级到新等级的显式映射。'
    return
  }
  await runOperation(async () => {
    const response = await api<{ data: MembershipLegacyWorkspace }>('/api/admin/app/memberships/migrations/dry-run', {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey('legacy-dry-run') },
      body: { mappings, limit: dryRunLimit.value },
    })
    workspace.value = response.data
    selectedJobId.value = response.data.job.jobId
    await refreshJobs()
    await router.replace({ query: { ...route.query, job: selectedJobId.value } })
    successMessage.value = 'Dry-run 已完成；冲突条目不会进入复核。'
  })
}

async function submitJob() {
  if (!workspace.value) return
  await runOperation(async () => {
    const response = await api<{ data: MembershipLegacyWorkspace }>(`/api/admin/app/memberships/migrations/${workspace.value!.job.jobId}/submit`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey('legacy-submit') },
      body: { expectedVersion: workspace.value!.job.version },
    })
    workspace.value = response.data
    await refreshJobs()
    successMessage.value = '可迁移条目已提交另一位 Owner 逐项复核。'
  })
}

async function reviewItem(item: MembershipLegacyItem, decision: 'approve' | 'reject') {
  if (!workspace.value) return
  const note = reviewNotes[item.itemId]?.trim() ?? ''
  if (note.length < 2) {
    errorMessage.value = '请填写至少 2 个字符的独立复核说明。'
    return
  }
  await runOperation(async () => {
    const response = await api<{ data: MembershipLegacyWorkspace }>(`/api/admin/app/memberships/migrations/${workspace.value!.job.jobId}/items/${item.itemId}/review`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newIdempotencyKey(`legacy-${decision}`) },
      body: { decision, expectedVersion: item.version, reviewNote: note },
    })
    workspace.value = response.data
    await refreshJobs()
    successMessage.value = decision === 'approve' ? '该条迁移已批准，等待受控执行。' : '该条迁移已拒绝，不会生成 App 会员。'
  })
}

async function executeJob() {
  if (!workspace.value || !window.confirm(workspace.value.permissions.executionRecoverable
    ? '确认恢复超时的迁移执行？系统只会继续处理尚未完成的已批准条目。'
    : '确认执行所有已批准条目？系统会再次核对旧会员证据并逐项追加 App grant。')) return
  await runOperation(async () => {
    if (!executeIdempotencyKey.value) executeIdempotencyKey.value = newIdempotencyKey('legacy-execute')
    const response = await api<{ data: MembershipLegacyWorkspace }>(`/api/admin/app/memberships/migrations/${workspace.value!.job.jobId}/execute`, {
      method: 'POST',
      headers: { 'Idempotency-Key': executeIdempotencyKey.value },
      body: { expectedVersion: workspace.value!.job.version },
    })
    workspace.value = response.data
    executeIdempotencyKey.value = ''
    await refreshJobs()
    successMessage.value = '受控执行已结束；请逐项核对迁移与失败结果。'
  })
}

async function runOperation(operation: () => Promise<void>) {
  operating.value = true
  errorMessage.value = ''
  errorCode.value = ''
  successMessage.value = ''
  try {
    await operation()
  }
  catch (error) {
    errorCode.value = apiErrorCode(error)
    errorMessage.value = resolveApiErrorMessage(error, '操作失败，请刷新后重试。')
  }
  finally {
    operating.value = false
  }
}

function addMapping() {
  if (mappingRows.value.length < 10) mappingRows.value.push({ legacyLevelCode: '', targetTierId: '' })
}

function removeMapping(index: number) {
  if (mappingRows.value.length > 1) mappingRows.value.splice(index, 1)
}

function statusClass(status: MembershipLegacyItem['status']) {
  if (status === 'migrated' || status === 'approved') return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (status === 'conflict' || status === 'evidence_insufficient' || status === 'failed' || status === 'stale') return 'bg-red-50 text-red-700 ring-red-200'
  if (status === 'pending_review') return 'bg-amber-50 text-amber-800 ring-amber-200'
  return 'bg-stone-100 text-stone-700 ring-stone-200'
}

function formatTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function newIdempotencyKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`
}

function apiErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return ''
  const candidate = error as { data?: unknown }
  let data = candidate.data
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    }
    catch {
      return ''
    }
  }
  if (!data || typeof data !== 'object') return ''
  const code = (data as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}
</script>

<template>
  <div class="min-w-0 space-y-6">
    <AdminAppPageHeader
      page-id="ADM-MBR-06"
      route="/admin/app/membership/migrations"
      title="旧会员映射"
      description="对 legacy vip/svip 证据执行 Dry-run、逐项复核和受控迁移。"
      :state="pageState"
      :figma-state="figmaState"
      :state-tone="pageTone"
    >
      <template #actions>
        <button
          v-if="workspace?.job.status === 'ready' || workspace?.permissions.executionRecoverable"
          type="button"
          class="min-h-10 rounded-xl bg-[#2f2622] px-4 text-sm font-medium text-white hover:bg-black disabled:opacity-50"
          :disabled="operating || !workspace.permissions.canExecute"
          :title="workspace.permissions.executionBlockedReason || undefined"
          @click="executeJob"
        >{{ workspace?.permissions.executionRecoverable ? '恢复执行' : '执行迁移' }}</button>
      </template>
    </AdminAppPageHeader>

    <p v-if="successMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">{{ successMessage }}</p>
    <p v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">{{ errorMessage }}</p>

    <section class="rounded-2xl border border-[#eaded8] bg-white p-5 shadow-sm">
      <div class="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div class="min-w-0">
          <h2 class="text-base font-semibold text-[#2f2622]">新建证据 Dry-run</h2>
          <p class="mt-1 max-w-3xl text-sm leading-6 text-stone-600">等级名称不会被自动推断。每一行显式指定 legacy code 与当前 App 目录等级；Dry-run 只生成快照，不发放权益。</p>
        </div>
        <div class="flex min-w-0 flex-col gap-2 sm:flex-row">
          <label class="text-sm text-stone-700">最多读取
            <input v-model.number="dryRunLimit" type="number" min="1" max="50" class="ml-2 w-20 rounded-lg border border-[#dccbc3] px-2 py-2 text-sm" />
          </label>
          <button type="button" class="min-h-10 rounded-xl bg-[#d62f65] px-4 text-sm font-medium text-white hover:bg-[#bd2756] disabled:opacity-50" :disabled="operating || !availableTiers.length" @click="createDryRun">{{ operating ? '处理中…' : '运行 Dry-run' }}</button>
        </div>
      </div>
      <div class="mt-5 overflow-x-auto">
        <table class="w-full min-w-[680px] table-fixed text-left text-sm">
          <thead class="border-b border-[#eee1db] text-xs text-stone-500"><tr><th class="w-[31%] px-3 py-3 font-medium">旧等级 code</th><th class="w-[55%] px-3 py-3 font-medium">目标 App 等级</th><th class="w-[14%] px-3 py-3 text-right font-medium">操作</th></tr></thead>
          <tbody class="divide-y divide-[#f2e8e3]">
            <tr v-for="(mapping, index) in mappingRows" :key="index">
              <td class="p-3"><input v-model.trim="mapping.legacyLevelCode" maxlength="48" class="w-full min-w-0 rounded-lg border border-[#dccbc3] px-3 py-2.5" placeholder="vip" /></td>
              <td class="p-3"><select v-model="mapping.targetTierId" class="w-full min-w-0 rounded-lg border border-[#dccbc3] bg-white px-3 py-2.5"><option value="" disabled>请选择，不自动推断</option><option v-for="tier in availableTiers" :key="tier.tierId" :value="tier.tierId">{{ tier.displayName }} · rank {{ tier.rank }}</option></select></td>
              <td class="p-3 text-right"><button type="button" class="rounded-lg px-3 py-2 text-red-600 hover:bg-red-50 disabled:opacity-40" :disabled="mappingRows.length === 1" @click="removeMapping(index)">移除</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <button type="button" class="mt-3 rounded-lg border border-[#dccbc3] bg-white px-3 py-2 text-sm text-stone-700 disabled:opacity-40" :disabled="mappingRows.length >= 10" @click="addMapping">增加映射</button>
    </section>

    <section class="grid min-w-0 gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
      <aside class="min-w-0 rounded-2xl border border-[#eaded8] bg-white p-4 shadow-sm">
        <div class="flex items-center justify-between gap-3"><h2 class="font-semibold text-[#2f2622]">迁移任务</h2><span class="text-xs text-stone-500">{{ jobs.length }} 项</span></div>
        <div v-if="jobs.length" class="mt-4 space-y-2">
          <button v-for="job in jobs" :key="job.jobId" type="button" class="w-full min-w-0 rounded-xl border p-3 text-left" :class="job.jobId === selectedJobId ? 'border-[#d62f65] bg-[#fff5f7]' : 'border-[#eee1db] hover:border-[#d9b7c3]'" @click="selectJob(job.jobId)">
            <span class="block truncate text-sm font-medium text-[#2f2622]">{{ MEMBERSHIP_LEGACY_JOB_LABELS[job.status] }}</span>
            <span class="mt-1 block break-all text-xs text-stone-500">{{ job.jobId }}</span>
            <span class="mt-2 block text-xs text-stone-600">共 {{ job.total }} · 可迁移 {{ job.counts.draft + job.counts.pending_review + job.counts.approved }} · 冲突 {{ job.counts.conflict + job.counts.failed + job.counts.stale }}</span>
          </button>
        </div>
        <p v-else class="mt-4 rounded-xl bg-[#fff9f5] px-3 py-8 text-center text-sm text-stone-500">尚无迁移任务</p>
      </aside>

      <div class="min-w-0 space-y-5">
        <section v-if="loading" class="rounded-2xl border border-[#eaded8] bg-white p-10 text-center text-sm text-stone-500">正在读取迁移证据…</section>
        <template v-else-if="workspace">
          <section class="rounded-2xl border border-[#eaded8] bg-white p-5 shadow-sm">
            <div class="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div class="min-w-0"><p class="break-all text-xs font-medium text-[#b92d5c]">{{ workspace.job.jobId }}</p><h2 class="mt-2 text-lg font-semibold text-[#2f2622]">{{ MEMBERSHIP_LEGACY_JOB_LABELS[workspace.job.status] }}</h2><p class="mt-1 text-sm text-stone-500">创建：{{ workspace.job.createdBy.label }} · {{ formatTime(workspace.job.createdAt) }} · 版本 {{ workspace.job.version }}</p></div>
              <button v-if="workspace.permissions.canSubmit" type="button" class="min-h-10 rounded-xl bg-[#d62f65] px-4 text-sm font-medium text-white disabled:opacity-50" :disabled="operating" @click="submitJob">提交逐项复核</button>
            </div>
            <p v-if="workspace.permissions.selfReviewBlocked && workspace.job.status === 'pending_review'" class="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">职责分离：你是任务创建人，不能复核本任务。请由另一位 Owner 完成逐项决定。</p>
            <p v-if="workspace.permissions.executionBlockedReason && workspace.job.status === 'ready'" class="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">{{ workspace.permissions.executionBlockedReason }}</p>
            <div class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><div v-for="item in [{ label: '总数', value: workspace.job.total }, { label: '待复核', value: workspace.job.counts.pending_review }, { label: '已批准', value: workspace.job.counts.approved }, { label: '证据/冲突/失败', value: workspace.job.counts.evidence_insufficient + workspace.job.counts.conflict + workspace.job.counts.failed + workspace.job.counts.stale }]" :key="item.label" class="rounded-xl bg-[#fff9f5] p-4"><p class="text-xs text-stone-500">{{ item.label }}</p><p class="mt-2 text-2xl font-semibold text-[#2f2622]">{{ item.value }}</p></div></div>
          </section>

          <section class="overflow-hidden rounded-2xl border border-[#eaded8] bg-white shadow-sm">
            <div class="border-b border-[#eee1db] px-5 py-4"><h2 class="font-semibold text-[#2f2622]">逐项证据与决定</h2><p class="mt-1 text-xs leading-5 text-stone-500">账号、旧等级、有效期和 SHA-256 证据均被冻结；执行前仍会重新核对。</p></div>
            <div class="overflow-x-auto">
              <table class="w-full min-w-[1080px] table-fixed text-left text-sm">
                <thead class="bg-[#fffaf7] text-xs text-stone-500"><tr><th class="w-[19%] px-4 py-3 font-medium">账号 / 证据</th><th class="w-[18%] px-4 py-3 font-medium">旧会员</th><th class="w-[16%] px-4 py-3 font-medium">目标等级</th><th class="w-[13%] px-4 py-3 font-medium">状态</th><th class="w-[34%] px-4 py-3 font-medium">复核 / 结果</th></tr></thead>
                <tbody class="divide-y divide-[#f2e8e3]">
                  <tr v-for="item in workspace.items" :key="item.itemId" class="align-top">
                    <td class="px-4 py-4"><p class="break-all font-medium text-[#2f2622]">{{ item.accountId || `user-${item.userId}` }}</p><p class="mt-1 text-xs text-stone-500">{{ item.emailMasked }}</p><p class="mt-2 break-all font-mono text-[10px] leading-4 text-stone-400">{{ item.evidenceSha256 }}</p></td>
                    <td class="px-4 py-4"><p class="font-medium text-stone-800">{{ item.legacyLevel.name }} · {{ item.legacyLevel.code }}</p><p class="mt-1 text-xs text-stone-500">rank {{ item.legacyLevel.rank }}</p><p class="mt-2 text-xs leading-5 text-stone-500">{{ formatTime(item.legacyStartsAt) }}<br />至 {{ formatTime(item.legacyExpiresAt) }}</p></td>
                    <td class="px-4 py-4"><p class="font-medium text-[#2f2622]">{{ item.targetTier.name }}</p><p class="mt-1 text-xs text-stone-500">{{ item.targetTier.code }} · rank {{ item.targetTier.rank }}</p></td>
                    <td class="px-4 py-4"><span class="inline-flex rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="statusClass(item.status)">{{ MEMBERSHIP_LEGACY_ITEM_LABELS[item.status] }}</span></td>
                    <td class="px-4 py-4">
                      <template v-if="item.status === 'pending_review' && workspace.permissions.canReview">
                        <textarea v-model.trim="reviewNotes[item.itemId]" rows="2" maxlength="500" class="w-full min-w-0 resize-y rounded-lg border border-[#dccbc3] px-3 py-2 text-sm" placeholder="独立复核说明（必填）" />
                        <div class="mt-2 flex flex-wrap gap-2"><button type="button" class="rounded-lg bg-[#2f2622] px-3 py-2 text-xs font-medium text-white disabled:opacity-50" :disabled="operating" @click="reviewItem(item, 'approve')">批准</button><button type="button" class="rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 disabled:opacity-50" :disabled="operating" @click="reviewItem(item, 'reject')">拒绝</button></div>
                      </template>
                      <p v-else-if="item.conflict" class="break-words text-sm leading-6 text-red-700"><span class="font-medium">{{ item.conflict.code }}</span><br />{{ item.conflict.summary }}</p>
                      <p v-else-if="item.failure" class="break-words text-sm leading-6 text-red-700"><span class="font-medium">{{ item.failure.code }}</span><br />{{ item.failure.summary }}</p>
                      <p v-else-if="item.resultGrantId" class="break-all text-sm leading-6 text-emerald-700">Grant：{{ item.resultGrantId }}</p>
                      <p v-else-if="item.reviewedBy" class="break-words text-sm leading-6 text-stone-600">{{ item.reviewedBy.label }}：{{ item.reviewNote }}</p>
                      <p v-else class="text-sm text-stone-400">等待流程推进</p>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </template>
        <section v-else class="rounded-2xl border border-dashed border-[#dccbc3] bg-white p-12 text-center"><h2 class="font-semibold text-[#2f2622]">选择或创建迁移任务</h2><p class="mt-2 text-sm text-stone-500">只有 Dry-run 结果才会进入独立复核，页面不会自动迁移。</p></section>
      </div>
    </section>
  </div>
</template>
