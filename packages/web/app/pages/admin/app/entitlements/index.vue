<script setup lang="ts">
import type {
  MembershipCatalogDetail,
  MembershipCatalogSummary,
  MembershipEntitlementAvailability,
  MembershipEntitlementDefinition,
  MembershipEntitlementImpact,
  MembershipEntitlementValueType,
} from '~/types/admin-app-membership-catalog'
import {
  membershipIssueClass,
  MEMBERSHIP_CATALOG_STATE_LABELS,
  MEMBERSHIP_VALUE_TYPE_LABELS,
} from '~/types/admin-app-membership-catalog'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

interface EntitlementValueDraft {
  tierId: string
  tierName: string
  rank: number
  valueInput: string
  availability: MembershipEntitlementAvailability
}

const { api } = useApi()
const route = useRoute()
const router = useRouter()
const selectedCatalogId = ref(typeof route.query.catalog === 'string' ? route.query.catalog : '')
const search = ref('')
const typeFilter = ref<'' | MembershipEntitlementValueType>('')
const availabilityFilter = ref<'' | MembershipEntitlementAvailability>('')

const { data: listResponse, status: listStatus, error: listError, refresh: refreshCatalogs } = await useAsyncData(
  'admin-entitlement-catalog-list',
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
  error: detailError,
  refresh: refreshDetail,
} = await useAsyncData(
  () => `admin-entitlements-${selectedCatalogId.value || 'none'}`,
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
const definitions = computed(() => {
  const term = search.value.trim().toLocaleLowerCase('zh-CN')
  return (catalog.value?.definitions ?? []).filter((item) => {
    if (typeFilter.value && item.valueType !== typeFilter.value) return false
    if (availabilityFilter.value && !item.values.some(value => value.availability === availabilityFilter.value)) return false
    if (!term) return true
    return [item.key, item.displayName, item.description, item.clientCapability]
      .some(value => value.toLocaleLowerCase('zh-CN').includes(term))
  })
})

const selectedKey = ref('')
const selectedDefinition = computed(() => catalog.value?.definitions.find(item => item.key === selectedKey.value) ?? null)
const editing = ref(false)
const isNew = ref(false)
const saving = ref(false)
const operationError = ref('')
const operationMessage = ref('')
const saveKey = ref(newIdempotencyKey())
const impact = ref<MembershipEntitlementImpact | null>(null)
const impactLoading = ref(false)
const impactError = ref('')

const form = reactive({
  key: '',
  schemaVersion: 1,
  valueType: 'boolean' as MembershipEntitlementValueType,
  defaultInput: 'false',
  periodRule: '',
  clientCapability: '',
  displayName: '',
  description: '',
  unitLabel: '',
  changeSummary: '',
})
const valueDrafts = ref<EntitlementValueDraft[]>([])

watch(catalog, (value) => {
  if (!value) return
  if (!value.definitions.some(item => item.key === selectedKey.value)) {
    selectedKey.value = value.definitions[0]?.key ?? ''
  }
  if (!editing && selectedKey.value) loadDefinitionIntoForm(selectedDefinition.value)
}, { immediate: true })

watch(selectedKey, async () => {
  if (!editing) loadDefinitionIntoForm(selectedDefinition.value)
  await loadImpact()
})

async function selectCatalog(id: string) {
  selectedCatalogId.value = id
  selectedKey.value = ''
  editing.value = false
  isNew.value = false
  impact.value = null
  await router.replace({ query: { ...route.query, catalog: id } })
}

function handleCatalogChange(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLSelectElement)) return
  void selectCatalog(target.value)
}

function editDefinition(item: MembershipEntitlementDefinition) {
  selectedKey.value = item.key
  isNew.value = false
  editing.value = true
  operationError.value = ''
  operationMessage.value = ''
  saveKey.value = newIdempotencyKey()
  loadDefinitionIntoForm(item)
}

function startNew() {
  if (!catalog.value) return
  selectedKey.value = ''
  isNew.value = true
  editing.value = true
  operationError.value = ''
  operationMessage.value = ''
  impact.value = null
  saveKey.value = newIdempotencyKey()
  Object.assign(form, {
    key: '',
    schemaVersion: 1,
    valueType: 'boolean',
    defaultInput: 'false',
    periodRule: '',
    clientCapability: '',
    displayName: '',
    description: '',
    unitLabel: '',
    changeSummary: '',
  })
  valueDrafts.value = catalog.value.tiers.map(tier => ({
    tierId: tier.tierId,
    tierName: tier.displayName,
    rank: tier.rank,
    valueInput: 'false',
    availability: 'planned',
  }))
}

function cancelEdit() {
  editing.value = false
  isNew.value = false
  if (!selectedKey.value) selectedKey.value = catalog.value?.definitions[0]?.key ?? ''
  loadDefinitionIntoForm(selectedDefinition.value)
}

function loadDefinitionIntoForm(item: MembershipEntitlementDefinition | null) {
  if (!item || !catalog.value) return
  Object.assign(form, {
    key: item.key,
    schemaVersion: item.schemaVersion,
    valueType: item.valueType,
    defaultInput: displayValue(item.defaultValue),
    periodRule: item.periodRule ?? '',
    clientCapability: item.clientCapability,
    displayName: item.displayName,
    description: item.description,
    unitLabel: item.unitLabel ?? '',
    changeSummary: '',
  })
  const values = new Map(item.values.map(value => [value.tierId, value]))
  valueDrafts.value = catalog.value.tiers.map((tier) => {
    const current = values.get(tier.tierId)
    return {
      tierId: tier.tierId,
      tierName: tier.displayName,
      rank: tier.rank,
      valueInput: displayValue(current?.value ?? item.defaultValue),
      availability: current?.availability ?? 'planned',
    }
  })
}

function changeValueType() {
  const fallback = form.valueType === 'boolean' ? 'false' : form.valueType === 'integer' ? '0' : 'none'
  form.defaultInput = fallback
  valueDrafts.value = valueDrafts.value.map(item => ({ ...item, valueInput: fallback, availability: 'planned' }))
}

async function saveEntitlement() {
  if (!catalog.value) return
  operationError.value = ''
  operationMessage.value = ''
  saving.value = true
  try {
    const stableKey = form.key.trim()
    await api(`/api/admin/app/memberships/catalogs/${catalog.value.catalogVersionId}/entitlements/${encodeURIComponent(stableKey)}`, {
      method: 'PUT',
      headers: { 'Idempotency-Key': saveKey.value },
      body: {
        expectedVersion: catalog.value.lockVersion,
        schemaVersion: form.schemaVersion,
        valueType: form.valueType,
        defaultValue: parseValue(form.defaultInput, form.valueType, '安全默认值'),
        periodRule: form.periodRule.trim() || null,
        clientCapability: form.clientCapability.trim(),
        displayName: form.displayName.trim(),
        description: form.description.trim(),
        unitLabel: form.unitLabel.trim() || null,
        values: valueDrafts.value.map(item => ({
          tierId: item.tierId,
          value: parseValue(item.valueInput, form.valueType, `${item.tierName} 的值`),
          availability: item.availability,
        })),
        changeSummary: form.changeSummary.trim(),
      },
    })
    selectedKey.value = stableKey
    editing.value = false
    isNew.value = false
    saveKey.value = newIdempotencyKey()
    operationMessage.value = 'Entitlement 草稿已保存；Schema 和客户端兼容门禁已重新计算。'
    await Promise.all([refreshCatalogs(), refreshDetail()])
    await loadImpact()
  }
  catch (error) {
    operationError.value = resolveApiErrorMessage(error, 'Entitlement 保存失败，请检查稳定 key、类型和五级值。')
  }
  finally {
    saving.value = false
  }
}

async function loadImpact() {
  if (!selectedCatalogId.value || !selectedKey.value) {
    impact.value = null
    return
  }
  impactLoading.value = true
  impactError.value = ''
  try {
    const response = await api<{ data: MembershipEntitlementImpact }>(
      `/api/admin/app/memberships/catalogs/${selectedCatalogId.value}/entitlements/${encodeURIComponent(selectedKey.value)}/impact`,
    )
    impact.value = response.data
  }
  catch (error) {
    impactError.value = resolveApiErrorMessage(error, '影响范围加载失败。')
  }
  finally {
    impactLoading.value = false
  }
}

function parseValue(raw: string, type: MembershipEntitlementValueType, label: string) {
  if (type === 'boolean') {
    if (raw === 'true') return true
    if (raw === 'false') return false
    throw new Error(`${label}必须是 true 或 false`)
  }
  if (type === 'integer') {
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}必须是非负整数`)
    return value
  }
  const value = raw.trim()
  if (!value || Array.from(value).length > 64) throw new Error(`${label}必须是 1–64 字符的枚举值`)
  return value
}

function displayValue(value: boolean | number | string) {
  return String(value)
}

function newIdempotencyKey() {
  return `entitlement:${crypto.randomUUID()}`
}

function definitionAvailability(item: MembershipEntitlementDefinition) {
  const available = item.values.filter(value => value.availability === 'available').length
  return available === item.values.length ? '全部可执行' : available === 0 ? '全部规划中' : `${available}/${item.values.length} 可执行`
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <header class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
      <div class="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2 text-xs font-medium text-gray-500"><span class="rounded-full bg-violet-50 px-2.5 py-1 text-violet-700">ADM-MBR-02</span><span>Typed contract · 安全默认值</span></div>
          <h1 class="mt-3 text-xl font-semibold text-gray-950 sm:text-2xl">Entitlement 定义</h1>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-gray-600">维护稳定能力键、Schema 版本、客户端 capability 和五级显式值。未知能力可以保持 planned，但不能直接成为可执行权限。</p>
        </div>
        <button :disabled="!canEdit" class="w-full rounded-xl bg-gray-950 px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto" @click="startNew">新建 Entitlement</button>
      </div>
      <nav class="mt-5 flex min-w-0 gap-2 overflow-x-auto pb-1 text-sm"><NuxtLink :to="`/admin/app/membership/catalogs?catalog=${selectedCatalogId}`" class="shrink-0 rounded-full bg-gray-100 px-3 py-1.5 text-gray-700 hover:bg-gray-200">目录版本</NuxtLink><span class="shrink-0 rounded-full bg-gray-950 px-3 py-1.5 text-white">Entitlement 定义</span><NuxtLink class="shrink-0 rounded-full bg-gray-100 px-3 py-1.5 text-gray-700 hover:bg-gray-200" to="/admin/app/membership/applications">会员申请</NuxtLink><NuxtLink class="shrink-0 rounded-full bg-gray-100 px-3 py-1.5 text-gray-700 hover:bg-gray-200" to="/admin/app/membership/grants/new">会员发放</NuxtLink></nav>
    </header>

    <div v-if="operationMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800">{{ operationMessage }}</div>
    <div v-if="operationError" class="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm leading-6 text-rose-800">{{ operationError }}</div>

    <section class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <div class="grid min-w-0 gap-3 lg:grid-cols-[minmax(220px,1fr)_minmax(180px,0.6fr)_minmax(180px,0.6fr)_minmax(180px,0.6fr)]">
        <label class="min-w-0 text-sm text-gray-700">目录版本<select :value="selectedCatalogId" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 bg-white px-3 py-2.5" @change="handleCatalogChange"><option v-for="item in catalogs" :key="item.catalogVersionId" :value="item.catalogVersionId">{{ item.versionCode }} · {{ MEMBERSHIP_CATALOG_STATE_LABELS[item.state] }}</option></select></label>
        <label class="min-w-0 text-sm text-gray-700">搜索<input v-model.trim="search" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5" placeholder="能力键、名称、capability"></label>
        <label class="min-w-0 text-sm text-gray-700">值类型<select v-model="typeFilter" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 bg-white px-3 py-2.5"><option value="">全部类型</option><option value="boolean">布尔权限</option><option value="integer">整数额度</option><option value="enum">枚举档位</option></select></label>
        <label class="min-w-0 text-sm text-gray-700">执行状态<select v-model="availabilityFilter" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 bg-white px-3 py-2.5"><option value="">全部状态</option><option value="available">包含可执行值</option><option value="planned">包含规划值</option></select></label>
      </div>
      <div v-if="catalog" class="mt-4 flex min-w-0 flex-wrap items-center gap-2 text-xs text-gray-600"><span class="rounded-full bg-gray-100 px-2.5 py-1">{{ catalog.definitions.length }} 个稳定 key</span><span class="rounded-full bg-gray-100 px-2.5 py-1">lock {{ catalog.lockVersion }}</span><span v-if="catalog.activeRuntimeReference" class="rounded-full bg-blue-50 px-2.5 py-1 text-blue-700">当前环境引用</span><span v-if="!canEdit" class="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700">只读：运行引用、已发布、待复核或已有事实依赖</span></div>
    </section>

    <p v-if="listStatus === 'pending' || detailStatus === 'pending'" class="rounded-2xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">正在读取 Entitlement 契约…</p>
    <p v-else-if="listError || detailError" class="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-800">目录或 Entitlement 读取失败，请确认后续已应用 `0089` 数据结构。</p>

    <div v-else-if="catalog" class="grid min-w-0 gap-5 xl:grid-cols-[minmax(260px,0.72fr)_minmax(0,1.55fr)_minmax(260px,0.78fr)]">
      <aside class="min-w-0 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
        <div class="flex items-center justify-between gap-2 px-2 py-2"><h2 class="text-sm font-semibold text-gray-950">能力键</h2><span class="text-xs text-gray-500">{{ definitions.length }}</span></div>
        <div class="mt-1 max-h-[64rem] space-y-2 overflow-y-auto pr-1">
          <button v-for="item in definitions" :key="item.key" class="w-full min-w-0 rounded-xl border p-3 text-left transition" :class="selectedKey === item.key && !isNew ? 'border-gray-950 bg-gray-950 text-white' : 'border-gray-200 hover:border-gray-400'" @click="selectedKey = item.key; editing = false; isNew = false"><strong class="block break-all text-sm">{{ item.key }}</strong><span class="mt-1 block break-words text-xs" :class="selectedKey === item.key && !isNew ? 'text-white/75' : 'text-gray-500'">{{ item.displayName }} · {{ MEMBERSHIP_VALUE_TYPE_LABELS[item.valueType] }}</span><span class="mt-2 block text-[11px]" :class="selectedKey === item.key && !isNew ? 'text-white/70' : 'text-gray-500'">{{ definitionAvailability(item) }}</span></button>
          <p v-if="!definitions.length" class="px-2 py-8 text-center text-sm text-gray-500">没有匹配的能力键。</p>
        </div>
      </aside>

      <section aria-label="Entitlement 详情与编辑" class="min-w-0 space-y-5">
        <section v-if="editing" class="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
          <div class="flex min-w-0 flex-wrap items-start justify-between gap-3"><div><span class="text-xs text-gray-500">{{ isNew ? '新建稳定能力键' : '编辑草稿 Schema' }}</span><h2 class="mt-1 text-lg font-semibold text-gray-950">{{ isNew ? '新建 Entitlement' : form.key }}</h2></div><button class="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100" @click="cancelEdit">取消编辑</button></div>
          <form class="mt-5 space-y-5" @submit.prevent="saveEntitlement">
            <div class="grid min-w-0 gap-4 md:grid-cols-2">
              <label class="min-w-0 text-sm text-gray-700">稳定 key<input v-model.trim="form.key" :disabled="!isNew" required maxlength="80" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5 font-mono text-sm disabled:bg-gray-100" placeholder="feature.capability.max"></label>
              <label class="min-w-0 text-sm text-gray-700">客户端 capability<input v-model.trim="form.clientCapability" required maxlength="80" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5 font-mono text-sm" placeholder="feature.capability"></label>
              <label class="min-w-0 text-sm text-gray-700">值类型<select v-model="form.valueType" required class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 bg-white px-3 py-2.5" @change="changeValueType"><option value="boolean">boolean · 布尔权限</option><option value="integer">integer · 整数额度</option><option value="enum">enum · 枚举档位</option></select></label>
              <label class="min-w-0 text-sm text-gray-700">Schema 版本<input v-model.number="form.schemaVersion" required min="1" type="number" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5"></label>
              <label class="min-w-0 text-sm text-gray-700">安全默认值<select v-if="form.valueType === 'boolean'" v-model="form.defaultInput" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 bg-white px-3 py-2.5"><option value="false">false · 默认拒绝</option><option value="true">true</option></select><input v-else v-model.trim="form.defaultInput" :type="form.valueType === 'integer' ? 'number' : 'text'" required :min="form.valueType === 'integer' ? 0 : undefined" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5"></label>
              <label class="min-w-0 text-sm text-gray-700">周期规则<input v-model.trim="form.periodRule" maxlength="120" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5" placeholder="例如 daily:Asia/Shanghai；无周期留空"></label>
              <label class="min-w-0 text-sm text-gray-700">用户可见名称<input v-model.trim="form.displayName" required maxlength="48" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5"></label>
              <label class="min-w-0 text-sm text-gray-700">单位<input v-model.trim="form.unitLabel" maxlength="24" class="mt-1.5 w-full min-w-0 rounded-xl border border-gray-300 px-3 py-2.5" placeholder="个/日、天；无单位留空"></label>
              <label class="min-w-0 text-sm text-gray-700 md:col-span-2">用户可见说明<textarea v-model.trim="form.description" required maxlength="240" rows="3" class="mt-1.5 w-full min-w-0 resize-y rounded-xl border border-gray-300 px-3 py-2.5" /></label>
            </div>

            <div class="min-w-0"><div class="flex flex-wrap items-center justify-between gap-2"><div><h3 class="text-sm font-semibold text-gray-950">五级显式值</h3><p class="mt-1 text-xs text-gray-500">每个等级都必须有值；planned 不参与运行时授权。</p></div><span class="text-xs text-gray-500">{{ valueDrafts.length }} / 5</span></div><div class="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 2xl:grid-cols-5"><article v-for="item in valueDrafts" :key="item.tierId" class="min-w-0 rounded-xl border border-gray-200 bg-gray-50 p-3"><span class="text-xs text-gray-500">rank {{ item.rank }}</span><strong class="mt-1 block break-words text-sm text-gray-950">{{ item.tierName }}</strong><label class="mt-3 block text-xs text-gray-600">值<select v-if="form.valueType === 'boolean'" v-model="item.valueInput" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm"><option value="false">false</option><option value="true">true</option></select><input v-else v-model.trim="item.valueInput" :type="form.valueType === 'integer' ? 'number' : 'text'" :min="form.valueType === 'integer' ? 0 : undefined" required class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm"></label><label class="mt-3 block text-xs text-gray-600">状态<select v-model="item.availability" class="mt-1 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm"><option value="planned">planned · 不执行</option><option value="available">available · 可执行</option></select></label></article></div></div>

            <label class="block text-sm text-gray-700">本次变更摘要<textarea v-model.trim="form.changeSummary" required maxlength="500" rows="3" class="mt-1.5 w-full min-w-0 resize-y rounded-xl border border-gray-300 px-3 py-2.5" placeholder="说明 Schema、五级值和客户端兼容影响。" /></label>
            <div class="flex min-w-0 flex-wrap justify-end gap-2"><button type="button" class="w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm sm:w-auto" @click="cancelEdit">取消</button><button :disabled="saving || !canEdit" class="w-full rounded-xl bg-gray-950 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40 sm:w-auto">{{ saving ? '保存并校验中…' : '保存 Entitlement 草稿' }}</button></div>
          </form>
        </section>

        <section v-else-if="selectedDefinition" class="min-w-0 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-6">
          <div class="flex min-w-0 flex-wrap items-start justify-between gap-3"><div class="min-w-0"><span class="text-xs text-gray-500">Schema v{{ selectedDefinition.schemaVersion }} · {{ MEMBERSHIP_VALUE_TYPE_LABELS[selectedDefinition.valueType] }}</span><h2 class="mt-1 break-all text-lg font-semibold text-gray-950">{{ selectedDefinition.key }}</h2><p class="mt-2 text-sm leading-6 text-gray-600">{{ selectedDefinition.description }}</p></div><button :disabled="!canEdit" class="w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm disabled:opacity-40 sm:w-auto" @click="editDefinition(selectedDefinition)">编辑草稿</button></div>
          <dl class="mt-5 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3"><div class="rounded-xl bg-gray-50 p-3"><dt class="text-xs text-gray-500">安全默认值</dt><dd class="mt-1 break-all text-sm font-medium text-gray-900">{{ selectedDefinition.defaultValue }}</dd></div><div class="rounded-xl bg-gray-50 p-3"><dt class="text-xs text-gray-500">客户端 capability</dt><dd class="mt-1 break-all font-mono text-xs font-medium text-gray-900">{{ selectedDefinition.clientCapability }}</dd></div><div class="rounded-xl bg-gray-50 p-3"><dt class="text-xs text-gray-500">周期 / 单位</dt><dd class="mt-1 break-words text-sm font-medium text-gray-900">{{ selectedDefinition.periodRule || '无周期' }} · {{ selectedDefinition.unitLabel || '无单位' }}</dd></div></dl>
          <div class="mt-5 overflow-x-auto rounded-xl border border-gray-200"><table class="min-w-[700px] w-full text-left text-sm"><thead class="bg-gray-50 text-xs text-gray-500"><tr><th class="px-4 py-3 font-medium">等级</th><th class="px-4 py-3 font-medium">rank</th><th class="px-4 py-3 font-medium">值</th><th class="px-4 py-3 font-medium">availability</th></tr></thead><tbody class="divide-y divide-gray-100"><tr v-for="tier in catalog.tiers" :key="tier.tierId"><td class="px-4 py-3 font-medium text-gray-900">{{ tier.displayName }}</td><td class="px-4 py-3 text-gray-600">{{ tier.rank }}</td><td class="px-4 py-3 break-all text-gray-900">{{ selectedDefinition.values.find(value => value.tierId === tier.tierId)?.value ?? '缺失' }}</td><td class="px-4 py-3"><span class="rounded-full px-2 py-1 text-xs" :class="selectedDefinition.values.find(value => value.tierId === tier.tierId)?.availability === 'available' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'">{{ selectedDefinition.values.find(value => value.tierId === tier.tierId)?.availability ?? 'missing' }}</span></td></tr></tbody></table></div>
        </section>
        <section v-else class="rounded-2xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500 shadow-sm">选择一个能力键，或新建 Entitlement。</section>
      </section>

      <aside class="min-w-0 space-y-5">
        <section class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between gap-2"><h2 class="text-sm font-semibold text-gray-950">影响查询</h2><button v-if="selectedKey" :disabled="impactLoading" class="rounded-lg px-2 py-1 text-xs text-gray-600 hover:bg-gray-100" @click="loadImpact">刷新</button></div>
          <p v-if="impactLoading" class="py-6 text-center text-sm text-gray-500">正在核对引用…</p><p v-else-if="impactError" class="mt-3 rounded-xl bg-rose-50 px-3 py-3 text-sm text-rose-700">{{ impactError }}</p>
          <template v-else-if="impact"><div class="mt-4 grid grid-cols-2 gap-2 text-center"><div class="rounded-xl bg-gray-50 p-3"><strong class="block text-lg text-gray-950">{{ impact.availableTierCount }}/{{ impact.affectedTierCount }}</strong><span class="text-xs text-gray-500">可执行等级</span></div><div class="rounded-xl bg-gray-50 p-3"><strong class="block text-lg text-gray-950">{{ impact.grants.active }}</strong><span class="text-xs text-gray-500">有效 grant</span></div></div><div class="mt-4 rounded-xl border px-3 py-3 text-sm" :class="impact.knownClientCapability ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-amber-200 bg-amber-50 text-amber-800'">{{ impact.knownClientCapability ? '客户端 capability 已登记' : '未知 capability：只有 planned 状态安全' }}</div><div class="mt-4"><span class="text-xs text-gray-500">服务端依赖</span><ul class="mt-2 space-y-2 text-sm text-gray-700"><li v-for="item in impact.dependencies" :key="item" class="rounded-lg bg-gray-50 px-3 py-2">{{ item }}</li></ul></div><div v-if="impact.baseDifference" class="mt-4 rounded-xl border border-gray-200 p-3 text-sm"><span class="text-xs text-gray-500">相对基线</span><p class="mt-1 text-gray-700">{{ impact.baseDifference.fields.length }} 个 Schema 字段、{{ impact.baseDifference.tierValueChangeCount }} 个等级值变化</p></div></template>
          <p v-else class="py-6 text-center text-sm text-gray-500">选择能力键后显示客户端、服务端和 grant 影响。</p>
        </section>

        <section class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"><div class="flex items-center justify-between gap-2"><h2 class="text-sm font-semibold text-gray-950">相关校验</h2><span class="text-xs text-gray-500">{{ catalog.validation.issues.filter(issue => !selectedKey || issue.scope === selectedKey || issue.scope.startsWith(`${selectedKey}:`)).length }}</span></div><div class="mt-3 max-h-[34rem] space-y-2 overflow-y-auto"><div v-for="issue in catalog.validation.issues.filter(issue => !selectedKey || issue.scope === selectedKey || issue.scope.startsWith(`${selectedKey}:`))" :key="`${issue.code}:${issue.scope}`" class="rounded-xl border px-3 py-3" :class="membershipIssueClass(issue.severity)"><strong class="break-all text-xs">{{ issue.code }}</strong><p class="mt-1 text-sm leading-6">{{ issue.message }}</p></div><p v-if="!catalog.validation.issues.some(issue => !selectedKey || issue.scope === selectedKey || issue.scope.startsWith(`${selectedKey}:`))" class="py-6 text-center text-sm text-gray-500">当前能力键没有校验问题。</p></div></section>
      </aside>
    </div>
  </div>
</template>
