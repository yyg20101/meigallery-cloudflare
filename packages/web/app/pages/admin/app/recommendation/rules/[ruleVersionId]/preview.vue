<script setup lang="ts">
import type {
  RecommendationDryRun,
  RecommendationRuleDetail,
} from '~/types/admin-app-recommendations'
import {
  RECOMMENDATION_STATE_LABELS,
  formatRecommendationDate,
  recommendationApiError,
} from '~/types/admin-app-recommendations'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const ruleVersionId = computed(() => String(route.params.ruleVersionId || ''))
const regionCode = ref('')
const running = ref(false)
const runError = ref('')
const runMessage = ref('')
const preview = ref<RecommendationDryRun | null>(null)

const { data, status, error, refresh } = await useAsyncData(
  () => `admin-recommendation-preview-${ruleVersionId.value}`,
  () => api<{ data: RecommendationRuleDetail }>(`/api/admin/app/recommendations/rules/${ruleVersionId.value}`),
)

const rule = computed(() => data.value?.data ?? null)

watch(rule, (value) => {
  if (!preview.value && value?.lastDryRun) preview.value = value.lastDryRun
}, { immediate: true })

async function runDryRun() {
  if (!rule.value) return
  running.value = true
  runError.value = ''
  runMessage.value = ''
  try {
    const response = await api<{ data: { result: RecommendationDryRun; rule: RecommendationRuleDetail } }>(`/api/admin/app/recommendations/rules/${ruleVersionId.value}/dry-run`, {
      method: 'POST',
      body: {
        expectedVersion: rule.value.version,
        regionCode: regionCode.value.trim() || null,
      },
    })
    preview.value = response.data.result
    data.value = { data: response.data.rule }
    runMessage.value = 'Dry-run 已完成；结果仅用于运营判断，没有写入真实曝光。'
  }
  catch (requestError) {
    runError.value = recommendationApiError(requestError, 'Dry-run 执行失败，请检查规则引用、候选供给与编辑锁版本。')
  }
  finally {
    running.value = false
  }
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-REC-03" :route="`/admin/app/recommendation/rules/${ruleVersionId}/preview`" title="推荐 Dry-run" description="以合成场景比较规则结果；不产生曝光，也不读取真实观看者偏好。" :state="error ? '加载失败' : running ? '运行中' : rule ? (RECOMMENDATION_STATE_LABELS[rule.state] || rule.state) : '正常'" :figma-state="error ? '样本不足' : '正常'" :state-tone="error ? 'danger' : running || status === 'pending' ? 'warning' : 'success'">
      <template #actions><NuxtLink :to="`/admin/app/recommendation/rules/${ruleVersionId}`" class="inline-flex min-h-10 items-center rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700">返回规则工作台</NuxtLink></template>
    </AdminAppPageHeader>

    <div class="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950"><span class="font-semibold">模拟边界：</span>个性化规则只选取已发布稳定 taxonomy 的合成词条，不绑定账号；公开资格与平台屏蔽规则仍由服务端执行。Dry-run 每次会递增规则编辑锁版本。</div>
    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{{ recommendationApiError(error, '规则加载失败。') }} <button class="ml-2 font-semibold underline" @click="refresh()">重试</button></div>
    <div v-if="status === 'pending'" class="rounded-xl border border-gray-200 bg-white px-5 py-14 text-center text-sm text-gray-500">正在加载推荐规则…</div>

    <template v-if="rule">
      <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <div class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_16rem_auto] lg:items-end">
          <div class="min-w-0"><h2 class="break-words text-base font-semibold text-gray-950">{{ rule.name }}</h2><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ rule.ruleVersionId }} · 编辑锁 v{{ rule.version }}</p></div>
          <label class="min-w-0"><span class="mb-1 block text-sm font-medium text-gray-700">模拟地区代码</span><input v-model.trim="regionCode" maxlength="32" class="min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="留空为全局" /></label>
          <button :disabled="running || !['draft', 'validating', 'approved'].includes(rule.state)" class="min-h-11 rounded-lg bg-gray-950 px-5 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" @click="runDryRun">{{ running ? '计算中…' : '运行 Dry-run' }}</button>
        </div>
        <p v-if="!['draft', 'validating', 'approved'].includes(rule.state)" class="mt-3 text-xs text-amber-700">当前状态不可重新运行；下方仍可查看最近一次结果。</p>
        <p v-if="runError" class="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{{ runError }}</p><p v-if="runMessage" class="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{{ runMessage }}</p>
      </section>

      <template v-if="preview">
        <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">候选总数</p><p class="mt-2 text-2xl font-bold text-gray-950">{{ preview.candidateCount }}</p><p class="mt-1 text-xs" :class="preview.emptyResultRisk ? 'text-red-700' : 'text-emerald-700'">{{ preview.emptyResultRisk ? '存在空结果风险' : '候选供给可用' }}</p></article>
          <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">原因覆盖率</p><p class="mt-2 text-2xl font-bold text-gray-950">{{ Math.round(preview.reasonCoverage * 100) }}%</p><p class="mt-1 text-xs text-gray-500">非默认原因占比</p></article>
          <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">地区覆盖</p><p class="mt-2 text-2xl font-bold text-gray-950">{{ preview.representedRegionCount }}</p><p class="mt-1 text-xs text-gray-500">模拟地区：{{ preview.scenario.regionCode || '全局' }}</p></article>
          <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">重复资料</p><p class="mt-2 text-2xl font-bold" :class="preview.repeatedProfileCount ? 'text-red-700' : 'text-emerald-700'">{{ preview.repeatedProfileCount }}</p><p class="mt-1 text-xs text-gray-500">应保持为 0</p></article>
          <article class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">真实曝光</p><p class="mt-2 text-sm font-semibold text-emerald-700">未产生</p><p class="mt-1 text-xs text-gray-500">{{ formatRecommendationDate(preview.generatedAt) }}</p></article>
        </div>

        <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div class="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-4 sm:px-5"><div><h2 class="text-base font-semibold text-gray-950">Top {{ preview.topItems.length }} 候选</h2><p class="mt-1 text-sm text-gray-500">仅显示模拟排序结果，不代表已向任何观看者展示。</p></div><span class="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">公开资格固定校验</span></div>
          <div v-if="!preview.topItems.length" class="px-5 py-12 text-center text-sm text-red-700">没有满足公开资格的候选，请勿提交或启用此规则。</div>
          <div v-else class="w-full overflow-x-auto"><table class="w-full min-w-[760px] divide-y divide-gray-200 text-sm"><thead class="bg-gray-50 text-left text-xs font-medium text-gray-600"><tr><th class="px-4 py-3">排名</th><th class="px-4 py-3">真人资料</th><th class="px-4 py-3">地区</th><th class="px-4 py-3">解释原因</th><th class="px-4 py-3 text-right">得分</th></tr></thead><tbody class="divide-y divide-gray-100"><tr v-for="(item, index) in preview.topItems" :key="item.profileId"><td class="px-4 py-4 font-medium text-gray-500">#{{ index + 1 }}</td><td class="max-w-80 px-4 py-4"><p class="break-words font-medium text-gray-950">{{ item.displayName }}</p><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ item.profileId }}</p></td><td class="px-4 py-4 text-gray-600">{{ item.regionLabel || '未披露' }}</td><td class="px-4 py-4 font-mono text-xs text-gray-600">{{ item.reasonCode }}</td><td class="px-4 py-4 text-right font-semibold text-gray-950">{{ item.score.toFixed(4) }}</td></tr></tbody></table></div>
        </section>

        <section class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5"><h2 class="text-base font-semibold text-gray-950">解释原因分布</h2><div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><div v-for="item in preview.reasons" :key="item.code" class="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-gray-50 px-3 py-3 text-sm"><span class="min-w-0 break-all font-mono text-gray-700">{{ item.code }}</span><span class="shrink-0 font-semibold text-gray-950">{{ item.count }}</span></div></div></section>
      </template>
      <div v-else class="rounded-xl border border-dashed border-gray-300 bg-white px-5 py-14 text-center"><h2 class="text-base font-semibold text-gray-900">尚无 Dry-run 结果</h2><p class="mt-2 text-sm text-gray-500">运行一次模拟后，才能提交草稿进入复核。</p></div>
    </template>
  </div>
</template>
