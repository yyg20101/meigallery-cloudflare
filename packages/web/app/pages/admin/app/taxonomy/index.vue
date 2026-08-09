<script setup lang="ts">
import type {
  TaxonomyCatalog,
  TaxonomyLegacyMapping,
  TaxonomyLegacyMappingType,
  TaxonomyPagination,
  TaxonomyTerm,
  TaxonomyTermSensitivity,
  TaxonomyTermStatus,
  TaxonomyTermVisibility,
  TaxonomyType,
} from '~/types/admin-app-taxonomy'
import {
  TAXONOMY_CATALOG_STATE_LABELS,
  TAXONOMY_MAPPING_TYPE_LABELS,
  TAXONOMY_STATUS_LABELS,
  TAXONOMY_TYPES,
  TAXONOMY_TYPE_LABELS,
  formatTaxonomyDate,
  taxonomyApiError,
  taxonomyStatusClass,
} from '~/types/admin-app-taxonomy'

definePageMeta({ layout: 'admin' })

type TermListResponse = { data: TaxonomyTerm[]; pagination: TaxonomyPagination }
type MappingListResponse = { data: TaxonomyLegacyMapping[]; pagination: TaxonomyPagination }
type WorkspaceTab = 'terms' | 'catalogs' | 'mappings'

const { api } = useApi()
const route = useRoute()
const initialTab = String(route.query.tab || '')
const activeTab = ref<WorkspaceTab>(['terms', 'catalogs', 'mappings'].includes(initialTab) ? initialTab as WorkspaceTab : 'terms')

const termSearchDraft = ref('')
const termQuery = ref('')
const termType = ref<'' | TaxonomyType>('')
const termStatus = ref<'' | TaxonomyTermStatus>('')
const termPage = ref(1)
const showCreateTerm = ref(false)
const creatingTerm = ref(false)
const createTermError = ref('')
const createTermForm = reactive({
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

const { data: termResponse, status: termLoadStatus, error: termLoadError, refresh: refreshTerms } = await useAsyncData(
  'admin-app-taxonomy-terms',
  () => api<TermListResponse>('/api/admin/app/taxonomy/terms', {
    query: {
      q: termQuery.value || undefined,
      type: termType.value || undefined,
      status: termStatus.value || undefined,
      page: termPage.value,
      pageSize: 100,
    },
  }),
  { watch: [termQuery, termType, termStatus, termPage] },
)

const terms = computed(() => termResponse.value?.data ?? [])
const termPagination = computed(() => termResponse.value?.pagination)
const termById = computed(() => new Map(terms.value.map(item => [item.termId, item])))
const termGroups = computed(() => TAXONOMY_TYPES.map(type => ({
  type,
  items: terms.value.filter(item => item.type === type),
})).filter(group => group.items.length > 0))

const { data: catalogResponse, status: catalogLoadStatus, error: catalogLoadError, refresh: refreshCatalogs } = await useAsyncData(
  'admin-app-taxonomy-catalogs',
  () => api<{ data: TaxonomyCatalog[] }>('/api/admin/app/taxonomy/catalogs'),
)
const catalogs = computed(() => catalogResponse.value?.data ?? [])
const showCreateCatalog = ref(false)
const creatingCatalog = ref(false)
const createCatalogError = ref('')
const createCatalogForm = reactive({
  versionCode: '',
  effectiveAt: '',
  minimumClientVersion: '1.0.0',
})

const mappingNamespaceFilter = ref('')
const mappingTypeFilter = ref<'' | TaxonomyLegacyMappingType>('')
const mappingPage = ref(1)
const { data: mappingResponse, status: mappingLoadStatus, error: mappingLoadError, refresh: refreshMappings } = await useAsyncData(
  'admin-app-taxonomy-legacy-mappings',
  () => api<MappingListResponse>('/api/admin/app/taxonomy/legacy-mappings', {
    query: {
      sourceNamespace: mappingNamespaceFilter.value || undefined,
      mappingType: mappingTypeFilter.value || undefined,
      page: mappingPage.value,
      pageSize: 50,
    },
  }),
  { watch: [mappingNamespaceFilter, mappingTypeFilter, mappingPage] },
)
const mappings = computed(() => mappingResponse.value?.data ?? [])
const mappingPagination = computed(() => mappingResponse.value?.pagination)
const savingMapping = ref(false)
const mappingError = ref('')
const mappingMessage = ref('')
const mappingForm = reactive({
  mappingId: '',
  sourceNamespace: 'legacy_gallery',
  sourceType: 'tag',
  sourceValue: '',
  mappingType: 'pending_review' as TaxonomyLegacyMappingType,
  targetTermId: '',
  mappingRuleVersion: '1.0.0',
  note: '',
  expectedVersion: undefined as number | undefined,
})
const mappingNeedsTarget = computed(() => ['exact', 'alias'].includes(mappingForm.mappingType))

function applyTermFilters() {
  termPage.value = 1
  const nextQuery = termSearchDraft.value.trim()
  if (termQuery.value === nextQuery) refreshTerms()
  else termQuery.value = nextQuery
}

function clearTermFilters() {
  termSearchDraft.value = ''
  termQuery.value = ''
  termType.value = ''
  termStatus.value = ''
  termPage.value = 1
}

function termDepth(item: TaxonomyTerm) {
  let depth = 0
  let parentId = item.parentTermId
  const visited = new Set<string>([item.termId])
  while (parentId && depth < 6 && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = termById.value.get(parentId)
    if (!parent) break
    depth += 1
    parentId = parent.parentTermId
  }
  return depth
}

function parsedAliases(value: string) {
  return [...new Set(value.split(/[,，\n]/u).map(item => item.trim()).filter(Boolean))]
}

async function createTerm() {
  createTermError.value = ''
  if (!createTermForm.changeReason.trim()) {
    createTermError.value = '请填写创建原因，便于后续复核和审计。'
    return
  }
  creatingTerm.value = true
  try {
    const response = await api<{ data: TaxonomyTerm }>('/api/admin/app/taxonomy/terms', {
      method: 'POST',
      body: {
        type: createTermForm.type,
        parentTermId: createTermForm.parentTermId.trim() || null,
        displayName: createTermForm.displayName.trim(),
        slug: createTermForm.slug.trim(),
        description: createTermForm.description.trim() || null,
        aliases: parsedAliases(createTermForm.aliases),
        visibility: createTermForm.visibility,
        allowedForProfile: createTermForm.allowedForProfile,
        sensitivity: createTermForm.sensitivity,
        sortOrder: createTermForm.sortOrder,
        changeReason: createTermForm.changeReason.trim(),
      },
    })
    await navigateTo(`/admin/app/taxonomy/${response.data.termId}`)
  }
  catch (error) {
    createTermError.value = taxonomyApiError(error, '词条草稿创建失败，请检查名称、别名、父级和 slug。')
  }
  finally {
    creatingTerm.value = false
  }
}

async function createCatalog() {
  createCatalogError.value = ''
  creatingCatalog.value = true
  try {
    const response = await api<{ data: TaxonomyCatalog }>('/api/admin/app/taxonomy/catalogs', {
      method: 'POST',
      body: {
        versionCode: createCatalogForm.versionCode.trim(),
        effectiveAt: toIso(createCatalogForm.effectiveAt),
        minimumClientVersion: createCatalogForm.minimumClientVersion.trim(),
      },
    })
    await navigateTo(`/admin/app/taxonomy/releases/${response.data.catalogVersionId}`)
  }
  catch (error) {
    createCatalogError.value = taxonomyApiError(error, '目录快照生成失败，请检查版本号和词条关系。')
  }
  finally {
    creatingCatalog.value = false
  }
}

function editMapping(item: TaxonomyLegacyMapping) {
  Object.assign(mappingForm, {
    mappingId: item.mappingId,
    sourceNamespace: item.sourceNamespace,
    sourceType: item.sourceType,
    sourceValue: item.sourceValue,
    mappingType: item.mappingType,
    targetTermId: item.targetTermId ?? '',
    mappingRuleVersion: item.mappingRuleVersion,
    note: item.note ?? '',
    expectedVersion: item.version,
  })
  mappingError.value = ''
  mappingMessage.value = ''
}

function resetMappingForm() {
  Object.assign(mappingForm, {
    mappingId: '',
    sourceNamespace: mappingNamespaceFilter.value || 'legacy_gallery',
    sourceType: 'tag',
    sourceValue: '',
    mappingType: 'pending_review',
    targetTermId: '',
    mappingRuleVersion: '1.0.0',
    note: '',
    expectedVersion: undefined,
  })
  mappingError.value = ''
  mappingMessage.value = ''
}

async function saveMapping() {
  mappingError.value = ''
  mappingMessage.value = ''
  if (mappingNeedsTarget.value && !mappingForm.targetTermId.trim()) {
    mappingError.value = '精确映射和别名映射必须指定已生效的稳定词条 ID。'
    return
  }
  savingMapping.value = true
  try {
    const response = await api<{ data: TaxonomyLegacyMapping }>('/api/admin/app/taxonomy/legacy-mappings', {
      method: 'PUT',
      body: {
        sourceNamespace: mappingForm.sourceNamespace.trim(),
        sourceType: mappingForm.sourceType.trim(),
        sourceValue: mappingForm.sourceValue.trim(),
        mappingType: mappingForm.mappingType,
        targetTermId: mappingNeedsTarget.value ? mappingForm.targetTermId.trim() : null,
        mappingRuleVersion: mappingForm.mappingRuleVersion.trim(),
        note: mappingForm.note.trim() || null,
        ...(mappingForm.expectedVersion ? { expectedVersion: mappingForm.expectedVersion } : {}),
      },
    })
    mappingMessage.value = '旧值映射已保存，列表已刷新。'
    editMapping(response.data)
    await refreshMappings()
  }
  catch (error) {
    mappingError.value = taxonomyApiError(error, '旧值映射保存失败，请刷新版本后重试。')
  }
  finally {
    savingMapping.value = false
  }
}

function toIso(value: string) {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <header class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div class="min-w-0">
        <p class="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">ADM-TAX-01</p>
        <h1 class="mt-1 text-xl font-bold text-gray-950">Taxonomy 分类目录</h1>
        <p class="mt-1 max-w-4xl text-sm leading-6 text-gray-500">维护稳定词条、不可变目录快照和 legacy 显式映射。展示名称与 slug 只用于显示，跨模块引用必须使用稳定 ID。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="min-h-10 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50" @click="Promise.all([refreshTerms(), refreshCatalogs(), refreshMappings()])">刷新工作区</button>
        <button type="button" class="min-h-10 rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white" @click="activeTab = 'terms'; showCreateTerm = !showCreateTerm">新建词条</button>
      </div>
    </header>

    <div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
      <span class="font-semibold">开发边界：</span>目录发布不会自动切换 App 当前目录；运行开关、目录选择和 production-ready 配置仍保持关闭，统一在全部开发完成后处理。
    </div>

    <nav class="flex min-w-0 gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-white p-1" aria-label="Taxonomy 工作区">
      <button v-for="tab in ([['terms', '词条目录'], ['catalogs', '目录版本'], ['mappings', '旧值映射']] as const)" :key="tab[0]" type="button" class="min-h-10 shrink-0 rounded-lg px-4 py-2 text-sm font-medium" :class="activeTab === tab[0] ? 'bg-gray-950 text-white' : 'text-gray-600 hover:bg-gray-100'" @click="activeTab = tab[0]">{{ tab[1] }}</button>
    </nav>

    <template v-if="activeTab === 'terms'">
      <form v-if="showCreateTerm" class="min-w-0 space-y-4 rounded-xl border border-blue-200 bg-white p-4 sm:p-5" @submit.prevent="createTerm">
        <div class="flex flex-wrap items-start justify-between gap-3"><div><h2 class="text-base font-semibold text-gray-950">新建词条草稿</h2><p class="mt-1 text-sm text-gray-500">创建后进入独立详情页继续编辑和提交复核。</p></div><button type="button" class="text-sm font-medium text-gray-500 hover:text-gray-900" @click="showCreateTerm = false">收起</button></div>
        <div class="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">分类类型</span><select v-model="createTermForm.type" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option v-for="type in TAXONOMY_TYPES" :key="type" :value="type">{{ TAXONOMY_TYPE_LABELS[type] }}</option></select></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">展示名称</span><input v-model.trim="createTermForm.displayName" required maxlength="40" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">slug</span><input v-model.trim="createTermForm.slug" required maxlength="64" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="fresh-style" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">父级稳定 ID</span><input v-model.trim="createTermForm.parentTermId" placeholder="可选：txt_…" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
          <label class="min-w-0 md:col-span-2"><span class="mb-1 block text-sm font-medium text-gray-700">别名</span><input v-model="createTermForm.aliases" maxlength="840" placeholder="逗号或换行分隔，最多 20 个" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          <label class="min-w-0 md:col-span-2"><span class="mb-1 block text-sm font-medium text-gray-700">说明</span><input v-model.trim="createTermForm.description" maxlength="300" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">可见范围</span><select v-model="createTermForm.visibility" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="public">公开</option><option value="internal">仅内部</option></select></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">敏感级别</span><select v-model="createTermForm.sensitivity" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="standard">标准</option><option value="restricted">受限</option></select></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">排序值</span><input v-model.number="createTermForm.sortOrder" type="number" min="-1000000" max="1000000" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          <label class="flex min-h-11 min-w-0 items-center gap-2 self-end rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700"><input v-model="createTermForm.allowedForProfile" type="checkbox" />允许人物资料使用</label>
          <label class="min-w-0 md:col-span-2 xl:col-span-4"><span class="mb-1 block text-sm font-medium text-gray-700">创建原因</span><input v-model.trim="createTermForm.changeReason" required maxlength="120" placeholder="说明来源、用途和判断依据" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
        </div>
        <p v-if="createTermForm.sensitivity === 'restricted'" class="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">受限词条可以保存草稿，但当前服务端拒绝审核为生效。</p>
        <p v-if="createTermError" class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ createTermError }}</p>
        <div class="flex justify-end"><button :disabled="creatingTerm" class="min-h-10 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{{ creatingTerm ? '创建中…' : '创建词条草稿' }}</button></div>
      </form>

      <form class="grid min-w-0 gap-3 rounded-xl border border-gray-200 bg-white p-4 md:grid-cols-[minmax(12rem,1fr)_11rem_11rem_auto_auto]" @submit.prevent="applyTermFilters">
        <input v-model="termSearchDraft" maxlength="80" placeholder="搜索名称、slug 或稳定 ID" class="min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <select v-model="termType" class="min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" @change="termPage = 1"><option value="">全部类型</option><option v-for="type in TAXONOMY_TYPES" :key="type" :value="type">{{ TAXONOMY_TYPE_LABELS[type] }}</option></select>
        <select v-model="termStatus" class="min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" @change="termPage = 1"><option value="">全部状态</option><option v-for="(label, value) in TAXONOMY_STATUS_LABELS" :key="value" :value="value">{{ label }}</option></select>
        <button class="min-h-10 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white">应用筛选</button>
        <button type="button" class="min-h-10 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50" @click="clearTermFilters">清空</button>
      </form>

      <div v-if="termLoadError" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{{ taxonomyApiError(termLoadError, '分类词条加载失败；能力可能尚未启用。') }} <button type="button" class="ml-2 font-semibold underline" @click="refreshTerms()">重试</button></div>
      <div v-if="termLoadStatus === 'pending'" class="rounded-xl border border-gray-200 bg-white px-5 py-14 text-center text-sm text-gray-500">正在读取稳定分类目录…</div>
      <div v-else-if="!terms.length && !termLoadError" class="rounded-xl border border-dashed border-gray-300 bg-white px-5 py-14 text-center"><p class="text-sm font-medium text-gray-700">{{ termQuery || termType || termStatus ? '当前筛选没有词条' : '尚未创建分类词条' }}</p><p class="mt-2 text-sm text-gray-500">{{ termQuery || termType || termStatus ? '清空筛选或调整条件后重试。' : '创建首个草稿后，再进入复核和目录快照流程。' }}</p></div>

      <section v-for="group in termGroups" :key="group.type" class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div class="flex items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3"><div><h2 class="text-sm font-semibold text-gray-950">{{ TAXONOMY_TYPE_LABELS[group.type] }}</h2><p class="mt-0.5 font-mono text-xs text-gray-500">{{ group.type }}</p></div><span class="rounded-full bg-white px-2.5 py-1 text-xs text-gray-600 ring-1 ring-gray-200">本页 {{ group.items.length }} 项</span></div>
        <ul class="divide-y divide-gray-100">
          <li v-for="item in group.items" :key="item.termId" class="flex min-w-0 flex-col gap-3 px-4 py-4 hover:bg-gray-50/70 sm:flex-row sm:items-center sm:justify-between">
            <div class="min-w-0" :style="{ paddingLeft: `${termDepth(item) * 20}px` }">
              <div class="flex min-w-0 flex-wrap items-center gap-2"><span v-if="item.parentTermId" class="text-gray-400" aria-hidden="true">↳</span><NuxtLink :to="`/admin/app/taxonomy/${item.termId}`" class="break-words font-medium text-blue-700 hover:underline">{{ item.displayName }}</NuxtLink><span class="inline-flex rounded-full px-2 py-0.5 text-xs ring-1 ring-inset" :class="taxonomyStatusClass(item.lifecycleStatus)">{{ TAXONOMY_STATUS_LABELS[item.lifecycleStatus] }}</span><span v-if="item.sensitivity === 'restricted'" class="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700 ring-1 ring-red-200">受限</span><span v-if="item.visibility === 'internal'" class="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">内部</span></div>
              <p class="mt-1 break-all font-mono text-xs text-gray-500">{{ item.termId }} · {{ item.slug }} · 编辑锁 v{{ item.version }}</p>
              <p v-if="item.parentTermId" class="mt-1 break-all text-xs text-gray-500">父级：{{ termById.get(item.parentTermId)?.displayName || item.parentTermId }}</p>
              <p v-if="item.mergeTargetTermId" class="mt-1 break-all text-xs text-blue-700">重定向至：{{ termById.get(item.mergeTargetTermId)?.displayName || item.mergeTargetTermId }}</p>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-3 text-xs text-gray-500"><span>{{ item.aliases.length }} 个别名</span><span>{{ item.allowedForProfile ? '可用于人物' : '不可用于人物' }}</span><NuxtLink :to="`/admin/app/taxonomy/${item.termId}`" class="text-sm font-medium text-blue-600 hover:underline">进入详情</NuxtLink></div>
          </li>
        </ul>
      </section>

      <div v-if="termPagination && termPagination.totalPages > 1" class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm text-gray-600"><span>共 {{ termPagination.total }} 项 · 第 {{ termPagination.page }} / {{ termPagination.totalPages }} 页</span><div class="flex gap-2"><button type="button" :disabled="termPage <= 1" class="min-h-9 rounded-lg border border-gray-300 px-3 disabled:opacity-40" @click="termPage--">上一页</button><button type="button" :disabled="termPage >= termPagination.totalPages" class="min-h-9 rounded-lg border border-gray-300 px-3 disabled:opacity-40" @click="termPage++">下一页</button></div></div>
    </template>

    <template v-else-if="activeTab === 'catalogs'">
      <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <div class="flex flex-wrap items-start justify-between gap-3"><div><h2 class="text-base font-semibold text-gray-950">不可变目录版本</h2><p class="mt-1 text-sm leading-6 text-gray-500">快照只收录已生效、已弃用和已合并词条；发布后不能原地修改。</p></div><button type="button" class="min-h-10 rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white" @click="showCreateCatalog = !showCreateCatalog">生成新快照</button></div>
        <form v-if="showCreateCatalog" class="mt-4 grid min-w-0 gap-4 rounded-xl border border-blue-200 bg-blue-50/40 p-4 md:grid-cols-3" @submit.prevent="createCatalog">
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">版本号</span><input v-model.trim="createCatalogForm.versionCode" required maxlength="40" placeholder="1.0.0-taxonomy.1" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm" /></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">计划生效时间</span><input v-model="createCatalogForm.effectiveAt" type="datetime-local" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm" /></label>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">最低客户端版本</span><input v-model.trim="createCatalogForm.minimumClientVersion" required maxlength="40" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm" /></label>
          <p v-if="createCatalogError" class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 md:col-span-3">{{ createCatalogError }}</p>
          <div class="flex justify-end md:col-span-3"><button :disabled="creatingCatalog" class="min-h-10 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{{ creatingCatalog ? '生成中…' : '生成不可变快照' }}</button></div>
        </form>
      </section>

      <div v-if="catalogLoadError" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{{ taxonomyApiError(catalogLoadError, '目录版本加载失败。') }} <button type="button" class="ml-2 font-semibold underline" @click="refreshCatalogs()">重试</button></div>
      <div v-if="catalogLoadStatus === 'pending'" class="rounded-xl border border-gray-200 bg-white px-5 py-14 text-center text-sm text-gray-500">正在加载目录版本…</div>
      <div v-else-if="!catalogs.length && !catalogLoadError" class="rounded-xl border border-dashed border-gray-300 bg-white px-5 py-14 text-center text-sm text-gray-500">尚无目录快照。先完成词条审核，再生成第一个版本。</div>
      <div v-else class="grid min-w-0 gap-4 lg:grid-cols-2">
        <NuxtLink v-for="catalog in catalogs" :key="catalog.catalogVersionId" :to="`/admin/app/taxonomy/releases/${catalog.catalogVersionId}`" class="group min-w-0 rounded-xl border border-gray-200 bg-white p-4 hover:border-blue-300 hover:shadow-sm sm:p-5">
          <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><h3 class="break-words font-semibold text-gray-950 group-hover:text-blue-700">目录 {{ catalog.versionCode }}</h3><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ catalog.catalogVersionId }}</p></div><span class="shrink-0 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="taxonomyStatusClass(catalog.state)">{{ TAXONOMY_CATALOG_STATE_LABELS[catalog.state] }}</span></div>
          <div class="mt-4 grid grid-cols-2 gap-3 text-sm"><div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">快照条目</p><p class="mt-1 font-semibold text-gray-900">{{ catalog.itemCount }}</p></div><div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">最低客户端</p><p class="mt-1 break-all font-mono font-semibold text-gray-900">{{ catalog.minimumClientVersion }}</p></div></div>
          <div class="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500"><span>生效：{{ formatTaxonomyDate(catalog.effectiveAt) }}</span><span :class="catalog.productionReady ? 'text-emerald-700' : 'text-amber-700'">{{ catalog.productionReady ? '允许生产选择' : '开发版本 · 禁止生产' }}</span></div>
        </NuxtLink>
      </div>
    </template>

    <template v-else>
      <div class="grid min-w-0 gap-5 xl:grid-cols-[minmax(340px,0.9fr)_minmax(520px,1.35fr)]">
        <form class="min-w-0 self-start rounded-xl border border-gray-200 bg-white p-4 sm:p-5" @submit.prevent="saveMapping">
          <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><h2 class="text-base font-semibold text-gray-950">{{ mappingForm.mappingId ? '编辑旧值映射' : '登记旧值映射' }}</h2><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ mappingForm.mappingId || '新映射' }}{{ mappingForm.expectedVersion ? ` · 编辑锁 v${mappingForm.expectedVersion}` : '' }}</p></div><button v-if="mappingForm.mappingId" type="button" class="shrink-0 text-sm font-medium text-blue-600 hover:underline" @click="resetMappingForm">新建</button></div>
          <div class="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">来源命名空间</span><input v-model.trim="mappingForm.sourceNamespace" required maxlength="40" :disabled="Boolean(mappingForm.mappingId)" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm disabled:bg-gray-100" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">来源类型</span><input v-model.trim="mappingForm.sourceType" required maxlength="40" :disabled="Boolean(mappingForm.mappingId)" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm disabled:bg-gray-100" /></label>
            <label class="min-w-0 sm:col-span-2"><span class="mb-1 block text-sm font-medium text-gray-700">来源值</span><input v-model.trim="mappingForm.sourceValue" required maxlength="120" :disabled="Boolean(mappingForm.mappingId)" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">映射结论</span><select v-model="mappingForm.mappingType" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option v-for="(label, value) in TAXONOMY_MAPPING_TYPE_LABELS" :key="value" :value="value">{{ label }}</option></select></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">规则版本</span><input v-model.trim="mappingForm.mappingRuleVersion" required maxlength="40" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
            <label v-if="mappingNeedsTarget" class="min-w-0 sm:col-span-2"><span class="mb-1 block text-sm font-medium text-gray-700">目标稳定词条 ID</span><input v-model.trim="mappingForm.targetTermId" required placeholder="必须是已生效词条：txt_…" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
            <label class="min-w-0 sm:col-span-2"><span class="mb-1 block text-sm font-medium text-gray-700">内部备注</span><textarea v-model.trim="mappingForm.note" maxlength="300" rows="3" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          </div>
          <p class="mt-4 rounded-lg bg-gray-50 px-3 py-2 text-sm leading-6 text-gray-600">未知值不得自动创建公开词条。只有“精确映射”和“别名映射”可以指向稳定词条，且目标必须已生效。</p>
          <p v-if="mappingError" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ mappingError }}</p><p v-if="mappingMessage" class="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{{ mappingMessage }}</p>
          <div class="mt-4 flex justify-end"><button :disabled="savingMapping" class="min-h-10 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{{ savingMapping ? '保存中…' : '保存映射' }}</button></div>
        </form>

      <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div class="space-y-3 border-b border-gray-200 p-4 sm:p-5"><div><h2 class="text-base font-semibold text-gray-950">映射治理队列</h2><p class="mt-1 text-sm text-gray-500">点击记录可携带当前编辑锁继续修订。</p></div><div class="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_13rem_auto]"><input v-model.lazy.trim="mappingNamespaceFilter" maxlength="40" placeholder="来源命名空间" class="min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" @change="mappingPage = 1" /><select v-model="mappingTypeFilter" class="min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" @change="mappingPage = 1"><option value="">全部映射结论</option><option v-for="(label, value) in TAXONOMY_MAPPING_TYPE_LABELS" :key="value" :value="value">{{ label }}</option></select><button type="button" class="min-h-10 rounded-lg border border-gray-300 px-4 py-2 text-sm" @click="refreshMappings()">刷新</button></div></div>
          <div v-if="mappingLoadError" class="m-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ taxonomyApiError(mappingLoadError, '旧值映射加载失败。') }}</div>
          <div v-if="mappingLoadStatus === 'pending'" class="p-12 text-center text-sm text-gray-500">正在加载旧值映射…</div>
          <div v-else-if="!mappings.length && !mappingLoadError" class="p-12 text-center text-sm text-gray-500">当前筛选没有旧值映射。</div>
          <div v-else class="w-full overflow-x-auto"><table class="w-full min-w-[820px] divide-y divide-gray-200 text-sm"><thead class="bg-gray-50 text-left text-xs font-medium text-gray-600"><tr><th class="px-4 py-3">来源</th><th class="px-4 py-3">结论</th><th class="px-4 py-3">目标</th><th class="px-4 py-3">版本 / 更新</th><th class="px-4 py-3 text-right">操作</th></tr></thead><tbody class="divide-y divide-gray-100"><tr v-for="item in mappings" :key="item.mappingId" class="align-top hover:bg-gray-50"><td class="max-w-64 px-4 py-4"><p class="break-words font-medium text-gray-900">{{ item.sourceValue }}</p><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ item.sourceNamespace }} / {{ item.sourceType }}</p><p class="mt-1 break-all text-xs text-gray-400">规范值：{{ item.sourceNormalizedValue }}</p></td><td class="px-4 py-4"><span class="whitespace-nowrap rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700">{{ TAXONOMY_MAPPING_TYPE_LABELS[item.mappingType] }}</span></td><td class="max-w-56 px-4 py-4"><NuxtLink v-if="item.targetTermId" :to="`/admin/app/taxonomy/${item.targetTermId}`" class="break-all font-mono text-xs text-blue-600 hover:underline">{{ item.targetTermId }}</NuxtLink><span v-else class="text-gray-400">不指向词条</span></td><td class="whitespace-nowrap px-4 py-4 text-xs leading-5 text-gray-500"><p>{{ item.mappingRuleVersion }} · 锁 v{{ item.version }}</p><p>{{ formatTaxonomyDate(item.updatedAt) }}</p></td><td class="px-4 py-4 text-right"><button type="button" class="font-medium text-blue-600 hover:underline" @click="editMapping(item)">编辑</button></td></tr></tbody></table></div>
          <div v-if="mappingPagination && mappingPagination.totalPages > 1" class="flex items-center justify-between gap-3 border-t border-gray-200 px-4 py-3 text-sm text-gray-600"><span>第 {{ mappingPagination.page }} / {{ mappingPagination.totalPages }} 页</span><div class="flex gap-2"><button type="button" :disabled="mappingPage <= 1" class="min-h-9 rounded-lg border border-gray-300 px-3 disabled:opacity-40" @click="mappingPage--">上一页</button><button type="button" :disabled="mappingPage >= mappingPagination.totalPages" class="min-h-9 rounded-lg border border-gray-300 px-3 disabled:opacity-40" @click="mappingPage++">下一页</button></div></div>
        </section>
      </div>
    </template>
  </div>
</template>
