<script setup lang="ts">
import type {
  RecommendationOverview,
  RecommendationRule,
} from '~/types/admin-app-recommendations'
import {
  RECOMMENDATION_STATE_LABELS,
  formatRecommendationDate,
  newRecommendationIdempotencyKey,
  recommendationApiError,
  recommendationStateClass,
} from '~/types/admin-app-recommendations'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const stateFilter = ref('')
const modeFilter = ref('')
const showCreate = ref(false)
const creating = ref(false)
const createError = ref('')
const form = reactive({
  mode: 'non_personalized' as 'non_personalized' | 'personalized',
  name: '',
  description: '',
  taxonomyCatalogId: '',
  heatVersionId: '',
  quality: 70,
  heat: 0,
  freshness: 30,
  region: 0,
  preferredTaxonomy: 0,
  targetRegions: '',
  rolloutPercent: 0,
  minimumClientVersion: '1.0',
})

const { data, status, error, refresh } = await useAsyncData(
  'admin-app-recommendation-rules',
  async () => {
    const [overview, rules] = await Promise.all([
      api<{ data: RecommendationOverview }>('/api/admin/app/recommendations/overview'),
      api<{ data: RecommendationRule[] }>('/api/admin/app/recommendations/rules', {
        query: {
          state: stateFilter.value || undefined,
          mode: modeFilter.value || undefined,
        },
      }),
    ])
    return { overview: overview.data, rules: rules.data }
  },
  { watch: [stateFilter, modeFilter] },
)

const overview = computed(() => data.value?.overview ?? null)
const rules = computed(() => data.value?.rules ?? [])
const weightTotal = computed(() => form.quality + form.heat + form.freshness + form.region + form.preferredTaxonomy)

watch(() => form.mode, (mode) => {
  if (mode === 'personalized') {
    Object.assign(form, { quality: 50, heat: 0, freshness: 20, region: 0, preferredTaxonomy: 30 })
  }
  else {
    Object.assign(form, { quality: 70, heat: 0, freshness: 30, region: 0, preferredTaxonomy: 0 })
  }
})

async function createRule() {
  createError.value = ''
  if (weightTotal.value !== 100) {
    createError.value = '五项权重之和必须等于 100。'
    return
  }
  creating.value = true
  try {
    const response = await api<{ data: { rule: RecommendationRule } }>('/api/admin/app/recommendations/rules', {
      method: 'POST',
      headers: { 'Idempotency-Key': newRecommendationIdempotencyKey('rule') },
      body: {
        mode: form.mode,
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
        rolloutPercent: form.rolloutPercent,
        minimumClientVersion: form.minimumClientVersion,
      },
    })
    await navigateTo(`/admin/app/recommendation/rules/${response.data.rule.ruleVersionId}`)
  }
  catch (requestError) {
    createError.value = recommendationApiError(requestError, '推荐规则创建失败，请检查字段和引用版本。')
  }
  finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-REC-01" route="/admin/app/recommendation/rules" title="推荐规则版本" description="管理候选、排序、热度、灰度和回滚，并保持安全过滤不可关闭。" :state="error ? '加载失败' : status === 'pending' ? '加载中' : '正常'" figma-state="正常" :state-tone="error ? 'danger' : status === 'pending' ? 'warning' : 'success'">
      <template #actions>
        <NuxtLink to="/admin/app/recommendation/placements" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          运营精选排期
        </NuxtLink>
        <button class="inline-flex min-h-10 items-center justify-center rounded-[10px] bg-[#d63363] px-4 py-2 text-sm font-medium text-white hover:bg-[#bd2756]" @click="showCreate = !showCreate">
          {{ showCreate ? '收起创建表单' : '新建规则草稿' }}
        </button>
      </template>
    </AdminAppPageHeader>

    <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
      <span class="font-semibold">当前决策边界：</span>
      在 OQ-023 关闭前只允许非个性化规则进入生效态；个性化只能使用观看者主动选择的稳定分类偏好，不读取会员、金币、消息或精确位置。平台精选必须固定显示“平台精选”。
    </div>

    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">
      {{ recommendationApiError(error, '推荐运营能力当前不可用；开发开关、策略或数据库结构尚未就绪。') }}
      <button class="ml-2 font-semibold underline" @click="refresh()">重试</button>
    </div>

    <template v-if="overview">
      <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4">
          <p class="text-xs font-medium text-gray-500">策略版本</p>
          <p class="mt-2 break-all text-sm font-semibold text-gray-950">{{ overview.policy.policyId }}</p>
          <p class="mt-2 text-xs" :class="overview.runtime.productionReady ? 'text-emerald-700' : 'text-amber-700'">
            {{ overview.runtime.productionReady ? '生产门禁已通过' : '开发策略 · 禁止生产启用' }}
          </p>
        </article>
        <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4">
          <p class="text-xs font-medium text-gray-500">规则队列</p>
          <p class="mt-2 text-2xl font-bold text-gray-950">{{ Object.values(overview.ruleCounts).reduce((sum, value) => sum + value, 0) }}</p>
          <p class="mt-2 text-xs text-gray-500">生效中 {{ overview.ruleCounts.active || 0 }} · 待复核 {{ overview.ruleCounts.validating || 0 }}</p>
        </article>
        <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4">
          <p class="text-xs font-medium text-gray-500">运营精选</p>
          <p class="mt-2 text-2xl font-bold text-gray-950">{{ Object.values(overview.placementCounts).reduce((sum, value) => sum + value, 0) }}</p>
          <p class="mt-2 text-xs text-gray-500">生效中 {{ overview.placementCounts.active || 0 }} · 待复核 {{ overview.placementCounts.pending_review || 0 }}</p>
        </article>
        <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4">
          <p class="text-xs font-medium text-gray-500">隐私能力</p>
          <p class="mt-2 text-sm font-semibold" :class="overview.runtime.personalizationReady ? 'text-emerald-700' : 'text-gray-700'">
            个性化：{{ overview.runtime.personalizationReady ? '已批准' : '保持关闭' }}
          </p>
          <p class="mt-2 text-xs text-gray-500">证据留存：{{ overview.runtime.evidenceReady ? '已批准' : '不写入' }}</p>
        </article>
      </div>
    </template>

    <form v-if="showCreate" class="min-w-0 space-y-4 rounded-xl border border-gray-200 bg-white p-4 sm:p-5" @submit.prevent="createRule">
      <div>
        <h2 class="text-base font-semibold text-gray-950">新建不可变规则版本</h2>
        <p class="mt-1 text-sm leading-6 text-gray-500">草稿可编辑；提交后如需调整，应复制为新版本。</p>
      </div>
      <div class="grid min-w-0 gap-4 md:grid-cols-2">
        <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">模式</span><select v-model="form.mode" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="non_personalized">非个性化</option><option value="personalized">个性化（仅建草稿）</option></select></label>
        <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">规则名称</span><input v-model.trim="form.name" required maxlength="80" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="例如：首页非个性化基线" /></label>
        <label class="min-w-0 md:col-span-2"><span class="mb-1 block text-sm font-medium text-gray-700">规则说明</span><textarea v-model.trim="form.description" maxlength="500" rows="3" class="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="说明目标、变更依据和风险边界" /></label>
        <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">稳定 taxonomy 目录 ID</span><input v-model.trim="form.taxonomyCatalogId" :required="form.mode === 'personalized'" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" placeholder="txc_…" /></label>
        <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">热度版本 ID</span><input v-model.trim="form.heatVersionId" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" placeholder="可选：rhv_…" /></label>
      </div>
      <fieldset class="min-w-0 rounded-xl border border-gray-200 p-4">
        <legend class="px-2 text-sm font-semibold text-gray-900">排序权重（合计 {{ weightTotal }}%）</legend>
        <div class="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label v-for="field in ([['quality', '内容质量'], ['heat', '热度'], ['freshness', '新鲜度'], ['region', '地区相关'], ['preferredTaxonomy', '主动偏好']] as const)" :key="field[0]" class="min-w-0 text-sm text-gray-700">
            {{ field[1] }}<input v-model.number="form[field[0]]" type="number" min="0" max="100" required class="mt-1 min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2" />
          </label>
        </div>
      </fieldset>
      <div class="grid min-w-0 gap-4 md:grid-cols-3">
        <label class="min-w-0 md:col-span-2"><span class="mb-1 block text-sm font-medium text-gray-700">目标地区代码</span><input v-model.trim="form.targetRegions" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="留空为全部；多个地区用逗号分隔" /></label>
        <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">最低客户端版本</span><input v-model.trim="form.minimumClientVersion" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /></label>
        <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">灰度比例</span><div class="flex min-w-0 items-center gap-2"><input v-model.number="form.rolloutPercent" type="number" min="0" max="100" required class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" /><span class="shrink-0 text-sm text-gray-500">%</span></div></label>
      </div>
      <p v-if="createError" class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ createError }}</p>
      <div class="flex flex-wrap justify-end gap-2">
        <button type="button" class="min-h-10 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700" @click="showCreate = false">取消</button>
        <button :disabled="creating || weightTotal !== 100" class="min-h-10 rounded-lg bg-gray-950 px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">{{ creating ? '创建中…' : '创建草稿' }}</button>
      </div>
    </form>

    <div class="flex min-w-0 flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-end">
      <label class="min-w-0 flex-1"><span class="mb-1 block text-xs font-medium text-gray-500">状态</span><select v-model="stateFilter" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="">全部状态</option><option v-for="(label, value) in RECOMMENDATION_STATE_LABELS" :key="value" :value="value">{{ label }}</option></select></label>
      <label class="min-w-0 flex-1"><span class="mb-1 block text-xs font-medium text-gray-500">模式</span><select v-model="modeFilter" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm"><option value="">全部模式</option><option value="non_personalized">非个性化</option><option value="personalized">个性化</option></select></label>
      <button :disabled="status === 'pending'" class="min-h-10 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 disabled:opacity-50" @click="refresh()">刷新</button>
    </div>

    <div class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div v-if="status === 'pending'" class="px-5 py-12 text-center text-sm text-gray-500">正在加载推荐规则…</div>
      <div v-else-if="!rules.length" class="px-5 py-12 text-center"><h2 class="text-base font-semibold text-gray-900">没有匹配的规则版本</h2><p class="mt-2 text-sm text-gray-500">可新建草稿，或调整筛选条件。</p></div>
      <div v-else class="w-full overflow-x-auto">
        <table class="w-full min-w-[1050px] divide-y divide-gray-200 text-sm">
          <thead class="bg-gray-50 text-left text-xs font-medium text-gray-600"><tr><th class="px-4 py-3">规则 / 版本</th><th class="px-4 py-3">模式</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">权重</th><th class="px-4 py-3">范围</th><th class="px-4 py-3">Dry-run</th><th class="px-4 py-3">更新时间</th><th class="px-4 py-3 text-right">操作</th></tr></thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="rule in rules" :key="rule.ruleVersionId" class="align-top hover:bg-gray-50/70">
              <td class="max-w-72 px-4 py-4"><p class="break-words font-medium text-gray-950">{{ rule.name }}</p><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ rule.ruleVersionId }} · v{{ rule.versionNumber }}</p></td>
              <td class="px-4 py-4"><span class="whitespace-nowrap">{{ rule.mode === 'personalized' ? '个性化' : '非个性化' }}</span></td>
              <td class="px-4 py-4"><span class="inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="recommendationStateClass(rule.state)">{{ RECOMMENDATION_STATE_LABELS[rule.state] || rule.state }}</span><p v-if="!rule.productionReady" class="mt-2 whitespace-nowrap text-xs text-amber-700">开发版本</p></td>
              <td class="px-4 py-4 text-xs leading-5 text-gray-600">质量 {{ rule.weights.quality }} · 热度 {{ rule.weights.heat }}<br />新鲜 {{ rule.weights.freshness }} · 地区 {{ rule.weights.region }}<br />偏好 {{ rule.weights.preferredTaxonomy }}</td>
              <td class="px-4 py-4 text-xs leading-5 text-gray-600"><p>灰度 {{ rule.rolloutPercent }}%</p><p>{{ rule.targetRegionCodes.length ? rule.targetRegionCodes.join('、') : '全部地区' }}</p></td>
              <td class="px-4 py-4 text-xs"><span :class="rule.lastDryRun && !rule.lastDryRun.emptyResultRisk ? 'text-emerald-700' : 'text-gray-500'">{{ rule.lastDryRun ? `${rule.lastDryRun.candidateCount} 个候选` : '未执行' }}</span></td>
              <td class="whitespace-nowrap px-4 py-4 text-xs text-gray-500">{{ formatRecommendationDate(rule.updatedAt) }}</td>
              <td class="px-4 py-4 text-right"><NuxtLink :to="`/admin/app/recommendation/rules/${rule.ruleVersionId}`" class="font-medium text-blue-600 hover:underline">进入工作台</NuxtLink></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
