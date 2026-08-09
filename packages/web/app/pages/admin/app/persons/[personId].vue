<script setup lang="ts">
import type { AdminPersonDetail } from '~/types/admin-app-person'
import type {
  TaxonomyCatalog,
  TaxonomyCatalogDetail,
  TaxonomyCatalogItem,
  TaxonomyType,
} from '~/types/admin-app-taxonomy'
import {
  formatAdminDate,
  PERSON_STATUS_LABELS,
  personStatusClass,
  VERIFICATION_ITEM_LABELS,
} from '~/types/admin-app-person'
import {
  TAXONOMY_CATALOG_STATE_LABELS,
  TAXONOMY_TYPES,
  TAXONOMY_TYPE_LABELS,
  formatTaxonomyDate,
  taxonomyApiError,
} from '~/types/admin-app-taxonomy'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const personId = computed(() => String(route.params.personId || ''))
const busyAction = ref('')
const message = ref<{ type: 'success' | 'error'; text: string } | null>(null)

const { data: response, status, error, refresh } = await useAsyncData(
  () => `admin-app-person-${personId.value}`,
  () => api<{ data: AdminPersonDetail }>(`/api/admin/app/persons/${personId.value}`),
)
const detail = computed(() => response.value?.data ?? null)

const { data: galleryData } = await useAsyncData(`admin-app-person-galleries-${personId.value}`, () =>
  api<{ data: Array<{ id: string; title: string; status: string }> }>('/api/admin/galleries', {
    query: { page: 1, pageSize: 100, status: 'published', sort: 'created_desc' },
  }),
)
const galleries = computed(() => galleryData.value?.data ?? [])
const sourceGalleryMissing = computed(() => Boolean(
  detail.value && !galleries.value.some(item => item.id === detail.value!.sourceGallery.id),
))

const { data: taxonomyCatalogResponse, status: taxonomyCatalogStatus, error: taxonomyCatalogError, refresh: refreshTaxonomyCatalogs } = await useAsyncData(
  `admin-app-person-taxonomy-catalogs-${personId.value}`,
  () => api<{ data: TaxonomyCatalog[] }>('/api/admin/app/taxonomy/catalogs'),
)
const taxonomyCatalogs = computed(() => taxonomyCatalogResponse.value?.data ?? [])
const selectedTaxonomyCatalogId = ref(detail.value?.taxonomy.catalogVersionId ?? '')
const selectedTaxonomyTermIds = ref(detail.value?.taxonomy.current.map(item => item.termId) ?? [])
const taxonomyQuery = ref('')
const taxonomyTypeFilter = ref<'' | TaxonomyType>('')

const taxonomyCatalogOptions = computed(() => taxonomyCatalogs.value.filter((catalog) => {
  const isCurrent = catalog.catalogVersionId === detail.value?.taxonomy.catalogVersionId
  const effectiveAt = Date.parse(catalog.effectiveAt)
  return isCurrent || (
    ['development', 'published'].includes(catalog.state)
    && Number.isFinite(effectiveAt)
    && effectiveAt <= Date.now()
  )
}))

const { data: selectedTaxonomyCatalogResponse, status: selectedTaxonomyCatalogStatus, error: selectedTaxonomyCatalogError, refresh: refreshSelectedTaxonomyCatalog } = await useAsyncData(
  () => `admin-app-person-taxonomy-catalog-${selectedTaxonomyCatalogId.value || 'none'}`,
  async () => selectedTaxonomyCatalogId.value
    ? api<{ data: TaxonomyCatalogDetail }>(`/api/admin/app/taxonomy/catalogs/${selectedTaxonomyCatalogId.value}`)
    : null,
  { watch: [selectedTaxonomyCatalogId] },
)
const selectedTaxonomyCatalog = computed(() => selectedTaxonomyCatalogResponse.value?.data ?? null)
const assignableTaxonomyItems = computed(() => (selectedTaxonomyCatalog.value?.items ?? []).filter(item => (
  item.publicState === 'active'
  && item.visibility === 'public'
  && item.sensitivity === 'standard'
  && item.allowedForProfile
)))
const assignableTaxonomyIds = computed(() => new Set(assignableTaxonomyItems.value.map(item => item.termId)))
const selectedTaxonomyIds = computed(() => new Set(selectedTaxonomyTermIds.value))
const invalidSelectedTaxonomyIds = computed(() => selectedTaxonomyTermIds.value.filter(termId => !assignableTaxonomyIds.value.has(termId)))
const filteredTaxonomyItems = computed(() => assignableTaxonomyItems.value.filter((item) => {
  if (taxonomyTypeFilter.value && item.type !== taxonomyTypeFilter.value) return false
  if (!taxonomyQuery.value.trim()) return true
  const keyword = taxonomyQuery.value.trim().toLocaleLowerCase('zh-CN')
  return [item.displayName, item.termId, item.slug, ...item.aliases]
    .some(value => value.toLocaleLowerCase('zh-CN').includes(keyword))
}))
const taxonomyItemGroups = computed(() => TAXONOMY_TYPES.map(type => ({
  type,
  items: filteredTaxonomyItems.value.filter(item => item.type === type),
})).filter(group => group.items.length))
const taxonomySelectionChanged = computed(() => {
  if (!detail.value) return false
  if (selectedTaxonomyCatalogId.value !== (detail.value.taxonomy.catalogVersionId ?? '')) return true
  return [...selectedTaxonomyTermIds.value].sort().join('|') !== detail.value.taxonomy.current.map(item => item.termId).sort().join('|')
})

const form = reactive({
  sourceGalleryId: '',
  displayName: '',
  summary: '',
  tagsText: '',
  regionCode: '',
  regionLabel: '',
  regionPrecision: 'city',
  recommendationScore: 0,
  heatScore: 0,
  recommendationReasonCode: 'EDITORIAL_QUALITY',
})
const authorizationForm = reactive({
  evidenceRef: '',
  validFrom: '',
  validUntil: '',
  reasonCode: 'ADMIN_CONFIRMED',
  note: '',
})
const verificationForm = reactive({
  evidenceRef: '',
  validUntil: '',
  reasonCode: 'VERIFICATION_PASSED',
  note: '',
})
const publicationForm = reactive({
  reasonCode: 'PUBLICATION_APPROVED',
  note: '',
})
const pauseForm = reactive({
  reasonCode: 'MANUAL_SAFETY_REVIEW',
  note: '',
})

watch(detail, (value) => {
  if (!value) return
  form.sourceGalleryId = value.sourceGallery.id
  form.displayName = value.displayName
  form.summary = value.summary || ''
  form.tagsText = value.tags.join('，')
  form.regionCode = value.region?.code || ''
  form.regionLabel = value.region?.label || ''
  form.regionPrecision = value.region?.precision || 'city'
  form.recommendationScore = value.recommendation.score
  form.heatScore = value.recommendation.heatScore
  form.recommendationReasonCode = value.recommendation.reasonCode
  selectedTaxonomyCatalogId.value = value.taxonomy.catalogVersionId ?? ''
  selectedTaxonomyTermIds.value = value.taxonomy.current.map(item => item.termId)
}, { immediate: true })

const pendingPublication = computed(() => detail.value?.history.publications.find(item =>
  item.profileVersion === detail.value?.contentVersion && item.status === 'pending_review',
) ?? null)
const allGatesPassed = computed(() => Boolean(detail.value?.gates.length) && detail.value!.gates.every(gate => gate.passed))
const verificationItems = Object.keys(VERIFICATION_ITEM_LABELS)

async function mutate(action: string, path: string, body: Record<string, unknown>, successText: string) {
  if (!detail.value || busyAction.value) return
  busyAction.value = action
  message.value = null
  try {
    await api(path, { method: 'POST', body })
    await refresh()
    message.value = { type: 'success', text: successText }
  } catch (requestError: any) {
    message.value = { type: 'error', text: resolveApiErrorMessage(requestError, '操作失败') }
  } finally {
    busyAction.value = ''
  }
}

function localDateTimeToIso(value: string) {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : value
}

async function saveProfile() {
  if (!detail.value || busyAction.value) return
  if (detail.value.liveProjection?.visible && !window.confirm('保存会创建新的不可见草稿版本，线上版本会保持不变。确认继续？')) return
  busyAction.value = 'save'
  message.value = null
  try {
    await api(`/api/admin/app/persons/${personId.value}`, {
      method: 'PATCH',
      body: {
        expectedVersion: detail.value.lockVersion,
        sourceGalleryId: form.sourceGalleryId,
        displayName: form.displayName,
        summary: form.summary,
        tags: [...new Set(form.tagsText.split(/[，,]/u).map(item => item.trim()).filter(Boolean))],
        regionCode: form.regionCode,
        regionLabel: form.regionLabel,
        regionPrecision: form.regionCode || form.regionLabel ? form.regionPrecision : '',
        recommendationScore: form.recommendationScore,
        heatScore: form.heatScore,
        recommendationReasonCode: form.recommendationReasonCode,
      },
    })
    await refresh()
    message.value = { type: 'success', text: '新草稿版本已保存；原线上版本未被覆盖。' }
  } catch (requestError: any) {
    message.value = { type: 'error', text: resolveApiErrorMessage(requestError, '保存失败') }
  } finally {
    busyAction.value = ''
  }
}

function resetTaxonomySelection() {
  if (!detail.value) return
  selectedTaxonomyTermIds.value = selectedTaxonomyCatalogId.value === detail.value.taxonomy.catalogVersionId
    ? detail.value.taxonomy.current.map(item => item.termId)
    : []
}

function toggleTaxonomyTerm(item: TaxonomyCatalogItem) {
  const selected = selectedTaxonomyIds.value.has(item.termId)
  if (selected) {
    selectedTaxonomyTermIds.value = selectedTaxonomyTermIds.value.filter(termId => termId !== item.termId)
    return
  }
  if (selectedTaxonomyTermIds.value.length >= 30) return
  selectedTaxonomyTermIds.value = [...selectedTaxonomyTermIds.value, item.termId]
}

function removeInvalidTaxonomyTerm(termId: string) {
  selectedTaxonomyTermIds.value = selectedTaxonomyTermIds.value.filter(item => item !== termId)
}

async function saveTaxonomyAssignments() {
  if (!detail.value || !selectedTaxonomyCatalogId.value || busyAction.value) return
  if (invalidSelectedTaxonomyIds.value.length) {
    message.value = { type: 'error', text: '当前选择仍包含已失效或不可用于人物的词条，请先移除后再保存。' }
    return
  }
  if (detail.value.liveProjection?.visible && !window.confirm('更新结构化分类会创建新的不可见草稿版本，并使新版本重新进入授权、认证和发布流程。当前线上版本保持不变。确认继续？')) return
  busyAction.value = 'taxonomy-save'
  message.value = null
  try {
    await api(`/api/admin/app/persons/${personId.value}/taxonomy`, {
      method: 'PUT',
      body: {
        expectedVersion: detail.value.lockVersion,
        catalogVersionId: selectedTaxonomyCatalogId.value,
        termIds: selectedTaxonomyTermIds.value,
      },
    })
    await refresh()
    message.value = { type: 'success', text: '稳定分类已保存为新内容版本；原线上分类投影未被覆盖。' }
  }
  catch (requestError) {
    message.value = { type: 'error', text: taxonomyApiError(requestError, '结构化分类保存失败，请刷新目录和编辑锁后重试。') }
  }
  finally {
    busyAction.value = ''
  }
}

function grantAuthorization() {
  if (!detail.value) return
  return mutate('authorization-grant', `/api/admin/app/persons/${personId.value}/authorization`, {
    expectedVersion: detail.value.lockVersion,
    evidenceRef: authorizationForm.evidenceRef,
    validFrom: localDateTimeToIso(authorizationForm.validFrom),
    validUntil: localDateTimeToIso(authorizationForm.validUntil),
    reasonCode: authorizationForm.reasonCode,
    note: authorizationForm.note,
  }, '当前内容版本的用途授权已登记。')
}

function revokeAuthorization() {
  const record = detail.value?.currentAuthorization
  if (!detail.value || !record || !window.confirm('撤销授权会立即暂停引用该授权的公开投影。确认继续？')) return
  return mutate('authorization-revoke', `/api/admin/app/persons/${personId.value}/authorization/revoke`, {
    expectedVersion: detail.value.lockVersion,
    recordId: record.id,
    reasonCode: 'AUTHORIZATION_REVOKED_BY_ADMIN',
    note: authorizationForm.note,
  }, '用途授权已撤销，关联公开投影已暂停。')
}

function submitVerification() {
  if (!detail.value) return
  return mutate('verification-submit', `/api/admin/app/persons/${personId.value}/verification/submit`, {
    expectedVersion: detail.value.lockVersion,
    evidenceRef: verificationForm.evidenceRef,
    note: verificationForm.note,
  }, '认证材料已提交复核。')
}

function decideVerification(decision: 'verified' | 'rejected') {
  const record = detail.value?.currentVerification
  if (!detail.value || !record) return
  const confirmed = decision === 'verified'
    ? window.confirm('确认四项检查均已完成，并通过当前内容版本的认证？')
    : window.confirm('确认退回当前认证申请？')
  if (!confirmed) return
  return mutate(`verification-${decision}`, `/api/admin/app/persons/${personId.value}/verification/decision`, {
    expectedVersion: detail.value.lockVersion,
    verificationId: record.id,
    decision,
    verificationItems: decision === 'verified' ? verificationItems : [],
    validUntil: localDateTimeToIso(verificationForm.validUntil),
    reasonCode: decision === 'verified' ? verificationForm.reasonCode : 'VERIFICATION_REJECTED',
    note: verificationForm.note,
  }, decision === 'verified' ? '当前内容版本已通过认证。' : '认证申请已退回。')
}

function revokeVerification() {
  const record = detail.value?.currentVerification
  if (!detail.value || !record || !window.confirm('撤销认证会立即暂停引用该认证的公开投影。确认继续？')) return
  return mutate('verification-revoke', `/api/admin/app/persons/${personId.value}/verification/revoke`, {
    expectedVersion: detail.value.lockVersion,
    recordId: record.id,
    reasonCode: 'VERIFICATION_REVOKED_BY_ADMIN',
    note: verificationForm.note,
  }, '认证已撤销，关联公开投影已暂停。')
}

function submitPublication() {
  if (!detail.value) return
  return mutate('publication-submit', `/api/admin/app/persons/${personId.value}/publication/submit`, {
    expectedVersion: detail.value.lockVersion,
    note: publicationForm.note,
  }, '当前内容版本已提交发布复核。')
}

function decidePublication(decision: 'published' | 'rejected') {
  if (!detail.value || !pendingPublication.value) return
  const confirmed = decision === 'published'
    ? window.confirm('确认公开预览、授权、认证和来源图库均无误，并发布到 App？')
    : window.confirm('确认退回当前发布申请？')
  if (!confirmed) return
  return mutate(`publication-${decision}`, `/api/admin/app/persons/${personId.value}/publication/decision`, {
    expectedVersion: detail.value.lockVersion,
    publicationId: pendingPublication.value.id,
    decision,
    reasonCode: decision === 'published' ? publicationForm.reasonCode : 'PUBLICATION_REJECTED',
    note: publicationForm.note,
  }, decision === 'published' ? '公开投影已生成，人物可进入 App 发现页。' : '发布申请已退回草稿。')
}

function pausePublication() {
  if (!detail.value || !window.confirm('确认立即暂停 App 公开展示？此操作不会删除历史版本。')) return
  return mutate('publication-pause', `/api/admin/app/persons/${personId.value}/publication/pause`, {
    expectedVersion: detail.value.lockVersion,
    reasonCode: pauseForm.reasonCode,
    note: pauseForm.note,
  }, 'App 公开投影已立即暂停。')
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <div v-if="status === 'pending'" class="rounded-xl border border-gray-200 bg-white px-6 py-12 text-center text-sm text-gray-500">正在加载人物工作台…</div>
    <div v-else-if="error || !detail" class="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
      人物工作台加载失败或记录不存在。
      <button class="ml-2 font-medium underline" @click="refresh()">重试</button>
    </div>

    <template v-else>
      <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div class="min-w-0">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <h1 class="break-words text-xl font-bold text-gray-950">{{ detail.displayName }}</h1>
            <span class="rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="personStatusClass(detail.publicationStatus)">
              {{ PERSON_STATUS_LABELS[detail.publicationStatus] || detail.publicationStatus }}
            </span>
          </div>
          <p class="mt-1 break-all text-xs leading-5 text-gray-500">{{ detail.personId }} · {{ detail.profileId }}</p>
        </div>
        <NuxtLink to="/admin/app/persons" class="shrink-0 text-sm font-medium text-blue-600 hover:underline">返回人物供给</NuxtLink>
      </div>

      <div class="grid min-w-0 gap-3 sm:grid-cols-3">
        <div class="min-w-0 rounded-xl border border-gray-200 bg-white p-4">
          <div class="text-xs text-gray-500">用途授权</div>
          <div class="mt-2"><span class="inline-flex max-w-full rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="personStatusClass(detail.authorizationStatus)">{{ PERSON_STATUS_LABELS[detail.authorizationStatus] || detail.authorizationStatus }}</span></div>
        </div>
        <div class="min-w-0 rounded-xl border border-gray-200 bg-white p-4">
          <div class="text-xs text-gray-500">认证状态</div>
          <div class="mt-2"><span class="inline-flex max-w-full rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="personStatusClass(detail.verificationStatus)">{{ PERSON_STATUS_LABELS[detail.verificationStatus] || detail.verificationStatus }}</span></div>
        </div>
        <div class="min-w-0 rounded-xl border border-gray-200 bg-white p-4">
          <div class="text-xs text-gray-500">App 公开状态</div>
          <div class="mt-2 text-sm font-medium" :class="detail.liveProjection?.visible ? 'text-emerald-700' : 'text-gray-700'">{{ detail.liveProjection?.visible ? '当前可见' : '当前不可见' }}</div>
        </div>
      </div>

      <div v-if="detail.liveContentVersion && detail.liveContentVersion !== detail.contentVersion" class="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-900">
        当前正在编辑草稿 v{{ detail.contentVersion }}，App 仍展示已经复核的线上 v{{ detail.liveContentVersion }}。只有重新通过发布复核后才会替换线上快照。
      </div>

      <div v-if="message" class="break-words rounded-xl border p-4 text-sm leading-6" :class="message.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'">
        {{ message.text }}
      </div>

      <div class="grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]">
        <form class="min-w-0 space-y-5 rounded-xl border border-gray-200 bg-white p-4 sm:p-6" @submit.prevent="saveProfile">
          <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div>
              <h2 class="text-base font-semibold text-gray-950">人物资料草稿</h2>
              <p class="mt-1 text-xs text-gray-500">内容 v{{ detail.contentVersion }} · 并发锁 {{ detail.lockVersion }}</p>
            </div>
            <span class="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">{{ detail.operation.label }}</span>
          </div>

          <label class="block min-w-0">
            <span class="mb-1 block text-sm font-medium text-gray-700">来源图库</span>
            <select v-model="form.sourceGalleryId" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option v-for="gallery in galleries" :key="gallery.id" :value="gallery.id">{{ gallery.title }}（{{ gallery.id }}）</option>
              <option v-if="sourceGalleryMissing" :value="detail.sourceGallery.id">{{ detail.sourceGallery.title }}（当前来源）</option>
            </select>
          </label>
          <div class="grid min-w-0 gap-4 sm:grid-cols-2">
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">展示名</span><input v-model="form.displayName" required maxlength="80" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">标签</span><input v-model="form.tagsText" maxlength="320" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          </div>
          <label class="block min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">公开简介</span><textarea v-model="form.summary" maxlength="500" rows="4" class="w-full min-w-0 resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6" /></label>
          <div class="grid min-w-0 gap-4 md:grid-cols-3">
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">地区代码</span><input v-model="form.regionCode" maxlength="32" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">地区名称</span><input v-model="form.regionLabel" maxlength="80" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">地区精度</span><select v-model="form.regionPrecision" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="city">城市</option><option value="province">省级</option><option value="country">国家</option><option value="broad">宽泛地区</option></select></label>
          </div>
          <div class="grid min-w-0 gap-4 md:grid-cols-3">
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">推荐分</span><input v-model.number="form.recommendationScore" type="number" min="0" max="1000000" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">热度分</span><input v-model.number="form.heatScore" type="number" min="0" max="1000000" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">推荐原因码</span><input v-model="form.recommendationReasonCode" maxlength="80" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" /></label>
          </div>
          <div class="flex min-w-0 flex-wrap items-center gap-3">
            <button :disabled="Boolean(busyAction)" class="inline-flex min-h-11 max-w-full items-center justify-center whitespace-normal rounded-lg bg-blue-600 px-5 py-2.5 text-center text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{{ busyAction === 'save' ? '保存中…' : '保存为新草稿版本' }}</button>
            <span class="text-xs leading-5 text-gray-500">资料变更会使新版本重新进入授权与认证流程。</span>
          </div>
        </form>

        <aside class="min-w-0 space-y-5">
          <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
            <h2 class="text-base font-semibold text-gray-950">发布门禁</h2>
            <ul class="mt-4 space-y-3">
              <li v-for="gate in detail.gates" :key="gate.code" class="flex min-w-0 items-start gap-3 text-sm">
                <span class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold" :class="gate.passed ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'">{{ gate.passed ? '✓' : '!' }}</span>
                <div class="min-w-0"><div class="break-words font-medium text-gray-900">{{ gate.label }}</div><div class="mt-0.5 break-words text-xs leading-5 text-gray-500">{{ gate.detail }}</div></div>
              </li>
            </ul>
          </section>

          <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
            <h2 class="text-base font-semibold text-gray-950">来源与线上版本</h2>
            <dl class="mt-4 space-y-3 text-sm">
              <div><dt class="text-gray-500">来源图库</dt><dd class="mt-1 break-words font-medium text-gray-900">{{ detail.sourceGallery.title }}</dd></div>
              <div><dt class="text-gray-500">来源状态</dt><dd class="mt-1">{{ detail.sourceGallery.status }} · {{ detail.sourceGallery.hasCover ? '封面已就绪' : '缺少封面' }}</dd></div>
              <div><dt class="text-gray-500">线上投影</dt><dd class="mt-1 break-words">{{ detail.liveProjection ? `投影 v${detail.liveProjection.projectionVersion} / 内容 v${detail.liveProjection.profileVersion}` : '尚未生成' }}</dd></div>
              <div><dt class="text-gray-500">更新时间</dt><dd class="mt-1">{{ formatAdminDate(detail.updatedAt) }}</dd></div>
            </dl>
          </section>
        </aside>
      </div>

      <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-6">
        <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div class="min-w-0">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <h2 class="text-base font-semibold text-gray-950">稳定 Taxonomy 分类</h2>
              <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="detail.taxonomy.ready ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'">{{ detail.taxonomy.ready ? '发布门禁通过' : '存在失效条件' }}</span>
            </div>
            <p class="mt-1 max-w-4xl text-sm leading-6 text-gray-500">按不可变目录和稳定词条 ID 标注当前内容版本。legacy 标签只保留迁移期展示兼容，搜索、筛选和推荐不得引用其文案。</p>
          </div>
          <NuxtLink to="/admin/app/taxonomy" class="shrink-0 text-sm font-medium text-blue-600 hover:underline">管理分类目录</NuxtLink>
        </div>

        <div class="mt-4 grid min-w-0 gap-3 lg:grid-cols-2">
          <article class="min-w-0 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><h3 class="text-sm font-semibold text-gray-900">当前草稿 v{{ detail.contentVersion }}</h3><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ detail.taxonomy.catalogVersionId || '尚未绑定目录' }}</p></div><span class="shrink-0 text-xs text-gray-500">{{ detail.taxonomy.current.length }} 项</span></div>
            <p class="mt-3 text-xs leading-5" :class="detail.taxonomy.ready ? 'text-emerald-700' : 'text-red-700'">{{ detail.taxonomy.readinessDetail }}</p>
            <div v-if="detail.taxonomy.current.length" class="mt-3 flex flex-wrap gap-2"><NuxtLink v-for="item in detail.taxonomy.current" :key="item.termId" :to="`/admin/app/taxonomy/${item.termId}`" class="max-w-full rounded-full bg-white px-2.5 py-1 text-xs text-gray-700 ring-1 ring-gray-200 hover:text-blue-700"><span class="break-words">{{ item.displayName }}</span><span class="ml-1 font-mono text-gray-400">v{{ item.termVersion }}</span></NuxtLink></div>
            <p v-else class="mt-3 text-xs text-gray-500">当前内容版本未设置结构化分类，这是允许的安全空状态。</p>
          </article>
          <article class="min-w-0 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><h3 class="text-sm font-semibold text-gray-900">App 线上分类</h3><p class="mt-1 text-xs text-gray-500">只读取已通过发布复核的投影</p></div><span class="shrink-0 text-xs text-gray-500">{{ detail.taxonomy.live.length }} 项</span></div>
            <div v-if="detail.taxonomy.live.length" class="mt-3 flex flex-wrap gap-2"><NuxtLink v-for="item in detail.taxonomy.live" :key="`${item.catalogVersionId}:${item.termId}`" :to="`/admin/app/taxonomy/${item.termId}`" class="max-w-full rounded-full bg-white px-2.5 py-1 text-xs text-gray-700 ring-1 ring-gray-200 hover:text-blue-700"><span class="break-words">{{ item.displayName }}</span><span class="ml-1 font-mono text-gray-400">内容 v{{ item.profileVersion }}</span></NuxtLink></div>
            <p v-else class="mt-3 text-xs text-gray-500">当前没有线上结构化分类投影。</p>
          </article>
        </div>

        <div v-if="taxonomyCatalogError" class="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
          {{ taxonomyApiError(taxonomyCatalogError, 'Taxonomy 后台能力当前不可用。') }}
          <button type="button" class="ml-2 font-semibold underline" @click="refreshTaxonomyCatalogs()">重试</button>
          <p class="mt-1 text-xs">在统一配置阶段启用后台能力前，人物基础资料和既有线上投影仍可安全查看，但不能修改稳定分类。</p>
        </div>

        <template v-else>
          <div class="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]">
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">分类目录版本</span><select v-model="selectedTaxonomyCatalogId" :disabled="taxonomyCatalogStatus === 'pending' || Boolean(busyAction)" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100" @change="resetTaxonomySelection"><option value="">请选择不可变目录</option><option v-for="catalog in taxonomyCatalogOptions" :key="catalog.catalogVersionId" :value="catalog.catalogVersionId">{{ catalog.versionCode }} · {{ TAXONOMY_CATALOG_STATE_LABELS[catalog.state] }}{{ catalog.productionReady ? ' · Production Ready' : '' }}</option></select></label>
            <div v-if="selectedTaxonomyCatalog" class="grid min-w-0 gap-2 rounded-lg bg-gray-50 p-3 text-xs leading-5 text-gray-600 sm:grid-cols-3"><div><span class="block text-gray-400">稳定目录 ID</span><span class="break-all font-mono text-gray-700">{{ selectedTaxonomyCatalog.catalogVersionId }}</span></div><div><span class="block text-gray-400">最低客户端</span><span class="font-mono text-gray-700">{{ selectedTaxonomyCatalog.minimumClientVersion }}</span></div><div><span class="block text-gray-400">计划生效</span><span class="text-gray-700">{{ formatTaxonomyDate(selectedTaxonomyCatalog.effectiveAt) }}</span></div></div>
          </div>

          <div v-if="selectedTaxonomyCatalogError" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ taxonomyApiError(selectedTaxonomyCatalogError, '所选目录明细加载失败。') }} <button type="button" class="ml-2 font-semibold underline" @click="refreshSelectedTaxonomyCatalog()">重试</button></div>
          <div v-if="selectedTaxonomyCatalogStatus === 'pending' && selectedTaxonomyCatalogId" class="mt-4 rounded-lg bg-gray-50 p-8 text-center text-sm text-gray-500">正在读取目录快照…</div>

          <template v-if="selectedTaxonomyCatalog">
            <div class="mt-4 flex min-w-0 flex-col gap-3 rounded-xl border border-gray-200 p-4 lg:flex-row lg:items-center lg:justify-between">
              <div class="min-w-0"><p class="text-sm font-semibold text-gray-900">已选择 {{ selectedTaxonomyTermIds.length }} / 30 个稳定词条</p><p class="mt-1 text-xs leading-5 text-gray-500">只有 active + public + standard + allowedForProfile 的快照项可选；保存空列表可清除当前草稿的结构化分类。</p></div>
              <div class="flex min-w-0 flex-col gap-2 sm:flex-row"><input v-model.trim="taxonomyQuery" maxlength="80" placeholder="搜索名称、别名或稳定 ID" class="min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm sm:w-64" /><select v-model="taxonomyTypeFilter" class="min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="">全部类型</option><option v-for="type in TAXONOMY_TYPES" :key="type" :value="type">{{ TAXONOMY_TYPE_LABELS[type] }}</option></select></div>
            </div>

            <div v-if="invalidSelectedTaxonomyIds.length" class="mt-4 rounded-xl border border-red-200 bg-red-50 p-4"><p class="text-sm font-semibold text-red-900">选择中包含 {{ invalidSelectedTaxonomyIds.length }} 个已失效或不可分配词条</p><p class="mt-1 text-xs leading-5 text-red-700">目录状态变化不会被静默忽略。移除后才能保存，避免发布范围被意外扩大。</p><div class="mt-3 flex flex-wrap gap-2"><button v-for="invalidId in invalidSelectedTaxonomyIds" :key="invalidId" type="button" class="max-w-full rounded-full bg-white px-2.5 py-1 text-left font-mono text-xs text-red-700 ring-1 ring-red-200 hover:bg-red-100" @click="removeInvalidTaxonomyTerm(invalidId)"><span class="break-all">{{ invalidId }}</span><span class="ml-1 font-sans">× 移除</span></button></div></div>

            <div v-if="!filteredTaxonomyItems.length" class="mt-4 rounded-xl border border-dashed border-gray-300 px-5 py-10 text-center text-sm text-gray-500">{{ assignableTaxonomyItems.length ? '当前搜索或类型筛选没有可用词条。' : '该目录没有可用于人物资料的 active 公开标准词条。' }}</div>
            <div v-else class="mt-4 grid min-w-0 gap-4 xl:grid-cols-2">
              <section v-for="group in taxonomyItemGroups" :key="group.type" class="min-w-0 overflow-hidden rounded-xl border border-gray-200">
                <div class="flex items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-4 py-3"><div><h3 class="text-sm font-semibold text-gray-900">{{ TAXONOMY_TYPE_LABELS[group.type] }}</h3><p class="mt-0.5 font-mono text-xs text-gray-400">{{ group.type }}</p></div><span class="text-xs text-gray-500">{{ group.items.length }} 项</span></div>
                <div class="grid min-w-0 gap-2 p-3 sm:grid-cols-2">
                  <label v-for="item in group.items" :key="item.termId" class="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm" :class="selectedTaxonomyIds.has(item.termId) ? 'border-blue-300 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'"><input type="checkbox" class="mt-1" :checked="selectedTaxonomyIds.has(item.termId)" :disabled="!selectedTaxonomyIds.has(item.termId) && selectedTaxonomyTermIds.length >= 30" @change="toggleTaxonomyTerm(item)" /><span class="min-w-0"><span class="block break-words font-medium text-gray-900">{{ item.displayName }}</span><span class="mt-1 block break-all font-mono text-xs text-gray-500">{{ item.termId }} · v{{ item.termVersion }}</span><span v-if="item.aliases.length" class="mt-1 block break-words text-xs text-gray-500">别名：{{ item.aliases.slice(0, 3).join('、') }}</span></span></label>
                </div>
              </section>
            </div>

            <div class="mt-4 flex min-w-0 flex-col gap-3 border-t border-gray-100 pt-4 sm:flex-row sm:items-center sm:justify-between"><p class="text-xs leading-5 text-gray-500">保存使用人物并发锁 {{ detail.lockVersion }}；目录项资格由服务端重新校验，前端选择不能绕过。</p><button type="button" :disabled="Boolean(busyAction) || !taxonomySelectionChanged || !selectedTaxonomyCatalogId || invalidSelectedTaxonomyIds.length > 0" class="inline-flex min-h-11 max-w-full items-center justify-center rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" @click="saveTaxonomyAssignments">{{ busyAction === 'taxonomy-save' ? '保存中…' : '保存稳定分类为新草稿版本' }}</button></div>
          </template>

          <div v-else-if="taxonomyCatalogStatus !== 'pending' && !taxonomyCatalogOptions.length" class="mt-4 rounded-xl border border-dashed border-gray-300 px-5 py-10 text-center"><p class="text-sm font-medium text-gray-700">尚无已生效的可编辑目录版本</p><p class="mt-2 text-sm text-gray-500">先在 Taxonomy 工作区审核词条并生成目录快照。</p></div>
        </template>
      </section>

      <div class="grid min-w-0 gap-5 xl:grid-cols-3">
        <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <h2 class="text-base font-semibold text-gray-950">1. 用途授权</h2>
          <p class="mt-1 text-xs leading-5 text-gray-500">只记录内部证据引用，不在此填写证件号码或证据正文。</p>
          <div v-if="detail.currentAuthorization" class="mt-4 rounded-lg bg-gray-50 p-3 text-xs leading-5 text-gray-600">
            <div class="break-all font-mono text-gray-800">{{ detail.currentAuthorization.id }}</div>
            <div class="mt-1">内容 v{{ detail.currentAuthorization.profileVersion }} · {{ PERSON_STATUS_LABELS[detail.currentAuthorization.effectiveStatus] || detail.currentAuthorization.effectiveStatus }}</div>
            <div class="mt-1 break-all">证据：{{ detail.currentAuthorization.evidenceRef }}</div>
            <div class="mt-1">有效期至：{{ formatAdminDate(detail.currentAuthorization.validUntil) }}</div>
          </div>
          <div class="mt-4 space-y-3">
            <label class="block min-w-0"><span class="mb-1 block text-xs font-medium text-gray-700">证据引用</span><input v-model="authorizationForm.evidenceRef" maxlength="500" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="内部案件号或私有对象引用" /></label>
            <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
              <label class="min-w-0"><span class="mb-1 block text-xs font-medium text-gray-700">开始时间（可选）</span><input v-model="authorizationForm.validFrom" type="datetime-local" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
              <label class="min-w-0"><span class="mb-1 block text-xs font-medium text-gray-700">结束时间（可选）</span><input v-model="authorizationForm.validUntil" type="datetime-local" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            </div>
            <label class="block min-w-0"><span class="mb-1 block text-xs font-medium text-gray-700">备注</span><textarea v-model="authorizationForm.note" maxlength="500" rows="2" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          </div>
          <div class="mt-4 flex min-w-0 flex-wrap gap-2">
            <button :disabled="Boolean(busyAction) || !authorizationForm.evidenceRef.trim()" class="min-h-10 max-w-full whitespace-normal rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="grantAuthorization">登记当前版本授权</button>
            <button v-if="detail.currentAuthorization?.storedStatus === 'active'" :disabled="Boolean(busyAction)" class="min-h-10 max-w-full whitespace-normal rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50" @click="revokeAuthorization">撤销授权</button>
          </div>
        </section>

        <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <h2 class="text-base font-semibold text-gray-950">2. 认证复核</h2>
          <p class="mt-1 text-xs leading-5 text-gray-500">认证结论绑定当前内容版本，不使用“本人运营”等未冻结宣传文案。</p>
          <div v-if="detail.currentVerification" class="mt-4 rounded-lg bg-gray-50 p-3 text-xs leading-5 text-gray-600">
            <div class="break-all font-mono text-gray-800">{{ detail.currentVerification.id }}</div>
            <div class="mt-1">内容 v{{ detail.currentVerification.profileVersion }} · {{ PERSON_STATUS_LABELS[detail.currentVerification.effectiveStatus] || detail.currentVerification.effectiveStatus }}</div>
            <div class="mt-1 break-all">证据：{{ detail.currentVerification.evidenceRef }}</div>
          </div>
          <div class="mt-4 space-y-3">
            <label class="block min-w-0"><span class="mb-1 block text-xs font-medium text-gray-700">认证证据引用</span><input v-model="verificationForm.evidenceRef" maxlength="500" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="内部案件号或私有对象引用" /></label>
            <label class="block min-w-0"><span class="mb-1 block text-xs font-medium text-gray-700">认证有效期（可选）</span><input v-model="verificationForm.validUntil" type="datetime-local" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="block min-w-0"><span class="mb-1 block text-xs font-medium text-gray-700">复核备注</span><textarea v-model="verificationForm.note" maxlength="500" rows="2" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          </div>
          <ul class="mt-4 space-y-2 text-xs leading-5 text-gray-600">
            <li v-for="item in verificationItems" :key="item" class="flex items-start gap-2"><span class="text-emerald-600">□</span><span>{{ VERIFICATION_ITEM_LABELS[item] }}</span></li>
          </ul>
          <div class="mt-4 flex min-w-0 flex-wrap gap-2">
            <button v-if="detail.verificationStatus !== 'pending' && detail.verificationStatus !== 'verified'" :disabled="Boolean(busyAction) || !verificationForm.evidenceRef.trim()" class="min-h-10 max-w-full whitespace-normal rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="submitVerification">提交认证复核</button>
            <template v-if="detail.verificationStatus === 'pending'">
              <button :disabled="Boolean(busyAction)" class="min-h-10 max-w-full whitespace-normal rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="decideVerification('verified')">四项检查通过</button>
              <button :disabled="Boolean(busyAction)" class="min-h-10 max-w-full whitespace-normal rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50" @click="decideVerification('rejected')">退回认证</button>
            </template>
            <button v-if="detail.currentVerification?.storedStatus === 'verified'" :disabled="Boolean(busyAction)" class="min-h-10 max-w-full whitespace-normal rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50" @click="revokeVerification">撤销认证</button>
          </div>
        </section>

        <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <h2 class="text-base font-semibold text-gray-950">3. 发布与暂停</h2>
          <p class="mt-1 text-xs leading-5 text-gray-500">发布时再次执行全部门禁，并把审定版本单向写入公开投影。</p>
          <div class="mt-4 rounded-lg p-3 text-sm" :class="allGatesPassed ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'">
            {{ allGatesPassed ? '全部发布门禁已通过' : `仍有 ${detail.gates.filter(item => !item.passed).length} 项门禁未通过` }}
          </div>
          <div class="mt-4 space-y-3">
            <label class="block min-w-0"><span class="mb-1 block text-xs font-medium text-gray-700">发布复核备注</span><textarea v-model="publicationForm.note" maxlength="500" rows="2" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="block min-w-0"><span class="mb-1 block text-xs font-medium text-gray-700">暂停说明</span><textarea v-model="pauseForm.note" maxlength="500" rows="2" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          </div>
          <div class="mt-4 flex min-w-0 flex-wrap gap-2">
            <button v-if="detail.publicationStatus !== 'pending_review'" :disabled="Boolean(busyAction) || !allGatesPassed" class="min-h-10 max-w-full whitespace-normal rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="submitPublication">提交发布复核</button>
            <template v-if="detail.publicationStatus === 'pending_review' && pendingPublication">
              <button :disabled="Boolean(busyAction)" class="min-h-10 max-w-full whitespace-normal rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="decidePublication('published')">确认发布到 App</button>
              <button :disabled="Boolean(busyAction)" class="min-h-10 max-w-full whitespace-normal rounded-lg border border-red-200 bg-white px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50" @click="decidePublication('rejected')">退回发布</button>
            </template>
            <button v-if="detail.liveProjection?.visible" :disabled="Boolean(busyAction)" class="min-h-10 max-w-full whitespace-normal rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="pausePublication">立即暂停公开</button>
          </div>
        </section>
      </div>

      <details class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <summary class="cursor-pointer px-4 py-4 text-sm font-semibold text-gray-900 sm:px-5">查看审批历史与证据引用</summary>
        <div class="grid min-w-0 gap-5 border-t border-gray-100 p-4 sm:p-5 xl:grid-cols-3">
          <section class="min-w-0"><h3 class="text-sm font-semibold text-gray-900">授权历史</h3><div class="mt-3 space-y-2"><div v-for="item in detail.history.authorizations" :key="item.id" class="min-w-0 rounded-lg bg-gray-50 p-3 text-xs leading-5 text-gray-600"><div class="break-all font-mono text-gray-800">{{ item.id }}</div><div>v{{ item.profileVersion }} · {{ item.effectiveStatus }} · {{ formatAdminDate(item.createdAt) }}</div><div class="break-all">{{ item.evidenceRef }}</div></div><p v-if="!detail.history.authorizations.length" class="text-xs text-gray-500">暂无记录</p></div></section>
          <section class="min-w-0"><h3 class="text-sm font-semibold text-gray-900">认证历史</h3><div class="mt-3 space-y-2"><div v-for="item in detail.history.verifications" :key="item.id" class="min-w-0 rounded-lg bg-gray-50 p-3 text-xs leading-5 text-gray-600"><div class="break-all font-mono text-gray-800">{{ item.id }}</div><div>v{{ item.profileVersion }} · {{ item.effectiveStatus }} · {{ formatAdminDate(item.submittedAt) }}</div><div class="break-all">{{ item.evidenceRef }}</div></div><p v-if="!detail.history.verifications.length" class="text-xs text-gray-500">暂无记录</p></div></section>
          <section class="min-w-0"><h3 class="text-sm font-semibold text-gray-900">发布历史</h3><div class="mt-3 space-y-2"><div v-for="item in detail.history.publications" :key="item.id" class="min-w-0 rounded-lg bg-gray-50 p-3 text-xs leading-5 text-gray-600"><div class="break-all font-mono text-gray-800">{{ item.id }}</div><div>v{{ item.profileVersion }} · {{ item.status }} · {{ formatAdminDate(item.submittedAt) }}</div><div v-if="item.reasonCode" class="break-all">{{ item.reasonCode }}</div></div><p v-if="!detail.history.publications.length" class="text-xs text-gray-500">暂无记录</p></div></section>
        </div>
      </details>
    </template>
  </div>
</template>
