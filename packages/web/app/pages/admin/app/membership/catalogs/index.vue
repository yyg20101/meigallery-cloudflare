<script setup lang="ts">
import type {
  MembershipCatalogComparison,
  MembershipCatalogDetail,
  MembershipCatalogPublishRequest,
  MembershipCatalogSummary,
  MembershipCatalogTier,
} from '~/types/admin-app-membership-catalog'
import {
  formatMembershipCatalogDate,
  membershipCatalogStateClass,
  membershipIssueClass,
  membershipPublishStatusClass,
  MEMBERSHIP_CATALOG_STATE_LABELS,
  MEMBERSHIP_PUBLISH_STATUS_LABELS,
} from '~/types/admin-app-membership-catalog'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const route = useRoute()
const router = useRouter()
const selectedCatalogId = ref(typeof route.query.catalog === 'string' ? route.query.catalog : '')

const { data: listResponse, status: listStatus, error: listError, refresh: refreshCatalogs } = await useAsyncData(
  'admin-membership-catalogs',
  () => api<{ data: MembershipCatalogSummary[] }>('/api/admin/app/memberships/catalogs'),
)
const catalogs = computed(() => listResponse.value?.data ?? [])

watch(catalogs, (items) => {
  if (!items.length) return
  if (!items.some(item => item.catalogVersionId === selectedCatalogId.value)) {
    selectedCatalogId.value = items[0]!.catalogVersionId
  }
}, { immediate: true })

const {
  data: detailResponse,
  status: detailStatus,
  error: detailLoadError,
  refresh: refreshDetail,
} = await useAsyncData(
  () => `admin-membership-catalog-${selectedCatalogId.value || 'none'}`,
  () => selectedCatalogId.value
    ? api<{ data: MembershipCatalogDetail }>(`/api/admin/app/memberships/catalogs/${selectedCatalogId.value}`)
    : Promise.resolve(null),
  { watch: [selectedCatalogId] },
)
const catalog = computed(() => detailResponse.value?.data ?? null)
const canEdit = computed(() => Boolean(
  catalog.value
  && catalog.value.state === 'development'
  && catalog.value.latestPublishRequest?.status !== 'pending_review'
  && catalog.value.grantCount === 0
  && catalog.value.applicationCount === 0
  && catalog.value.dependentCatalogCount === 0
  && !catalog.value.activeRuntimeReference,
))

const reviewStatus = ref<'pending_review' | 'approved' | 'rejected' | 'stale' | ''>('pending_review')
const {
  data: reviewResponse,
  status: reviewLoadStatus,
  error: reviewLoadError,
  refresh: refreshReviews,
} = await useAsyncData(
  'admin-membership-catalog-publish-reviews',
  () => api<{ data: MembershipCatalogPublishRequest[] }>('/api/admin/app/memberships/catalog-publish-reviews', {
    query: { status: reviewStatus.value || undefined },
  }),
  { watch: [reviewStatus] },
)
const reviews = computed(() => reviewResponse.value?.data ?? [])

const operationError = ref('')
const operationMessage = ref('')
const showCreate = ref(false)
const creating = ref(false)
const createKey = ref(newIdempotencyKey('catalog-create'))
const createForm = reactive({
  baseCatalogVersionId: '',
  versionCode: '',
  effectiveAt: toLocalDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()),
  timezone: 'Asia/Shanghai',
  minimumClientVersion: '1.0',
  changeSummary: '',
})

const showSettings = ref(false)
const savingSettings = ref(false)
const settingsKey = ref(newIdempotencyKey('catalog-settings'))
const settingsForm = reactive({
  versionCode: '',
  effectiveAt: '',
  timezone: 'Asia/Shanghai',
  minimumClientVersion: '1.0',
  changeSummary: '',
})

const showTiers = ref(false)
const savingTiers = ref(false)
const tierKey = ref(newIdempotencyKey('catalog-tiers'))
const tierChangeSummary = ref('')
const tierForm = ref<MembershipCatalogTier[]>([])

const comparison = ref<MembershipCatalogComparison | null>(null)
const comparisonBase = ref('')
const comparing = ref(false)
const comparisonError = ref('')

const publishNote = ref('')
const publishProductionReady = ref(false)
const submittingPublish = ref(false)
const publishKey = ref(newIdempotencyKey('catalog-publish'))

const selectedReview = ref<MembershipCatalogPublishRequest | null>(null)
const loadingReview = ref(false)
const reviewNote = ref('')
const reviewConfirmed = ref(false)
const decidingReview = ref(false)
const decisionKey = ref(newIdempotencyKey('catalog-decision'))

watch(catalog, (value) => {
  if (!value) return
  Object.assign(settingsForm, {
    versionCode: value.versionCode,
    effectiveAt: toLocalDateTime(value.effectiveAt),
    timezone: value.timezone,
    minimumClientVersion: value.minimumClientVersion,
    changeSummary: value.changeSummary,
  })
  tierForm.value = value.tiers.map(item => ({ ...item }))
  comparisonBase.value = value.baseCatalogVersionId
    ?? catalogs.value.find(item => item.catalogVersionId !== value.catalogVersionId)?.catalogVersionId
    ?? ''
  comparison.value = null
  comparisonError.value = ''
  publishProductionReady.value = false
  publishNote.value = ''
}, { immediate: true })

watch(() => createForm.baseCatalogVersionId, (baseId) => {
  if (!baseId || createForm.versionCode) return
  const base = catalogs.value.find(item => item.catalogVersionId === baseId)
  if (base) createForm.versionCode = `${base.versionCode}-next`
})

async function selectCatalog(id: string) {
  selectedCatalogId.value = id
  await router.replace({ query: { ...route.query, catalog: id } })
}

function openCreate() {
  const preferred = catalogs.value.find(item => item.catalogVersionId === catalog.value?.catalogVersionId && isCloneableBase(item))
    ?? catalogs.value.find(isCloneableBase)
  Object.assign(createForm, {
    baseCatalogVersionId: preferred?.catalogVersionId ?? '',
    versionCode: '',
    effectiveAt: toLocalDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()),
    timezone: catalog.value?.timezone ?? 'Asia/Shanghai',
    minimumClientVersion: catalog.value?.minimumClientVersion ?? '1.0',
    changeSummary: '',
  })
  createKey.value = newIdempotencyKey('catalog-create')
  operationError.value = ''
  showCreate.value = true
}

async function createCatalog() {
  operationError.value = ''
  operationMessage.value = ''
  creating.value = true
  try {
    const response = await api<{ data: MembershipCatalogDetail }>('/api/admin/app/memberships/catalogs', {
      method: 'POST',
      headers: { 'Idempotency-Key': createKey.value },
      body: {
        ...createForm,
        effectiveAt: new Date(createForm.effectiveAt).toISOString(),
      },
    })
    showCreate.value = false
    operationMessage.value = '新目录已从所选基线完整复制；运行时引用没有变化。'
    await refreshCatalogs()
    await selectCatalog(response.data.catalogVersionId)
  }
  catch (error) {
    operationError.value = resolveApiErrorMessage(error, '目录草稿创建失败，请检查版本号与基线。')
  }
  finally {
    creating.value = false
  }
}

async function saveSettings() {
  if (!catalog.value) return
  operationError.value = ''
  operationMessage.value = ''
  savingSettings.value = true
  try {
    await api(`/api/admin/app/memberships/catalogs/${catalog.value.catalogVersionId}`, {
      method: 'PATCH',
      headers: { 'Idempotency-Key': settingsKey.value },
      body: {
        expectedVersion: catalog.value.lockVersion,
        ...settingsForm,
        effectiveAt: new Date(settingsForm.effectiveAt).toISOString(),
      },
    })
    settingsKey.value = newIdempotencyKey('catalog-settings')
    showSettings.value = false
    operationMessage.value = '目录设置草稿已保存，并生成新的乐观锁版本。'
    await refreshWorkspace()
  }
  catch (error) {
    operationError.value = resolveApiErrorMessage(error, '目录设置保存失败，请刷新版本后重试。')
  }
  finally {
    savingSettings.value = false
  }
}

async function saveTiers() {
  if (!catalog.value) return
  operationError.value = ''
  operationMessage.value = ''
  savingTiers.value = true
  try {
    await api(`/api/admin/app/memberships/catalogs/${catalog.value.catalogVersionId}/tiers`, {
      method: 'PUT',
      headers: { 'Idempotency-Key': tierKey.value },
      body: {
        expectedVersion: catalog.value.lockVersion,
        tiers: tierForm.value,
        changeSummary: tierChangeSummary.value,
      },
    })
    tierKey.value = newIdempotencyKey('catalog-tiers')
    tierChangeSummary.value = ''
    showTiers.value = false
    operationMessage.value = '五级名称、rank 与服务文案草稿已保存。'
    await refreshWorkspace()
  }
  catch (error) {
    operationError.value = resolveApiErrorMessage(error, '五级目录保存失败，请检查 rank、顺序与必填文案。')
  }
  finally {
    savingTiers.value = false
  }
}

async function compareCatalog() {
  if (!catalog.value || !comparisonBase.value) return
  comparing.value = true
  comparisonError.value = ''
  try {
    const response = await api<{ data: MembershipCatalogComparison }>(
      `/api/admin/app/memberships/catalogs/${catalog.value.catalogVersionId}/compare`,
      { query: { baseCatalogVersionId: comparisonBase.value } },
    )
    comparison.value = response.data
  }
  catch (error) {
    comparisonError.value = resolveApiErrorMessage(error, '版本比较失败，请重新选择基线。')
  }
  finally {
    comparing.value = false
  }
}

async function submitPublish() {
  if (!catalog.value) return
  operationError.value = ''
  operationMessage.value = ''
  submittingPublish.value = true
  try {
    const response = await api<{ data: MembershipCatalogPublishRequest }>(
      `/api/admin/app/memberships/catalogs/${catalog.value.catalogVersionId}/publish-requests`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': publishKey.value },
        body: {
          expectedVersion: catalog.value.lockVersion,
          productionReady: publishProductionReady.value,
          submitNote: publishNote.value,
        },
      },
    )
    publishKey.value = newIdempotencyKey('catalog-publish')
    publishNote.value = ''
    operationMessage.value = `发布申请 ${response.data.requestId} 已进入独立复核；目录尚未生效。`
    await refreshWorkspace()
  }
  catch (error) {
    operationError.value = resolveApiErrorMessage(error, '目录发布申请提交失败，请先处理阻断项。')
  }
  finally {
    submittingPublish.value = false
  }
}

async function openReview(item: MembershipCatalogPublishRequest) {
  loadingReview.value = true
  operationError.value = ''
  try {
    const response = await api<{ data: MembershipCatalogPublishRequest }>(
      `/api/admin/app/memberships/catalog-publish-reviews/${item.requestId}`,
    )
    selectedReview.value = response.data
    reviewNote.value = ''
    reviewConfirmed.value = false
    decisionKey.value = newIdempotencyKey('catalog-decision')
  }
  catch (error) {
    operationError.value = resolveApiErrorMessage(error, '发布复核详情加载失败。')
  }
  finally {
    loadingReview.value = false
  }
}

async function decideReview(decision: 'approve' | 'reject') {
  if (!selectedReview.value || !reviewConfirmed.value) return
  decidingReview.value = true
  operationError.value = ''
  operationMessage.value = ''
  try {
    await api(`/api/admin/app/memberships/catalog-publish-reviews/${selectedReview.value.requestId}/decision`, {
      method: 'POST',
      headers: { 'Idempotency-Key': decisionKey.value },
      body: {
        expectedVersion: selectedReview.value.version,
        decision,
        reviewNote: reviewNote.value,
      },
    })
    operationMessage.value = decision === 'approve'
      ? '独立复核已批准；目录成为不可变已发布版本，但环境引用仍未自动切换。'
      : '独立复核已拒绝；目录在没有其他稳定引用时可继续编辑。'
    selectedReview.value = null
    await refreshWorkspace()
  }
  catch (error) {
    operationError.value = resolveApiErrorMessage(error, '复核决定提交失败，请刷新内容哈希与版本。')
  }
  finally {
    decidingReview.value = false
  }
}

async function refreshWorkspace() {
  await Promise.all([refreshCatalogs(), refreshDetail(), refreshReviews()])
}

function newIdempotencyKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`
}

function toLocalDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function shortHash(value: string) {
  return value ? `${value.slice(0, 10)}…${value.slice(-8)}` : '—'
}

function changeKindLabel(kind: 'added' | 'removed' | 'changed') {
  return kind === 'added' ? '新增' : kind === 'removed' ? '移除' : '修改'
}

function isCloneableBase(item: MembershipCatalogSummary) {
  if (item.latestPublishRequest?.status === 'pending_review') return false
  return item.state !== 'development'
    || item.activeRuntimeReference
    || item.grantCount > 0
    || item.applicationCount > 0
    || item.dependentCatalogCount > 0
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <header class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
      <div class="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2 text-xs font-medium text-gray-500">
            <span class="rounded-full bg-rose-50 px-2.5 py-1 text-rose-700">ADM-MBR-01</span>
            <span>管理平面 · 不自动切换运行时</span>
          </div>
          <h1 class="mt-3 text-xl font-semibold text-gray-950 sm:text-2xl">五级会员目录</h1>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
            以不可变版本维护名称、rank、服务说明和权益组合。草稿发布必须由另一位 Owner 复核；批准后仍需后置配置才会成为环境引用。
          </p>
        </div>
        <button class="w-full rounded-xl bg-gray-950 px-4 py-2.5 text-sm font-medium text-white hover:bg-gray-800 sm:w-auto" @click="openCreate">
          新建目录版本
        </button>
      </div>
      <nav class="mt-5 flex min-w-0 gap-2 overflow-x-auto pb-1 text-sm">
        <span class="shrink-0 rounded-full bg-gray-950 px-3 py-1.5 text-white">目录版本</span>
        <NuxtLink class="shrink-0 rounded-full bg-gray-100 px-3 py-1.5 text-gray-700 hover:bg-gray-200" to="/admin/app/entitlements">Entitlement 定义</NuxtLink>
        <NuxtLink class="shrink-0 rounded-full bg-gray-100 px-3 py-1.5 text-gray-700 hover:bg-gray-200" to="/admin/app/membership/applications">会员申请</NuxtLink>
        <NuxtLink class="shrink-0 rounded-full bg-gray-100 px-3 py-1.5 text-gray-700 hover:bg-gray-200" to="/admin/app/membership/grants/new">会员发放</NuxtLink>
        <NuxtLink class="shrink-0 rounded-full bg-gray-100 px-3 py-1.5 text-gray-700 hover:bg-gray-200" to="/admin/app/membership/reviews">变更复核</NuxtLink>
      </nav>
    </header>

    <div v-if="operationMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">{{ operationMessage }}</div>
    <div v-if="operationError" class="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800">{{ operationError }}</div>

    <section v-if="showCreate" class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-base font-semibold text-gray-950">从既有版本复制草稿</h2>
          <p class="mt-1 text-sm text-gray-500">复制只创建新版本，不修改基线、grant 或环境变量。</p>
        </div>
        <button class="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100" @click="showCreate = false">关闭</button>
      </div>
      <p v-if="!catalogs.some(isCloneableBase)" class="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">当前没有可复制的稳定基线。请先完成现有可编辑草稿并发布，或在后续配置阶段建立明确的运行引用。</p>
      <form class="mt-5 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3" @submit.prevent="createCatalog">
        <label class="min-w-0 text-sm text-gray-700">稳定基线目录
          <select v-model="createForm.baseCatalogVersionId" required class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 bg-white px-3 py-2.5">
            <option value="" disabled>请选择已发布或已有稳定引用的版本</option>
            <option v-for="item in catalogs" :key="item.catalogVersionId" :value="item.catalogVersionId" :disabled="!isCloneableBase(item)">{{ item.versionCode }} · {{ isCloneableBase(item) ? MEMBERSHIP_CATALOG_STATE_LABELS[item.state] : '草稿尚未稳定' }}</option>
          </select>
        </label>
        <label class="min-w-0 text-sm text-gray-700">新版本号
          <input v-model.trim="createForm.versionCode" required maxlength="64" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5" placeholder="app-1.0-catalog-draft-2">
        </label>
        <label class="min-w-0 text-sm text-gray-700">计划生效时间
          <input v-model="createForm.effectiveAt" required type="datetime-local" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5">
        </label>
        <label class="min-w-0 text-sm text-gray-700">目录时区
          <input v-model.trim="createForm.timezone" required maxlength="64" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5">
        </label>
        <label class="min-w-0 text-sm text-gray-700">最低客户端版本
          <input v-model.trim="createForm.minimumClientVersion" required maxlength="32" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5">
        </label>
        <label class="min-w-0 text-sm text-gray-700 md:col-span-2 xl:col-span-3">变更目标
          <textarea v-model.trim="createForm.changeSummary" required maxlength="500" rows="3" class="mt-1.5 w-full min-w-0 resize-y rounded-xl border border-gray-300 px-3 py-2.5" placeholder="说明为什么需要新版本、准备调整什么，以及明确不自动切换环境。" />
        </label>
        <div class="flex min-w-0 flex-wrap justify-end gap-2 md:col-span-2 xl:col-span-3">
          <button type="button" class="w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm text-gray-700 sm:w-auto" @click="showCreate = false">取消</button>
          <button type="submit" :disabled="creating || !createForm.baseCatalogVersionId" class="w-full rounded-xl bg-gray-950 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 sm:w-auto">{{ creating ? '创建中…' : '创建完整草稿副本' }}</button>
        </div>
      </form>
    </section>

    <div class="grid min-w-0 gap-5 xl:grid-cols-[minmax(250px,0.7fr)_minmax(0,2fr)]">
      <aside class="min-w-0 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
        <div class="flex items-center justify-between gap-3 px-2 py-2">
          <h2 class="text-sm font-semibold text-gray-900">目录版本</h2>
          <span class="text-xs text-gray-500">{{ catalogs.length }} 个</span>
        </div>
        <p v-if="listStatus === 'pending'" class="px-2 py-8 text-center text-sm text-gray-500">正在加载目录…</p>
        <p v-else-if="listError" class="m-2 rounded-xl bg-rose-50 px-3 py-3 text-sm text-rose-700">目录列表加载失败。</p>
        <div v-else class="mt-1 space-y-2">
          <button
            v-for="item in catalogs"
            :key="item.catalogVersionId"
            class="w-full min-w-0 rounded-xl border p-3 text-left transition"
            :class="selectedCatalogId === item.catalogVersionId ? 'border-gray-950 bg-gray-950 text-white' : 'border-gray-200 bg-white hover:border-gray-400'"
            @click="selectCatalog(item.catalogVersionId)"
          >
            <span class="flex min-w-0 items-start justify-between gap-2">
              <strong class="min-w-0 break-words text-sm">{{ item.versionCode }}</strong>
              <span v-if="item.activeRuntimeReference" class="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">环境引用</span>
            </span>
            <span class="mt-2 flex flex-wrap gap-1.5 text-[11px]" :class="selectedCatalogId === item.catalogVersionId ? 'text-white/75' : 'text-gray-500'">
              <span>{{ MEMBERSHIP_CATALOG_STATE_LABELS[item.state] }}</span>
              <span>lock {{ item.lockVersion }}</span>
              <span>{{ item.entitlementCount }} 项权益</span>
            </span>
            <span v-if="item.latestPublishRequest" class="mt-2 block text-xs" :class="selectedCatalogId === item.catalogVersionId ? 'text-white/80' : 'text-blue-700'">
              {{ MEMBERSHIP_PUBLISH_STATUS_LABELS[item.latestPublishRequest.status] }}
            </span>
          </button>
          <p v-if="!catalogs.length" class="px-2 py-8 text-center text-sm text-gray-500">尚无目录版本。</p>
        </div>
      </aside>

      <section aria-label="会员目录详情与编辑" class="min-w-0 space-y-5">
        <section v-if="detailStatus === 'pending'" class="rounded-2xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500 shadow-sm">正在读取目录事实…</section>
        <section v-else-if="detailLoadError" class="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800">目录详情加载失败，请确认 `0089` 结构已在后续配置阶段应用。</section>
        <template v-else-if="catalog">
          <section class="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
            <div class="flex min-w-0 flex-wrap items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset" :class="membershipCatalogStateClass(catalog.state)">{{ MEMBERSHIP_CATALOG_STATE_LABELS[catalog.state] }}</span>
                  <span v-if="catalog.activeRuntimeReference" class="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-200">当前环境引用</span>
                  <span v-if="catalog.productionReady" class="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">Production ready</span>
                </div>
                <h2 class="mt-3 break-words text-lg font-semibold text-gray-950">{{ catalog.versionCode }}</h2>
                <p class="mt-1 break-all text-xs text-gray-500">{{ catalog.catalogVersionId }}</p>
                <p class="mt-3 max-w-3xl text-sm leading-6 text-gray-600">{{ catalog.changeSummary }}</p>
              </div>
              <div class="flex w-full min-w-0 flex-wrap gap-2 sm:w-auto">
                <button :disabled="!canEdit" class="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto" @click="showSettings = !showSettings">编辑设置</button>
                <button :disabled="!canEdit" class="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm text-gray-700 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto" @click="showTiers = !showTiers">编辑五级</button>
                <NuxtLink :to="`/admin/app/entitlements?catalog=${catalog.catalogVersionId}`" class="w-full rounded-xl bg-gray-950 px-3 py-2 text-center text-sm text-white sm:w-auto">管理 Entitlement</NuxtLink>
              </div>
            </div>

            <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
              <div class="rounded-xl bg-gray-50 p-3"><span class="text-xs text-gray-500">计划生效</span><strong class="mt-1 block text-sm text-gray-900">{{ formatMembershipCatalogDate(catalog.effectiveAt) }}</strong></div>
              <div class="rounded-xl bg-gray-50 p-3"><span class="text-xs text-gray-500">最低客户端</span><strong class="mt-1 block text-sm text-gray-900">{{ catalog.minimumClientVersion }}</strong></div>
              <div class="rounded-xl bg-gray-50 p-3"><span class="text-xs text-gray-500">业务引用</span><strong class="mt-1 block text-sm text-gray-900">{{ catalog.grantCount }} grant · {{ catalog.applicationCount }} 申请</strong></div>
              <div class="rounded-xl bg-gray-50 p-3"><span class="text-xs text-gray-500">版本依赖</span><strong class="mt-1 block text-sm text-gray-900">{{ catalog.dependentCatalogCount }} 个后继目录</strong></div>
              <div class="rounded-xl bg-gray-50 p-3"><span class="text-xs text-gray-500">内容哈希</span><strong class="mt-1 block break-all text-sm text-gray-900">{{ shortHash(catalog.contentHash) }}</strong></div>
            </div>

            <div v-if="!canEdit && catalog.state === 'development'" class="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800">
              <span v-if="catalog.latestPublishRequest?.status === 'pending_review'">目录正等待独立复核，内容已锁定。</span>
              <span v-else-if="catalog.activeRuntimeReference">当前环境正在引用该目录，不允许原地修改；请先从该版本创建新草稿，发布后再单独变更环境配置。</span>
              <span v-else>目录已有 grant、申请或后继版本引用，不再允许原地修改；请从该版本创建新草稿。</span>
            </div>
          </section>

          <section v-if="showSettings" class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
            <h3 class="text-base font-semibold text-gray-950">目录设置草稿</h3>
            <form class="mt-4 grid min-w-0 gap-4 md:grid-cols-2" @submit.prevent="saveSettings">
              <label class="min-w-0 text-sm text-gray-700">版本号<input v-model.trim="settingsForm.versionCode" required class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5"></label>
              <label class="min-w-0 text-sm text-gray-700">计划生效时间<input v-model="settingsForm.effectiveAt" required type="datetime-local" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5"></label>
              <label class="min-w-0 text-sm text-gray-700">时区<input v-model.trim="settingsForm.timezone" required class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5"></label>
              <label class="min-w-0 text-sm text-gray-700">最低客户端版本<input v-model.trim="settingsForm.minimumClientVersion" required class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5"></label>
              <label class="min-w-0 text-sm text-gray-700 md:col-span-2">变更摘要<textarea v-model.trim="settingsForm.changeSummary" required maxlength="500" rows="3" class="mt-1.5 w-full min-w-0 resize-y rounded-xl border border-gray-300 px-3 py-2.5" /></label>
              <div class="flex flex-wrap justify-end gap-2 md:col-span-2"><button type="button" class="w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm sm:w-auto" @click="showSettings = false">取消</button><button :disabled="savingSettings" class="w-full rounded-xl bg-gray-950 px-4 py-2.5 text-sm text-white disabled:opacity-50 sm:w-auto">{{ savingSettings ? '保存中…' : '保存设置草稿' }}</button></div>
            </form>
          </section>

          <section class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
            <div class="flex flex-wrap items-center justify-between gap-3"><div><h3 class="text-base font-semibold text-gray-950">五级展示与 rank</h3><p class="mt-1 text-sm text-gray-500">名称只参与展示；权限始终使用 rank 与 entitlement key。</p></div><span class="text-xs text-gray-500">{{ catalog.tiers.length }} / 5</span></div>
            <div class="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 2xl:grid-cols-5">
              <article v-for="tier in catalog.tiers" :key="tier.tierId" class="min-w-0 rounded-xl border border-gray-200 p-4">
                <span class="text-xs text-gray-500">rank {{ tier.rank }}</span><h4 class="mt-1 break-words font-semibold text-gray-950">{{ tier.displayName }}</h4><p class="mt-1 break-all text-xs text-gray-500">{{ tier.code }}</p><p class="mt-3 text-sm leading-6 text-gray-600">{{ tier.tagline }}</p>
              </article>
            </div>
          </section>

          <section v-if="showTiers" class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
            <div><h3 class="text-base font-semibold text-gray-950">编辑完整五级目录</h3><p class="mt-1 text-sm text-gray-500">稳定 tierId 不可更换；一次保存完整五级，避免 rank 与顺序处于中间态。</p></div>
            <form class="mt-5 space-y-4" @submit.prevent="saveTiers">
              <article v-for="(tier, index) in tierForm" :key="tier.tierId" class="min-w-0 rounded-xl border border-gray-200 bg-gray-50 p-4">
                <div class="flex flex-wrap items-center justify-between gap-2"><strong class="break-all text-sm text-gray-900">{{ tier.tierId }}</strong><span class="text-xs text-gray-500">等级 {{ index + 1 }}</span></div>
                <div class="mt-4 grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <label class="text-xs text-gray-600">展示名称<input v-model.trim="tier.displayName" required maxlength="32" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"></label>
                  <label class="text-xs text-gray-600">稳定 code<input v-model.trim="tier.code" required maxlength="48" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"></label>
                  <label class="text-xs text-gray-600">rank<input v-model.number="tier.rank" required type="number" min="1" max="1000" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"></label>
                  <label class="text-xs text-gray-600">展示顺序<input v-model.number="tier.sortOrder" required type="number" min="1" max="1000" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"></label>
                  <label class="text-xs text-gray-600">颜色 token<input v-model.trim="tier.accentToken" required maxlength="32" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"></label>
                  <label class="text-xs text-gray-600 md:col-span-2 xl:col-span-3">一句话说明<input v-model.trim="tier.tagline" required maxlength="120" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"></label>
                  <label class="text-xs text-gray-600 md:col-span-2">获取方式<input v-model.trim="tier.acquisitionLabel" required maxlength="120" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"></label>
                  <label class="text-xs text-gray-600 md:col-span-2">服务披露<input v-model.trim="tier.serviceDisclosure" required maxlength="240" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"></label>
                </div>
              </article>
              <label class="block text-sm text-gray-700">本次五级调整摘要<textarea v-model.trim="tierChangeSummary" required maxlength="500" rows="3" class="mt-1.5 w-full min-w-0 resize-y rounded-xl border border-gray-300 px-3 py-2.5" /></label>
              <div class="flex flex-wrap justify-end gap-2"><button type="button" class="w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm sm:w-auto" @click="showTiers = false">取消</button><button :disabled="savingTiers" class="w-full rounded-xl bg-gray-950 px-4 py-2.5 text-sm text-white disabled:opacity-50 sm:w-auto">{{ savingTiers ? '保存中…' : '保存完整五级草稿' }}</button></div>
            </form>
          </section>

          <div class="grid min-w-0 gap-5 lg:grid-cols-2">
            <section class="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
              <div class="flex flex-wrap items-start justify-between gap-3"><div><h3 class="text-base font-semibold text-gray-950">Schema 与发布校验</h3><p class="mt-1 text-sm text-gray-500">错误阻断所有发布；警告允许非生产发布，但阻断 production ready。</p></div><div class="flex gap-1.5 text-xs"><span class="rounded-full bg-rose-50 px-2 py-1 text-rose-700">{{ catalog.validation.errorCount }} 错误</span><span class="rounded-full bg-amber-50 px-2 py-1 text-amber-700">{{ catalog.validation.warningCount }} 警告</span></div></div>
              <div class="mt-4 max-h-[32rem] space-y-2 overflow-y-auto pr-1">
                <div v-for="issue in catalog.validation.issues" :key="`${issue.code}:${issue.scope}`" class="min-w-0 rounded-xl border px-3 py-3" :class="membershipIssueClass(issue.severity)"><div class="flex min-w-0 flex-wrap items-center gap-2"><strong class="break-all text-xs">{{ issue.code }}</strong><span class="break-all text-[11px] opacity-75">{{ issue.scope }}</span></div><p class="mt-1 text-sm leading-6">{{ issue.message }}</p></div>
                <div v-if="!catalog.validation.issues.length" class="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-4 text-sm text-emerald-800">当前目录没有结构或兼容性问题。</div>
              </div>
            </section>

            <section class="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
              <h3 class="text-base font-semibold text-gray-950">与基线比较</h3>
              <div class="mt-4 flex min-w-0 flex-col gap-2 sm:flex-row">
                <select v-model="comparisonBase" class="min-w-0 flex-1 rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm"><option value="">选择比较版本</option><option v-for="item in catalogs.filter(item => item.catalogVersionId !== catalog?.catalogVersionId)" :key="item.catalogVersionId" :value="item.catalogVersionId">{{ item.versionCode }}</option></select>
                <button :disabled="!comparisonBase || comparing" class="w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm disabled:opacity-40 sm:w-auto" @click="compareCatalog">{{ comparing ? '比较中…' : '生成差异' }}</button>
              </div>
              <p v-if="comparisonError" class="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{{ comparisonError }}</p>
              <template v-if="comparison">
                <div class="mt-4 grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-3"><div class="rounded-xl bg-gray-50 p-3"><strong class="block text-lg text-gray-950">{{ comparison.summary.changedTiers }}</strong>等级修改</div><div class="rounded-xl bg-gray-50 p-3"><strong class="block text-lg text-gray-950">{{ comparison.summary.addedEntitlements }}</strong>权益新增</div><div class="col-span-2 rounded-xl bg-gray-50 p-3 sm:col-span-1"><strong class="block text-lg text-gray-950">{{ comparison.summary.changedEntitlements }}</strong>权益修改</div></div>
                <div class="mt-4 max-h-80 space-y-2 overflow-y-auto"><div v-for="item in comparison.tierChanges" :key="`tier:${item.tierId}`" class="rounded-lg border border-gray-200 px-3 py-2 text-sm"><strong class="break-all">{{ item.tierId }}</strong><span class="ml-2 text-gray-500">{{ changeKindLabel(item.kind) }} · {{ item.fields.join('、') }}</span></div><div v-for="item in comparison.entitlementChanges" :key="`ent:${item.key}`" class="rounded-lg border border-gray-200 px-3 py-2 text-sm"><strong class="break-all">{{ item.key }}</strong><span class="ml-2 text-gray-500">{{ changeKindLabel(item.kind) }} · {{ item.tierValueChangeCount }} 个等级值</span></div><p v-if="!comparison.tierChanges.length && !comparison.entitlementChanges.length" class="py-8 text-center text-sm text-gray-500">两个版本内容一致。</p></div>
              </template>
            </section>
          </div>

          <section class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
            <div class="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.7fr)]">
              <div class="min-w-0"><h3 class="text-base font-semibold text-gray-950">提交目录发布独立复核</h3><p class="mt-2 text-sm leading-6 text-gray-600">提交后锁定当前内容哈希。批准只把目录变成不可变版本，不会改 Wrangler、环境目录 ID 或迁移 grant。</p><label class="mt-4 block text-sm text-gray-700">发布依据<textarea v-model.trim="publishNote" :disabled="!canEdit" maxlength="500" rows="4" class="mt-1.5 w-full min-w-0 resize-y rounded-xl border border-gray-300 px-3 py-2.5 disabled:bg-gray-100" placeholder="说明差异核对、客户端兼容性和仍未关闭的产品决策。" /></label><label class="mt-3 flex min-w-0 items-start gap-2 text-sm text-gray-700"><input v-model="publishProductionReady" type="checkbox" :disabled="!catalog.validation.canMarkProductionReady || !canEdit" class="mt-1"><span>申请标记为 production ready<span class="block text-xs leading-5 text-gray-500">当前产品决策未批准时不可选择；非生产发布仍不会切换环境。</span></span></label></div>
              <div class="min-w-0 rounded-xl border border-gray-200 bg-gray-50 p-4"><span class="text-xs text-gray-500">提交门禁</span><strong class="mt-1 block text-lg" :class="catalog.validation.canSubmitPublish ? 'text-emerald-700' : 'text-rose-700'">{{ catalog.validation.canSubmitPublish ? '可提交独立复核' : '存在阻断错误' }}</strong><dl class="mt-4 space-y-2 text-sm"><div class="flex justify-between gap-3"><dt class="text-gray-500">目录 lock</dt><dd class="font-medium">{{ catalog.lockVersion }}</dd></div><div class="flex justify-between gap-3"><dt class="text-gray-500">生产决策</dt><dd class="font-medium">{{ catalog.productionDecisionStatus === 'approved' ? '已批准' : '未决' }}</dd></div><div class="flex justify-between gap-3"><dt class="text-gray-500">内容哈希</dt><dd class="break-all text-right font-mono text-xs">{{ shortHash(catalog.contentHash) }}</dd></div></dl><button :disabled="!canEdit || !catalog.validation.canSubmitPublish || publishNote.trim().length < 2 || submittingPublish" class="mt-5 w-full rounded-xl bg-gray-950 px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40" @click="submitPublish">{{ submittingPublish ? '提交中…' : '提交另一位 Owner 复核' }}</button></div>
            </div>
          </section>
        </template>
      </section>
    </div>

    <section class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
      <div class="flex min-w-0 flex-wrap items-start justify-between gap-3"><div><h2 class="text-base font-semibold text-gray-950">目录发布复核队列</h2><p class="mt-1 text-sm text-gray-500">只有有效 Owner 且不是目录创建人/发布申请人时可作出决定。</p></div><select v-model="reviewStatus" class="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm sm:w-auto"><option value="">全部状态</option><option value="pending_review">待独立复核</option><option value="approved">已批准</option><option value="rejected">已拒绝</option><option value="stale">内容已变化</option></select></div>
      <p v-if="reviewLoadStatus === 'pending'" class="py-8 text-center text-sm text-gray-500">正在加载发布队列…</p>
      <p v-else-if="reviewLoadError" class="mt-4 rounded-xl bg-rose-50 px-3 py-3 text-sm text-rose-700">发布复核队列加载失败。</p>
      <div v-else class="mt-4 grid min-w-0 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        <button v-for="item in reviews" :key="item.requestId" :disabled="loadingReview" class="min-w-0 rounded-xl border border-gray-200 p-4 text-left hover:border-gray-400 disabled:opacity-50" @click="openReview(item)"><span class="flex min-w-0 flex-wrap items-center justify-between gap-2"><strong class="min-w-0 break-words text-sm text-gray-950">{{ item.catalog.versionCode }}</strong><span class="rounded-full px-2 py-1 text-[11px] ring-1 ring-inset" :class="membershipPublishStatusClass(item.status)">{{ MEMBERSHIP_PUBLISH_STATUS_LABELS[item.status] }}</span></span><span class="mt-2 block break-all text-xs text-gray-500">{{ item.requestId }}</span><p class="mt-3 line-clamp-2 text-sm leading-6 text-gray-600">{{ item.submitNote }}</p><span class="mt-3 block text-xs" :class="item.canReview ? 'text-emerald-700' : 'text-gray-500'">{{ item.canReview ? '可由我独立复核' : '只读或职责冲突' }} · {{ item.requestedBy.label }}</span></button>
        <p v-if="!reviews.length" class="py-8 text-center text-sm text-gray-500 lg:col-span-2 2xl:col-span-3">当前筛选下没有发布申请。</p>
      </div>
    </section>

    <section v-if="selectedReview" class="rounded-2xl border border-gray-300 bg-white p-4 shadow-lg sm:p-6">
      <div class="flex min-w-0 flex-wrap items-start justify-between gap-3"><div class="min-w-0"><span class="text-xs font-medium text-gray-500">目录发布复核</span><h2 class="mt-1 break-words text-lg font-semibold text-gray-950">{{ selectedReview.catalog.versionCode }}</h2><p class="mt-1 break-all text-xs text-gray-500">{{ selectedReview.requestId }}</p></div><button class="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100" @click="selectedReview = null">关闭</button></div>
      <div class="mt-5 grid min-w-0 gap-4 lg:grid-cols-2">
        <div class="min-w-0 space-y-3"><div class="rounded-xl bg-gray-50 p-4"><span class="text-xs text-gray-500">申请依据</span><p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-gray-800">{{ selectedReview.submitNote }}</p></div><div class="grid grid-cols-2 gap-2 text-sm"><div class="rounded-xl border border-gray-200 p-3"><span class="text-xs text-gray-500">申请人</span><strong class="mt-1 block break-words">{{ selectedReview.requestedBy.label }}</strong></div><div class="rounded-xl border border-gray-200 p-3"><span class="text-xs text-gray-500">目录 lock</span><strong class="mt-1 block">{{ selectedReview.catalogLockVersion }}</strong></div><div class="col-span-2 rounded-xl border border-gray-200 p-3"><span class="text-xs text-gray-500">固化内容哈希</span><strong class="mt-1 block break-all font-mono text-xs">{{ selectedReview.contentHash }}</strong></div></div></div>
        <div class="min-w-0"><div class="rounded-xl border p-4" :class="selectedReview.canReview ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'"><strong class="text-sm" :class="selectedReview.canReview ? 'text-emerald-800' : 'text-amber-800'">{{ selectedReview.canReview ? '职责分离检查通过' : '当前账号不能复核此申请' }}</strong><p class="mt-1 text-xs leading-5" :class="selectedReview.canReview ? 'text-emerald-700' : 'text-amber-700'">批准前服务端会再次计算内容哈希、Schema 门禁、目录状态与 Owner 身份。</p></div><label class="mt-4 block text-sm text-gray-700">复核结论<textarea v-model.trim="reviewNote" :disabled="!selectedReview.canReview" maxlength="500" rows="4" class="mt-1.5 w-full min-w-0 resize-y rounded-xl border border-gray-300 px-3 py-2.5 disabled:bg-gray-100" /></label><label class="mt-3 flex items-start gap-2 text-sm text-gray-700"><input v-model="reviewConfirmed" :disabled="!selectedReview.canReview" type="checkbox" class="mt-1"><span>我已独立核对基线差异、内容哈希、客户端兼容性和“不自动切换环境”的边界。</span></label><div class="mt-4 flex min-w-0 flex-wrap justify-end gap-2"><button :disabled="!selectedReview.canReview || !reviewConfirmed || reviewNote.trim().length < 2 || decidingReview" class="w-full rounded-xl border border-rose-300 px-4 py-2.5 text-sm font-medium text-rose-700 disabled:opacity-40 sm:w-auto" @click="decideReview('reject')">拒绝发布</button><button :disabled="!selectedReview.canReview || !reviewConfirmed || reviewNote.trim().length < 2 || decidingReview" class="w-full rounded-xl bg-gray-950 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40 sm:w-auto" @click="decideReview('approve')">批准为不可变版本</button></div></div>
      </div>
    </section>
  </div>
</template>
