<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsEmptyState from '~/components/admin/analytics/AnalyticsEmptyState.vue'
import AnalyticsMetricCard from '~/components/admin/analytics/AnalyticsMetricCard.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'
import AnalyticsTopList from '~/components/admin/analytics/AnalyticsTopList.vue'
import AnalyticsTrendPanel from '~/components/admin/analytics/AnalyticsTrendPanel.vue'

definePageMeta({ layout: 'admin' })

interface SeoData {
  totals: Record<string, number>
  trend: Array<Record<string, unknown>>
  referrers: Array<Record<string, unknown>>
  landingPages: Array<Record<string, unknown>>
  notes?: {
    source?: string
    limitation?: string
  }
}

const analytics = useAdminAnalytics<SeoData>('/api/admin/analytics/seo')

const totals = computed(() => analytics.data.value?.totals ?? {})
const hasSeoData = computed(() => {
  const data = analytics.data.value
  if (!data) return false
  return totalNumber('session_count') > 0 || data.trend.length > 0 || data.referrers.length > 0 || data.landingPages.length > 0
})

const trendSeries = [
  { label: '搜索 Session', key: 'session_count', tone: 'blue' as const },
  { label: '搜索 PV', key: 'page_view_count', tone: 'teal' as const },
  { label: '联系', key: 'contact_click_count', tone: 'gold' as const },
  { label: '注册', key: 'register_count', tone: 'green' as const },
]

const metrics = computed(() => [
  {
    label: '自然搜索 Session',
    value: formatAnalyticsNumber(totalNumber('session_count')),
    hint: `全站占比 ${formatRate(totalNumber('search_session_share'))}`,
    tone: 'blue' as const,
  },
  {
    label: '搜索落地',
    value: formatAnalyticsNumber(totalNumber('landing_count')),
    hint: `跳出率 ${formatRate(totalNumber('landing_bounce_rate'))}`,
    tone: 'default' as const,
  },
  {
    label: '搜索联系',
    value: formatAnalyticsNumber(totalNumber('contact_click_count')),
    hint: `联系率 ${formatRate(totalNumber('contact_rate'))}`,
    tone: 'gold' as const,
  },
  {
    label: '搜索注册',
    value: formatAnalyticsNumber(totalNumber('register_count')),
    hint: `注册率 ${formatRate(totalNumber('register_rate'))}`,
    tone: 'green' as const,
  },
])

function totalNumber(key: string) {
  return Number(totals.value[key] ?? 0)
}

function formatRate(value: unknown) {
  const num = Number(value ?? 0)
  if (!Number.isFinite(num)) return '0%'
  const percent = Math.abs(num) <= 1 ? num * 100 : num
  return `${percent.toFixed(1)}%`
}
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    title="SEO 分析"
    description="基于站内一方埋点识别自然搜索来源、搜索落地页和后续联系/注册转化。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    @refresh="analytics.refresh"
  >
    <template v-if="analytics.data.value">
      <section class="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
        {{ analytics.data.value.notes?.source }}
        {{ analytics.data.value.notes?.limitation }}
      </section>

      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <AnalyticsMetricCard
          v-for="metric in metrics"
          :key="metric.label"
          :label="metric.label"
          :value="metric.value"
          :hint="metric.hint"
          :tone="metric.tone"
        />
      </div>

      <AnalyticsEmptyState
        v-if="!hasSeoData"
        title="暂无 SEO 数据"
        description="当前范围没有被识别为自然搜索的访问。搜索引擎 referrer 或 utm_medium=seo/search/organic_search 进入站点后会在这里展示。"
        secondary-label="查看来源分析"
        secondary-to="/admin/analytics/sources"
        tone="blue"
      />

      <div class="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]">
        <AnalyticsTrendPanel
          title="自然搜索趋势"
          description="按日观察自然搜索带来的访问、页面浏览、联系和注册。"
          :rows="analytics.data.value.trend"
          :series="trendSeries"
        />

        <AnalyticsTopList
          title="搜索引擎来源"
          description="按自然搜索 Session 排序"
          :rows="analytics.data.value.referrers"
          label-key="source_label"
          meta-key="source_name"
          value-key="session_count"
          value-label="Session"
        />
      </div>

      <section>
        <div class="mb-2 flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 class="text-sm font-semibold text-gray-900">SEO 落地页表现</h2>
            <p class="mt-1 text-xs text-gray-500">优先看入口数、跳出率、停留、联系和注册，判断哪些页面值得继续优化标题、描述和内容结构。</p>
          </div>
          <NuxtLink to="/admin/analytics/source-pages?sourceChannel=search" class="text-xs font-medium text-blue-600 hover:underline">查看来源内容明细</NuxtLink>
        </div>
        <AnalyticsDataTable
          empty-title="暂无搜索落地页"
          empty-text="自然搜索访问进入站点后，会按落地页聚合展示。"
          :columns="[
            { key: 'route_label', label: '页面', sortable: true },
            { key: 'path', label: '路径', sortable: true },
            { key: 'entry_count', label: '入口', type: 'number', sortable: true },
            { key: 'page_view_count', label: 'PV', type: 'number', sortable: true },
            { key: 'bounce_rate', label: '跳出率', type: 'percent', sortable: true },
            { key: 'average_active_seconds', label: '平均停留', type: 'duration', sortable: true },
            { key: 'max_scroll_depth', label: '最大滚动', type: 'percent', sortable: true },
            { key: 'contact_click_count', label: '联系', type: 'number', sortable: true },
            { key: 'register_count', label: '注册', type: 'number', sortable: true },
            { key: 'contact_rate', label: '联系率', type: 'percent', sortable: true },
          ]"
          :rows="analytics.data.value.landingPages"
        />
      </section>

      <section>
        <h2 class="mb-2 text-sm font-semibold text-gray-900">搜索来源明细</h2>
        <AnalyticsDataTable
          compact
          empty-title="暂无搜索来源"
          empty-text="有自然搜索来源后会展示 Google、Bing、Baidu 等 referrer 的表现。"
          :columns="[
            { key: 'source_label', label: '来源', sortable: true },
            { key: 'source_name', label: 'referrer host', sortable: true },
            { key: 'session_count', label: 'Session', type: 'number', sortable: true },
            { key: 'page_view_count', label: 'PV', type: 'number', sortable: true },
            { key: 'average_active_seconds', label: '平均时长', type: 'duration', sortable: true },
            { key: 'contact_click_count', label: '联系', type: 'number', sortable: true },
            { key: 'register_count', label: '注册', type: 'number', sortable: true },
            { key: 'contact_rate', label: '联系率', type: 'percent', sortable: true },
            { key: 'register_rate', label: '注册率', type: 'percent', sortable: true },
          ]"
          :rows="analytics.data.value.referrers"
        />
      </section>
    </template>
  </AnalyticsPageShell>
</template>
