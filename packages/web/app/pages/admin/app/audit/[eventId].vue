<script setup lang="ts">
import {
  adminAuditPurposeLabel,
  adminAuditResultClass,
  adminAuditResultLabel,
  adminAuditRiskClass,
  adminAuditRiskLabel,
  formatAdminAuditTime,
  type AdminAppAuditEventDetail,
  type AdminAppAuditPurpose,
} from '~/types/admin-app-audit'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const allowedPurposes: AdminAppAuditPurpose[] = [
  'operational_investigation',
  'security_review',
  'financial_reconciliation',
  'compliance_audit',
]
const requestedPurpose = typeof route.query.purpose === 'string' && allowedPurposes.includes(route.query.purpose as AdminAppAuditPurpose)
  ? route.query.purpose as AdminAppAuditPurpose
  : null
const purpose = ref<AdminAppAuditPurpose | ''>(requestedPurpose ?? '')
const detail = ref<AdminAppAuditEventDetail | null>(null)
const loading = ref(false)
const errorMessage = ref('')

onMounted(() => {
  if (purpose.value) loadDetail()
})

async function loadDetail() {
  if (!purpose.value) {
    errorMessage.value = '请选择本次读取的业务用途。'
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    const response = await api<{ data: AdminAppAuditEventDetail }>(
      `/api/admin/app/audit/events/${encodeURIComponent(String(route.params.eventId))}`,
      { query: { purpose: purpose.value } },
    )
    detail.value = response.data
    await navigateTo({ query: { purpose: purpose.value } }, { replace: true })
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '审计详情读取失败或不在当前授权范围。')
  }
  finally {
    loading.value = false
  }
}

function renderPayload(value: unknown) {
  return JSON.stringify(value, null, 2)
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <header class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div class="min-w-0">
        <NuxtLink to="/admin/app/audit" class="text-sm font-medium text-gray-600 hover:text-gray-950">← 返回审计查询</NuxtLink>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <h1 class="text-xl font-bold text-gray-950">审计事件详情</h1>
          <span v-if="detail" class="rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset" :class="adminAuditRiskClass(detail.riskLevel)">{{ adminAuditRiskLabel(detail.riskLevel) }}风险</span>
        </div>
        <p class="mt-1 max-w-4xl text-sm leading-6 text-gray-600">只展示字段级脱敏差异和受控引用。详情读取本身会新增审计事件，不会修改原事件或触发任何业务重放。</p>
      </div>
      <p v-if="detail" class="max-w-full break-all font-mono text-xs text-gray-500">{{ detail.eventId }}</p>
    </header>

    <section v-if="!detail" class="rounded-xl border border-amber-200 bg-amber-50 p-5">
      <h2 class="text-sm font-semibold text-amber-950">读取前确认业务用途</h2>
      <p class="mt-1 text-sm leading-6 text-amber-800">用途会写入新的访问审计；请勿以通用浏览为由批量打开敏感事件。</p>
      <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label class="min-w-0 flex-1 text-sm text-amber-950">本次用途
          <select v-model="purpose" class="mt-1 min-h-11 w-full rounded-lg border border-amber-300 bg-white px-3">
            <option value="" disabled>请选择</option>
            <option v-for="item in allowedPurposes" :key="item" :value="item">{{ adminAuditPurposeLabel(item) }}</option>
          </select>
        </label>
        <button type="button" :disabled="!purpose || loading" class="min-h-11 rounded-lg bg-amber-950 px-5 text-sm font-medium text-white disabled:opacity-50" @click="loadDetail">{{ loading ? '正在读取…' : '确认并读取详情' }}</button>
      </div>
    </section>

    <p v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ errorMessage }}</p>
    <p v-if="loading && !detail" class="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">正在执行授权范围复核与脱敏…</p>

    <template v-if="detail">
      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">稳定序号</p><p class="mt-1 font-mono text-xl font-semibold text-gray-950">#{{ detail.sequence }}</p></div>
        <div class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">发生时间</p><p class="mt-1 text-sm font-semibold leading-6 text-gray-950">{{ formatAdminAuditTime(detail.occurredAt) }}</p></div>
        <div class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">执行结果</p><span class="mt-2 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset" :class="adminAuditResultClass(detail.result)">{{ adminAuditResultLabel(detail.result) }}</span></div>
        <div class="rounded-xl border p-4" :class="detail.registry ? 'border-emerald-200 bg-emerald-50' : 'border-violet-200 bg-violet-50'"><p class="text-xs" :class="detail.registry ? 'text-emerald-700' : 'text-violet-700'">动作登记</p><p class="mt-1 text-sm font-semibold" :class="detail.registry ? 'text-emerald-950' : 'text-violet-950'">{{ detail.registry ? `已登记 Schema v${detail.registry.schemaVersion}` : '尚未登记生产口径' }}</p></div>
      </section>

      <section class="rounded-xl border border-gray-200 bg-white p-5">
        <h2 class="text-base font-semibold text-gray-950">责任事实</h2>
        <dl class="mt-4 grid min-w-0 gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
          <div class="min-w-0"><dt class="text-xs text-gray-500">谁</dt><dd class="mt-1 break-words text-sm font-medium text-gray-900">{{ detail.explanation.who }} · {{ detail.actor.role }} #{{ detail.actor.id }}</dd></div>
          <div class="min-w-0"><dt class="text-xs text-gray-500">何时</dt><dd class="mt-1 text-sm text-gray-900">{{ formatAdminAuditTime(detail.explanation.when) }}</dd></div>
          <div class="min-w-0"><dt class="text-xs text-gray-500">做了什么</dt><dd class="mt-1 break-words text-sm text-gray-900">{{ detail.explanation.what }}<span class="mt-1 block break-all font-mono text-xs text-gray-500">{{ detail.action }}</span></dd></div>
          <div class="min-w-0"><dt class="text-xs text-gray-500">对什么</dt><dd class="mt-1 break-all text-sm text-gray-900">{{ detail.explanation.target }}</dd></div>
          <div class="min-w-0"><dt class="text-xs text-gray-500">为什么</dt><dd class="mt-1 break-words text-sm text-gray-900">{{ detail.explanation.why }}</dd></div>
          <div class="min-w-0"><dt class="text-xs text-gray-500">审批引用</dt><dd class="mt-1 break-all font-mono text-xs text-gray-900">{{ detail.explanation.approval }}</dd></div>
        </dl>
      </section>

      <section class="rounded-xl border border-gray-200 bg-white p-5">
        <h2 class="text-base font-semibold text-gray-950">关联上下文</h2>
        <dl class="mt-4 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div v-for="item in [
            ['Request ID', detail.context.requestId],
            ['Trace ID', detail.context.traceId],
            ['原因码', detail.context.reasonCode],
            ['业务单号', detail.context.businessReference],
            ['目标版本', detail.context.targetVersion],
            ['审批申请', detail.context.approvalRequestId],
            ['审批步骤', detail.context.approvalStepId],
            ['策略版本', detail.context.policyVersion],
            ['Capability', detail.context.capability],
            ['范围摘要', detail.context.scopeSummary],
            ['错误码', detail.context.errorCode],
          ]" :key="String(item[0])" class="min-w-0 rounded-lg bg-gray-50 p-3">
            <dt class="text-xs text-gray-500">{{ item[0] }}</dt>
            <dd class="mt-1 break-all font-mono text-xs text-gray-900">{{ item[1] || '未登记' }}</dd>
          </div>
        </dl>
      </section>

      <section class="grid min-w-0 gap-4 xl:grid-cols-2">
        <article v-for="payload in [{ label: '变更前', data: detail.before }, { label: '变更后', data: detail.after }]" :key="payload.label" class="min-w-0 rounded-xl border border-gray-200 bg-white p-5">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div><h2 class="text-base font-semibold text-gray-950">{{ payload.label }}</h2><p class="mt-1 text-xs text-gray-500">已脱敏字段 {{ payload.data.redactedFieldCount }} 个</p></div>
            <span class="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">{{ payload.data.state }}</span>
          </div>
          <p class="mt-3 break-all font-mono text-[11px] text-gray-500">SHA-256：{{ payload.data.digest || '无载荷' }}</p>
          <pre class="mt-3 max-h-[32rem] min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-gray-950 p-4 text-xs leading-6 text-gray-100">{{ renderPayload(payload.data.value) }}</pre>
        </article>
      </section>

      <section class="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div class="border-b border-gray-200 px-5 py-4"><h2 class="text-base font-semibold text-gray-950">关联事件时间线</h2><p class="mt-1 text-xs leading-5 text-gray-500">仅使用相同目标、request、trace 或业务单号建立非敏感关联。</p></div>
        <ol class="divide-y divide-gray-100">
          <li v-for="event in detail.relatedEvents" :key="event.eventId" class="grid min-w-0 gap-3 p-5 md:grid-cols-[90px_minmax(0,1fr)_140px] md:items-center">
            <div><p class="font-mono text-xs font-semibold text-gray-900">#{{ event.sequence }}</p><p class="mt-1 text-[11px] text-gray-500">{{ formatAdminAuditTime(event.occurredAt) }}</p></div>
            <div class="min-w-0"><p class="break-words text-sm font-medium text-gray-900">{{ event.actionDisplayName }}</p><p class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ event.target.type }} / {{ event.target.id || '—' }}</p></div>
            <NuxtLink v-if="event.eventId !== detail.eventId" :to="{ path: `/admin/app/audit/${event.eventId}`, query: { purpose } }" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50">读取该事件</NuxtLink>
            <span v-else class="text-xs font-medium text-emerald-700 md:text-right">当前事件</span>
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>
