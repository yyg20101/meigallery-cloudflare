<script setup lang="ts">
import AnalyticsConversionFunnel from '~/components/admin/analytics/AnalyticsConversionFunnel.vue'
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsEmptyState from '~/components/admin/analytics/AnalyticsEmptyState.vue'
import AnalyticsHealthStrip from '~/components/admin/analytics/AnalyticsHealthStrip.vue'
import AnalyticsMetricCard from '~/components/admin/analytics/AnalyticsMetricCard.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'
import AnalyticsTopList from '~/components/admin/analytics/AnalyticsTopList.vue'
import AnalyticsTrendPanel from '~/components/admin/analytics/AnalyticsTrendPanel.vue'

definePageMeta({ layout: 'admin' })

const { isOwner } = useAuth()
const createExport = useAnalyticsExport()

interface OverviewData {
  totals: Record<string, number>
  trend: Array<Record<string, unknown>>
  topSources: Array<Record<string, unknown>>
  topPages: Array<Record<string, unknown>>
  topClicks: Array<Record<string, unknown>>
  health: Record<string, unknown> | null
  funnel?: {
    stages: Array<Record<string, unknown>>
    dropOffs: Array<Record<string, unknown>>
  }
  diagnostics?: {
    aggregateMissing?: boolean
    acceptedCount?: number
    aggregateTotal?: number
  }
}

const analytics = useAdminAnalytics<OverviewData>('/api/admin/analytics/overview')

const totals = computed(() => analytics.data.value?.totals ?? {})

const trendSeries = [
  { label: 'Session', key: 'session_count', tone: 'blue' as const },
  { label: 'PV', key: 'page_view_count', tone: 'teal' as const },
  { label: '有效联系', key: 'effective_contact_click_count', fallbackKey: 'contact_click_count', tone: 'gold' as const },
  { label: '注册', key: 'register_count', tone: 'green' as const },
  { label: '会员', key: 'membership_grant_count', tone: 'gray' as const },
]

function totalNumber(key: string) {
  return Number(totals.value[key] ?? 0)
}

function effectiveContactClickCount() {
  if ('effective_contact_click_count' in totals.value) {
    return totalNumber('effective_contact_click_count')
  }
  return totalNumber('contact_click_count')
}

const metrics = computed(() => [
  {
    label: '访问规模',
    value: formatAnalyticsNumber(totalNumber('session_count')),
    hint: `访客 ${formatAnalyticsNumber(totalNumber('visitor_count'))} / PV ${formatAnalyticsNumber(totalNumber('page_view_count'))}`,
    tone: 'blue' as const,
  },
  {
    label: '内容兴趣',
    value: formatAnalyticsNumber(totalNumber('gallery_detail_count')),
    hint: `详情打开率 ${formatAnalyticsPercent(totalNumber('gallery_detail_count'), totalNumber('session_count'))}`,
    tone: 'default' as const,
  },
  {
    label: '有效联系',
    value: formatAnalyticsNumber(effectiveContactClickCount()),
    hint: `联系率 ${formatAnalyticsPercent(effectiveContactClickCount(), totalNumber('session_count'))}`,
    tone: 'gold' as const,
  },
  {
    label: '注册 / 会员',
    value: `${formatAnalyticsNumber(totalNumber('register_count'))} / ${formatAnalyticsNumber(totalNumber('membership_grant_count'))}`,
    hint: `注册率 ${formatAnalyticsPercent(totalNumber('register_count'), totalNumber('session_count'))}`,
    tone: 'green' as const,
  },
])

const decisionMetrics = computed(() => [
  {
    label: '详情打开率',
    value: formatAnalyticsPercent(totalNumber('gallery_detail_count'), totalNumber('session_count')),
    description: '判断落地页是否能把访客带进内容详情。',
    to: '/admin/analytics/pages',
  },
  {
    label: '有效联系率',
    value: formatAnalyticsPercent(effectiveContactClickCount(), totalNumber('session_count')),
    description: '衡量联系方式点击是否真实产生咨询意图。',
    to: '/admin/analytics/clicks',
  },
  {
    label: '注册转化率',
    value: formatAnalyticsPercent(totalNumber('register_count'), totalNumber('session_count')),
    description: '观察访问到账号注册的转化效率。',
    to: '/admin/analytics/sources',
  },
  {
    label: '会员发放率',
    value: formatAnalyticsPercent(totalNumber('membership_grant_count'), totalNumber('register_count')),
    description: '衡量注册用户最终被发放会员的比例。',
    to: '/admin/users',
  },
])

const funnel = computed(() => {
  const apiFunnel = analytics.data.value?.funnel
  if (apiFunnel?.stages?.length) {
    return apiFunnel.stages.map((step, index) => ({
      ...step,
      label: String(step.label ?? ''),
      value: Number(step.value ?? 0),
      rateFromPrevious: Number(step.rateFromPrevious ?? 0),
      rateFromEntry: Number(step.rateFromEntry ?? 0),
      tone: (['blue', 'default', 'gold', 'green', 'red'][index] ?? 'default') as 'blue' | 'default' | 'gold' | 'green' | 'red',
    }))
  }
  const landing = totalNumber('session_count')
  return [
    { label: '落地', value: landing, rate: landing > 0 ? '100%' : '--', tone: 'blue' as const },
    { label: '详情', value: totalNumber('gallery_detail_count'), rate: landing > 0 ? formatAnalyticsPercent(totalNumber('gallery_detail_count'), landing) : '--', tone: 'default' as const },
    { label: '有效联系', value: effectiveContactClickCount(), rate: landing > 0 ? formatAnalyticsPercent(effectiveContactClickCount(), landing) : '--', tone: 'gold' as const },
    { label: '注册', value: totalNumber('register_count'), rate: landing > 0 ? formatAnalyticsPercent(totalNumber('register_count'), landing) : '--', tone: 'green' as const },
    { label: '会员', value: totalNumber('membership_grant_count'), rate: landing > 0 ? formatAnalyticsPercent(totalNumber('membership_grant_count'), landing) : '--', tone: 'gold' as const },
  ]
})

const funnelDropOffs = computed(() => {
  return (analytics.data.value?.funnel?.dropOffs ?? []).map(item => ({
    fromLabel: String(item.fromLabel ?? ''),
    toLabel: String(item.toLabel ?? ''),
    lost: Number(item.lost ?? 0),
    lossRate: Number(item.lossRate ?? 0),
  }))
})

const hasActivity = computed(() => {
  const data = analytics.data.value
  if (!data) return false
  const totalKeys = [
    'visitor_count',
    'session_count',
    'page_view_count',
    'register_count',
    'invite_register_count',
    'contact_click_count',
    'effective_contact_click_count',
    'membership_grant_count',
    'gallery_detail_count',
  ]
  return totalKeys.some(key => totalNumber(key) > 0) ||
    data.trend.length > 0 ||
    data.topSources.length > 0 ||
    data.topPages.length > 0 ||
    data.topClicks.length > 0
})

const drilldowns = computed(() => [
  {
    title: '来源分析',
    description: '对比自然、社交、广告、邀请来源的注册和联系质量。',
    to: '/admin/analytics/sources',
    value: analytics.data.value?.topSources[0]?.source_label || analytics.data.value?.topSources[0]?.source_name || '暂无来源',
  },
  {
    title: 'SEO 分析',
    description: '查看自然搜索来源、落地页、跳出和联系转化。',
    to: '/admin/analytics/seo',
    value: '搜索来源与落地页',
  },
  {
    title: '点击分析',
    description: '核对联系方式、会员引导、广告位等关键点击。',
    to: '/admin/analytics/source-clicks',
    value: analytics.data.value?.topClicks[0]?.element_label || analytics.data.value?.topClicks[0]?.element_id || '暂无点击',
  },
])

const riskItems = computed(() => {
  const data = analytics.data.value
  if (!data) return []
  const items: Array<{ title: string; description: string; tone: 'gray' | 'amber' | 'red' }> = []
  const accepted = Number(data.health?.accepted_count ?? 0)
  const rejected = Number(data.health?.rejected_count ?? 0)
  const duplicate = Number(data.health?.duplicate_count ?? 0)
  if (!hasActivity.value) {
    items.push({
      title: '暂无运营数据',
      description: '当前时间范围还没有访问、转化或聚合排行，先确认前台采集和聚合任务。',
      tone: 'gray',
    })
  }
  if (!data.health?.last_ingested_at) {
    items.push({
      title: '暂无最近采集时间',
      description: '健康表还没有写入 last_ingested_at，可能是采集未开启或前台暂无访问。',
      tone: 'amber',
    })
  }
  if (data.diagnostics?.aggregateMissing) {
    items.push({
      title: '日报聚合缺失',
      description: `健康表已接收 ${formatAnalyticsNumber(data.diagnostics.acceptedCount)} 条事件，但当前范围聚合仍为 0，建议确认 API 已部署最新采集写入逻辑。`,
      tone: 'red',
    })
  }
  if (rejected > 0) {
    items.push({
      title: '存在 rejected 事件',
      description: `${formatAnalyticsNumber(rejected)} 条事件被拒绝，建议查看健康页排查 URL 或字段校验问题。`,
      tone: 'red',
    })
  }
  if (isAnalyticsDuplicateRisk(duplicate, accepted)) {
    items.push({
      title: '重复上报偏高',
      description: `${formatAnalyticsNumber(duplicate)} 条事件被去重，占接收尝试 ${formatAnalyticsPercent(duplicate, accepted + duplicate)}，建议排查前端重试或多实例上报。`,
      tone: 'amber',
    })
  }
  return items
})

function riskClass(tone: string) {
  if (tone === 'red') return 'border-red-100 bg-red-50 text-red-900'
  if (tone === 'amber') return 'border-amber-100 bg-amber-50 text-amber-900'
  return 'border-gray-200 bg-white text-gray-800'
}
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    v-model:date="analytics.date.value"
    title="数据分析"
    description="先看访问趋势、转化效率和采集健康，再下钻来源、内容、SEO 与点击明细。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('overview', analytics.range.value, analytics.date.value)"
  >
    <template v-if="analytics.data.value">
      <AnalyticsHealthStrip :health="analytics.data.value.health" :usage="analytics.usage.value" to="/admin/analytics/health" />

      <section class="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-900">
        本页为站内一方数据分析。FB、Facebook 或 Meta 来源表示 UTM、推广链接或 referrer 归因；Meta Pixel 只向 Meta 后台同步转化事件，不作为本页数据源。
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
        v-if="!hasActivity"
        title="暂无分析数据"
        description="当前时间范围没有访问、转化或排行数据。先确认站点设置已开启 analytics_enabled，并访问前台产生首批事件。"
        action-label="刷新数据"
        secondary-label="查看采集健康"
        secondary-to="/admin/analytics/health"
        tone="blue"
        @action="analytics.refresh"
      />

      <div class="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,0.65fr)]">
        <AnalyticsTrendPanel
          title="核心趋势"
          description="按日对比 Session、PV、有效联系、注册和会员发放，优先判断增长是否连续。"
          :rows="analytics.data.value.trend"
          :series="trendSeries"
        />

        <section class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div class="mb-4">
            <h2 class="text-sm font-semibold text-gray-900">转化诊断</h2>
            <p class="mt-1 text-xs leading-5 text-gray-500">用少量比率快速定位下一步分析入口。</p>
          </div>
          <div class="divide-y divide-gray-100">
            <NuxtLink
              v-for="item in decisionMetrics"
              :key="item.label"
              :to="item.to"
              class="block py-3 first:pt-0 last:pb-0 hover:bg-gray-50"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-sm font-medium text-gray-900">{{ item.label }}</p>
                  <p class="mt-1 text-xs leading-5 text-gray-500">{{ item.description }}</p>
                </div>
                <span class="shrink-0 text-lg font-semibold tabular-nums text-gray-950">{{ item.value }}</span>
              </div>
            </NuxtLink>
          </div>
        </section>
      </div>

      <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <AnalyticsConversionFunnel :steps="funnel" :drop-offs="funnelDropOffs" />

        <section class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div class="mb-4">
            <h2 class="text-sm font-semibold text-gray-900">下钻入口</h2>
            <p class="mt-1 text-xs leading-5 text-gray-500">从当前范围内最有价值的维度继续分析。</p>
          </div>
          <div class="divide-y divide-gray-100">
            <NuxtLink v-for="item in drilldowns" :key="item.title" :to="item.to" class="block py-3 first:pt-0 last:pb-0 hover:bg-gray-50">
              <p class="text-sm font-medium text-gray-900">{{ item.title }}</p>
              <p class="mt-1 text-xs leading-5 text-gray-500">{{ item.description }}</p>
              <p class="mt-2 truncate text-xs font-medium text-blue-700">{{ item.value }}</p>
            </NuxtLink>
          </div>
        </section>
      </div>

      <div class="grid gap-5 xl:grid-cols-3">
        <AnalyticsTopList
          title="Top 来源"
          description="站内归因来源，优先观察注册和联系"
          :rows="analytics.data.value.topSources"
          label-key="source_label"
          meta-key="source_channel_label"
          value-key="session_count"
          value-label="Session"
          to="/admin/analytics/sources"
        />
        <AnalyticsTopList
          title="Top 页面"
          description="最值得继续优化的内容入口"
          :rows="analytics.data.value.topPages"
          label-key="route_label"
          meta-key="path"
          value-key="page_view_count"
          value-label="PV"
          to="/admin/analytics/pages"
        />
        <AnalyticsTopList
          title="Top 点击"
          description="按去重行为点击排序，包含联系方式具体点击"
          :rows="analytics.data.value.topClicks"
          label-key="element_label"
          meta-key="location_label"
          value-key="effective_click_count"
          value-label="去重"
          to="/admin/analytics/clicks"
        />
      </div>

      <section class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div class="mb-4 flex items-center justify-between gap-3">
          <div>
            <h2 class="text-sm font-semibold text-gray-900">风险队列</h2>
            <p class="mt-1 text-xs text-gray-500">只展示需要运营或技术处理的事项。</p>
          </div>
          <NuxtLink to="/admin/analytics/health" class="text-xs font-medium text-blue-600 hover:underline">查看健康</NuxtLink>
        </div>
        <div v-if="riskItems.length === 0" class="rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          当前范围暂无明显采集风险。
        </div>
        <div v-else class="grid gap-3 lg:grid-cols-2">
          <div v-for="item in riskItems" :key="item.title" :class="['rounded-lg border px-4 py-3', riskClass(item.tone)]">
            <p class="text-sm font-semibold">{{ item.title }}</p>
            <p class="mt-1 text-xs leading-5 opacity-80">{{ item.description }}</p>
          </div>
        </div>
      </section>

      <section>
        <h2 class="mb-2 text-sm font-semibold text-gray-900">日趋势明细</h2>
        <AnalyticsDataTable
          compact
          empty-title="暂无日趋势"
          empty-text="聚合任务生成日报后会显示每天的访问和转化数据。"
          :columns="[
            { key: 'date', label: '日期', sortable: true },
            { key: 'visitor_count', label: '访客', type: 'number', sortable: true },
            { key: 'session_count', label: 'Session', type: 'number', sortable: true },
            { key: 'page_view_count', label: 'PV', type: 'number', sortable: true },
            { key: 'register_count', label: '注册', type: 'number', sortable: true },
            { key: 'contact_click_count', label: '有效联系', type: 'number', sortable: true },
            { key: 'effective_contact_click_count', label: '有效联系', type: 'number', sortable: true },
            { key: 'membership_grant_count', label: '会员', type: 'number', sortable: true },
          ]"
          :rows="analytics.data.value.trend"
        />
      </section>
    </template>
  </AnalyticsPageShell>
</template>
