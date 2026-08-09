<script setup lang="ts">
import type { AdminMembershipReviewRequest, AdminMembershipReviewStatus, AdminMembershipRiskCode } from '~/types/admin-app-membership-review'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const toast = useToast()
const requestId = String(route.params.reviewId || '')
const errorMessage = ref('')
const operationError = ref('')
const operating = ref(false)
const reviewNote = ref('')
const decisionKey = ref('')

const { data, status, refresh } = await useAsyncData(
  `admin-app-membership-review-${requestId}`,
  async () => {
    errorMessage.value = ''
    try {
      return await api<{ data: AdminMembershipReviewRequest }>(`/api/admin/app/memberships/reviews/${requestId}`)
    }
    catch (error) {
      errorMessage.value = apiErrorMessage(error, '会员复核详情加载失败。')
      return null
    }
  },
)

const review = computed(() => data.value?.data ?? null)
const membershipChanged = computed(() => {
  const current = review.value
  if (!current) return false
  return (current.baseline.grantId ?? null) !== (current.currentMembership.grant?.grantId ?? null)
    || current.baseline.rank !== (current.currentMembership.tier?.rank ?? 0)
    || (current.baseline.expiresAt ?? null) !== (current.currentMembership.grant?.expiresAt ?? null)
})

async function submitDecision(decision: 'approve' | 'reject') {
  const current = review.value
  if (!current || operating.value || !current.canReview) return
  const note = reviewNote.value.trim()
  if (Array.from(note).length < 2) {
    operationError.value = '请填写至少 2 个字符的复核意见。'
    return
  }
  const description = decision === 'approve'
    ? '批准后服务端会重新核对账号与当前会员；条件一致才会原子写入正式变更。'
    : '拒绝不会产生会员权限；来源为会员申请时，原处理人可修正方案后重新提交。'
  if (!window.confirm(`${description}\n\n确认${decision === 'approve' ? '批准' : '拒绝'}本次会员变更？`)) return
  if (!decisionKey.value) {
    decisionKey.value = `membership.review.${decision}.${crypto.randomUUID().replaceAll('-', '')}`
  }
  operating.value = true
  operationError.value = ''
  try {
    const response = await api<{ message: string; data: AdminMembershipReviewRequest }>(
      `/api/admin/app/memberships/reviews/${current.requestId}/decision`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': decisionKey.value },
        body: { decision, expectedVersion: current.version, reviewNote: note },
      },
    )
    toast.add({ title: response.message, color: 'success' })
    decisionKey.value = ''
    await refresh()
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '复核提交失败；请保留当前页面并按提示重试。')
    await refresh()
  }
  finally {
    operating.value = false
  }
}

function statusLabel(value: AdminMembershipReviewStatus) {
  return {
    pending_review: '待复核',
    executing: '执行中',
    approved: '已通过并生效',
    rejected: '已拒绝',
    stale: '账号变化已失效',
    cancelled: '已取消',
  }[value]
}

function statusClass(value: AdminMembershipReviewStatus) {
  if (value === 'approved') return 'bg-emerald-100 text-emerald-800 ring-emerald-200'
  if (value === 'pending_review' || value === 'executing') return 'bg-violet-100 text-violet-800 ring-violet-200'
  if (value === 'rejected' || value === 'stale') return 'bg-amber-100 text-amber-900 ring-amber-200'
  return 'bg-gray-100 text-gray-700 ring-gray-200'
}

function operationTitle(value: AdminMembershipReviewRequest) {
  if (value.operation === 'revoke') return `撤销 ${value.revokeTarget?.tierName ?? '会员'}`
  return `${value.grantChange?.action === 'renew' ? '续期' : '发放'} ${value.grantChange?.tierName ?? '会员'}`
}

function riskLabel(value: AdminMembershipRiskCode) {
  return {
    POLICY_UNRESOLVED_ALL_REVIEW: '风险阈值尚未正式发布，保守要求全部复核',
    POLICY_REVIEW_ALL: '当前正式策略要求全部变更独立复核',
    RANK_THRESHOLD: '目标等级达到复核阈值',
    DURATION_THRESHOLD: '有效期达到复核阈值',
    LOWER_THAN_CURRENT_TIER: '目标等级低于当前生效等级',
    REVOCATION: '撤销属于需复核操作',
  }[value]
}

function reasonLabel(value: string) {
  return {
    manual_review: '人工审核',
    customer_support: '客户支持',
    promotion: '运营活动',
    compensation: '服务补偿',
    admin_correction: '管理员更正',
    customer_request: '用户申请',
    account_restriction: '账号限制',
    policy_enforcement: '规则执行',
  }[value] ?? value
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
    timeZone: 'Asia/Shanghai',
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
    <header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <NuxtLink to="/admin/app/membership/reviews" class="text-sm font-medium text-violet-700 hover:underline">← 返回独立复核队列</NuxtLink>
        <h1 class="mt-2 break-words text-xl font-bold text-gray-950">会员变更复核详情</h1>
        <p class="mt-1 break-all font-mono text-xs text-gray-500">{{ requestId }}</p>
      </div>
      <button type="button" class="min-h-10 shrink-0 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50" @click="refresh()">刷新详情</button>
    </header>

    <p v-if="status === 'pending'" class="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">正在加载复核详情…</p>
    <p v-else-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ errorMessage }}</p>

    <template v-else-if="review">
      <section class="rounded-xl border border-gray-200 bg-white p-5">
        <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset" :class="statusClass(review.status)">{{ statusLabel(review.status) }}</span>
              <span class="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">{{ review.source.type === 'membership_application' ? '来源：会员申请' : '来源：管理员创建' }}</span>
            </div>
            <h2 class="mt-3 break-words text-lg font-semibold text-gray-950">{{ operationTitle(review) }}</h2>
            <p class="mt-1 break-words text-sm text-gray-600">账号 {{ review.account.emailMasked }} · {{ review.account.accountId ?? `内部 #${review.account.userId}` }}</p>
          </div>
          <NuxtLink :to="`/admin/users/${review.account.userId}`" class="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50">查看账号</NuxtLink>
        </div>
        <dl class="mt-5 grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <div><dt class="text-xs text-gray-500">业务单号</dt><dd class="mt-1 break-all font-mono text-xs text-gray-950">{{ review.businessReference }}</dd></div>
          <div><dt class="text-xs text-gray-500">标准原因</dt><dd class="mt-1 text-gray-950">{{ reasonLabel(review.reasonCode) }}</dd></div>
          <div><dt class="text-xs text-gray-500">发起人</dt><dd class="mt-1 break-words text-gray-950">{{ review.requestedBy.label }} · #{{ review.requestedBy.id }}</dd></div>
          <div><dt class="text-xs text-gray-500">提交时间</dt><dd class="mt-1 text-gray-950">{{ formatDate(review.createdAt) }}</dd></div>
        </dl>
      </section>

      <section class="grid min-w-0 gap-5 xl:grid-cols-2">
        <div class="min-w-0 rounded-xl border border-gray-200 bg-white p-5">
          <h3 class="font-semibold text-gray-950">申请变更</h3>
          <dl v-if="review.grantChange" class="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <div><dt class="text-xs text-gray-500">目标等级</dt><dd class="mt-1 font-medium text-gray-950">{{ review.grantChange.tierName }} · Rank {{ review.grantChange.rank }}</dd></div>
            <div><dt class="text-xs text-gray-500">操作</dt><dd class="mt-1 text-gray-950">{{ review.grantChange.action === 'renew' ? '同级续期' : '新发放' }} · {{ review.grantChange.durationDays }} 天</dd></div>
            <div class="sm:col-span-2"><dt class="text-xs text-gray-500">冻结有效期</dt><dd class="mt-1 break-words text-gray-950">{{ formatDate(review.grantChange.startsAt) }} — {{ formatDate(review.grantChange.expiresAt) }}</dd></div>
          </dl>
          <dl v-else-if="review.revokeTarget" class="mt-4 grid gap-4 text-sm sm:grid-cols-2">
            <div><dt class="text-xs text-gray-500">目标 grant</dt><dd class="mt-1 break-all font-mono text-xs text-gray-950">{{ review.revokeTarget.grantId }}</dd></div>
            <div><dt class="text-xs text-gray-500">等级</dt><dd class="mt-1 font-medium text-gray-950">{{ review.revokeTarget.tierName }} · Rank {{ review.revokeTarget.rank }}</dd></div>
            <div class="sm:col-span-2"><dt class="text-xs text-gray-500">原有效期</dt><dd class="mt-1 text-gray-950">{{ formatDate(review.revokeTarget.startsAt) }} — {{ formatDate(review.revokeTarget.expiresAt) }}</dd></div>
          </dl>
          <div class="mt-5 rounded-lg bg-blue-50 p-4">
            <p class="text-xs font-medium text-blue-700">用户可见说明</p>
            <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-blue-950">{{ review.userVisibleNote }}</p>
          </div>
          <div class="mt-3 rounded-lg border border-gray-200 p-4">
            <p class="text-xs font-medium text-gray-500">内部依据（本页读取已审计）</p>
            <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">{{ review.internalNote || '发起人未填写内部备注。' }}</p>
          </div>
        </div>

        <div class="min-w-0 rounded-xl border bg-white p-5" :class="membershipChanged ? 'border-amber-300' : 'border-gray-200'">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="font-semibold text-gray-950">账号状态核对</h3>
            <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="membershipChanged ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-800'">{{ membershipChanged ? '已发生变化' : '与提交基线一致' }}</span>
          </div>
          <div class="mt-4 grid gap-4 sm:grid-cols-2">
            <div class="rounded-lg bg-gray-50 p-4">
              <p class="text-xs font-medium text-gray-500">提交时基线</p>
              <p class="mt-2 text-sm font-semibold text-gray-950">Rank {{ review.baseline.rank }}</p>
              <p class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ review.baseline.grantId ?? '无生效 grant' }}</p>
              <p class="mt-2 text-xs text-gray-600">到期：{{ formatDate(review.baseline.expiresAt) }}</p>
            </div>
            <div class="rounded-lg bg-gray-50 p-4">
              <p class="text-xs font-medium text-gray-500">当前权威状态</p>
              <p class="mt-2 text-sm font-semibold text-gray-950">{{ review.currentMembership.tier?.displayName ?? '普通用户' }} · Rank {{ review.currentMembership.tier?.rank ?? 0 }}</p>
              <p class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ review.currentMembership.grant?.grantId ?? '无生效 grant' }}</p>
              <p class="mt-2 text-xs text-gray-600">到期：{{ formatDate(review.currentMembership.grant?.expiresAt) }}</p>
            </div>
          </div>
          <p v-if="membershipChanged" class="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">批准时服务端会拒绝旧快照并将本申请标记为失效，不会在变化后的账号上静默执行旧方案。</p>

          <div class="mt-5 rounded-lg border border-violet-200 bg-violet-50 p-4">
            <p class="text-xs font-medium text-violet-700">复核策略快照</p>
            <p class="mt-2 break-all font-mono text-xs text-violet-950">{{ review.policy.versionCode }}</p>
            <ul class="mt-2 space-y-1 text-sm leading-6 text-violet-950">
              <li v-for="code in review.policy.riskCodes" :key="code">• {{ riskLabel(code) }}</li>
            </ul>
          </div>
        </div>
      </section>

      <section v-if="review.status === 'pending_review'" class="rounded-xl border border-violet-200 bg-white p-5">
        <h3 class="font-semibold text-gray-950">独立复核结论</h3>
        <p v-if="!review.canReview" class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">你是本申请的发起人，不能复核自己的会员变更。请由另一位有效管理员处理。</p>
        <template v-else>
          <label class="mt-4 block text-sm text-gray-700">复核意见（必填，2–500 字）
            <textarea v-model="reviewNote" maxlength="500" rows="4" class="mt-1 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 leading-6" placeholder="写明核对的业务依据、账号状态和批准或拒绝理由。" />
          </label>
          <p class="mt-2 text-xs leading-5 text-gray-500">意见正文保存在受控复核记录中；通用审计仅保存 SHA-256 与长度。</p>
          <p v-if="operationError" class="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700">{{ operationError }}</p>
          <div class="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button type="button" :disabled="operating" class="min-h-11 rounded-lg border border-red-300 bg-white px-5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50" @click="submitDecision('reject')">{{ operating ? '提交中…' : '拒绝变更' }}</button>
            <button type="button" :disabled="operating || membershipChanged" class="min-h-11 rounded-lg bg-violet-700 px-5 text-sm font-medium text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50" @click="submitDecision('approve')">{{ operating ? '执行中…' : membershipChanged ? '账号已变化，不能批准' : '批准并原子执行' }}</button>
          </div>
        </template>
      </section>

      <section v-else class="rounded-xl border border-gray-200 bg-white p-5">
        <h3 class="font-semibold text-gray-950">复核结果</h3>
        <dl class="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div><dt class="text-xs text-gray-500">复核人</dt><dd class="mt-1 break-words text-gray-950">{{ review.reviewedBy ? `${review.reviewedBy.label} · #${review.reviewedBy.id}` : '—' }}</dd></div>
          <div><dt class="text-xs text-gray-500">复核时间</dt><dd class="mt-1 text-gray-950">{{ formatDate(review.reviewedAt) }}</dd></div>
          <div><dt class="text-xs text-gray-500">结果 grant</dt><dd class="mt-1 break-all font-mono text-xs text-gray-950">{{ review.resultGrantId ?? '未产生' }}</dd></div>
        </dl>
        <div class="mt-4 rounded-lg bg-gray-50 p-4">
          <p class="text-xs font-medium text-gray-500">复核意见</p>
          <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">{{ review.reviewNote ?? '—' }}</p>
        </div>
      </section>
    </template>
  </div>
</template>
