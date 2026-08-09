<script setup lang="ts">
import type { AdminSearchOverview } from '~/types/admin-app-search'
import {
  SEARCH_READINESS_LABELS,
  adminSearchApiError,
  formatAdminSearchDate,
} from '~/types/admin-app-search'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { data: response, status, error, refresh } = await useAsyncData(
  'admin-app-search-overview',
  () => api<{ data: AdminSearchOverview }>('/api/admin/app/search/overview'),
)

const overview = computed(() => response.value?.data ?? null)
const readinessEntries = computed(() => {
  if (!overview.value) return []
  return (Object.keys(SEARCH_READINESS_LABELS) as Array<keyof typeof SEARCH_READINESS_LABELS>)
    .map(key => ({
      key,
      label: SEARCH_READINESS_LABELS[key],
      ...overview.value!.readiness[key],
    }))
})

function stateLabel(state: string | null | undefined) {
  if (state === 'development') return '开发版本'
  if (state === 'published') return '已发布'
  if (state === 'retired') return '已退役'
  return state || '未知'
}

function stateClass(state: string | null | undefined) {
  if (state === 'published') return 'bg-emerald-50 text-emerald-700 ring-emerald-200'
  if (state === 'development') return 'bg-amber-50 text-amber-800 ring-amber-200'
  return 'bg-gray-100 text-gray-600 ring-gray-200'
}

function scalarLabel(value: string | number | boolean | null) {
  if (value === null) return '未配置'
  return String(value)
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div class="min-w-0">
        <h1 class="text-xl font-bold text-gray-950">App 搜索运营核查</h1>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
          只读核查搜索策略、稳定分类目录、会员筛选权益和隐私数据健康。页面不会展示搜索词、条件名称或用户明细，也不会直接修改运行配置。
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <NuxtLink to="/admin/app/taxonomy" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          查看分类目录
        </NuxtLink>
        <button :disabled="status === 'pending'" class="inline-flex min-h-10 items-center justify-center rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50" @click="refresh()">
          {{ status === 'pending' ? '刷新中…' : '刷新核查' }}
        </button>
      </div>
    </div>

    <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
      <span class="font-semibold">开发阶段边界：</span>
      当前只完成管理能力与可见性。migration、真实目录、会员 grant 迁移、Wrangler 开关和生产门禁仍在统一配置阶段处理，本页没有“一键启用”或隐式切换入口。
    </div>

    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">
      {{ adminSearchApiError(error, '搜索运营核查当前不可用，请确认 0080–0082 数据结构已在目标环境完成。') }}
      <button class="ml-2 font-semibold underline" @click="refresh()">重试</button>
    </div>

    <div v-if="status === 'pending' && !overview" class="rounded-xl border border-gray-200 bg-white px-5 py-14 text-center text-sm text-gray-500">
      正在核查搜索策略与跨域依赖…
    </div>

    <template v-if="overview">
      <section class="space-y-3">
        <div class="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 class="text-base font-semibold text-gray-950">端到端就绪状态</h2>
            <p class="mt-1 text-sm text-gray-500">就绪表示当前环境配置与不可变版本依赖均可执行，不代表已获准上线。</p>
          </div>
          <p class="break-words text-xs text-gray-500">核查时间：{{ formatAdminSearchDate(overview.generatedAt) }}</p>
        </div>
        <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <article v-for="item in readinessEntries" :key="item.key" class="min-w-0 rounded-xl border bg-white p-4" :class="item.ready ? 'border-emerald-200' : 'border-amber-200'">
            <div class="flex min-w-0 items-start justify-between gap-3">
              <h3 class="min-w-0 text-sm font-semibold text-gray-950">{{ item.label }}</h3>
              <span class="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset" :class="item.ready ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-amber-50 text-amber-800 ring-amber-200'">
                {{ item.ready ? '可执行' : '保持关闭' }}
              </span>
            </div>
            <p v-if="item.ready" class="mt-4 text-xs leading-5 text-emerald-700">当前配置链路完整，仍需通过统一测试与上线评审。</p>
            <ul v-else class="mt-4 space-y-1.5 text-xs leading-5 text-gray-600">
              <li v-for="blocker in item.blockers.slice(0, 4)" :key="blocker" class="break-words">· {{ blocker }}</li>
              <li v-if="item.blockers.length > 4" class="text-gray-500">另有 {{ item.blockers.length - 4 }} 项依赖未就绪</li>
            </ul>
          </article>
        </div>
      </section>

      <section class="grid min-w-0 gap-4 xl:grid-cols-2">
        <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <div class="flex min-w-0 items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-base font-semibold text-gray-950">运行配置</h2>
              <p class="mt-1 text-sm text-gray-500">仅显示非敏感开关和选中版本，不显示 secret。</p>
            </div>
            <span class="shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset" :class="overview.runtime.search.runtimeEnabled ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-gray-100 text-gray-600 ring-gray-200'">
              {{ overview.runtime.search.runtimeEnabled ? '运行链路开启' : '运行链路关闭' }}
            </span>
          </div>
          <dl class="mt-4 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
            <div class="min-w-0 rounded-lg bg-gray-50 p-3"><dt class="text-xs text-gray-500">环境</dt><dd class="mt-1 break-words font-medium text-gray-900">{{ overview.runtime.environment }}</dd></div>
            <div class="min-w-0 rounded-lg bg-gray-50 p-3"><dt class="text-xs text-gray-500">App 认证</dt><dd class="mt-1 font-medium" :class="overview.runtime.authEnabled ? 'text-emerald-700' : 'text-amber-700'">{{ overview.runtime.authEnabled ? '已开启' : '未开启' }}</dd></div>
            <div class="min-w-0 rounded-lg bg-gray-50 p-3"><dt class="text-xs text-gray-500">搜索开关</dt><dd class="mt-1 font-medium" :class="overview.runtime.search.featureFlagEnabled ? 'text-emerald-700' : 'text-amber-700'">{{ overview.runtime.search.featureFlagEnabled ? '已配置 true' : '保持 false / 未配置' }}</dd></div>
            <div class="min-w-0 rounded-lg bg-gray-50 p-3"><dt class="text-xs text-gray-500">生产门禁</dt><dd class="mt-1 font-medium" :class="overview.runtime.search.productionGateEnabled ? 'text-emerald-700' : 'text-amber-700'">{{ overview.runtime.search.productionGateEnabled ? '当前满足' : '尚未满足' }}</dd></div>
            <div class="min-w-0 rounded-lg bg-gray-50 p-3 sm:col-span-2"><dt class="text-xs text-gray-500">选中搜索策略</dt><dd class="mt-1 break-all font-mono text-xs font-medium text-gray-900">{{ overview.runtime.search.selectedPolicyId }}</dd><p v-if="!overview.runtime.search.policyConfigured" class="mt-1 text-xs text-amber-700">当前显示代码安全回退 ID，环境变量尚未显式配置。</p></div>
          </dl>
        </article>

        <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
          <h2 class="text-base font-semibold text-gray-950">跨域版本依赖</h2>
          <div class="mt-4 grid min-w-0 gap-3 sm:grid-cols-2">
            <div class="min-w-0 rounded-lg border border-gray-200 p-3">
              <div class="flex min-w-0 items-start justify-between gap-2">
                <h3 class="text-sm font-semibold text-gray-900">Taxonomy</h3>
                <span class="shrink-0 text-xs font-medium" :class="overview.taxonomy.ready ? 'text-emerald-700' : 'text-amber-700'">{{ overview.taxonomy.ready ? '就绪' : '未就绪' }}</span>
              </div>
              <p class="mt-2 break-all font-mono text-xs text-gray-600">{{ overview.taxonomy.configuredCatalogVersionId || '未配置目录' }}</p>
              <p v-if="overview.taxonomy.catalog" class="mt-2 text-xs leading-5 text-gray-500">{{ stateLabel(overview.taxonomy.catalog.state) }} · {{ overview.taxonomy.catalog.itemCount || 0 }} 词条 · {{ overview.taxonomy.catalog.closureCount || 0 }} 闭包关系</p>
              <ul v-if="overview.taxonomy.blockers.length" class="mt-2 space-y-1 text-xs leading-5 text-amber-800"><li v-for="item in overview.taxonomy.blockers" :key="item">· {{ item }}</li></ul>
            </div>
            <div class="min-w-0 rounded-lg border border-gray-200 p-3">
              <div class="flex min-w-0 items-start justify-between gap-2">
                <h3 class="text-sm font-semibold text-gray-900">会员权益</h3>
                <span class="shrink-0 text-xs font-medium" :class="overview.membership.ready ? 'text-emerald-700' : 'text-amber-700'">{{ overview.membership.ready ? '就绪' : '未就绪' }}</span>
              </div>
              <p class="mt-2 break-all font-mono text-xs text-gray-600">{{ overview.membership.configuredCatalogVersionId || '未配置目录' }}</p>
              <p v-if="overview.membership.catalog" class="mt-2 text-xs leading-5 text-gray-500">{{ stateLabel(overview.membership.catalog.state) }} · {{ overview.membership.catalog.tierCount || 0 }} 个等级 · 最低客户端 {{ overview.membership.catalog.minimumClientVersion }}</p>
              <ul v-if="overview.membership.blockers.length" class="mt-2 space-y-1 text-xs leading-5 text-amber-800"><li v-for="item in overview.membership.blockers" :key="item">· {{ item }}</li></ul>
            </div>
          </div>
        </article>
      </section>

      <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div class="border-b border-gray-200 px-4 py-4 sm:px-5">
          <h2 class="text-base font-semibold text-gray-950">不可变搜索策略版本</h2>
          <p class="mt-1 text-sm text-gray-500">策略切换只通过受控环境配置完成；本页不会原地修改历史版本。</p>
        </div>
        <div v-if="!overview.policies.length" class="px-5 py-12 text-center text-sm text-gray-500">尚无搜索策略版本。</div>
        <div v-else class="w-full overflow-x-auto">
          <table class="w-full min-w-[1120px] divide-y divide-gray-200 text-sm">
            <thead class="bg-gray-50 text-left text-xs font-medium text-gray-600">
              <tr><th class="px-4 py-3">策略 / 选中</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">能力</th><th class="px-4 py-3">隐私门禁</th><th class="px-4 py-3">限制</th><th class="px-4 py-3">当前环境</th><th class="px-4 py-3">生效时间</th></tr>
            </thead>
            <tbody class="divide-y divide-gray-100">
              <tr v-for="policy in overview.policies" :key="policy.policyId" class="align-top" :class="policy.selected ? 'bg-pink-50/40' : ''">
                <td class="max-w-72 px-4 py-4"><p class="break-all font-mono text-xs font-semibold text-gray-950">{{ policy.policyId }}</p><span v-if="policy.selected" class="mt-2 inline-flex rounded-full bg-pink-50 px-2.5 py-1 text-xs font-medium text-pink-700 ring-1 ring-inset ring-pink-200">当前配置选择</span></td>
                <td class="px-4 py-4"><span class="inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="stateClass(policy.state)">{{ stateLabel(policy.state) }}</span><p class="mt-2 whitespace-nowrap text-xs" :class="policy.productionReady ? 'text-emerald-700' : 'text-amber-700'">{{ policy.productionReady ? 'production-ready' : '开发门禁' }}</p></td>
                <td class="px-4 py-4 text-xs leading-5 text-gray-600"><p>人物 {{ policy.capabilities.profiles ? '开' : '关' }} · 历史 {{ policy.capabilities.history ? '开' : '关' }}</p><p>筛选 {{ policy.capabilities.structuredFilters ? '开' : '关' }} · 预估 {{ policy.capabilities.filterPreview ? '开' : '关' }}</p><p>保存 {{ policy.capabilities.savedFilters ? '开' : '关' }}</p></td>
                <td class="px-4 py-4 text-xs leading-5 text-gray-600"><p>默认记录：关闭</p><p>保留决策：{{ policy.privacy.historyRetentionDecisionStatus }}</p><p>到期清理：{{ policy.privacy.purgeEnabled ? '已启用' : '未启用' }} · {{ policy.privacy.historyRetentionDays }} 天</p></td>
                <td class="px-4 py-4 text-xs leading-5 text-gray-600"><p>搜索词 {{ policy.limits.maxQueryLength }}</p><p>历史 {{ policy.limits.maxHistoryItems }}</p><p>筛选 {{ policy.limits.maxFilterTerms }} · 名称 {{ policy.limits.maxSavedFilterNameLength }}</p></td>
                <td class="max-w-72 px-4 py-4 text-xs leading-5"><span class="font-medium" :class="policy.readyForCurrentEnvironment ? 'text-emerald-700' : 'text-amber-700'">{{ policy.readyForCurrentEnvironment ? '版本自身就绪' : '版本自身未就绪' }}</span><ul v-if="policy.blockers.length" class="mt-1 text-gray-600"><li v-for="item in policy.blockers" :key="item" class="break-words">· {{ item }}</li></ul></td>
                <td class="whitespace-nowrap px-4 py-4 text-xs text-gray-500">{{ formatAdminSearchDate(policy.effectiveAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="space-y-3">
        <div>
          <h2 class="text-base font-semibold text-gray-950">隐私数据健康摘要</h2>
          <p class="mt-1 text-sm text-gray-500">只返回聚合计数；未知或尚未执行 migration 时不会伪装为 0。</p>
        </div>
        <div class="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs font-medium text-gray-500">历史记录偏好</p><p class="mt-2 text-2xl font-bold text-gray-950">{{ overview.privacy.historyRecordingEnabledCount }}</p><p class="mt-2 text-xs leading-5 text-gray-500">明确开启 / 已创建偏好 {{ overview.privacy.historyPreferenceCount }}</p></article>
          <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs font-medium text-gray-500">有效搜索历史</p><p class="mt-2 text-2xl font-bold text-gray-950">{{ overview.privacy.activeHistoryItemCount }}</p><p class="mt-2 text-xs leading-5 text-gray-500">涉及账号 {{ overview.privacy.historyAccountCount }} · 7 天内到期 {{ overview.privacy.expiringSoonHistoryItemCount }}</p></article>
          <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs font-medium text-gray-500">有效保存条件</p><p class="mt-2 text-2xl font-bold text-gray-950">{{ overview.privacy.activeSavedFilterCount }}</p><p class="mt-2 text-xs leading-5 text-gray-500">涉及账号 {{ overview.privacy.savedFilterAccountCount }} · 已清理 tombstone {{ overview.privacy.deletedSavedFilterCount }}</p></article>
          <article class="min-w-0 rounded-xl border bg-white p-4" :class="overview.privacy.needsReviewSavedFilterCount ? 'border-amber-200' : 'border-gray-200'"><p class="text-xs font-medium text-gray-500">保存条件需复核</p><p class="mt-2 text-2xl font-bold" :class="overview.privacy.needsReviewSavedFilterCount ? 'text-amber-700' : 'text-gray-950'">{{ overview.privacy.needsReviewSavedFilterCount }}</p><p class="mt-2 text-xs leading-5 text-gray-500">缺失引用 {{ overview.privacy.missingSavedFilterReferenceCount }} · 重定向 {{ overview.privacy.redirectedSavedFilterCount }} · 弃用 {{ overview.privacy.deprecatedSavedFilterCount }}</p></article>
        </div>
        <div class="grid min-w-0 gap-4 xl:grid-cols-2">
          <article class="min-w-0 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
            <h3 class="text-sm font-semibold text-gray-950">目录迁移摘要</h3>
            <dl class="mt-4 grid min-w-0 gap-3 text-sm sm:grid-cols-2">
              <div class="rounded-lg bg-gray-50 p-3"><dt class="text-xs text-gray-500">当前目录条件</dt><dd class="mt-1 text-xl font-bold text-gray-950">{{ overview.privacy.currentCatalogSavedFilterCount }}</dd></div>
              <div class="rounded-lg bg-gray-50 p-3"><dt class="text-xs text-gray-500">其他目录条件</dt><dd class="mt-1 text-xl font-bold text-gray-950">{{ overview.privacy.otherCatalogSavedFilterCount }}</dd></div>
              <div class="rounded-lg bg-gray-50 p-3"><dt class="text-xs text-gray-500">有效稳定引用</dt><dd class="mt-1 text-xl font-bold text-gray-950">{{ overview.privacy.activeSavedFilterReferenceCount }}</dd></div>
              <div class="rounded-lg bg-gray-50 p-3"><dt class="text-xs text-gray-500">受限引用条件</dt><dd class="mt-1 text-xl font-bold text-gray-950">{{ overview.privacy.restrictedSavedFilterCount }}</dd></div>
            </dl>
            <p class="mt-3 text-xs leading-5 text-gray-500">最近保存条件变更：{{ formatAdminSearchDate(overview.privacy.latestSavedFilterUpdatedAt) }}</p>
          </article>
          <article class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div class="border-b border-gray-200 px-4 py-4 sm:px-5"><h3 class="text-sm font-semibold text-gray-950">保存条件来源目录</h3></div>
            <div v-if="!overview.savedFilterCatalogUsage.length" class="px-5 py-10 text-center text-sm text-gray-500">尚无有效保存条件。</div>
            <div v-else class="w-full overflow-x-auto"><table class="w-full min-w-[600px] divide-y divide-gray-200 text-sm"><thead class="bg-gray-50 text-left text-xs text-gray-600"><tr><th class="px-4 py-3">目录</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">条件</th><th class="px-4 py-3">账号</th><th class="px-4 py-3">最近更新</th></tr></thead><tbody class="divide-y divide-gray-100"><tr v-for="item in overview.savedFilterCatalogUsage" :key="item.catalogVersionId"><td class="max-w-64 px-4 py-3"><p class="break-words text-xs font-medium text-gray-900">{{ item.versionCode || '目录记录缺失' }}</p><p class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ item.catalogVersionId }}</p></td><td class="px-4 py-3"><span class="whitespace-nowrap rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="stateClass(item.state)">{{ stateLabel(item.state) }}</span></td><td class="px-4 py-3 font-medium text-gray-900">{{ item.activeFilterCount }}</td><td class="px-4 py-3 text-gray-600">{{ item.accountCount }}</td><td class="whitespace-nowrap px-4 py-3 text-xs text-gray-500">{{ formatAdminSearchDate(item.latestUpdatedAt) }}</td></tr></tbody></table></div>
          </article>
        </div>
      </section>

      <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div class="border-b border-gray-200 px-4 py-4 sm:px-5">
          <h2 class="text-base font-semibold text-gray-950">会员 Search-2 执行值</h2>
          <p class="mt-1 break-words text-sm text-gray-500">授权只读取 {{ overview.membership.entitlementKeys.advanced }} 与 {{ overview.membership.entitlementKeys.savedFilterMax }}，不从等级名称或 rank 推导。</p>
        </div>
        <div v-if="!overview.membership.tiers.length" class="px-5 py-12 text-center text-sm text-gray-500">当前会员目录没有可核查的等级执行值。</div>
        <div v-else class="w-full overflow-x-auto">
          <table class="w-full min-w-[760px] divide-y divide-gray-200 text-sm">
            <thead class="bg-gray-50 text-left text-xs font-medium text-gray-600"><tr><th class="px-4 py-3">等级</th><th class="px-4 py-3">rank</th><th class="px-4 py-3">高级筛选</th><th class="px-4 py-3">保存上限</th><th class="px-4 py-3">可执行性</th></tr></thead>
            <tbody class="divide-y divide-gray-100"><tr v-for="tier in overview.membership.tiers" :key="tier.tierId"><td class="px-4 py-3"><p class="font-medium text-gray-950">{{ tier.displayName }}</p><p class="mt-1 break-all font-mono text-xs text-gray-500">{{ tier.code }} · {{ tier.tierId }}</p></td><td class="px-4 py-3 text-gray-600">{{ tier.rank }}</td><td class="px-4 py-3 font-mono text-xs text-gray-700">{{ scalarLabel(tier.advancedTier) }}</td><td class="px-4 py-3 font-mono text-xs text-gray-700">{{ scalarLabel(tier.savedFilterMax) }}</td><td class="px-4 py-3"><span class="whitespace-nowrap rounded-full px-2.5 py-1 text-xs ring-1 ring-inset" :class="tier.valid ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-amber-50 text-amber-800 ring-amber-200'">{{ tier.valid ? '值有效' : tier.available ? '值无效' : 'planned / 缺失' }}</span></td></tr></tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
