<script setup lang="ts">
import {
  adminAuditPurposeLabel,
  adminAuditResultClass,
  adminAuditResultLabel,
  adminAuditRiskClass,
  adminAuditRiskLabel,
  formatAdminAuditTime,
  type AdminAppAuditEventList,
  type AdminAppAuditEventSummary,
  type AdminAppAuditPurpose,
} from '~/types/admin-app-audit'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()
const now = new Date()
const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000)

const purpose = ref<AdminAppAuditPurpose>('operational_investigation')
const from = ref(toLocalDateTime(sevenDaysAgo))
const to = ref(toLocalDateTime(now))
const action = ref('')
const domain = ref('')
const riskLevel = ref('')
const result = ref('')
const targetType = ref('')
const targetId = ref('')
const actorId = ref('')
const requestId = ref('')
const traceId = ref('')
const businessReference = ref('')
const showAdvanced = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const errorMessage = ref('')
const response = ref<AdminAppAuditEventList | null>(null)
const events = ref<AdminAppAuditEventSummary[]>([])
const appliedQuery = ref<AuditQueryParams | null>(null)

type AuditQueryParams = {
  purpose: AdminAppAuditPurpose
  from: string
  to: string
  action?: string
  domain?: string
  riskLevel?: string
  result?: string
  targetType?: string
  targetId?: string
  actorId?: string
  requestId?: string
  traceId?: string
  businessReference?: string
  limit: number
}

const purposeOptions: AdminAppAuditPurpose[] = [
  'operational_investigation',
  'security_review',
  'financial_reconciliation',
  'compliance_audit',
]

const filtersDirty = computed(() => {
  if (!appliedQuery.value) return false
  try {
    return JSON.stringify(buildQuery()) !== JSON.stringify(appliedQuery.value)
  }
  catch {
    return true
  }
})

onMounted(() => runQuery(true))

async function runQuery(reset: boolean) {
  if (reset) loading.value = true
  else loadingMore.value = true
  errorMessage.value = ''
  try {
    const baseQuery = reset ? buildQuery() : appliedQuery.value
    if (!baseQuery) return
    const query = {
      ...baseQuery,
      cursor: reset ? undefined : response.value?.nextCursor ?? undefined,
    }
    const result = await api<{ data: AdminAppAuditEventList }>('/api/admin/app/audit/events', { query })
    response.value = result.data
    events.value = reset ? result.data.events : [...events.value, ...result.data.events]
    if (reset) appliedQuery.value = baseQuery
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '审计事件加载失败，请检查时间范围与查询用途。')
  }
  finally {
    loading.value = false
    loadingMore.value = false
  }
}

function buildQuery(): AuditQueryParams {
  const fromDate = new Date(from.value)
  const toDate = new Date(to.value)
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new Error('请选择合法的开始与结束时间')
  }
  return {
    purpose: purpose.value,
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
    action: action.value || undefined,
    domain: domain.value || undefined,
    riskLevel: riskLevel.value || undefined,
    result: result.value || undefined,
    targetType: targetType.value.trim() || undefined,
    targetId: targetId.value.trim() || undefined,
    actorId: isOwner.value ? actorId.value.trim() || undefined : undefined,
    requestId: requestId.value.trim() || undefined,
    traceId: traceId.value.trim() || undefined,
    businessReference: businessReference.value.trim() || undefined,
    limit: 30,
  }
}

function clearOptionalFilters() {
  action.value = ''
  domain.value = ''
  riskLevel.value = ''
  result.value = ''
  targetType.value = ''
  targetId.value = ''
  actorId.value = ''
  requestId.value = ''
  traceId.value = ''
  businessReference.value = ''
}

function toLocalDateTime(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function payloadStateLabel(value: 'empty' | 'valid' | 'invalid') {
  return { empty: '无载荷', valid: '可脱敏查看', invalid: '格式异常' }[value]
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-AUD-01" route="/admin/app/audit" title="审计查询" description="按动作、对象、操作者、时间和请求链查询稳定责任事实；查询本身留痕。" :state="errorMessage ? '查询失败' : loading ? '查询中' : '正常'" figma-state="正常" :state-tone="errorMessage ? 'danger' : loading ? 'warning' : 'success'">
      <template #actions>
        <NuxtLink
          v-if="isOwner"
          to="/admin/app/audit/registry"
          class="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Action 口径
        </NuxtLink>
        <NuxtLink
          to="/admin/app/audit/exports"
          class="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          受控导出
        </NuxtLink>
        <NuxtLink
          v-if="isOwner"
          to="/admin/app/audit/integrity"
          class="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          完整性状态
        </NuxtLink>
      </template>
    </AdminAppPageHeader>

    <section class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
      <form class="space-y-4" @submit.prevent="runQuery(true)">
        <div class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label class="min-w-0 text-sm text-gray-700">查询用途
            <select v-model="purpose" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
              <option v-for="item in purposeOptions" :key="item" :value="item">{{ adminAuditPurposeLabel(item) }}</option>
            </select>
          </label>
          <label class="min-w-0 text-sm text-gray-700">开始时间
            <input v-model="from" type="datetime-local" required class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" />
          </label>
          <label class="min-w-0 text-sm text-gray-700">结束时间
            <input v-model="to" type="datetime-local" required class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" />
          </label>
          <label class="min-w-0 text-sm text-gray-700">风险等级
            <select v-model="riskLevel" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
              <option value="">全部风险</option>
              <option value="critical">关键</option>
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </label>
        </div>

        <div class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label class="min-w-0 text-sm text-gray-700">业务域
            <select v-model="domain" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
              <option value="">全部业务域</option>
              <option v-for="item in response?.filterOptions.domains ?? []" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label class="min-w-0 text-sm text-gray-700">操作 action
            <select v-model="action" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
              <option value="">全部操作</option>
              <option v-for="item in response?.filterOptions.actions ?? []" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </label>
          <label class="min-w-0 text-sm text-gray-700">执行结果
            <select v-model="result" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
              <option value="">全部结果</option>
              <option value="succeeded">成功</option>
              <option value="denied">拒绝</option>
              <option value="failed">失败</option>
            </select>
          </label>
          <label class="min-w-0 text-sm text-gray-700">目标类型
            <input v-model="targetType" maxlength="96" placeholder="例如 app_membership_grant" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" />
          </label>
        </div>

        <button type="button" class="text-sm font-medium text-gray-700 underline underline-offset-4" @click="showAdvanced = !showAdvanced">
          {{ showAdvanced ? '收起精确引用筛选' : '展开精确引用筛选' }}
        </button>

        <div v-if="showAdvanced" class="grid min-w-0 gap-3 rounded-lg bg-gray-50 p-3 md:grid-cols-2 xl:grid-cols-3">
          <label class="min-w-0 text-sm text-gray-700">目标 ID
            <input v-model="targetId" maxlength="192" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" />
          </label>
          <label v-if="isOwner" class="min-w-0 text-sm text-gray-700">操作者数字 ID
            <input v-model="actorId" inputmode="numeric" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" />
          </label>
          <label class="min-w-0 text-sm text-gray-700">业务单号
            <input v-model="businessReference" maxlength="192" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" />
          </label>
          <label class="min-w-0 text-sm text-gray-700">Request ID
            <input v-model="requestId" maxlength="192" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" />
          </label>
          <label class="min-w-0 text-sm text-gray-700">Trace ID
            <input v-model="traceId" maxlength="192" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" />
          </label>
        </div>

        <div class="flex flex-wrap gap-2">
          <button type="submit" :disabled="loading" class="inline-flex min-h-11 items-center justify-center rounded-lg bg-gray-950 px-5 text-sm font-medium text-white hover:bg-black disabled:opacity-50">
            {{ loading ? '正在查询…' : '执行审计查询' }}
          </button>
          <button type="button" class="inline-flex min-h-11 items-center justify-center rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50" @click="clearOptionalFilters">清除可选筛选</button>
        </div>
      </form>
    </section>

    <p v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ errorMessage }}</p>

    <section v-if="response" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">范围内事件</p><p class="mt-1 text-2xl font-semibold text-gray-950">{{ response.summary.total }}</p><p class="mt-1 text-xs text-gray-500">权限：{{ response.visibility === 'all' ? '跨域只读' : '仅本人操作' }}</p></div>
      <div class="rounded-xl border border-red-200 bg-red-50 p-4"><p class="text-xs text-red-700">关键风险</p><p class="mt-1 text-2xl font-semibold text-red-950">{{ response.summary.critical }}</p></div>
      <div class="rounded-xl border border-amber-200 bg-amber-50 p-4"><p class="text-xs text-amber-800">高风险</p><p class="mt-1 text-2xl font-semibold text-amber-950">{{ response.summary.high }}</p></div>
      <div class="rounded-xl border border-violet-200 bg-violet-50 p-4"><p class="text-xs text-violet-700">未登记 action 事件</p><p class="mt-1 text-2xl font-semibold text-violet-950">{{ response.summary.unregistered }}</p><p class="mt-1 text-xs text-violet-700">不把未知口径视为已就绪</p></div>
    </section>

    <p v-if="loading" class="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">正在按授权范围读取审计事件…</p>

    <section v-else-if="events.length" class="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div class="hidden grid-cols-[90px_minmax(150px,1fr)_minmax(180px,1.3fr)_minmax(170px,1fr)_100px_100px] gap-4 border-b border-gray-200 bg-gray-50 px-5 py-3 text-xs font-medium text-gray-500 xl:grid">
        <span>序号 / 时间</span><span>操作者</span><span>操作</span><span>目标</span><span>风险 / 结果</span><span class="text-right">详情</span>
      </div>
      <article v-for="event in events" :key="event.eventId" class="grid min-w-0 gap-3 border-b border-gray-100 p-5 last:border-b-0 xl:grid-cols-[90px_minmax(150px,1fr)_minmax(180px,1.3fr)_minmax(170px,1fr)_100px_100px] xl:items-center xl:gap-4">
        <div class="min-w-0">
          <p class="font-mono text-xs font-semibold text-gray-900">#{{ event.sequence }}</p>
          <p class="mt-1 text-[11px] leading-5 text-gray-500">{{ formatAdminAuditTime(event.occurredAt) }}</p>
        </div>
        <div class="min-w-0">
          <p class="truncate text-sm font-medium text-gray-950">{{ event.actor.label }}</p>
          <p class="mt-1 text-xs text-gray-500">{{ event.actor.role }} · #{{ event.actor.id }}</p>
        </div>
        <div class="min-w-0">
          <p class="break-words text-sm font-medium text-gray-900">{{ event.actionDisplayName }}</p>
          <p class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ event.action }}</p>
          <p class="mt-1 text-[11px]" :class="event.registry ? 'text-emerald-700' : 'text-violet-700'">{{ event.registry ? `已登记 v${event.registry.schemaVersion}` : '生产 action 口径未登记' }}</p>
        </div>
        <div class="min-w-0">
          <p class="break-words text-xs font-medium text-gray-700">{{ event.target.type }}</p>
          <p class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ event.target.id || '无目标 ID' }}</p>
          <p v-if="event.context.businessReference" class="mt-1 break-all text-[11px] text-gray-500">业务单：{{ event.context.businessReference }}</p>
        </div>
        <div class="flex flex-wrap gap-1.5 xl:block xl:space-y-1.5">
          <span class="inline-flex rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="adminAuditRiskClass(event.riskLevel)">{{ adminAuditRiskLabel(event.riskLevel) }}</span>
          <span class="inline-flex rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="adminAuditResultClass(event.result)">{{ adminAuditResultLabel(event.result) }}</span>
        </div>
        <div class="xl:text-right">
          <NuxtLink :to="{ path: `/admin/app/audit/${event.eventId}`, query: { purpose } }" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50">查看</NuxtLink>
          <p class="mt-1 text-[10px] text-gray-400">{{ payloadStateLabel(event.payloadState.after) }}</p>
        </div>
      </article>
    </section>

    <section v-else-if="response && !errorMessage" class="rounded-xl border border-dashed border-gray-300 bg-white p-12 text-center">
      <p class="text-sm font-medium text-gray-700">当前范围没有可见审计事件</p>
      <p class="mt-2 text-xs leading-5 text-gray-500">请调整时间或精确筛选；普通管理员只能查询本人操作。</p>
    </section>

    <p v-if="response?.nextCursor && filtersDirty" class="rounded-xl border border-blue-200 bg-blue-50 p-4 text-center text-sm text-blue-800">筛选条件已修改。请先重新执行查询，避免把不同范围的事件混入当前结果。</p>

    <div v-if="response?.nextCursor && !filtersDirty" class="flex justify-center">
      <button type="button" :disabled="loadingMore" class="min-h-11 rounded-lg border border-gray-300 bg-white px-5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50" @click="runQuery(false)">{{ loadingMore ? '正在加载…' : '加载更多事件' }}</button>
    </div>
  </div>
</template>
