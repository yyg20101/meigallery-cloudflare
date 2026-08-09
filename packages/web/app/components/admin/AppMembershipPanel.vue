<script setup lang="ts">
type EntitlementValue = boolean | number | string

interface MembershipDefinition {
  key: string
  displayName: string
  unitLabel: string | null
}

interface MembershipTier {
  tierId: string
  code: string
  displayName: string
  tagline: string
  rank: number
  accentToken: string
  acquisitionLabel: string
  serviceDisclosure: string
  entitlements: Array<{
    key: string
    value: EntitlementValue
    availability: 'available' | 'planned'
  }>
}

interface MembershipCatalog {
  catalogVersionId: string
  versionCode: string
  state: 'development' | 'published'
  productionReady: boolean
  definitions: MembershipDefinition[]
  tiers: MembershipTier[]
}

interface MembershipSnapshot {
  status: 'free' | 'active'
  tier: null | {
    tierId: string
    displayName: string
    rank: number
  }
  grant: null | {
    grantId: string
    startsAt: string
    expiresAt: string
    userVisibleNote: string
  }
}

interface MembershipGrant {
  grantId: string
  tierName: string
  rank: number
  startsAt: string
  expiresAt: string
  reasonCode: string
  userVisibleNote: string
  businessReference: string
  revoked: boolean
  revokedAt: string | null
  replayed?: boolean
}

interface MembershipState {
  catalog: MembershipCatalog
  current: MembershipSnapshot
  grants: MembershipGrant[]
}

interface GrantPreview {
  user: { emailMasked: string }
  action: 'grant' | 'renew'
  tier: { tierId: string; displayName: string; rank: number }
  startsAt: string
  expiresAt: string
  durationDays: number
  userVisibleNote: string
  businessReference: string
  willBecomeCurrentImmediately: boolean
  warnings: Array<'DEVELOPMENT_CATALOG' | 'ENTITLEMENTS_PLANNED' | 'LOWER_THAN_CURRENT_TIER'>
  review: ReviewRequirement
}

interface ReviewRequirement {
  required: boolean
  policyId: string | null
  policyVersionCode: string
  mode: 'conservative_review_all' | 'review_all' | 'risk_based'
  riskCodes: Array<'POLICY_UNRESOLVED_ALL_REVIEW' | 'POLICY_REVIEW_ALL' | 'RANK_THRESHOLD' | 'DURATION_THRESHOLD' | 'LOWER_THAN_CURRENT_TIER' | 'REVOCATION'>
}

interface ChangeRequestResult {
  requestId: string
  status: string
}

const props = withDefaults(defineProps<{ userId: number; autoload?: boolean }>(), {
  autoload: false,
})
const { api } = useApi()
const toast = useToast()

const loading = ref(false)
const loaded = ref(false)
const unavailable = ref(false)
const errorMessage = ref('')
const state = ref<MembershipState | null>(null)
const preview = ref<GrantPreview | null>(null)
const previewLoading = ref(false)
const commitLoading = ref(false)
const showCommitModal = ref(false)
const grantIdempotencyKey = ref('')
const submittedReviewId = ref('')

const form = reactive({
  tierId: '',
  action: 'grant' as 'grant' | 'renew',
  startsAtLocal: '',
  durationDays: 30,
  reasonCode: 'manual_review',
  userVisibleNote: '平台审核通过，会员权益已发放。',
  businessReference: '',
  internalNote: '',
})

const revokeGrant = ref<MembershipGrant | null>(null)
const revokeLoading = ref(false)
const revokePreviewLoading = ref(false)
const revokeReview = ref<ReviewRequirement | null>(null)
const revokeIdempotencyKey = ref('')
const revokeForm = reactive({
  reasonCode: 'admin_correction',
  userVisibleNote: '平台更正了本次会员发放。',
  businessReference: '',
  internalNote: '',
})

watch(form, () => {
  preview.value = null
  grantIdempotencyKey.value = ''
}, { deep: true })

onMounted(() => {
  if (props.autoload) loadState()
})

async function loadState() {
  loading.value = true
  errorMessage.value = ''
  unavailable.value = false
  try {
    const response = await api<{ data: MembershipState }>(`/api/admin/app/memberships/users/${props.userId}`)
    state.value = response.data
    loaded.value = true
    if (!form.tierId) {
      form.tierId = response.data.current.tier?.tierId || response.data.catalog.tiers[0]?.tierId || ''
    }
  }
  catch (error: any) {
    const status = Number(error?.statusCode || error?.status || error?.response?.status || 0)
    unavailable.value = status === 403
    errorMessage.value = resolveApiErrorMessage(
      error,
      unavailable.value ? '当前环境尚未开放 App 会员管理' : 'App 会员状态载入失败',
    )
  }
  finally {
    loading.value = false
  }
}

async function createPreview() {
  errorMessage.value = ''
  if (!form.tierId || !form.businessReference.trim() || !form.userVisibleNote.trim()) {
    errorMessage.value = '请选择会员等级，并填写业务单号和用户可见说明'
    return
  }
  previewLoading.value = true
  try {
    const response = await api<{ data: GrantPreview }>('/api/admin/app/memberships/grants/preview', {
      method: 'POST',
      body: grantBody(),
    })
    preview.value = response.data
  }
  catch (error: any) {
    errorMessage.value = resolveApiErrorMessage(error, '会员发放预览失败')
  }
  finally {
    previewLoading.value = false
  }
}

function requestCommit() {
  if (!preview.value) return
  if (!grantIdempotencyKey.value) {
    grantIdempotencyKey.value = `membership:${crypto.randomUUID()}`
  }
  showCommitModal.value = true
}

async function commitGrant() {
  if (!preview.value) return
  commitLoading.value = true
  errorMessage.value = ''
  try {
    const path = preview.value.review.required
      ? '/api/admin/app/memberships/change-requests'
      : '/api/admin/app/memberships/grants'
    const response = await api<{ data: MembershipGrant | ChangeRequestResult; message: string }>(path, {
      method: 'POST',
      headers: { 'Idempotency-Key': grantIdempotencyKey.value },
      body: grantBody(preview.value.startsAt),
    })
    showCommitModal.value = false
    toast.add({ title: response.message, color: 'success' })
    if ('requestId' in response.data) submittedReviewId.value = response.data.requestId
    preview.value = null
    grantIdempotencyKey.value = ''
    form.businessReference = ''
    form.internalNote = ''
    await loadState()
  }
  catch (error: any) {
    errorMessage.value = resolveApiErrorMessage(error, 'App 会员发放失败，可使用同一幂等键安全重试')
  }
  finally {
    commitLoading.value = false
  }
}

async function requestRevoke(grant: MembershipGrant) {
  revokeGrant.value = grant
  revokeReview.value = null
  revokeIdempotencyKey.value = `membership:${crypto.randomUUID()}`
  revokeForm.businessReference = ''
  revokeForm.internalNote = ''
  revokePreviewLoading.value = true
  errorMessage.value = ''
  try {
    const response = await api<{ data: { review: ReviewRequirement } }>(
      `/api/admin/app/memberships/grants/${grant.grantId}/revoke-preview`,
      { method: 'POST' },
    )
    revokeReview.value = response.data.review
  }
  catch (error) {
    revokeGrant.value = null
    errorMessage.value = resolveApiErrorMessage(error, '会员撤销预览失败')
  }
  finally {
    revokePreviewLoading.value = false
  }
}

async function commitRevoke() {
  if (!revokeGrant.value) return
  if (!revokeForm.businessReference.trim() || !revokeForm.userVisibleNote.trim()) {
    errorMessage.value = '撤销前必须填写业务单号和用户可见说明'
    return
  }
  revokeLoading.value = true
  errorMessage.value = ''
  try {
    if (!revokeReview.value) {
      errorMessage.value = '撤销策略尚未载入，请关闭弹窗后重新操作'
      return
    }
    const suffix = revokeReview.value.required ? 'revoke-request' : 'revoke'
    const response = await api<{ data: MembershipGrant | ChangeRequestResult; message: string }>(
      `/api/admin/app/memberships/grants/${revokeGrant.value.grantId}/${suffix}`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': revokeIdempotencyKey.value },
        body: revokeForm,
      },
    )
    revokeGrant.value = null
    toast.add({ title: response.message, color: 'success' })
    if ('requestId' in response.data) submittedReviewId.value = response.data.requestId
    await loadState()
  }
  catch (error: any) {
    errorMessage.value = resolveApiErrorMessage(error, 'App 会员撤销失败，可使用同一幂等键安全重试')
  }
  finally {
    revokeLoading.value = false
  }
}

function grantBody(startsAt?: string) {
  return {
    userId: props.userId,
    tierId: form.tierId,
    action: form.action,
    startsAt: startsAt || parseLocalDateTime(form.startsAtLocal),
    durationDays: Number(form.durationDays),
    reasonCode: form.reasonCode,
    userVisibleNote: form.userVisibleNote,
    businessReference: form.businessReference,
    internalNote: form.internalNote || undefined,
  }
}

function parseLocalDateTime(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

function entitlementLabel(tier: MembershipTier, definition: MembershipDefinition): string {
  const entitlement = tier.entitlements.find(item => item.key === definition.key)
  if (!entitlement) return '未配置'
  if (typeof entitlement.value === 'boolean') return entitlement.value ? '包含' : '未包含'
  if (definition.key === 'discovery.filter_tier' || definition.key === 'discovery.filter.advanced') {
    return ({ none: '暂不开放', basic: '基础筛选', full: '完整筛选' } as Record<string, string>)[String(entitlement.value)] || String(entitlement.value)
  }
  return `${entitlement.value}${definition.unitLabel || ''}`
}

function entitlementAvailability(tier: MembershipTier, key: string) {
  return tier.entitlements.find(item => item.key === key)?.availability ?? null
}

function warningLabel(warning: GrantPreview['warnings'][number]): string {
  return {
    DEVELOPMENT_CATALOG: '当前使用开发草案目录',
    ENTITLEMENTS_PLANNED: '权益均为规划值，不会放行业务功能',
    LOWER_THAN_CURRENT_TIER: '所选等级低于当前生效等级',
  }[warning]
}

function reviewRiskLabel(code: ReviewRequirement['riskCodes'][number]): string {
  return {
    POLICY_UNRESOLVED_ALL_REVIEW: '风险阈值尚未正式发布，按保守规则全部复核',
    POLICY_REVIEW_ALL: '当前策略要求全部会员变更独立复核',
    RANK_THRESHOLD: '目标等级达到独立复核阈值',
    DURATION_THRESHOLD: '发放有效期达到独立复核阈值',
    LOWER_THAN_CURRENT_TIER: '目标等级低于当前生效等级',
    REVOCATION: '撤销操作要求独立复核',
  }[code]
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-rose-200 bg-white">
    <header class="flex flex-col gap-3 border-b border-rose-100 bg-rose-50/70 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold text-gray-900">独立 App 五级会员</h2>
          <span class="rounded-full px-2 py-1 text-xs font-medium" :class="!state ? 'bg-gray-100 text-gray-700' : state.catalog.productionReady ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'">{{ !state ? 'App 1.0' : state.catalog.productionReady ? '生产目录' : '开发目录' }}</span>
        </div>
        <p class="mt-1 text-xs leading-5 text-gray-600">与旧 Web vip/svip 隔离；发放、续期和撤销按服务端策略进入双人复核并记录审计。</p>
      </div>
      <button
        type="button"
        :disabled="loading"
        class="min-h-11 shrink-0 rounded-lg border border-rose-300 bg-white px-4 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
        @click="loadState"
      >{{ loading ? '载入中…' : loaded ? '刷新状态' : '载入 App 会员工具' }}</button>
    </header>

    <div v-if="errorMessage" class="mx-5 mt-5 rounded-lg border p-3 text-sm leading-6" :class="unavailable ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-red-200 bg-red-50 text-red-700'">
      {{ errorMessage }}
    </div>

    <div v-if="submittedReviewId" class="mx-5 mt-5 flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm leading-6 text-blue-900 sm:flex-row sm:items-center sm:justify-between">
      <span>变更尚未生效，已进入独立复核队列。</span>
      <NuxtLink :to="`/admin/app/membership/reviews/${submittedReviewId}`" class="shrink-0 font-medium text-blue-700 hover:underline">查看复核申请</NuxtLink>
    </div>

    <div v-if="state" class="space-y-6 p-5">
      <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-gray-500">当前 App 会员</p>
          <p class="mt-1 text-lg font-semibold text-gray-900">
            {{ state.current.tier?.displayName || '普通用户' }}
            <span class="ml-1 text-sm font-normal text-gray-500">Rank {{ state.current.tier?.rank || 0 }}</span>
          </p>
          <p class="mt-1 text-xs text-gray-500">到期：{{ formatDate(state.current.grant?.expiresAt) }}</p>
        </div>
        <div class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          目录 {{ state.catalog.versionCode }} · {{ state.catalog.productionReady ? '已通过生产门禁' : '未通过生产门禁' }}
        </div>
      </div>

      <div>
        <h3 class="text-sm font-semibold text-gray-900">1. 选择等级</h3>
        <div class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <label
            v-for="tier in state.catalog.tiers"
            :key="tier.tierId"
            class="relative min-w-0 cursor-pointer rounded-xl border p-3 transition"
            :class="form.tierId === tier.tierId ? 'border-rose-500 bg-rose-50 ring-2 ring-rose-100' : 'border-gray-200 hover:border-rose-300'"
          >
            <input v-model="form.tierId" class="sr-only" type="radio" :value="tier.tierId" />
            <span class="block text-base font-semibold text-gray-900">{{ tier.displayName }}</span>
            <span class="mt-0.5 block text-xs text-gray-500">Rank {{ tier.rank }}</span>
            <span class="mt-2 block break-words text-xs leading-5 text-gray-600">{{ tier.tagline }}</span>
          </label>
        </div>
      </div>

      <div v-if="form.tierId" class="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-gray-900">所选等级权益</h3>
          <span class="rounded-full bg-gray-200 px-2 py-1 text-xs text-gray-700">由稳定 entitlement 驱动</span>
        </div>
        <div class="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div v-for="definition in state.catalog.definitions" :key="definition.key" class="flex min-w-0 items-start justify-between gap-3 text-xs leading-5">
            <span class="min-w-0 text-gray-600">{{ definition.displayName }}</span>
            <span class="flex shrink-0 items-center gap-1.5 font-medium text-gray-900">
              {{ entitlementLabel(state.catalog.tiers.find(t => t.tierId === form.tierId)!, definition) }}
              <span v-if="entitlementAvailability(state.catalog.tiers.find(t => t.tierId === form.tierId)!, definition.key) === 'planned'" class="rounded-full bg-amber-100 px-1.5 text-[10px] text-amber-800">规划</span>
            </span>
          </div>
        </div>
      </div>

      <div>
        <h3 class="text-sm font-semibold text-gray-900">2. 填写发放依据</h3>
        <div class="mt-3 grid gap-4 sm:grid-cols-2">
          <label class="text-sm text-gray-700">
            操作类型
            <select v-model="form.action" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
              <option value="grant">新发放</option>
              <option value="renew">同级续期</option>
            </select>
          </label>
          <label class="text-sm text-gray-700">
            有效天数（1–366）
            <input v-model.number="form.durationDays" type="number" min="1" max="366" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3" />
          </label>
          <label class="text-sm text-gray-700 sm:col-span-2">
            预约生效时间（可选，最多提前 90 天）
            <input v-model="form.startsAtLocal" type="datetime-local" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3" />
            <span class="mt-1 block text-xs leading-5 text-gray-500">留空立即生效；同级续期会自动从已有同级 grant 的最晚到期时间继续。</span>
          </label>
          <label class="text-sm text-gray-700">
            发放原因
            <select v-model="form.reasonCode" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
              <option value="manual_review">人工审核</option>
              <option value="customer_support">客户支持</option>
              <option value="promotion">运营活动</option>
              <option value="compensation">服务补偿</option>
            </select>
          </label>
          <label class="text-sm text-gray-700">
            业务单号（必填）
            <input v-model="form.businessReference" maxlength="100" placeholder="例如 CASE-20260806-001" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3" />
          </label>
          <label class="text-sm text-gray-700 sm:col-span-2">
            用户可见说明（必填）
            <textarea v-model="form.userVisibleNote" maxlength="240" rows="2" class="mt-1 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 leading-6" />
          </label>
          <label class="text-sm text-gray-700 sm:col-span-2">
            内部备注（可选，不进入审计正文）
            <textarea v-model="form.internalNote" maxlength="1000" rows="2" class="mt-1 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 leading-6" />
          </label>
        </div>
        <button
          type="button"
          :disabled="previewLoading"
          class="mt-4 min-h-11 w-full rounded-lg bg-gray-900 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 sm:w-auto"
          @click="createPreview"
        >{{ previewLoading ? '生成中…' : '生成变更预览' }}</button>
      </div>

      <div v-if="preview" class="rounded-xl border border-blue-200 bg-blue-50 p-4">
        <h3 class="text-sm font-semibold text-blue-950">3. 核对变更预览</h3>
        <dl class="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt class="text-xs text-blue-700">目标账号</dt><dd class="mt-0.5 font-medium text-blue-950">{{ preview.user.emailMasked }}</dd></div>
          <div><dt class="text-xs text-blue-700">目标等级</dt><dd class="mt-0.5 font-medium text-blue-950">{{ preview.tier.displayName }} · Rank {{ preview.tier.rank }}</dd></div>
          <div><dt class="text-xs text-blue-700">开始时间</dt><dd class="mt-0.5 text-blue-950">{{ formatDate(preview.startsAt) }}</dd></div>
          <div><dt class="text-xs text-blue-700">到期时间</dt><dd class="mt-0.5 text-blue-950">{{ formatDate(preview.expiresAt) }}</dd></div>
        </dl>
        <ul v-if="preview.warnings.length" class="mt-3 space-y-1 text-xs leading-5 text-amber-800">
          <li v-for="warning in preview.warnings" :key="warning">• {{ warningLabel(warning) }}</li>
        </ul>
        <div class="mt-3 rounded-lg border p-3 text-xs leading-5" :class="preview.review.required ? 'border-violet-200 bg-violet-50 text-violet-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'">
          <p class="font-semibold">{{ preview.review.required ? '需要独立复核，提交后不会立即生效' : '当前策略允许直接执行' }}</p>
          <ul v-if="preview.review.riskCodes.length" class="mt-1 space-y-1">
            <li v-for="code in preview.review.riskCodes" :key="code">• {{ reviewRiskLabel(code) }}</li>
          </ul>
          <p class="mt-1 break-all text-[11px] opacity-75">策略：{{ preview.review.policyVersionCode }}</p>
        </div>
        <button type="button" class="mt-4 min-h-11 w-full rounded-lg bg-rose-600 px-4 text-sm font-medium text-white hover:bg-rose-700 sm:w-auto" @click="requestCommit">
          {{ preview.review.required ? '确认并提交复核' : '进入最终确认' }}
        </button>
      </div>

      <div>
        <h3 class="text-sm font-semibold text-gray-900">App 会员发放历史</h3>
        <div v-if="state.grants.length" class="mt-3 overflow-x-auto rounded-lg border border-gray-200">
          <table class="min-w-[820px] w-full text-left text-xs">
            <thead class="bg-gray-50 text-gray-600">
              <tr><th class="px-3 py-2">等级</th><th class="px-3 py-2">有效期</th><th class="px-3 py-2">业务单号</th><th class="px-3 py-2">状态</th><th class="px-3 py-2 text-right">操作</th></tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="grant in state.grants" :key="grant.grantId">
                <td class="px-3 py-3 font-medium text-gray-900">{{ grant.tierName }} · {{ grant.rank }}</td>
                <td class="px-3 py-3 text-gray-600">{{ formatDate(grant.startsAt) }} — {{ formatDate(grant.expiresAt) }}</td>
                <td class="px-3 py-3 font-mono text-gray-600">{{ grant.businessReference }}</td>
                <td class="px-3 py-3"><span :class="grant.revoked ? 'text-red-700' : 'text-green-700'">{{ grant.revoked ? '已撤销' : '有效记录' }}</span></td>
                <td class="px-3 py-3 text-right">
                  <button v-if="!grant.revoked" type="button" class="min-h-10 rounded-lg border border-red-200 px-3 text-red-700 hover:bg-red-50" @click="requestRevoke(grant)">撤销</button>
                  <span v-else class="text-gray-400">{{ formatDate(grant.revokedAt) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="mt-2 text-sm text-gray-400">暂无 App 会员发放记录</p>
      </div>
    </div>

    <div v-else-if="!loading && !errorMessage" class="p-5 text-sm leading-6 text-gray-500">
      为避免默认关闭的开发能力影响用户详情页，请按需载入。此处不会读取或修改旧 Web 会员数据。
    </div>
  </section>

  <UModal v-model:open="showCommitModal">
    <template #content>
      <div class="max-h-[85vh] overflow-y-auto p-6">
        <h3 class="text-base font-semibold text-gray-900">{{ preview?.review.required ? '提交 App 会员独立复核' : '最终确认 App 会员发放' }}</h3>
        <p class="mt-2 text-sm leading-6 text-gray-600">{{ preview?.review.required ? '提交后只创建待复核申请，不产生会员权限；必须由另一位管理员核对并批准。' : '确认后会创建不可变 grant、幂等请求记录和管理员审计日志。' }}草案权益仍不会放行业务能力。</p>
        <div v-if="preview" class="mt-4 rounded-lg bg-gray-50 p-4 text-sm leading-7 text-gray-700">
          <p>账号：{{ preview.user.emailMasked }}</p>
          <p>等级：{{ preview.tier.displayName }} · Rank {{ preview.tier.rank }}</p>
          <p>有效期：{{ formatDate(preview.startsAt) }} — {{ formatDate(preview.expiresAt) }}</p>
          <p>业务单号：{{ preview.businessReference }}</p>
        </div>
        <div class="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" class="min-h-11 rounded-lg border border-gray-300 px-4 text-sm" :disabled="commitLoading" @click="showCommitModal = false">返回修改</button>
          <button type="button" class="min-h-11 rounded-lg bg-rose-600 px-4 text-sm font-medium text-white disabled:opacity-50" :disabled="commitLoading" @click="commitGrant">{{ commitLoading ? '提交中…' : preview?.review.required ? '提交独立复核' : '确认并发放' }}</button>
        </div>
      </div>
    </template>
  </UModal>

  <UModal :open="Boolean(revokeGrant)" @update:open="value => { if (!value && !revokeLoading) revokeGrant = null }">
    <template #content>
      <div class="max-h-[85vh] overflow-y-auto p-6">
        <h3 class="text-base font-semibold text-gray-900">撤销 App 会员发放</h3>
        <p class="mt-2 text-sm leading-6 text-red-700">撤销以追加记录表达，不删除原 grant。需要独立复核时，提交申请不会立即改变用户权益。</p>
        <p v-if="revokePreviewLoading" class="mt-3 rounded-lg bg-gray-50 p-3 text-sm text-gray-500">正在载入撤销策略…</p>
        <div v-else-if="revokeReview" class="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-xs leading-5 text-violet-900">
          <p class="font-semibold">{{ revokeReview.required ? '本次撤销需要另一位管理员独立复核' : '当前策略允许直接撤销' }}</p>
          <p class="mt-1 break-all opacity-75">策略：{{ revokeReview.policyVersionCode }}</p>
        </div>
        <div class="mt-4 space-y-4">
          <label class="block text-sm text-gray-700">撤销原因
            <select v-model="revokeForm.reasonCode" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
              <option value="admin_correction">管理员更正</option><option value="customer_request">用户申请</option><option value="account_restriction">账号限制</option><option value="policy_enforcement">规则执行</option>
            </select>
          </label>
          <label class="block text-sm text-gray-700">业务单号（必填）<input v-model="revokeForm.businessReference" maxlength="100" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3" /></label>
          <label class="block text-sm text-gray-700">用户可见说明（必填）<textarea v-model="revokeForm.userVisibleNote" maxlength="240" rows="2" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 leading-6" /></label>
          <label class="block text-sm text-gray-700">内部备注（可选）<textarea v-model="revokeForm.internalNote" maxlength="1000" rows="2" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 leading-6" /></label>
        </div>
        <div class="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button type="button" class="min-h-11 rounded-lg border border-gray-300 px-4 text-sm" :disabled="revokeLoading" @click="revokeGrant = null">取消</button>
          <button type="button" class="min-h-11 rounded-lg bg-red-600 px-4 text-sm font-medium text-white disabled:opacity-50" :disabled="revokeLoading || revokePreviewLoading || !revokeReview" @click="commitRevoke">{{ revokeLoading ? '提交中…' : revokeReview?.required ? '提交撤销复核' : '确认撤销' }}</button>
        </div>
      </div>
    </template>
  </UModal>
</template>
