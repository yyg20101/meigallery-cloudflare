<script setup lang="ts">
import type {
  TaxonomyLegacyMapping,
  TaxonomyPagination,
  TaxonomyTerm,
  TaxonomyTermDetail,
  TaxonomyTermSensitivity,
  TaxonomyTermVisibility,
  TaxonomyType,
} from '~/types/admin-app-taxonomy'
import {
  TAXONOMY_CATALOG_STATE_LABELS,
  TAXONOMY_PUBLIC_STATE_LABELS,
  TAXONOMY_STATUS_LABELS,
  TAXONOMY_TYPES,
  TAXONOMY_TYPE_LABELS,
  formatTaxonomyDate,
  taxonomyApiError,
  taxonomyApiErrorDetail,
  taxonomyStatusClass,
} from '~/types/admin-app-taxonomy'

definePageMeta({ layout: 'admin' })

type LifecycleAction = 'hide' | 'deprecate' | 'archive' | 'restore'

const route = useRoute()
const { api } = useApi()
const termId = computed(() => String(route.params.termId || ''))
const operation = ref('')
const operationError = ref('')
const operationMessage = ref('')
const operationDetail = ref<unknown>(null)
const workflowReason = ref('')
const reviewDecision = ref<'active' | 'rejected'>('active')
const lifecycleAction = ref<LifecycleAction>('hide')
const mergeTargetTermId = ref('')
const criticalConfirmed = ref(false)

const form = reactive({
  type: 'style' as TaxonomyType,
  parentTermId: '',
  displayName: '',
  slug: '',
  description: '',
  aliases: '',
  visibility: 'public' as TaxonomyTermVisibility,
  allowedForProfile: true,
  sensitivity: 'standard' as TaxonomyTermSensitivity,
  sortOrder: 0,
  changeReason: '',
})

const { data, status, error, refresh } = await useAsyncData(
  () => `admin-app-taxonomy-term-${termId.value}`,
  () => api<{ data: TaxonomyTermDetail }>(`/api/admin/app/taxonomy/terms/${termId.value}`),
)

const term = computed(() => data.value?.data ?? null)
const editable = computed(() => term.value && !['merged', 'archived'].includes(term.value.lifecycleStatus))
const activeTargetType = computed(() => term.value?.type ?? '')
const { data: targetResponse, refresh: refreshTargets } = await useAsyncData(
  () => `admin-app-taxonomy-merge-targets-${activeTargetType.value || 'none'}`,
  async () => {
    if (!activeTargetType.value) return { data: [] as TaxonomyTerm[], pagination: emptyPagination() }
    return api<{ data: TaxonomyTerm[]; pagination: TaxonomyPagination }>('/api/admin/app/taxonomy/terms', {
      query: { type: activeTargetType.value, status: 'active', page: 1, pageSize: 100 },
    })
  },
  { watch: [activeTargetType] },
)
const mergeTargets = computed(() => (targetResponse.value?.data ?? []).filter(item => item.termId !== termId.value))

const lifecycleOptions = computed<Array<{ value: LifecycleAction; label: string; danger: boolean }>>(() => {
  const current = term.value?.lifecycleStatus
  if (current === 'active') return [
    { value: 'hide', label: '隐藏词条', danger: false },
    { value: 'deprecate', label: '弃用词条', danger: true },
  ]
  if (current === 'hidden') return [
    { value: 'restore', label: '恢复为草稿', danger: false },
    { value: 'deprecate', label: '弃用词条', danger: true },
    { value: 'archive', label: '尝试归档', danger: true },
  ]
  if (current === 'deprecated') return [
    { value: 'restore', label: '恢复为草稿', danger: false },
    { value: 'archive', label: '尝试归档', danger: true },
  ]
  if (current === 'draft') return [{ value: 'archive', label: '尝试归档', danger: true }]
  return []
})

watch(term, (value) => {
  if (!value) return
  Object.assign(form, {
    type: value.type,
    parentTermId: value.parentTermId ?? '',
    displayName: value.displayName,
    slug: value.slug,
    description: value.description ?? '',
    aliases: value.aliases.join('\n'),
    visibility: value.visibility,
    allowedForProfile: value.allowedForProfile,
    sensitivity: value.sensitivity,
    sortOrder: value.sortOrder,
    changeReason: '',
  })
  const firstAction = lifecycleOptions.value[0]
  if (firstAction) lifecycleAction.value = firstAction.value
}, { immediate: true })

watch(() => term.value?.lifecycleStatus, () => {
  criticalConfirmed.value = false
  workflowReason.value = ''
})

function parsedAliases(value: string) {
  return [...new Set(value.split(/[,，\n]/u).map(item => item.trim()).filter(Boolean))]
}

async function saveTerm() {
  if (!term.value || !editable.value) return
  clearOperationFeedback()
  if (!form.changeReason.trim()) {
    operationError.value = '请填写本次编辑原因；保存后词条将回到草稿态。'
    return
  }
  if (term.value.lifecycleStatus !== 'draft' && import.meta.client) {
    const confirmed = window.confirm('当前词条已经进入生命周期流程。保存编辑会生成新修订并回到草稿态，已发布目录快照不受影响。确认继续？')
    if (!confirmed) return
  }
  operation.value = 'save'
  try {
    await api(`/api/admin/app/taxonomy/terms/${termId.value}`, {
      method: 'PATCH',
      body: {
        expectedVersion: term.value.version,
        type: form.type,
        parentTermId: form.parentTermId.trim() || null,
        displayName: form.displayName.trim(),
        slug: form.slug.trim(),
        description: form.description.trim() || null,
        aliases: parsedAliases(form.aliases),
        visibility: form.visibility,
        allowedForProfile: form.allowedForProfile,
        sensitivity: form.sensitivity,
        sortOrder: form.sortOrder,
        changeReason: form.changeReason.trim(),
      },
    })
    operationMessage.value = '词条草稿已保存；已发布目录快照保持不变。'
    await Promise.all([refresh(), refreshTargets()])
  }
  catch (requestError) {
    setOperationError(requestError, '词条保存失败，请刷新编辑锁版本后重试。')
  }
  finally {
    operation.value = ''
  }
}

async function submitForReview() {
  if (!term.value) return
  if (!requireWorkflowReason()) return
  operation.value = 'submit'
  try {
    await api(`/api/admin/app/taxonomy/terms/${termId.value}/submit`, {
      method: 'POST',
      body: { expectedVersion: term.value.version, reason: workflowReason.value.trim() },
    })
    operationMessage.value = '词条已提交复核，编辑锁已更新。'
    await refreshAfterWorkflow()
  }
  catch (requestError) {
    setOperationError(requestError, '提交复核失败，请刷新后重试。')
  }
  finally {
    operation.value = ''
  }
}

async function reviewTerm() {
  if (!term.value) return
  if (!requireWorkflowReason()) return
  if (reviewDecision.value === 'active' && term.value.sensitivity === 'restricted') {
    operationError.value = '受限词条尚未接入隐私/法务升级审批，当前不能审核为生效。'
    return
  }
  operation.value = 'decision'
  try {
    await api(`/api/admin/app/taxonomy/terms/${termId.value}/decision`, {
      method: 'POST',
      body: {
        expectedVersion: term.value.version,
        decision: reviewDecision.value,
        reason: workflowReason.value.trim(),
      },
    })
    operationMessage.value = reviewDecision.value === 'active' ? '词条已审核生效。' : '词条已退回草稿。'
    await refreshAfterWorkflow()
  }
  catch (requestError) {
    setOperationError(requestError, '复核决定提交失败，请刷新版本后重试。')
  }
  finally {
    operation.value = ''
  }
}

async function changeLifecycle() {
  if (!term.value) return
  if (!requireWorkflowReason()) return
  if (!criticalConfirmed.value) {
    operationError.value = '请先确认已理解该操作对新目录版本和现有引用的影响。'
    return
  }
  operation.value = `lifecycle-${lifecycleAction.value}`
  try {
    await api(`/api/admin/app/taxonomy/terms/${termId.value}/lifecycle`, {
      method: 'POST',
      body: {
        expectedVersion: term.value.version,
        action: lifecycleAction.value,
        reason: workflowReason.value.trim(),
      },
    })
    operationMessage.value = '生命周期操作已完成；已发布目录快照保持不变。'
    await refreshAfterWorkflow()
  }
  catch (requestError) {
    setOperationError(requestError, '生命周期操作失败，请检查状态、引用影响和编辑锁。')
  }
  finally {
    operation.value = ''
  }
}

async function mergeTerm() {
  if (!term.value) return
  clearOperationFeedback()
  if (!mergeTargetTermId.value) {
    operationError.value = '请选择同类型的已生效合并目标。'
    return
  }
  if (!workflowReason.value.trim()) {
    operationError.value = '请填写合并原因。'
    return
  }
  if (!criticalConfirmed.value) {
    operationError.value = '请先确认合并会永久保留源稳定 ID，并在下一目录生成重定向。'
    return
  }
  operation.value = 'merge'
  try {
    await api(`/api/admin/app/taxonomy/terms/${termId.value}/merge`, {
      method: 'POST',
      body: {
        expectedVersion: term.value.version,
        targetTermId: mergeTargetTermId.value,
        reason: workflowReason.value.trim(),
      },
    })
    operationMessage.value = '词条已合并；下一目录快照将保留稳定重定向。'
    await refreshAfterWorkflow()
  }
  catch (requestError) {
    setOperationError(requestError, '词条合并失败，请检查目标状态、类型和版本。')
  }
  finally {
    operation.value = ''
  }
}

const savingMapping = ref(false)
const mappingError = ref('')
const mappingMessage = ref('')
const mappingForm = reactive({
  sourceNamespace: 'legacy_gallery',
  sourceType: 'tag',
  sourceValue: '',
  mappingType: 'exact' as 'exact' | 'alias',
  mappingRuleVersion: '1.0.0',
  note: '',
})

async function mapLegacyValue() {
  if (!term.value || term.value.lifecycleStatus !== 'active') return
  mappingError.value = ''
  mappingMessage.value = ''
  savingMapping.value = true
  try {
    const response = await api<{ data: TaxonomyLegacyMapping }>('/api/admin/app/taxonomy/legacy-mappings', {
      method: 'PUT',
      body: {
        sourceNamespace: mappingForm.sourceNamespace.trim(),
        sourceType: mappingForm.sourceType.trim(),
        sourceValue: mappingForm.sourceValue.trim(),
        mappingType: mappingForm.mappingType,
        targetTermId: term.value.termId,
        mappingRuleVersion: mappingForm.mappingRuleVersion.trim(),
        note: mappingForm.note.trim() || null,
      },
    })
    mappingMessage.value = `映射 ${response.data.mappingId} 已保存，编辑锁 v${response.data.version}。`
    mappingForm.sourceValue = ''
    mappingForm.note = ''
  }
  catch (requestError) {
    mappingError.value = taxonomyApiError(requestError, '旧值映射保存失败；若映射已存在，请到映射工作区携带编辑锁修订。')
  }
  finally {
    savingMapping.value = false
  }
}

function requireWorkflowReason() {
  clearOperationFeedback()
  if (workflowReason.value.trim()) return true
  operationError.value = '请填写状态操作原因，便于复核和审计。'
  return false
}

async function refreshAfterWorkflow() {
  workflowReason.value = ''
  criticalConfirmed.value = false
  mergeTargetTermId.value = ''
  await Promise.all([refresh(), refreshTargets()])
}

function clearOperationFeedback() {
  operationError.value = ''
  operationMessage.value = ''
  operationDetail.value = null
}

function setOperationError(requestError: unknown, fallback: string) {
  operationError.value = taxonomyApiError(requestError, fallback)
  operationDetail.value = taxonomyApiErrorDetail(requestError)
}

function readableDetail(value: unknown) {
  if (!value) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  }
  catch {
    return String(value)
  }
}

function emptyPagination(): TaxonomyPagination {
  return { page: 1, pageSize: 100, total: 0, totalPages: 0 }
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-TAX-02" :route="route.path" :title="term?.displayName || '词条详情'" :description="`编辑词条、别名和旧值映射，并预览合并影响 · ${termId}`" :state="status === 'pending' ? '加载中' : error ? '加载失败' : term ? TAXONOMY_STATUS_LABELS[term.lifecycleStatus] : '正常'" :figma-state="term?.mergeTargetTermId ? '合并冲突' : term?.catalogs.length ? '被引用' : '正常'" :state-tone="error ? 'danger' : status === 'pending' ? 'warning' : 'info'">
      <template #actions>
        <span v-if="term" class="inline-flex min-h-10 items-center rounded-full bg-white px-3 text-xs text-gray-600 ring-1 ring-gray-200">编辑锁 v{{ term.version }}</span>
        <NuxtLink to="/admin/app/taxonomy" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-[#eaded8] bg-white px-4 text-sm font-medium text-stone-700 hover:bg-[#fff7f2]">返回 Taxonomy 目录</NuxtLink>
      </template>
    </AdminAppPageHeader>

    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{{ taxonomyApiError(error, '词条详情加载失败。') }} <button type="button" class="ml-2 font-semibold underline" @click="refresh()">重试</button></div>
    <div v-if="status === 'pending'" class="rounded-xl border border-gray-200 bg-white px-5 py-14 text-center text-sm text-gray-500">正在加载词条与引用影响…</div>

    <template v-if="term">
      <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">类型</p><p class="mt-2 font-semibold text-gray-950">{{ TAXONOMY_TYPE_LABELS[term.type] }}</p><p class="mt-1 font-mono text-xs text-gray-500">{{ term.type }}</p></article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">公开资格</p><p class="mt-2 font-semibold" :class="term.visibility === 'public' && term.sensitivity === 'standard' ? 'text-emerald-700' : 'text-amber-700'">{{ term.visibility === 'public' ? '公开' : '仅内部' }} · {{ term.sensitivity === 'standard' ? '标准' : '受限' }}</p><p class="mt-1 text-xs text-gray-500">{{ term.allowedForProfile ? '允许人物资料使用' : '不允许人物资料使用' }}</p></article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">目录引用</p><p class="mt-2 text-lg font-bold text-gray-950">{{ term.catalogs.length }}</p><p class="mt-1 text-xs text-gray-500">最近 30 个不可变快照引用</p></article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">最近更新</p><p class="mt-2 text-sm font-semibold text-gray-950">{{ formatTaxonomyDate(term.updatedAt) }}</p><p class="mt-1 text-xs text-gray-500">管理员 #{{ term.updatedBy }}</p></article>
      </div>

      <div v-if="term.lifecycleStatus === 'merged'" class="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900"><span class="font-semibold">稳定重定向：</span>该词条已合并，源 ID 永久保留；下一目录快照将重定向至 <NuxtLink v-if="term.mergeTargetTermId" :to="`/admin/app/taxonomy/${term.mergeTargetTermId}`" class="break-all font-mono font-semibold underline">{{ term.mergeTargetTermId }}</NuxtLink>。</div>
      <div v-if="term.sensitivity === 'restricted'" class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"><span class="font-semibold">敏感升级未开放：</span>受限词条可以维护草稿，但当前不能审核为生效，也不能进入公开目录。</div>

      <form class="min-w-0 space-y-5 rounded-xl border border-gray-200 bg-white p-4 sm:p-5" @submit.prevent="saveTerm">
        <div class="flex flex-wrap items-start justify-between gap-3"><div><h2 class="text-base font-semibold text-gray-950">词条属性与别名</h2><p class="mt-1 text-sm leading-6 text-gray-500">保存任何修改都会生成新修订并回到草稿态；已发布快照不被改写。</p></div><span v-if="!editable" class="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">不可编辑状态</span></div>
        <fieldset :disabled="!editable || Boolean(operation)" class="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4 disabled:opacity-70">
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">分类类型</span><select v-model="form.type" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option v-for="type in TAXONOMY_TYPES" :key="type" :value="type">{{ TAXONOMY_TYPE_LABELS[type] }}</option></select></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">展示名称</span><input v-model.trim="form.displayName" required maxlength="40" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">slug</span><input v-model.trim="form.slug" required maxlength="64" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">父级稳定 ID</span><input v-model.trim="form.parentTermId" placeholder="可选：txt_…" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
          <label class="min-w-0 md:col-span-2"><span class="mb-1 block text-sm font-medium text-gray-700">别名（每行或逗号分隔）</span><textarea v-model="form.aliases" maxlength="840" rows="4" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          <label class="min-w-0 md:col-span-2"><span class="mb-1 block text-sm font-medium text-gray-700">说明</span><textarea v-model.trim="form.description" maxlength="300" rows="4" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">可见范围</span><select v-model="form.visibility" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="public">公开</option><option value="internal">仅内部</option></select></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">敏感级别</span><select v-model="form.sensitivity" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="standard">标准</option><option value="restricted">受限</option></select></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">排序值</span><input v-model.number="form.sortOrder" type="number" min="-1000000" max="1000000" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          <label class="flex min-h-11 min-w-0 items-center gap-2 self-end rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700"><input v-model="form.allowedForProfile" type="checkbox" />允许人物资料使用</label>
          <label class="min-w-0 md:col-span-2 xl:col-span-4"><span class="mb-1 block text-sm font-medium text-gray-700">本次编辑原因</span><input v-model.trim="form.changeReason" required maxlength="120" placeholder="记录字段变更依据；保存后自动清空" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
        </fieldset>
        <div v-if="editable" class="flex justify-end"><button :disabled="Boolean(operation)" class="min-h-10 rounded-lg bg-gray-950 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{{ operation === 'save' ? '保存中…' : '保存词条草稿' }}</button></div>
      </form>

      <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <h2 class="text-base font-semibold text-gray-950">复核、生命周期与合并</h2>
        <p class="mt-1 text-sm leading-6 text-gray-500">所有状态变化均携带当前编辑锁和审计原因。合并、弃用和归档只影响后续目录版本，不改写已发布快照。</p>
        <div class="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">操作原因</span><textarea v-model.trim="workflowReason" maxlength="120" rows="3" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="填写复核依据、影响判断或合并原因" /></label>
          <label v-if="term.lifecycleStatus === 'pending_review'" class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">复核决定</span><select v-model="reviewDecision" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="active">审核生效</option><option value="rejected">退回草稿</option></select></label>
          <label v-else-if="lifecycleOptions.length" class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">生命周期操作</span><select v-model="lifecycleAction" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option v-for="item in lifecycleOptions" :key="item.value" :value="item.value">{{ item.label }}</option></select></label>
        </div>
        <div v-if="['active', 'hidden', 'deprecated'].includes(term.lifecycleStatus)" class="mt-4 rounded-xl border border-blue-200 bg-blue-50/50 p-4"><h3 class="text-sm font-semibold text-blue-950">合并到同类型已生效词条</h3><p class="mt-1 text-sm leading-6 text-blue-800">合并后源 ID 永久保留并在新快照中成为 redirect，不支持从本页面撤销。</p><div class="mt-3 grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_auto]"><select v-model="mergeTargetTermId" class="min-h-11 min-w-0 rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm"><option value="">选择合并目标</option><option v-for="target in mergeTargets" :key="target.termId" :value="target.termId">{{ target.displayName }} · {{ target.termId }}</option></select><button type="button" :disabled="Boolean(operation) || !mergeTargetTermId" class="min-h-11 rounded-lg bg-blue-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="mergeTerm">执行合并</button></div><p v-if="!mergeTargets.length" class="mt-2 text-xs text-blue-800">当前未找到其他同类型已生效词条，不能执行合并。</p></div>
        <label v-if="lifecycleOptions.length || ['active', 'hidden', 'deprecated'].includes(term.lifecycleStatus)" class="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm leading-6 text-amber-950"><input v-model="criticalConfirmed" type="checkbox" class="mt-1" /><span>我已确认现有目录引用、人物投影和客户端不会被当前操作静默改写；归档若仍有引用将由服务端拒绝。</span></label>
        <p v-if="operationError" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ operationError }}</p>
        <pre v-if="operationDetail" class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-red-950 p-3 text-xs text-red-50">{{ readableDetail(operationDetail) }}</pre>
        <p v-if="operationMessage" class="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{{ operationMessage }}</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <button v-if="term.lifecycleStatus === 'draft'" type="button" :disabled="Boolean(operation)" class="min-h-10 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="submitForReview">{{ operation === 'submit' ? '提交中…' : '提交复核' }}</button>
          <button v-if="term.lifecycleStatus === 'pending_review'" type="button" :disabled="Boolean(operation) || (reviewDecision === 'active' && term.sensitivity === 'restricted')" class="min-h-10 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="reviewTerm">{{ operation === 'decision' ? '提交中…' : '记录复核决定' }}</button>
          <button v-if="lifecycleOptions.length" type="button" :disabled="Boolean(operation) || !criticalConfirmed" class="min-h-10 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50" @click="changeLifecycle">{{ operation.startsWith('lifecycle-') ? '处理中…' : lifecycleOptions.find(item => item.value === lifecycleAction)?.label }}</button>
        </div>
      </section>

      <div class="grid min-w-0 gap-5 xl:grid-cols-2">
        <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div class="border-b border-gray-200 px-4 py-4 sm:px-5"><h2 class="text-base font-semibold text-gray-950">不可变修订历史</h2><p class="mt-1 text-sm text-gray-500">显示最近 30 条修订，版本号不可复用。</p></div>
          <div v-if="!term.revisions.length" class="px-5 py-10 text-center text-sm text-gray-500">暂无修订记录。</div>
          <ol v-else class="divide-y divide-gray-100"><li v-for="revision in term.revisions" :key="revision.version" class="grid min-w-0 gap-2 px-4 py-4 text-sm sm:grid-cols-[6rem_minmax(0,1fr)_11rem] sm:px-5"><div><p class="font-semibold text-gray-900">v{{ revision.version }}</p><span class="mt-1 inline-flex rounded-full px-2 py-0.5 text-xs ring-1 ring-inset" :class="taxonomyStatusClass(revision.lifecycleStatus)">{{ TAXONOMY_STATUS_LABELS[revision.lifecycleStatus] }}</span></div><p class="min-w-0 break-words leading-6 text-gray-700">{{ revision.changeReason }}</p><div class="text-xs leading-5 text-gray-500"><p>{{ formatTaxonomyDate(revision.createdAt) }}</p><p>管理员 #{{ revision.changedBy }}</p></div></li></ol>
        </section>

        <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div class="border-b border-gray-200 px-4 py-4 sm:px-5"><h2 class="text-base font-semibold text-gray-950">目录快照引用</h2><p class="mt-1 text-sm text-gray-500">历史快照引用不会因当前编辑或生命周期变化而消失。</p></div>
          <div v-if="!term.catalogs.length" class="px-5 py-10 text-center text-sm text-gray-500">该词条尚未进入任何目录快照。</div>
          <ul v-else class="divide-y divide-gray-100"><li v-for="catalog in term.catalogs" :key="catalog.catalogVersionId" class="flex min-w-0 flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"><div class="min-w-0"><NuxtLink :to="`/admin/app/taxonomy/releases/${catalog.catalogVersionId}`" class="break-words text-sm font-medium text-blue-600 hover:underline">目录 {{ catalog.versionCode }}</NuxtLink><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ catalog.catalogVersionId }} · 词条修订 v{{ catalog.termVersion }}</p></div><div class="flex shrink-0 flex-wrap gap-2"><span class="rounded-full px-2 py-0.5 text-xs ring-1 ring-inset" :class="taxonomyStatusClass(catalog.state)">{{ TAXONOMY_CATALOG_STATE_LABELS[catalog.state] }}</span><span class="rounded-full px-2 py-0.5 text-xs ring-1 ring-inset" :class="taxonomyStatusClass(catalog.publicState)">{{ TAXONOMY_PUBLIC_STATE_LABELS[catalog.publicState] }}</span></div></li></ul>
        </section>
      </div>

      <form class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5" @submit.prevent="mapLegacyValue">
        <div class="flex flex-wrap items-start justify-between gap-3"><div><h2 class="text-base font-semibold text-gray-950">添加旧值映射</h2><p class="mt-1 text-sm leading-6 text-gray-500">将已确认语义的 legacy 值指向当前稳定词条；修订既有映射请进入完整映射工作区。</p></div><NuxtLink to="/admin/app/taxonomy?tab=mappings" class="text-sm font-medium text-blue-600 hover:underline">进入映射工作区</NuxtLink></div>
        <fieldset :disabled="term.lifecycleStatus !== 'active' || savingMapping" class="mt-4 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4 disabled:opacity-60">
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">来源命名空间</span><input v-model.trim="mappingForm.sourceNamespace" required maxlength="40" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">来源类型</span><input v-model.trim="mappingForm.sourceType" required maxlength="40" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">来源值</span><input v-model.trim="mappingForm.sourceValue" required maxlength="120" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">映射类型</span><select v-model="mappingForm.mappingType" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="exact">精确映射</option><option value="alias">别名映射</option></select></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">规则版本</span><input v-model.trim="mappingForm.mappingRuleVersion" required maxlength="40" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
          <label class="min-w-0 md:col-span-2 xl:col-span-3"><span class="mb-1 block text-sm font-medium text-gray-700">内部备注</span><input v-model.trim="mappingForm.note" maxlength="300" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
        </fieldset>
        <p v-if="term.lifecycleStatus !== 'active'" class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">只有已生效词条可以作为 exact/alias 映射目标。</p><p v-if="mappingError" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ mappingError }}</p><p v-if="mappingMessage" class="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{{ mappingMessage }}</p>
        <div v-if="term.lifecycleStatus === 'active'" class="mt-4 flex justify-end"><button :disabled="savingMapping" class="min-h-10 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{{ savingMapping ? '保存中…' : '保存旧值映射' }}</button></div>
      </form>
    </template>
  </div>
</template>
