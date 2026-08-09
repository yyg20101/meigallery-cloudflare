<script setup lang="ts">
import {
  auditRegistryOperationLabel,
  auditRegistryRequestStatusClass,
  auditRegistryRequestStatusLabel,
  auditRegistryRiskLabel,
  auditRegistrySensitivityLabel,
  auditRegistryStateClass,
  auditRegistryStateLabel,
  formatAuditRegistryTime,
  type AdminAppAuditRegistryActionSummary,
  type AdminAppAuditRegistryOperation,
  type AdminAppAuditRegistryOverview,
  type AdminAppAuditRegistryPreview,
  type AdminAppAuditRegistryRequest,
  type AdminAppAuditRegistryRiskLevel,
  type AdminAppAuditRegistrySensitivity,
} from '~/types/admin-app-audit-registry'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const overview = ref<AdminAppAuditRegistryOverview | null>(null)
const actions = ref<AdminAppAuditRegistryActionSummary[]>([])
const requests = ref<AdminAppAuditRegistryRequest[]>([])
const loading = ref(true)
const filtering = ref(false)
const previewing = ref(false)
const submitting = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const stateFilter = ref('')
const domainFilter = ref('')
const keyword = ref('')
const editorOpen = ref(false)
const selectedAction = ref<AdminAppAuditRegistryActionSummary | null>(null)
const preview = ref<AdminAppAuditRegistryPreview | null>(null)

const form = reactive({
  actionKey: '',
  operation: 'publish' as AdminAppAuditRegistryOperation,
  domain: 'audit',
  displayName: '',
  ownerReference: '',
  sensitivity: 'restricted' as AdminAppAuditRegistrySensitivity,
  riskLevel: 'high' as AdminAppAuditRegistryRiskLevel,
  adminVisible: false,
  retentionPolicyReference: '',
  qualityRuleReference: '',
  requestReason: '',
})

const domainOptions = computed(() => [...new Set(actions.value.flatMap((item) => [
  item.latestDefinition?.domain,
  ...item.observation.domains,
]).filter((item): item is string => Boolean(item)))].sort())

watch(form, () => {
  preview.value = null
  successMessage.value = ''
}, { deep: true })

onMounted(loadWorkspace)

async function loadWorkspace() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [overviewResponse, actionsResponse, requestsResponse] = await Promise.all([
      api<{ data: AdminAppAuditRegistryOverview }>('/api/admin/app/audit/registry/overview'),
      api<{ data: AdminAppAuditRegistryActionSummary[] }>('/api/admin/app/audit/registry/actions'),
      api<{ data: AdminAppAuditRegistryRequest[] }>('/api/admin/app/audit/registry/requests', {
        query: { limit: 30 },
      }),
    ])
    overview.value = overviewResponse.data
    actions.value = actionsResponse.data
    requests.value = requestsResponse.data
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, 'Action 口径治理工作区加载失败。该页面仅限有效 Owner。')
  }
  finally {
    loading.value = false
  }
}

async function applyFilters() {
  filtering.value = true
  errorMessage.value = ''
  try {
    const response = await api<{ data: AdminAppAuditRegistryActionSummary[] }>('/api/admin/app/audit/registry/actions', {
      query: {
        state: stateFilter.value || undefined,
        domain: domainFilter.value || undefined,
        q: keyword.value.trim() || undefined,
      },
    })
    actions.value = response.data
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, 'Action 筛选失败，请检查输入。')
  }
  finally {
    filtering.value = false
  }
}

function clearFilters() {
  stateFilter.value = ''
  domainFilter.value = ''
  keyword.value = ''
  loadWorkspace()
}

function startNewAction() {
  selectedAction.value = null
  Object.assign(form, {
    actionKey: '',
    operation: 'publish',
    domain: 'audit',
    displayName: '',
    ownerReference: '',
    sensitivity: 'restricted',
    riskLevel: 'high',
    adminVisible: false,
    retentionPolicyReference: '',
    qualityRuleReference: '',
    requestReason: '',
  })
  editorOpen.value = true
  preview.value = null
  nextTick(() => document.querySelector<HTMLElement>('[data-registry-editor]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

function startPublish(item: AdminAppAuditRegistryActionSummary) {
  const definition = item.latestDefinition
  selectedAction.value = item
  Object.assign(form, {
    actionKey: item.actionKey,
    operation: 'publish',
    domain: definition?.domain ?? item.observation.domains[0] ?? 'audit',
    displayName: definition?.displayName ?? item.actionKey,
    ownerReference: definition?.ownerReference ?? '',
    sensitivity: definition?.sensitivity ?? 'restricted',
    riskLevel: definition?.riskLevel ?? item.observation.riskLevels[0] ?? 'high',
    adminVisible: definition?.visibleRoles.includes('admin') ?? false,
    retentionPolicyReference: definition?.retentionPolicyReference ?? '',
    qualityRuleReference: definition?.qualityRuleReference ?? '',
    requestReason: '',
  })
  editorOpen.value = true
  preview.value = null
  nextTick(() => document.querySelector<HTMLElement>('[data-registry-editor]')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

function startRetire(item: AdminAppAuditRegistryActionSummary) {
  if (item.latestDefinition?.status !== 'active') return
  startPublish(item)
  form.operation = 'retire'
}

function proposalBody() {
  return {
    actionKey: form.actionKey.trim(),
    operation: form.operation,
    domain: form.domain.trim(),
    displayName: form.displayName.trim(),
    ownerReference: form.ownerReference.trim(),
    sensitivity: form.sensitivity,
    riskLevel: form.riskLevel,
    visibleRoles: form.adminVisible ? ['admin', 'owner'] : ['owner'],
    retentionPolicyReference: form.retentionPolicyReference.trim(),
    qualityRuleReference: form.qualityRuleReference.trim(),
    requestReason: form.requestReason.trim(),
  }
}

async function previewProposal() {
  previewing.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const response = await api<{ data: AdminAppAuditRegistryPreview }>('/api/admin/app/audit/registry/preview', {
      method: 'POST',
      body: proposalBody(),
    })
    preview.value = response.data
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '口径预览失败，请检查必填字段与稳定引用格式。')
  }
  finally {
    previewing.value = false
  }
}

async function submitRequest() {
  if (!preview.value?.canSubmit) return
  if (Array.from(form.requestReason.trim()).length < 10) {
    errorMessage.value = '申请原因至少填写 10 个字符。'
    return
  }
  const message = form.operation === 'publish'
    ? `确认提交 ${form.actionKey} 的 v${preview.value.proposal.schemaVersion} 口径申请？提交后必须由另一位 Owner 独立复核。`
    : `确认提交 ${form.actionKey} 的退休申请？批准后该 Action 会从当前 active 口径移除。`
  if (!window.confirm(message)) return
  submitting.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const response = await api<{ data: AdminAppAuditRegistryRequest; replayed: boolean }>('/api/admin/app/audit/registry/requests', {
      method: 'POST',
      headers: { 'Idempotency-Key': `audit-registry-create-${crypto.randomUUID()}` },
      body: proposalBody(),
    })
    successMessage.value = response.replayed ? '已返回同一口径申请。' : '口径申请已提交，等待另一位 Owner 独立复核。'
    editorOpen.value = false
    preview.value = null
    await loadWorkspace()
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '口径申请提交失败，请刷新当前 Action 状态后重试。')
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <header class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
      <div class="min-w-0">
        <NuxtLink to="/admin/app/audit/integrity" class="text-sm font-medium text-gray-600 hover:text-gray-950">← 返回审计完整性</NuxtLink>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <h1 class="text-xl font-bold text-gray-950">Action 口径治理</h1>
          <span class="rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-800">Owner · 双人复核</span>
        </div>
        <p class="mt-1 max-w-4xl text-sm leading-6 text-gray-600">从真实审计事实识别未登记 Action，预览历史影响并追加正式版本。这里不会自动登记、修改历史事实、批准保留策略或运行清理。</p>
      </div>
      <button type="button" class="inline-flex min-h-11 max-w-full shrink-0 items-center justify-center whitespace-normal rounded-lg bg-gray-950 px-5 py-2 text-sm font-medium text-white hover:bg-black" @click="startNewAction">登记前置 Action</button>
    </header>

    <p v-if="errorMessage" class="break-words rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ errorMessage }}</p>
    <p v-if="successMessage" class="break-words rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-700">{{ successMessage }}</p>
    <p v-if="loading" class="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">正在读取 Action 口径、观察事实与待复核申请…</p>

    <template v-if="overview">
      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">观察到的 Action</p><p class="mt-1 text-2xl font-semibold text-gray-950">{{ overview.distinctActionCount }}</p><p class="mt-1 text-xs text-gray-500">当前 active {{ overview.activeActionCount }}</p></div>
        <div class="rounded-xl border border-violet-200 bg-violet-50 p-4"><p class="text-xs text-violet-700">未登记 Action</p><p class="mt-1 text-2xl font-semibold text-violet-950">{{ overview.unregisteredActionCount }}</p><p class="mt-1 text-xs text-violet-700">涉及事实 {{ overview.unregisteredEventCount }}</p></div>
        <div class="rounded-xl border border-blue-200 bg-blue-50 p-4"><p class="text-xs text-blue-700">待独立复核</p><p class="mt-1 text-2xl font-semibold text-blue-950">{{ overview.pendingRequestCount }}</p><p class="mt-1 text-xs text-blue-700">申请人不能自审</p></div>
        <div class="rounded-xl border p-4" :class="overview.productionReady ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'"><p class="text-xs" :class="overview.productionReady ? 'text-emerald-700' : 'text-amber-800'">Registry 就绪状态</p><p class="mt-1 text-lg font-semibold" :class="overview.productionReady ? 'text-emerald-950' : 'text-amber-950'">{{ overview.productionReady ? '口径治理无阻断' : '尚未生产就绪' }}</p><p class="mt-1 text-xs" :class="overview.productionReady ? 'text-emerald-700' : 'text-amber-800'">冲突 {{ overview.inconsistentActionCount }} · 治理引用未就绪 {{ overview.definitionsNotProductionReady }}</p></div>
      </section>

      <section v-if="overview.blockers.length" class="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <h2 class="text-sm font-semibold text-amber-950">当前阻断项</h2>
        <ul class="mt-2 space-y-1 text-sm leading-6 text-amber-900"><li v-for="item in overview.blockers" :key="item">• {{ item }}</li></ul>
        <p class="mt-3 text-xs leading-5 text-amber-800">申请与代码存在不代表正式口径、保留政策或 production 已获批准。</p>
      </section>

      <section data-registry-editor v-if="editorOpen" class="scroll-mt-4 rounded-xl border border-blue-200 bg-white p-4 shadow-sm sm:p-5">
        <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0"><h2 class="text-base font-semibold text-gray-950">{{ form.operation === 'publish' ? '口径候选与影响预览' : '退休当前口径' }}</h2><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ form.actionKey || '尚未填写 action key' }}</p></div>
          <button type="button" class="self-start text-sm font-medium text-gray-600 hover:text-gray-950" @click="editorOpen = false">关闭</button>
        </div>

        <form class="mt-5 space-y-4" @submit.prevent="previewProposal">
          <div class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label class="min-w-0 text-sm text-gray-700">Action key
              <input v-model="form.actionKey" required maxlength="128" :readonly="Boolean(selectedAction)" placeholder="app.domain.action" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs read-only:bg-gray-50" />
            </label>
            <label class="min-w-0 text-sm text-gray-700">变更动作
              <select v-model="form.operation" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
                <option value="publish">发布新口径版本</option>
                <option v-if="selectedAction?.latestDefinition?.status === 'active'" value="retire">退休当前口径</option>
              </select>
            </label>
            <label v-if="form.operation === 'publish'" class="min-w-0 text-sm text-gray-700">业务域
              <input v-model="form.domain" required maxlength="48" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" />
            </label>
            <label v-if="form.operation === 'publish'" class="min-w-0 text-sm text-gray-700">展示名称
              <input v-model="form.displayName" required maxlength="120" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" />
            </label>
          </div>

          <div v-if="form.operation === 'publish'" class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label class="min-w-0 text-sm text-gray-700">Owner 稳定引用
              <input v-model="form.ownerReference" required maxlength="192" placeholder="team://audit-owner" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" />
            </label>
            <label class="min-w-0 text-sm text-gray-700">敏感级别
              <select v-model="form.sensitivity" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3"><option value="internal">内部</option><option value="restricted">受限</option><option value="highly_restricted">高度受限</option></select>
            </label>
            <label class="min-w-0 text-sm text-gray-700">风险等级
              <select v-model="form.riskLevel" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3"><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">关键</option></select>
            </label>
            <label class="flex min-h-11 items-center gap-3 self-end rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700"><input v-model="form.adminVisible" type="checkbox" class="size-4" /><span>允许 admin 在本人范围查看<br><small class="text-gray-500">Owner 始终可见</small></span></label>
          </div>

          <div v-if="form.operation === 'publish'" class="grid min-w-0 gap-3 md:grid-cols-2">
            <label class="min-w-0 text-sm text-gray-700">已审批保留策略引用
              <input v-model="form.retentionPolicyReference" required maxlength="192" placeholder="policy://audit-retention/v1" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" />
              <span class="mt-1 block text-xs leading-5 text-gray-500">这里只引用外部已审批事实，不在本页设置天数或开启清理。</span>
            </label>
            <label class="min-w-0 text-sm text-gray-700">质量规则引用
              <input v-model="form.qualityRuleReference" required maxlength="192" placeholder="quality://audit-action/v1" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono text-xs" />
              <span class="mt-1 block text-xs leading-5 text-gray-500">用于核对来源、字段、风险与完整性，不执行自动修复。</span>
            </label>
          </div>

          <label class="block min-w-0 text-sm text-gray-700">申请原因
            <textarea v-model="form.requestReason" required minlength="10" maxlength="1000" rows="3" placeholder="说明新增、变更或退休该 Action 口径的必要性、证据和影响。" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 leading-6" />
          </label>

          <div class="flex flex-wrap gap-2">
            <button type="submit" :disabled="previewing" class="inline-flex min-h-11 max-w-full items-center justify-center whitespace-normal rounded-lg border border-gray-300 bg-white px-5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">{{ previewing ? '正在核对…' : '预览历史影响' }}</button>
            <span class="self-center text-xs leading-5 text-gray-500">预览不会写入数据库。</span>
          </div>
        </form>

        <section v-if="preview" class="mt-5 space-y-4 border-t border-gray-200 pt-5">
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">候选版本</p><p class="mt-1 font-mono text-lg font-semibold">v{{ preview.proposal.schemaVersion }}</p></div>
            <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">历史影响</p><p class="mt-1 text-lg font-semibold">{{ preview.affectedHistoricalEventCount }} 条</p></div>
            <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">观察业务域</p><p class="mt-1 break-words text-sm font-semibold">{{ preview.observation.domains.join('、') || '尚无事实' }}</p></div>
            <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">观察风险</p><p class="mt-1 text-sm font-semibold">{{ preview.observation.riskLevels.map(auditRegistryRiskLabel).join('、') || '尚无事实' }}</p></div>
          </div>
          <div v-if="preview.blockers.length" class="rounded-lg border border-red-200 bg-red-50 p-4"><p class="text-sm font-semibold text-red-900">当前不能提交</p><ul class="mt-2 space-y-1 text-sm leading-6 text-red-800"><li v-for="item in preview.blockers" :key="item">• {{ item }}</li></ul></div>
          <div v-if="preview.warnings.length" class="rounded-lg border border-amber-200 bg-amber-50 p-4"><p class="text-sm font-semibold text-amber-950">复核人必须确认</p><ul class="mt-2 space-y-1 text-sm leading-6 text-amber-900"><li v-for="item in preview.warnings" :key="item">• {{ item }}</li></ul></div>
          <button type="button" :disabled="!preview.canSubmit || submitting" class="inline-flex min-h-11 max-w-full items-center justify-center whitespace-normal rounded-lg bg-blue-700 px-5 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50" @click="submitRequest">{{ submitting ? '正在提交…' : '提交独立复核' }}</button>
        </section>
      </section>

      <section class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <form class="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] xl:items-end" @submit.prevent="applyFilters">
          <label class="min-w-0 text-sm text-gray-700">搜索 Action / 展示名<input v-model="keyword" maxlength="80" class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3" /></label>
          <label class="min-w-0 text-sm text-gray-700">治理状态<select v-model="stateFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3"><option value="">全部状态</option><option value="unregistered">未登记</option><option value="pending_review">待复核</option><option value="inconsistent">观察冲突</option><option value="active">当前已登记</option><option value="retired">已退休</option></select></label>
          <label class="min-w-0 text-sm text-gray-700">业务域<select v-model="domainFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3"><option value="">全部业务域</option><option v-for="item in domainOptions" :key="item" :value="item">{{ item }}</option></select></label>
          <button type="submit" :disabled="filtering" class="min-h-11 rounded-lg bg-gray-950 px-5 text-sm font-medium text-white disabled:opacity-50">{{ filtering ? '筛选中…' : '应用筛选' }}</button>
          <button type="button" class="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700" @click="clearFilters">清除</button>
        </form>
      </section>

      <section class="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div class="hidden grid-cols-[minmax(220px,1.4fr)_130px_minmax(170px,1fr)_minmax(180px,1fr)_190px] gap-4 border-b border-gray-200 bg-gray-50 px-5 py-3 text-xs font-medium text-gray-500 xl:grid"><span>Action</span><span>状态</span><span>观察事实</span><span>当前口径</span><span class="text-right">操作</span></div>
        <article v-for="item in actions" :key="item.actionKey" class="grid min-w-0 gap-3 border-b border-gray-100 p-5 last:border-b-0 xl:grid-cols-[minmax(220px,1.4fr)_130px_minmax(170px,1fr)_minmax(180px,1fr)_190px] xl:items-center xl:gap-4">
          <div class="min-w-0"><p class="break-all font-mono text-xs font-semibold text-gray-950">{{ item.actionKey }}</p><p class="mt-1 break-words text-xs text-gray-500">{{ item.latestDefinition?.displayName || '尚无正式展示名称' }}</p></div>
          <div><span class="inline-flex rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="auditRegistryStateClass(item.governanceState)">{{ auditRegistryStateLabel(item.governanceState) }}</span><p v-if="item.pendingRequest" class="mt-1 break-all font-mono text-[10px] text-blue-700">{{ item.pendingRequest.requestId }}</p></div>
          <div class="min-w-0 text-xs leading-5 text-gray-600"><p>{{ item.observation.eventCount }} 条 · 缺索引 {{ item.observation.missingIndexCount }}</p><p class="break-words">域：{{ item.observation.domains.join('、') || '无事实' }}</p><p>风险：{{ item.observation.riskLevels.map(auditRegistryRiskLabel).join('、') || '无事实' }}</p><p>{{ formatAuditRegistryTime(item.observation.lastSeenAt) }}</p></div>
          <div v-if="item.latestDefinition" class="min-w-0 text-xs leading-5 text-gray-600"><p>v{{ item.latestDefinition.schemaVersion }} · {{ item.latestDefinition.status === 'active' ? 'active' : 'retired' }}</p><p>{{ item.latestDefinition.domain }} · {{ auditRegistrySensitivityLabel(item.latestDefinition.sensitivity) }} · {{ auditRegistryRiskLabel(item.latestDefinition.riskLevel) }}</p><p class="break-all font-mono text-[10px]">{{ item.latestDefinition.ownerReference }}</p><p :class="item.latestDefinition.productionReady ? 'text-emerald-700' : 'text-amber-700'">{{ item.latestDefinition.productionReady ? '治理引用已批准并就绪' : '治理引用未批准或未就绪' }}</p></div><p v-else class="text-xs text-violet-700">没有正式版本</p>
          <div class="flex flex-wrap gap-2 xl:justify-end">
            <NuxtLink v-if="item.pendingRequest" :to="`/admin/app/audit/registry/requests/${item.pendingRequest.requestId}`" class="inline-flex min-h-10 max-w-full items-center justify-center whitespace-normal rounded-lg border border-blue-300 bg-blue-50 px-3 text-sm font-medium text-blue-800">查看复核</NuxtLink>
            <button v-else type="button" class="min-h-10 max-w-full whitespace-normal rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50" @click="startPublish(item)">{{ item.latestDefinition?.status === 'active' ? '新建版本' : '登记口径' }}</button>
            <button v-if="!item.pendingRequest && item.latestDefinition?.status === 'active'" type="button" class="min-h-10 max-w-full whitespace-normal rounded-lg border border-red-300 px-3 text-sm font-medium text-red-700 hover:bg-red-50" @click="startRetire(item)">申请退休</button>
          </div>
        </article>
        <p v-if="!actions.length" class="p-12 text-center text-sm text-gray-500">当前筛选下没有 Action。</p>
      </section>

      <section class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div><h2 class="text-base font-semibold text-gray-950">最近口径申请</h2><p class="mt-1 text-xs leading-5 text-gray-500">发布与退休均保留独立申请、复核人、原因和不可变事件。</p></div><span class="text-xs text-gray-500">最近 {{ requests.length }} 项</span></div>
        <div v-if="requests.length" class="mt-4 divide-y divide-gray-100 rounded-lg border border-gray-200">
          <NuxtLink v-for="request in requests" :key="request.requestId" :to="`/admin/app/audit/registry/requests/${request.requestId}`" class="grid min-w-0 gap-3 p-4 hover:bg-gray-50 md:grid-cols-[minmax(200px,1fr)_150px_minmax(150px,1fr)_120px] md:items-center">
            <div class="min-w-0"><p class="break-all font-mono text-xs font-semibold text-gray-950">{{ request.proposal.actionKey }}</p><p class="mt-1 break-all font-mono text-[10px] text-gray-500">{{ request.requestId }}</p></div>
            <div><p class="text-sm text-gray-700">{{ auditRegistryOperationLabel(request.operation) }}</p><p class="mt-1 text-xs text-gray-500">候选 v{{ request.proposal.schemaVersion }}</p></div>
            <div class="min-w-0"><p class="truncate text-sm text-gray-700">{{ request.requestedBy.label }}</p><p class="mt-1 text-xs text-gray-500">{{ formatAuditRegistryTime(request.createdAt) }}</p></div>
            <span class="justify-self-start rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset md:justify-self-end" :class="auditRegistryRequestStatusClass(request.status)">{{ auditRegistryRequestStatusLabel(request.status) }}</span>
          </NuxtLink>
        </div>
        <p v-else class="mt-4 rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">尚无口径变更申请。</p>
      </section>
    </template>
  </div>
</template>
