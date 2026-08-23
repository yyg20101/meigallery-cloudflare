<script setup lang="ts">
import type {
  TaxonomyCatalogDetail,
  TaxonomyCatalogItem,
  TaxonomyPublicState,
  TaxonomyType,
} from '~/types/admin-app-taxonomy'
import {
  TAXONOMY_CATALOG_STATE_LABELS,
  TAXONOMY_PUBLIC_STATE_LABELS,
  TAXONOMY_TYPES,
  TAXONOMY_TYPE_LABELS,
  formatTaxonomyDate,
  taxonomyApiError,
  taxonomyStatusClass,
} from '~/types/admin-app-taxonomy'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const catalogId = computed(() => String(route.params.id || ''))
const searchDraft = ref('')
const query = ref('')
const typeFilter = ref<'' | TaxonomyType>('')
const publicStateFilter = ref<'' | TaxonomyPublicState>('')
const publishing = ref(false)
const publishError = ref('')
const publishMessage = ref('')
const immutableConfirmed = ref(false)
const clientCompatibilityConfirmed = ref(false)
const productionReady = ref(false)
const productionConfirmed = ref(false)

const { data, status, error, refresh } = await useAsyncData(
  () => `admin-app-taxonomy-catalog-${catalogId.value}`,
  () => api<{ data: TaxonomyCatalogDetail }>(`/api/admin/app/taxonomy/catalogs/${catalogId.value}`),
)

const catalog = computed(() => data.value?.data ?? null)
const itemIds = computed(() => new Set((catalog.value?.items ?? []).map(item => item.termId)))
const missingParentItems = computed(() => (catalog.value?.items ?? []).filter(item => item.parentTermId && !itemIds.value.has(item.parentTermId)))
const missingRedirectItems = computed(() => (catalog.value?.items ?? []).filter(item => item.publicState === 'redirect' && (!item.redirectTargetTermId || !itemIds.value.has(item.redirectTargetTermId))))
const graphComplete = computed(() => !missingParentItems.value.length && !missingRedirectItems.value.length)
const itemCounts = computed(() => {
  const items = catalog.value?.items ?? []
  return {
    active: items.filter(item => item.publicState === 'active').length,
    deprecated: items.filter(item => item.publicState === 'deprecated').length,
    redirect: items.filter(item => item.publicState === 'redirect').length,
    profileEligible: items.filter(item => item.publicState === 'active' && item.visibility === 'public' && item.sensitivity === 'standard' && item.allowedForProfile).length,
    nonPublic: items.filter(item => item.visibility !== 'public' || item.sensitivity !== 'standard').length,
  }
})
const filteredItems = computed(() => (catalog.value?.items ?? []).filter((item) => {
  if (typeFilter.value && item.type !== typeFilter.value) return false
  if (publicStateFilter.value && item.publicState !== publicStateFilter.value) return false
  if (!query.value) return true
  const keyword = query.value.toLocaleLowerCase('zh-CN')
  return [item.displayName, item.slug, item.termId, ...item.aliases]
    .some(value => value.toLocaleLowerCase('zh-CN').includes(keyword))
}))
const groupedItems = computed(() => TAXONOMY_TYPES.map(type => ({
  type,
  items: filteredItems.value.filter(item => item.type === type),
})).filter(group => group.items.length))
const readyToPublish = computed(() => Boolean(
  catalog.value
  && catalog.value.state === 'development'
  && catalog.value.itemCount > 0
  && graphComplete.value
  && catalog.value.minimumClientVersion
  && immutableConfirmed.value
  && clientCompatibilityConfirmed.value
  && (!productionReady.value || productionConfirmed.value),
))

watch(catalog, (value) => {
  if (!value) return
  productionReady.value = value.productionReady
}, { immediate: true })

function applyFilters() {
  query.value = searchDraft.value.trim()
}

function clearFilters() {
  searchDraft.value = ''
  query.value = ''
  typeFilter.value = ''
  publicStateFilter.value = ''
}

async function publishCatalog() {
  if (!catalog.value || !readyToPublish.value) return
  publishError.value = ''
  publishMessage.value = ''
  if (import.meta.client) {
    const mode = productionReady.value ? '允许 production 配置选择' : '仅发布为开发目录'
    if (!window.confirm(`确认发布目录 ${catalog.value.versionCode}？\n\n发布后快照不可修改，本次将${mode}。`)) return
  }
  publishing.value = true
  try {
    await api(`/api/admin/app/taxonomy/catalogs/${catalogId.value}/publish`, {
      method: 'POST',
      body: {
        expectedVersion: catalog.value.lockVersion,
        productionReady: productionReady.value,
      },
    })
    publishMessage.value = '目录已发布为不可变快照。当前 App 目录配置尚未切换。'
    immutableConfirmed.value = false
    clientCompatibilityConfirmed.value = false
    productionConfirmed.value = false
    await refresh()
  }
  catch (requestError) {
    publishError.value = taxonomyApiError(requestError, '目录发布失败，请刷新编辑锁并重新检查快照。')
  }
  finally {
    publishing.value = false
  }
}

function itemParentLabel(item: TaxonomyCatalogItem) {
  if (!item.parentTermId) return '根词条'
  return catalog.value?.items.find(candidate => candidate.termId === item.parentTermId)?.displayName ?? item.parentTermId
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-TAX-03" :route="route.path" :title="`目录发布 · ${catalog?.versionCode || '加载中'}`" :description="`校验目录变更对资料、筛选和客户端兼容性的影响 · ${catalogId}`" :state="status === 'pending' ? '加载中' : error ? '加载失败' : catalog ? TAXONOMY_CATALOG_STATE_LABELS[catalog.state] : '正常'" :figma-state="error ? '未知引用' : catalog && !catalog.productionReady ? '待复核' : '正常'" :state-tone="error ? 'danger' : status === 'pending' ? 'warning' : catalog?.productionReady ? 'success' : 'info'">
      <template #actions>
        <span v-if="catalog" class="inline-flex min-h-10 items-center rounded-full px-3 text-xs font-medium ring-1 ring-inset" :class="catalog.productionReady ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-amber-50 text-amber-800 ring-amber-200'">{{ catalog.productionReady ? 'Production Ready' : '开发版本' }}</span>
        <NuxtLink to="/admin/app/taxonomy" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-[#eaded8] bg-white px-4 text-sm font-medium text-stone-700 hover:bg-[#fff7f2]">返回 Taxonomy 目录</NuxtLink>
      </template>
    </AdminAppPageHeader>

    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{{ taxonomyApiError(error, '目录快照加载失败。') }} <button type="button" class="ml-2 font-semibold underline" @click="refresh()">重试</button></div>
    <div v-if="status === 'pending'" class="rounded-xl border border-gray-200 bg-white px-5 py-14 text-center text-sm text-gray-500">正在读取不可变目录快照…</div>

    <template v-if="catalog">
      <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">快照条目</p><p class="mt-2 text-2xl font-bold text-gray-950">{{ catalog.itemCount }}</p><p class="mt-1 text-xs text-gray-500">锁版本 v{{ catalog.lockVersion }}</p></article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">新人物可选</p><p class="mt-2 text-2xl font-bold text-emerald-700">{{ itemCounts.profileEligible }}</p><p class="mt-1 text-xs text-gray-500">active + public + standard</p></article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">兼容条目</p><p class="mt-2 text-sm font-semibold text-gray-950">{{ itemCounts.deprecated }} 弃用 · {{ itemCounts.redirect }} 重定向</p><p class="mt-1 text-xs text-gray-500">客户端不得把 redirect 当新筛选项</p></article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">最低客户端</p><p class="mt-2 break-all font-mono text-lg font-bold text-gray-950">{{ catalog.minimumClientVersion }}</p><p class="mt-1 text-xs text-gray-500">计划生效：{{ formatTaxonomyDate(catalog.effectiveAt) }}</p></article>
      </div>

      <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <div class="flex flex-wrap items-start justify-between gap-3"><div><h2 class="text-base font-semibold text-gray-950">发布前检查与影响预览</h2><p class="mt-1 text-sm leading-6 text-gray-500">检查结果来自当前不可变快照；服务端发布时仍会校验状态、非空目录和编辑锁。</p></div><span class="rounded-full px-3 py-1 text-xs font-medium" :class="graphComplete && catalog.itemCount > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'">{{ graphComplete && catalog.itemCount > 0 ? '结构检查通过' : '存在阻断项' }}</span></div>
        <ul class="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
          <li class="rounded-lg border p-3 text-sm" :class="catalog.itemCount > 0 ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'"><span class="font-semibold">{{ catalog.itemCount > 0 ? '通过' : '阻断' }}：</span>目录包含 {{ catalog.itemCount }} 个快照条目。</li>
          <li class="rounded-lg border p-3 text-sm" :class="graphComplete ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'"><span class="font-semibold">{{ graphComplete ? '通过' : '阻断' }}：</span>父级与重定向目标引用{{ graphComplete ? '完整' : '不完整' }}。</li>
          <li class="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900"><span class="font-semibold">公开影响：</span>{{ itemCounts.active }} 个生效项；{{ itemCounts.nonPublic }} 个内部或受限项不会由公共目录返回。</li>
          <li class="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"><span class="font-semibold">客户端影响：</span>低于 {{ catalog.minimumClientVersion }} 的客户端不得选择该目录；发布本身不会修改 App 当前配置。</li>
        </ul>
        <div v-if="missingParentItems.length || missingRedirectItems.length" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800"><p class="font-semibold">结构阻断 ID</p><p v-if="missingParentItems.length" class="mt-1 break-all">缺失父级：{{ missingParentItems.map(item => item.termId).join('、') }}</p><p v-if="missingRedirectItems.length" class="mt-1 break-all">缺失重定向目标：{{ missingRedirectItems.map(item => item.termId).join('、') }}</p></div>
      </section>

      <section v-if="catalog.state === 'development'" class="min-w-0 rounded-xl border border-blue-200 bg-white p-4 sm:p-5">
        <h2 class="text-base font-semibold text-gray-950">提交目录发布</h2>
        <p class="mt-1 text-sm leading-6 text-gray-500">发布使用锁版本 v{{ catalog.lockVersion }} 防止重复或过期提交。发布后该快照不可修改，任何变化都必须生成新目录。</p>
        <div class="mt-4 space-y-3">
          <label class="flex items-start gap-2 rounded-lg border border-gray-200 p-3 text-sm leading-6 text-gray-700"><input v-model="immutableConfirmed" type="checkbox" class="mt-1" /><span>我已确认目录条目、父子关系、别名和重定向是本次要发布的不可变快照。</span></label>
          <label class="flex items-start gap-2 rounded-lg border border-gray-200 p-3 text-sm leading-6 text-gray-700"><input v-model="clientCompatibilityConfirmed" type="checkbox" class="mt-1" /><span>我已确认目标客户端支持目录类型与最低版本 {{ catalog.minimumClientVersion }}，不兼容客户端会保持 fail closed。</span></label>
          <label class="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950"><input v-model="productionReady" type="checkbox" class="mt-1" /><span><span class="font-semibold">允许 production 配置选择该目录</span><br />这只写入目录资格，不会修改环境开关或当前目录选择。</span></label>
          <label v-if="productionReady" class="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-900"><input v-model="productionConfirmed" type="checkbox" class="mt-1" /><span>我已单独复核真实目录、授权范围和客户端兼容性，确认将该快照标记为 Production Ready。</span></label>
        </div>
        <p v-if="publishError" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ publishError }}</p><p v-if="publishMessage" class="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{{ publishMessage }}</p>
        <div class="mt-4 flex flex-wrap items-center justify-between gap-3"><p class="text-xs leading-5 text-gray-500">重复提交会因目录已不可变或编辑锁变化被服务端拒绝。</p><button type="button" :disabled="publishing || !readyToPublish" class="min-h-11 rounded-lg bg-blue-700 px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" @click="publishCatalog">{{ publishing ? '发布中…' : '提交目录发布' }}</button></div>
      </section>

      <section v-else class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <h2 class="text-base font-semibold text-gray-950">已发布快照</h2>
        <p class="mt-1 text-sm leading-6 text-gray-600">发布人：管理员 #{{ catalog.publishedBy ?? '—' }} · 发布时间：{{ formatTaxonomyDate(catalog.publishedAt) }}。该快照只读，后续词条编辑不会改变它。</p>
        <div v-if="publishMessage" class="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{{ publishMessage }}</div>
        <div class="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950"><span class="font-semibold">回滚边界：</span>当前 Taxonomy-1 API 不支持修改或退役已发布快照，也没有伪回滚入口。需要回退时，应从修正后的稳定词条生成并发布新目录；待统一配置阶段再把当前目录显式切换到目标版本，并保留审计记录。</div>
      </section>

      <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div class="space-y-3 border-b border-gray-200 p-4 sm:p-5"><div><h2 class="text-base font-semibold text-gray-950">快照条目明细</h2><p class="mt-1 text-sm text-gray-500">当前显示 {{ filteredItems.length }} / {{ catalog.items.length }} 项；所有关联均按稳定 ID 展示。</p></div><form class="grid min-w-0 gap-3 md:grid-cols-[minmax(13rem,1fr)_12rem_12rem_auto_auto]" @submit.prevent="applyFilters"><input v-model="searchDraft" maxlength="80" placeholder="搜索名称、别名、slug 或 ID" class="min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /><select v-model="typeFilter" class="min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="">全部类型</option><option v-for="type in TAXONOMY_TYPES" :key="type" :value="type">{{ TAXONOMY_TYPE_LABELS[type] }}</option></select><select v-model="publicStateFilter" class="min-h-10 min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="">全部公开状态</option><option value="active">公开生效</option><option value="deprecated">公开弃用</option><option value="redirect">稳定重定向</option></select><button class="min-h-10 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white">应用</button><button type="button" class="min-h-10 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600" @click="clearFilters">清空</button></form></div>
        <div v-if="!filteredItems.length" class="px-5 py-12 text-center text-sm text-gray-500">当前筛选没有快照条目。</div>
        <div v-else class="w-full overflow-x-auto"><table class="w-full min-w-[980px] divide-y divide-gray-200 text-sm"><thead class="bg-gray-50 text-left text-xs font-medium text-gray-600"><tr><th class="px-4 py-3">类型 / 词条</th><th class="px-4 py-3">公开状态</th><th class="px-4 py-3">父级 / 重定向</th><th class="px-4 py-3">公开资格</th><th class="px-4 py-3">快照修订</th></tr></thead><tbody v-for="group in groupedItems" :key="group.type" class="divide-y divide-gray-100"><tr class="bg-gray-50/70"><td colspan="5" class="px-4 py-2 text-xs font-semibold text-gray-700">{{ TAXONOMY_TYPE_LABELS[group.type] }} · {{ group.items.length }} 项</td></tr><tr v-for="item in group.items" :key="item.termId" class="align-top hover:bg-gray-50"><td class="max-w-72 px-4 py-4"><NuxtLink :to="`/admin/app/taxonomy/${item.termId}`" class="break-words font-medium text-blue-600 hover:underline">{{ item.displayName }}</NuxtLink><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ item.termId }} · {{ item.slug }}</p><p v-if="item.aliases.length" class="mt-1 break-words text-xs text-gray-500">别名：{{ item.aliases.join('、') }}</p></td><td class="px-4 py-4"><span class="whitespace-nowrap rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="taxonomyStatusClass(item.publicState)">{{ TAXONOMY_PUBLIC_STATE_LABELS[item.publicState] }}</span></td><td class="max-w-64 px-4 py-4 text-xs leading-5 text-gray-600"><p class="break-all">父级：{{ itemParentLabel(item) }}</p><p v-if="item.redirectTargetTermId" class="mt-1 break-all text-blue-700">重定向：{{ item.redirectTargetTermId }}</p></td><td class="px-4 py-4 text-xs leading-5"><p :class="item.visibility === 'public' ? 'text-emerald-700' : 'text-gray-500'">{{ item.visibility === 'public' ? '公开' : '仅内部' }}</p><p :class="item.sensitivity === 'standard' ? 'text-emerald-700' : 'text-red-700'">{{ item.sensitivity === 'standard' ? '标准' : '受限' }}</p><p :class="item.allowedForProfile ? 'text-emerald-700' : 'text-gray-500'">{{ item.allowedForProfile ? '人物可选' : '人物不可选' }}</p></td><td class="whitespace-nowrap px-4 py-4 text-xs leading-5 text-gray-500"><p>词条 v{{ item.termVersion }}</p><p>排序 {{ item.sortOrder }}</p></td></tr></tbody></table></div>
      </section>
    </template>
  </div>
</template>
