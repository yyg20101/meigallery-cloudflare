<script setup lang="ts">
import type { RecommendationPlacement } from '~/types/admin-app-recommendations'
import {
  RECOMMENDATION_STATE_LABELS,
  formatRecommendationDate,
  newRecommendationIdempotencyKey,
  recommendationApiError,
  recommendationStateClass,
} from '~/types/admin-app-recommendations'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()
const stateFilter = ref('')
const selectedId = ref('')
const selected = ref<RecommendationPlacement | null>(null)
const detailLoading = ref(false)
const showCreate = ref(false)
const operation = ref('')
const operationError = ref('')
const operationMessage = ref('')
const reason = ref('')
const decision = ref<'approve' | 'reject'>('approve')
const createForm = reactive({ profileId: '', priority: 100, regionCode: '', reason: '', startsAt: '', endsAt: '' })
const editForm = reactive({ profileId: '', priority: 100, regionCode: '', reason: '', startsAt: '', endsAt: '' })

const { data, status, error, refresh } = await useAsyncData(
  'admin-recommendation-placements',
  () => api<{ data: RecommendationPlacement[] }>('/api/admin/app/recommendations/placements', {
    query: { state: stateFilter.value || undefined },
  }),
  { watch: [stateFilter] },
)

const placements = computed(() => data.value?.data ?? [])

watch(selected, (value) => {
  if (!value) return
  Object.assign(editForm, {
    profileId: value.profileId,
    priority: value.priority,
    regionCode: value.regionCode ?? '',
    reason: value.reason,
    startsAt: toDateTimeLocal(value.startsAt),
    endsAt: toDateTimeLocal(value.endsAt),
  })
})

async function loadDetail(placementId: string) {
  selectedId.value = placementId
  detailLoading.value = true
  operationError.value = ''
  operationMessage.value = ''
  try {
    const response = await api<{ data: RecommendationPlacement }>(`/api/admin/app/recommendations/placements/${placementId}`)
    selected.value = response.data
  }
  catch (requestError) {
    operationError.value = recommendationApiError(requestError, '运营精选详情加载失败。')
  }
  finally {
    detailLoading.value = false
  }
}

async function refreshAll() {
  await refresh()
  if (selectedId.value) await loadDetail(selectedId.value)
}

async function createPlacement() {
  operation.value = 'create'
  operationError.value = ''
  try {
    const response = await api<{ data: { placement: RecommendationPlacement } }>('/api/admin/app/recommendations/placements', {
      method: 'POST',
      headers: { 'Idempotency-Key': newRecommendationIdempotencyKey('placement') },
      body: placementBody(createForm),
    })
    showCreate.value = false
    await refresh()
    await loadDetail(response.data.placement.placementId)
    operationMessage.value = '运营精选排期草稿已创建。'
  }
  catch (requestError) {
    operationError.value = recommendationApiError(requestError, '运营精选排期创建失败，请检查真人资料 ID 和时间范围。')
  }
  finally {
    operation.value = ''
  }
}

async function savePlacement() {
  if (!selected.value || selected.value.state !== 'draft') return
  operation.value = 'save'
  operationError.value = ''
  operationMessage.value = ''
  try {
    await api(`/api/admin/app/recommendations/placements/${selected.value.placementId}`, {
      method: 'PATCH',
      body: { expectedVersion: selected.value.version, ...placementBody(editForm) },
    })
    operationMessage.value = '排期草稿已保存。'
    await refreshAll()
  }
  catch (requestError) {
    operationError.value = recommendationApiError(requestError, '排期保存失败，请刷新版本后重试。')
  }
  finally {
    operation.value = ''
  }
}

async function mutate(action: 'submit' | 'decision' | 'activate' | 'pause') {
  if (!selected.value) return
  operationError.value = ''
  operationMessage.value = ''
  if (!reason.value.trim()) {
    operationError.value = '请填写本次操作原因。'
    return
  }
  if (['activate', 'pause'].includes(action) && import.meta.client) {
    if (!window.confirm(`确认${action === 'activate' ? '启用' : '暂停'}这条运营精选排期？`)) return
  }
  operation.value = action
  try {
    await api(`/api/admin/app/recommendations/placements/${selected.value.placementId}/${action}`, {
      method: 'POST',
      body: {
        expectedVersion: selected.value.version,
        reason: reason.value.trim(),
        ...(action === 'decision' ? { decision: decision.value } : {}),
      },
    })
    reason.value = ''
    operationMessage.value = '排期状态已更新。'
    await refreshAll()
  }
  catch (requestError) {
    operationError.value = recommendationApiError(requestError, '状态操作失败，请检查公开资格、排期冲突和复核权限。')
  }
  finally {
    operation.value = ''
  }
}

function placementBody(value: typeof createForm) {
  return {
    profileId: value.profileId,
    priority: value.priority,
    regionCode: value.regionCode || null,
    reason: value.reason,
    startsAt: toIso(value.startsAt),
    endsAt: toIso(value.endsAt),
  }
}

function toDateTimeLocal(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function toIso(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-REC-04" route="/admin/app/recommendation/placements" title="运营精选" description="配置精选位置、时间和用户可见披露，并在生效前复核公开资格。" :state="error ? '加载失败' : status === 'pending' ? '加载中' : '正常'" figma-state="正常" :state-tone="error ? 'danger' : status === 'pending' ? 'warning' : 'success'">
      <template #actions><NuxtLink to="/admin/app/recommendation/rules" class="inline-flex min-h-10 items-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700">返回规则</NuxtLink><button class="inline-flex min-h-10 items-center justify-center rounded-[10px] bg-[#d63363] px-4 text-sm font-medium text-white hover:bg-[#bd2756]" @click="showCreate = !showCreate">{{ showCreate ? '收起创建表单' : '创建排期' }}</button></template>
    </AdminAppPageHeader>

    <div class="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm leading-6 text-rose-950"><span class="font-semibold">不可隐藏的披露：</span>所有精选项固定显示“平台精选”，运营原因不会替代用户可见披露。排期生效时再次校验授权、认证、发布和来源图库状态。</div>
    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{{ recommendationApiError(error, '运营精选列表加载失败。') }} <button class="ml-2 font-semibold underline" @click="refresh()">重试</button></div>

    <form v-if="showCreate" class="min-w-0 space-y-4 rounded-xl border border-gray-200 bg-white p-4 sm:p-5" @submit.prevent="createPlacement">
      <div><h2 class="text-base font-semibold text-gray-950">新建排期草稿</h2><p class="mt-1 text-sm text-gray-500">提交复核前会检查目标资料公开资格和重叠排期。</p></div>
      <div class="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">真人资料 ID</span><input v-model.trim="createForm.profileId" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" placeholder="pp_…" /></label>
        <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">优先级</span><input v-model.number="createForm.priority" type="number" min="1" max="1000" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
        <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">地区代码</span><input v-model.trim="createForm.regionCode" maxlength="32" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="留空为全局" /></label>
        <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">开始时间</span><input v-model="createForm.startsAt" type="datetime-local" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
        <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">结束时间</span><input v-model="createForm.endsAt" type="datetime-local" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
        <label class="min-w-0 md:col-span-2 xl:col-span-3"><span class="mb-1 block text-sm font-medium text-gray-700">运营原因</span><textarea v-model.trim="createForm.reason" maxlength="500" rows="3" required class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="记录选取依据，不会作为用户侧披露文案" /></label>
      </div>
      <div class="flex justify-end"><button :disabled="operation === 'create'" class="min-h-10 rounded-lg bg-gray-950 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{{ operation === 'create' ? '创建中…' : '创建草稿' }}</button></div>
    </form>

    <div class="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-4">
        <label class="min-w-52 flex-1"><span class="mb-1 block text-xs font-medium text-gray-500">状态</span><select v-model="stateFilter" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="">全部状态</option><option value="draft">草稿</option><option value="pending_review">待复核</option><option value="approved">已批准</option><option value="scheduled">待生效</option><option value="active">生效中</option><option value="paused">已暂停</option><option value="expired">已过期</option><option value="retired">已退役</option></select></label>
      <button :disabled="status === 'pending'" class="min-h-10 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50" @click="refreshAll">刷新</button>
    </div>

    <div class="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]">
      <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div v-if="status === 'pending'" class="px-5 py-12 text-center text-sm text-gray-500">正在加载排期…</div>
        <div v-else-if="!placements.length" class="px-5 py-12 text-center"><h2 class="text-base font-semibold text-gray-900">没有匹配的排期</h2><p class="mt-2 text-sm text-gray-500">创建一条精选排期草稿开始运营流程。</p></div>
        <div v-else class="w-full overflow-x-auto"><table class="w-full min-w-[850px] divide-y divide-gray-200 text-sm"><thead class="bg-gray-50 text-left text-xs font-medium text-gray-600"><tr><th class="px-4 py-3">资料 / 披露</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">范围</th><th class="px-4 py-3">排期</th><th class="px-4 py-3 text-right">操作</th></tr></thead><tbody class="divide-y divide-gray-100"><tr v-for="item in placements" :key="item.placementId" class="align-top" :class="selectedId === item.placementId ? 'bg-blue-50/60' : 'hover:bg-gray-50/70'"><td class="max-w-72 px-4 py-4"><p class="break-all font-mono text-xs text-gray-700">{{ item.profileId }}</p><span class="mt-2 inline-flex rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-700 ring-1 ring-rose-200">{{ item.disclosure.label }}</span></td><td class="px-4 py-4"><span class="inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="recommendationStateClass(item.state)">{{ RECOMMENDATION_STATE_LABELS[item.state] || item.state }}</span></td><td class="px-4 py-4 text-xs leading-5 text-gray-600"><p>{{ item.regionCode || '全部地区' }}</p><p>优先级 {{ item.priority }}</p></td><td class="whitespace-nowrap px-4 py-4 text-xs leading-5 text-gray-600"><p>{{ formatRecommendationDate(item.startsAt) }}</p><p>至 {{ formatRecommendationDate(item.endsAt) }}</p></td><td class="px-4 py-4 text-right"><button class="font-medium text-blue-600 hover:underline" @click="loadDetail(item.placementId)">查看与处理</button></td></tr></tbody></table></div>
      </section>

      <aside class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <div v-if="detailLoading" class="py-14 text-center text-sm text-gray-500">正在加载排期详情…</div>
        <div v-else-if="!selected" class="py-14 text-center"><h2 class="text-base font-semibold text-gray-900">选择一条排期</h2><p class="mt-2 text-sm text-gray-500">查看公开资格、编辑草稿或完成状态操作。</p></div>
        <template v-else>
          <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><h2 class="text-base font-semibold text-gray-950">排期详情</h2><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ selected.placementId }} · 编辑锁 v{{ selected.version }}</p></div><span class="shrink-0 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="recommendationStateClass(selected.state)">{{ RECOMMENDATION_STATE_LABELS[selected.state] }}</span></div>
          <div class="mt-4 rounded-lg p-3 text-sm" :class="selected.eligibility?.eligible ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'"><span class="font-semibold">当前公开资格：</span>{{ selected.eligibility?.eligible ? '满足' : '不满足' }}<p class="mt-1 text-xs">检查时间：{{ formatRecommendationDate(selected.eligibility?.checkedAt) }}</p></div>
          <form class="mt-4 min-w-0 space-y-3" @submit.prevent="savePlacement">
            <fieldset :disabled="selected.state !== 'draft' || Boolean(operation)" class="min-w-0 space-y-3 disabled:opacity-70">
              <label class="block min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">真人资料 ID</span><input v-model.trim="editForm.profileId" required class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
              <div class="grid min-w-0 gap-3 sm:grid-cols-2"><label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">优先级</span><input v-model.number="editForm.priority" type="number" min="1" max="1000" required class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label><label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">地区</span><input v-model.trim="editForm.regionCode" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="全部地区" /></label></div>
              <label class="block min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">运营原因</span><textarea v-model.trim="editForm.reason" required maxlength="500" rows="3" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
              <div class="grid min-w-0 gap-3 sm:grid-cols-2"><label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">开始</span><input v-model="editForm.startsAt" type="datetime-local" required class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label><label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">结束</span><input v-model="editForm.endsAt" type="datetime-local" required class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label></div>
            </fieldset>
            <button v-if="selected.state === 'draft'" :disabled="Boolean(operation)" class="min-h-10 w-full rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{{ operation === 'save' ? '保存中…' : '保存草稿' }}</button>
          </form>
          <div class="my-5 border-t border-gray-200" />
          <h3 class="text-sm font-semibold text-gray-950">流程操作</h3><p class="mt-1 text-xs leading-5 text-gray-500">创建人与 Owner 复核人必须分离；启用前再次检查公开资格、结束时间和排期冲突。已暂停排期不可原地复用，需要创建并复核新排期。</p>
          <label class="mt-3 block min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">操作原因</span><textarea v-model.trim="reason" maxlength="500" rows="3" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          <label v-if="selected.state === 'pending_review'" class="mt-3 block min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">复核决定</span><select v-model="decision" :disabled="!isOwner" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"><option value="approve">批准</option><option value="reject">退回草稿</option></select></label>
          <p v-if="operationError" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ operationError }}</p><p v-if="operationMessage" class="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{{ operationMessage }}</p>
          <div class="mt-3 flex flex-wrap gap-2"><button v-if="selected.state === 'draft'" :disabled="Boolean(operation)" class="min-h-10 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="mutate('submit')">提交复核</button><button v-if="selected.state === 'pending_review'" :disabled="Boolean(operation) || !isOwner" class="min-h-10 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="mutate('decision')">记录决定</button><button v-if="['approved', 'scheduled'].includes(selected.state)" :disabled="Boolean(operation) || !isOwner" class="min-h-10 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="mutate('activate')">启用排期</button><button v-if="['active', 'scheduled'].includes(selected.state)" :disabled="Boolean(operation) || !isOwner" class="min-h-10 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50" @click="mutate('pause')">暂停排期</button></div>
        </template>
      </aside>
    </div>
  </div>
</template>
