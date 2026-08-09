<script setup lang="ts">
import {
  auditRegistryOperationLabel,
  auditRegistryRequestStatusClass,
  auditRegistryRequestStatusLabel,
  auditRegistryRiskLabel,
  auditRegistrySensitivityLabel,
  formatAuditRegistryTime,
  type AdminAppAuditRegistryRequest,
} from '~/types/admin-app-audit-registry'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const request = ref<AdminAppAuditRegistryRequest | null>(null)
const loading = ref(true)
const reviewing = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const decision = ref<'approve' | 'reject'>('approve')
const reasonCode = ref('definition_verified')
const reviewNote = ref('')

const requestId = computed(() => String(route.params.requestId || ''))
const approveReasons = [
  { value: 'definition_verified', label: '定义、范围与引用已核对' },
  { value: 'other', label: '其他批准依据' },
]
const rejectReasons = [
  { value: 'scope_incorrect', label: '业务域或责任范围错误' },
  { value: 'risk_incorrect', label: '风险级别错误' },
  { value: 'visibility_incorrect', label: '可见角色错误' },
  { value: 'policy_reference_invalid', label: '保留策略引用无效' },
  { value: 'quality_rule_invalid', label: '质量规则引用无效' },
  { value: 'other', label: '其他驳回原因' },
]

watch(decision, (value) => {
  reasonCode.value = value === 'approve' ? 'definition_verified' : 'scope_incorrect'
})

onMounted(loadRequest)

async function loadRequest() {
  loading.value = true
  errorMessage.value = ''
  try {
    const response = await api<{ data: AdminAppAuditRegistryRequest }>(
      `/api/admin/app/audit/registry/requests/${encodeURIComponent(requestId.value)}`,
    )
    request.value = response.data
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, 'Action 口径申请读取失败。')
  }
  finally {
    loading.value = false
  }
}

async function submitReview() {
  const current = request.value
  if (!current?.canReview) return
  if (Array.from(reviewNote.value.trim()).length < 10) {
    errorMessage.value = '复核说明至少填写 10 个字符。'
    return
  }
  const action = decision.value === 'approve' ? '批准并追加正式口径版本' : '驳回本次申请'
  const baselineWarning = current.currentState.baselineChanged
    ? '当前基线已经变化，服务端会把申请安全标记为失效，不会发布口径。'
    : '服务端会再次核对当前版本、观察业务域、风险和稳定引用。'
  if (!window.confirm(`确认${action}？${baselineWarning}`)) return
  reviewing.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const response = await api<{ data: AdminAppAuditRegistryRequest; replayed: boolean }>(
      `/api/admin/app/audit/registry/requests/${encodeURIComponent(current.requestId)}/review`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `audit-registry-review-${crypto.randomUUID()}` },
        body: {
          expectedVersion: current.version,
          decision: decision.value,
          reasonCode: reasonCode.value,
          reviewNote: reviewNote.value.trim(),
        },
      },
    )
    request.value = response.data
    successMessage.value = response.data.status === 'stale'
      ? '复核时发现基线变化，原申请已安全失效；请基于当前事实重新提交。'
      : response.replayed
        ? '已返回同一复核结果。'
        : decision.value === 'approve'
          ? '独立复核已通过，正式口径版本已追加。'
          : '申请已驳回，未写入正式口径。'
    reviewNote.value = ''
    await loadRequest()
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '复核提交失败，请刷新申请版本后重试。')
    await loadRequest()
  }
  finally {
    reviewing.value = false
  }
}

function eventLabel(value: string) {
  return ({ submitted: '已提交申请', approved: '独立复核通过', rejected: '独立复核驳回', stale: '基线变化并失效' } as Record<string, string>)[value] ?? value
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <header class="min-w-0">
      <NuxtLink to="/admin/app/audit/registry" class="text-sm font-medium text-gray-600 hover:text-gray-950">← 返回 Action 口径治理</NuxtLink>
      <div class="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <h1 class="break-words text-xl font-bold text-gray-950">Action 口径申请</h1>
        <span v-if="request" class="rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset" :class="auditRegistryRequestStatusClass(request.status)">{{ auditRegistryRequestStatusLabel(request.status) }}</span>
      </div>
      <p class="mt-1 break-all font-mono text-xs text-gray-500">{{ requestId }}</p>
    </header>

    <p v-if="errorMessage" class="break-words rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ errorMessage }}</p>
    <p v-if="successMessage" class="break-words rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-700">{{ successMessage }}</p>
    <p v-if="loading" class="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">正在重新核对申请、当前 Registry 与观察事实…</p>

    <template v-if="request">
      <section v-if="request.currentState.baselineChanged && request.status === 'pending_review'" class="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <h2 class="text-sm font-semibold text-amber-950">申请基线已经变化</h2>
        <p class="mt-2 text-sm leading-6 text-amber-900">当前正式版本、观察口径或治理策略就绪状态与提交时不同。批准请求不会套用旧判断，服务端会将原申请标记为“基线已变化”，要求重新预览并提交。</p>
      </section>

      <section class="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0"><h2 class="text-base font-semibold text-gray-950">候选口径</h2><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ request.proposal.actionKey }}</p></div>
            <span class="self-start rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">{{ auditRegistryOperationLabel(request.operation) }} · v{{ request.proposal.schemaVersion }}</span>
          </div>
          <dl class="mt-5 grid min-w-0 gap-4 sm:grid-cols-2">
            <div><dt class="text-xs text-gray-500">展示名称</dt><dd class="mt-1 break-words text-sm font-medium text-gray-950">{{ request.proposal.displayName }}</dd></div>
            <div><dt class="text-xs text-gray-500">业务域</dt><dd class="mt-1 break-all font-mono text-sm text-gray-900">{{ request.proposal.domain }}</dd></div>
            <div><dt class="text-xs text-gray-500">敏感 / 风险</dt><dd class="mt-1 text-sm text-gray-900">{{ auditRegistrySensitivityLabel(request.proposal.sensitivity) }} · {{ auditRegistryRiskLabel(request.proposal.riskLevel) }}</dd></div>
            <div><dt class="text-xs text-gray-500">可见角色元数据</dt><dd class="mt-1 text-sm text-gray-900">{{ request.proposal.visibleRoles.join('、') }}</dd></div>
            <div class="sm:col-span-2"><dt class="text-xs text-gray-500">Owner 引用</dt><dd class="mt-1 break-all font-mono text-xs leading-5 text-gray-900">{{ request.proposal.ownerReference }}</dd></div>
            <div><dt class="text-xs text-gray-500">保留策略引用</dt><dd class="mt-1 break-all font-mono text-xs leading-5 text-gray-900">{{ request.proposal.retentionPolicyReference || '无' }}</dd></div>
            <div><dt class="text-xs text-gray-500">质量规则引用</dt><dd class="mt-1 break-all font-mono text-xs leading-5 text-gray-900">{{ request.proposal.qualityRuleReference || '无' }}</dd></div>
          </dl>
          <div class="mt-5 rounded-lg bg-gray-50 p-4"><p class="text-xs text-gray-500">申请原因</p><p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">{{ request.requestReason }}</p></div>
        </article>

        <aside class="min-w-0 space-y-4">
          <section class="rounded-xl border border-gray-200 bg-white p-4">
            <h2 class="text-sm font-semibold text-gray-950">职责分离</h2>
            <dl class="mt-3 space-y-3 text-sm">
              <div><dt class="text-xs text-gray-500">申请人</dt><dd class="mt-1 break-words text-gray-900">{{ request.requestedBy.label }} · #{{ request.requestedBy.id }}</dd></div>
              <div><dt class="text-xs text-gray-500">复核人</dt><dd class="mt-1 break-words text-gray-900">{{ request.reviewedBy ? `${request.reviewedBy.label} · #${request.reviewedBy.id}` : '尚未复核' }}</dd></div>
              <div><dt class="text-xs text-gray-500">创建 / 更新</dt><dd class="mt-1 text-gray-900">{{ formatAuditRegistryTime(request.createdAt) }}<br>{{ formatAuditRegistryTime(request.updatedAt) }}</dd></div>
            </dl>
          </section>
          <section class="rounded-xl border border-gray-200 bg-white p-4">
            <h2 class="text-sm font-semibold text-gray-950">提交时基线</h2>
            <p class="mt-3 text-sm text-gray-700">当前版本：{{ request.baseline.expectedCurrentSchemaVersion ? `v${request.baseline.expectedCurrentSchemaVersion}` : '无正式版本' }}</p>
            <p class="mt-1 text-sm text-gray-700">历史事实：{{ request.baseline.observedEventCount }} 条</p>
            <p class="mt-1 text-xs text-gray-500">{{ formatAuditRegistryTime(request.baseline.observedFirstAt) }} — {{ formatAuditRegistryTime(request.baseline.observedLastAt) }}</p>
            <p class="mt-3 break-all font-mono text-[10px] leading-5 text-gray-500">{{ request.baseline.observationDigest }}</p>
          </section>
        </aside>
      </section>

      <section class="grid min-w-0 gap-4 lg:grid-cols-2">
        <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <h2 class="text-base font-semibold text-gray-950">当前权威状态</h2>
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">当前最新版本</p><p class="mt-1 text-sm font-semibold text-gray-950">{{ request.currentState.latestDefinition ? `v${request.currentState.latestDefinition.schemaVersion} · ${request.currentState.latestDefinition.status}` : '无正式版本' }}</p></div>
            <div class="rounded-lg p-3" :class="request.currentState.baselineChanged ? 'bg-amber-50 text-amber-950' : 'bg-emerald-50 text-emerald-950'"><p class="text-xs">基线复核</p><p class="mt-1 text-sm font-semibold">{{ request.currentState.baselineChanged ? '已变化' : '保持一致' }}</p></div>
            <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">当前事实 / 缺索引</p><p class="mt-1 text-sm font-semibold text-gray-950">{{ request.currentState.observation.eventCount }} / {{ request.currentState.observation.missingIndexCount }}</p></div>
            <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">观察域 / 风险</p><p class="mt-1 break-words text-sm font-semibold text-gray-950">{{ request.currentState.observation.domains.join('、') || '无' }} · {{ request.currentState.observation.riskLevels.map(auditRegistryRiskLabel).join('、') || '无' }}</p></div>
            <div class="rounded-lg p-3" :class="request.currentState.governanceReady ? 'bg-emerald-50 text-emerald-950' : 'bg-amber-50 text-amber-950'"><p class="text-xs">治理引用</p><p class="mt-1 text-sm font-semibold">{{ request.currentState.governanceReady ? '当前已批准并就绪' : '已失效或未就绪' }}</p></div>
          </div>
        </article>

        <form v-if="request.status === 'pending_review' && request.canReview" class="min-w-0 rounded-xl border border-blue-200 bg-white p-4 sm:p-5" @submit.prevent="submitReview">
          <h2 class="text-base font-semibold text-gray-950">独立复核</h2>
          <p class="mt-1 text-xs leading-5 text-gray-500">服务端会在提交时重新核对当前版本和观察口径；页面可见按钮不替代权限或并发校验。</p>
          <div class="mt-4 grid gap-3 sm:grid-cols-2">
            <label class="text-sm text-gray-700">决定<select v-model="decision" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3"><option value="approve">批准并追加版本</option><option value="reject">驳回申请</option></select></label>
            <label class="text-sm text-gray-700">结构化原因<select v-model="reasonCode" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3"><option v-for="item in decision === 'approve' ? approveReasons : rejectReasons" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
          </div>
          <label class="mt-3 block text-sm text-gray-700">复核说明<textarea v-model="reviewNote" required minlength="10" maxlength="1000" rows="4" placeholder="记录已核对的定义、来源、可见角色、策略引用和结论依据。" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 leading-6" /></label>
          <button type="submit" :disabled="reviewing" class="mt-4 min-h-11 max-w-full whitespace-normal rounded-lg px-5 py-2 text-sm font-medium text-white disabled:opacity-50" :class="decision === 'approve' ? 'bg-blue-700 hover:bg-blue-800' : 'bg-red-700 hover:bg-red-800'">{{ reviewing ? '正在重新核对…' : decision === 'approve' ? '批准并追加正式版本' : '驳回本次申请' }}</button>
        </form>
        <section v-else-if="request.status === 'pending_review'" class="rounded-xl border border-amber-200 bg-amber-50 p-5"><h2 class="text-sm font-semibold text-amber-950">等待另一位 Owner</h2><p class="mt-2 text-sm leading-6 text-amber-900">申请人不能复核本人操作。请由另一位有效 Owner 进入本页完成独立判断。</p></section>
        <section v-else class="rounded-xl border border-gray-200 bg-white p-5"><h2 class="text-sm font-semibold text-gray-950">复核结论</h2><p class="mt-2 text-sm text-gray-700">{{ request.reviewReasonCode || '无结构化原因' }}</p><p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-700">{{ request.reviewNote || '无复核说明' }}</p><p v-if="request.resultRegistryId" class="mt-3 break-all font-mono text-xs text-emerald-700">正式版本：{{ request.resultRegistryId }}</p></section>
      </section>

      <section class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <h2 class="text-base font-semibold text-gray-950">不可变时间线</h2>
        <div v-if="request.events.length" class="mt-4 space-y-3">
          <article v-for="event in request.events" :key="event.eventId" class="grid min-w-0 gap-3 rounded-lg border border-gray-200 p-4 md:grid-cols-[42px_minmax(0,1fr)_180px] md:items-start">
            <span class="flex size-8 items-center justify-center rounded-full bg-gray-950 text-xs font-semibold text-white">{{ event.sequence }}</span>
            <div class="min-w-0"><p class="text-sm font-semibold text-gray-950">{{ eventLabel(event.type) }}</p><p class="mt-1 break-words text-xs leading-5 text-gray-600">{{ event.actor.label }} · {{ event.reasonCode }}</p><pre class="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-2 font-mono text-[10px] leading-5 text-gray-600">{{ JSON.stringify(event.summary, null, 2) }}</pre></div>
            <p class="text-xs text-gray-500 md:text-right">{{ formatAuditRegistryTime(event.createdAt) }}<br><span class="break-all font-mono text-[10px]">{{ event.eventId }}</span></p>
          </article>
        </div>
      </section>
    </template>
  </div>
</template>
