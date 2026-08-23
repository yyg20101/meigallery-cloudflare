<script setup lang="ts">
import type { RecommendationRuleDetail } from '~/types/admin-app-recommendations'
import {
  RECOMMENDATION_ACTION_LABELS,
  RECOMMENDATION_STATE_LABELS,
  formatRecommendationDate,
  newRecommendationIdempotencyKey,
  recommendationApiError,
} from '~/types/admin-app-recommendations'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const { isOwner } = useAuth()
const ruleVersionId = computed(() => String(route.params.ruleVersionId || ''))
const operation = ref('')
const operationError = ref('')
const operationMessage = ref('')
const reason = ref('')
const decision = ref<'approve' | 'reject'>('approve')
const form = reactive({
  name: '',
  description: '',
  taxonomyCatalogId: '',
  heatVersionId: '',
  quality: 0,
  heat: 0,
  freshness: 0,
  region: 0,
  preferredTaxonomy: 0,
  targetRegions: '',
  maxConsecutiveSameRegion: 3,
  maxConsecutiveSameTerm: 3,
  repeatExposureCap: 3,
  rolloutPercent: 0,
  minimumClientVersion: '1.0',
  effectiveAt: '',
  expiresAt: '',
  rollbackRuleVersionId: '',
})

const { data, status, error, refresh } = await useAsyncData(
  () => `admin-recommendation-rule-${ruleVersionId.value}`,
  () => api<{ data: RecommendationRuleDetail }>(`/api/admin/app/recommendations/rules/${ruleVersionId.value}`),
)

const rule = computed(() => data.value?.data ?? null)
const editable = computed(() => rule.value?.state === 'draft')
const weightTotal = computed(() => form.quality + form.heat + form.freshness + form.region + form.preferredTaxonomy)

watch(rule, (value) => {
  if (!value) return
  Object.assign(form, {
    name: value.name,
    description: value.description ?? '',
    taxonomyCatalogId: value.taxonomyCatalogId ?? '',
    heatVersionId: value.heatVersionId ?? '',
    quality: value.weights.quality,
    heat: value.weights.heat,
    freshness: value.weights.freshness,
    region: value.weights.region,
    preferredTaxonomy: value.weights.preferredTaxonomy,
    targetRegions: value.targetRegionCodes.join(', '),
    maxConsecutiveSameRegion: value.diversity.maxConsecutiveSameRegion,
    maxConsecutiveSameTerm: value.diversity.maxConsecutiveSameTerm,
    repeatExposureCap: value.diversity.repeatExposureCap,
    rolloutPercent: value.rolloutPercent,
    minimumClientVersion: value.minimumClientVersion,
    effectiveAt: toDateTimeLocal(value.effectiveAt),
    expiresAt: toDateTimeLocal(value.expiresAt),
    rollbackRuleVersionId: value.rollbackRuleVersionId ?? '',
  })
}, { immediate: true })

async function saveDraft() {
  if (!rule.value || !editable.value) return
  operationError.value = ''
  operationMessage.value = ''
  if (weightTotal.value !== 100) {
    operationError.value = '五项权重之和必须等于 100。'
    return
  }
  operation.value = 'save'
  try {
    await api(`/api/admin/app/recommendations/rules/${ruleVersionId.value}`, {
      method: 'PATCH',
      body: {
        expectedVersion: rule.value.version,
        name: form.name,
        description: form.description || null,
        taxonomyCatalogId: form.taxonomyCatalogId || null,
        heatVersionId: form.heatVersionId || null,
        weights: {
          quality: form.quality,
          heat: form.heat,
          freshness: form.freshness,
          region: form.region,
          preferredTaxonomy: form.preferredTaxonomy,
        },
        targetRegionCodes: form.targetRegions.split(/[,，\s]+/u).map(item => item.trim()).filter(Boolean),
        maxConsecutiveSameRegion: form.maxConsecutiveSameRegion,
        maxConsecutiveSameTerm: form.maxConsecutiveSameTerm,
        repeatExposureCap: form.repeatExposureCap,
        rolloutPercent: form.rolloutPercent,
        minimumClientVersion: form.minimumClientVersion,
        effectiveAt: toIso(form.effectiveAt),
        expiresAt: toIso(form.expiresAt),
        rollbackRuleVersionId: form.rollbackRuleVersionId || null,
      },
    })
    operationMessage.value = '草稿已保存，历史 Dry-run 结果已按契约失效。'
    await refresh()
  }
  catch (requestError) {
    operationError.value = recommendationApiError(requestError, '草稿保存失败，请刷新版本后重试。')
  }
  finally {
    operation.value = ''
  }
}

async function copyRule() {
  if (!rule.value) return
  operation.value = 'copy'
  operationError.value = ''
  try {
    const response = await api<{ data: { rule: RecommendationRuleDetail } }>(`/api/admin/app/recommendations/rules/${ruleVersionId.value}/copy`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newRecommendationIdempotencyKey('copy') },
    })
    await navigateTo(`/admin/app/recommendation/rules/${response.data.rule.ruleVersionId}`)
  }
  catch (requestError) {
    operationError.value = recommendationApiError(requestError, '规则复制失败。')
  }
  finally {
    operation.value = ''
  }
}

async function mutate(action: 'submit' | 'decision' | 'activate' | 'pause' | 'rollback') {
  if (!rule.value) return
  operationError.value = ''
  operationMessage.value = ''
  if (!reason.value.trim()) {
    operationError.value = '请填写本次操作原因，便于复核和审计。'
    return
  }
  if ((action === 'activate' || action === 'pause' || action === 'rollback') && import.meta.client) {
    const label = {
      activate: '启用',
      pause: '暂停',
      rollback: '回滚',
    }[action]
    if (!window.confirm(`确认${label}当前推荐规则？该操作会改变版本化推荐运行状态。`)) return
  }
  operation.value = action
  try {
    await api(`/api/admin/app/recommendations/rules/${ruleVersionId.value}/${action}`, {
      method: 'POST',
      body: {
        expectedVersion: rule.value.version,
        reason: reason.value.trim(),
        ...(action === 'decision' ? { decision: decision.value } : {}),
      },
    })
    operationMessage.value = '状态操作已完成。'
    reason.value = ''
    await refresh()
  }
  catch (requestError) {
    operationError.value = recommendationApiError(requestError, '状态操作失败，请刷新版本并检查操作权限。')
  }
  finally {
    operation.value = ''
  }
}

function toDateTimeLocal(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function toIso(value: string) {
  if (!value) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-REC-02" :route="`/admin/app/recommendation/rules/${ruleVersionId}`" title="推荐规则编辑" :description="rule ? `${rule.name} · 编辑锁 v${rule.version}` : '配置候选、排序、多样性与灰度，并提交独立审核。'" :state="error ? '加载失败' : status === 'pending' ? '加载中' : rule ? (RECOMMENDATION_STATE_LABELS[rule.state] || rule.state) : '正常'" :figma-state="error ? 'Schema 错误' : '正常'" :state-tone="error ? 'danger' : status === 'pending' ? 'warning' : 'success'">
      <template #actions>
        <NuxtLink to="/admin/app/recommendation/rules" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700">返回规则列表</NuxtLink>
        <NuxtLink :to="`/admin/app/recommendation/rules/${ruleVersionId}/preview`" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Dry-run 预览</NuxtLink>
        <button v-if="rule" class="min-h-10 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50" :disabled="Boolean(operation)" @click="copyRule">复制新版本</button>
      </template>
    </AdminAppPageHeader>

    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{{ recommendationApiError(error, '推荐规则加载失败。') }} <button class="ml-2 font-semibold underline" @click="refresh()">重试</button></div>
    <div v-if="status === 'pending'" class="rounded-xl border border-gray-200 bg-white px-5 py-14 text-center text-sm text-gray-500">正在加载规则工作台…</div>

    <template v-if="rule">
      <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">规则版本</p><p class="mt-2 text-lg font-bold text-gray-950">v{{ rule.versionNumber }}</p><p class="mt-1 text-xs text-gray-500">编辑锁 v{{ rule.version }}</p></article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">运行模式</p><p class="mt-2 text-sm font-semibold text-gray-950">{{ rule.mode === 'personalized' ? '个性化' : '非个性化' }}</p><p class="mt-1 text-xs text-gray-500">入口：发现首页</p></article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">灰度范围</p><p class="mt-2 text-lg font-bold text-gray-950">{{ rule.rolloutPercent }}%</p><p class="mt-1 text-xs text-gray-500">{{ rule.targetRegionCodes.length ? rule.targetRegionCodes.join('、') : '全部地区' }}</p></article>
        <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">最近 Dry-run</p><p class="mt-2 text-sm font-semibold" :class="rule.lastDryRun && !rule.lastDryRun.emptyResultRisk ? 'text-emerald-700' : 'text-amber-700'">{{ rule.lastDryRun ? `${rule.lastDryRun.candidateCount} 个候选` : '尚未执行' }}</p><p class="mt-1 text-xs text-gray-500">{{ formatRecommendationDate(rule.lastDryRunAt) }}</p></article>
      </div>

      <div v-if="rule.mode === 'personalized'" class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"><span class="font-semibold">个性化保护：</span>当前可编辑和 Dry-run，但 OQ-023 未批准时服务端拒绝启用；不得通过修改前端绕过。</div>

      <form class="min-w-0 space-y-5 rounded-xl border border-gray-200 bg-white p-4 sm:p-5" @submit.prevent="saveDraft">
        <div class="flex flex-wrap items-start justify-between gap-3"><div><h2 class="text-base font-semibold text-gray-950">规则定义</h2><p class="mt-1 text-sm text-gray-500">{{ editable ? '当前为草稿，可保存修改。' : '规则已进入流程，只读展示；需要修改请复制新版本。' }}</p></div><span v-if="!rule.productionReady" class="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 ring-1 ring-amber-200">开发版本 · 禁止生产</span></div>
        <fieldset :disabled="!editable || Boolean(operation)" class="min-w-0 space-y-4 disabled:opacity-75">
          <div class="grid min-w-0 gap-4 md:grid-cols-2">
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">规则名称</span><input v-model.trim="form.name" required maxlength="80" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">最低客户端版本</span><input v-model.trim="form.minimumClientVersion" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0 md:col-span-2"><span class="mb-1 block text-sm font-medium text-gray-700">说明</span><textarea v-model.trim="form.description" maxlength="500" rows="3" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">taxonomy 目录 ID</span><input v-model.trim="form.taxonomyCatalogId" :required="rule.mode === 'personalized'" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">热度版本 ID</span><input v-model.trim="form.heatVersionId" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" /></label>
          </div>
          <div class="min-w-0 rounded-xl border border-gray-200 p-4"><div class="flex items-center justify-between gap-3"><h3 class="text-sm font-semibold text-gray-900">排序权重</h3><span class="text-xs font-medium" :class="weightTotal === 100 ? 'text-emerald-700' : 'text-red-700'">合计 {{ weightTotal }}%</span></div><div class="mt-3 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-5"><label v-for="field in ([['quality', '质量'], ['heat', '热度'], ['freshness', '新鲜度'], ['region', '地区'], ['preferredTaxonomy', '主动偏好']] as const)" :key="field[0]" class="min-w-0 text-sm text-gray-700">{{ field[1] }}<input v-model.number="form[field[0]]" type="number" min="0" max="100" required class="mt-1 min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2" /></label></div></div>
          <div class="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label class="min-w-0 md:col-span-2"><span class="mb-1 block text-sm font-medium text-gray-700">目标地区</span><input v-model.trim="form.targetRegions" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="留空为全部地区" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">灰度比例</span><input v-model.number="form.rolloutPercent" type="number" min="0" max="100" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">回滚目标版本</span><input v-model.trim="form.rollbackRuleVersionId" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" placeholder="rrv_…" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">同地区连续上限</span><input v-model.number="form.maxConsecutiveSameRegion" type="number" min="1" max="20" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">同分类连续上限</span><input v-model.number="form.maxConsecutiveSameTerm" type="number" min="1" max="20" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">重复曝光上限</span><input v-model.number="form.repeatExposureCap" type="number" min="1" max="100" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <div />
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">计划生效时间</span><input v-model="form.effectiveAt" type="datetime-local" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
            <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">计划结束时间</span><input v-model="form.expiresAt" type="datetime-local" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
          </div>
        </fieldset>
        <div v-if="editable" class="flex justify-end"><button :disabled="Boolean(operation) || weightTotal !== 100" class="min-h-10 rounded-lg bg-gray-950 px-5 py-2 text-sm font-medium text-white disabled:opacity-50">{{ operation === 'save' ? '保存中…' : '保存草稿' }}</button></div>
      </form>

      <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <h2 class="text-base font-semibold text-gray-950">状态操作</h2>
        <p class="mt-1 text-sm leading-6 text-gray-500">所有状态修改均要求当前编辑锁版本和审计原因；批准、启用、暂停与回滚仅 Owner 可执行，且创建人不得复核自己的版本。</p>
        <div class="mt-4 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">操作原因</span><textarea v-model.trim="reason" maxlength="500" rows="3" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="填写依据、风险判断或回滚原因" /></label>
          <label v-if="rule.state === 'validating'" class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">复核决定</span><select v-model="decision" :disabled="!isOwner" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-100"><option value="approve">批准</option><option value="reject">退回草稿</option></select></label>
        </div>
        <p v-if="operationError" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ operationError }}</p><p v-if="operationMessage" class="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{{ operationMessage }}</p>
        <div class="mt-4 flex flex-wrap gap-2">
          <button v-if="rule.state === 'draft'" :disabled="Boolean(operation) || !rule.lastDryRun" class="min-h-10 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="mutate('submit')">提交复核</button>
          <button v-if="rule.state === 'validating'" :disabled="Boolean(operation) || !isOwner" class="min-h-10 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="mutate('decision')">记录复核决定</button>
          <button v-if="['approved', 'scheduled', 'paused'].includes(rule.state)" :disabled="Boolean(operation) || !isOwner" class="min-h-10 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="mutate('activate')">启用规则</button>
          <button v-if="['active', 'scheduled'].includes(rule.state)" :disabled="Boolean(operation) || !isOwner" class="min-h-10 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 disabled:opacity-50" @click="mutate('pause')">暂停规则</button>
          <button v-if="['active', 'scheduled'].includes(rule.state) && rule.rollbackRuleVersionId" :disabled="Boolean(operation) || !isOwner" class="min-h-10 rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" @click="mutate('rollback')">回滚至登记版本</button>
        </div>
      </section>

      <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div class="border-b border-gray-200 px-4 py-4 sm:px-5"><h2 class="text-base font-semibold text-gray-950">不可变状态时间线</h2><p class="mt-1 text-sm text-gray-500">显示最近 100 条规则状态事件。</p></div>
        <div v-if="!rule.events.length" class="px-5 py-10 text-center text-sm text-gray-500">暂无状态事件。</div>
        <ol v-else class="divide-y divide-gray-100">
          <li v-for="event in rule.events" :key="event.eventId" class="grid min-w-0 gap-2 px-4 py-4 text-sm sm:grid-cols-[10rem_minmax(0,1fr)_12rem] sm:px-5">
            <div><p class="font-medium text-gray-900">{{ RECOMMENDATION_ACTION_LABELS[event.action] || event.action }}</p><p class="mt-1 text-xs text-gray-500">{{ event.fromState ? `${RECOMMENDATION_STATE_LABELS[event.fromState] || event.fromState} → ` : '' }}{{ RECOMMENDATION_STATE_LABELS[event.toState] || event.toState }}</p></div>
            <p class="min-w-0 break-words leading-6 text-gray-700">{{ event.reason }}</p>
            <div class="text-xs leading-5 text-gray-500"><p>{{ formatRecommendationDate(event.createdAt) }}</p><p>管理员 #{{ event.actorId }}</p></div>
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>
