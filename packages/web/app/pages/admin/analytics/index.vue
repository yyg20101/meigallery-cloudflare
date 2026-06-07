<script setup lang="ts">
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
}

const analytics = useAdminAnalytics<OverviewData>('/api/admin/analytics/overview')

const metrics = computed(() => {
  const totals = analytics.data.value?.totals ?? {}
  return [
    { label: '访客', value: formatAnalyticsNumber(totals.visitor_count), tone: 'blue' as const },
    { label: 'Session', value: formatAnalyticsNumber(totals.session_count), tone: 'default' as const },
    { label: 'PV', value: formatAnalyticsNumber(totals.page_view_count), tone: 'default' as const },
    { label: '注册', value: formatAnalyticsNumber(totals.register_count), tone: 'green' as const },
    { label: '邀请注册', value: formatAnalyticsNumber(totals.invite_register_count), tone: 'green' as const },
    { label: '联系', value: formatAnalyticsNumber(totals.contact_click_count), tone: 'gold' as const },
    { label: '会员发放', value: formatAnalyticsNumber(totals.membership_grant_count), tone: 'gold' as const },
    { label: '平均时长', value: formatAnalyticsDuration(totals.average_active_seconds), tone: 'default' as const },
  ]
})

const funnel = computed(() => {
  const totals = analytics.data.value?.totals ?? {}
  const landing = Number(totals.session_count ?? 0)
  return [
    { label: '落地', value: landing, rate: '100%' },
    { label: '详情', value: Number(totals.gallery_detail_count ?? 0), rate: formatAnalyticsPercent(totals.gallery_detail_count, landing) },
    { label: '联系', value: Number(totals.contact_click_count ?? 0), rate: formatAnalyticsPercent(totals.contact_click_count, landing) },
    { label: '注册', value: Number(totals.register_count ?? 0), rate: formatAnalyticsPercent(totals.register_count, landing) },
    { label: '会员', value: Number(totals.membership_grant_count ?? 0), rate: formatAnalyticsPercent(totals.membership_grant_count, landing) },
  ]
})

</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    title="数据分析"
    description="从来源、内容、联系和会员发放看运营闭环。默认读取聚合表和摘要表，避免扫描原始事件。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('overview', analytics.range.value)"
  >
    <template v-if="analytics.data.value">
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <AnalyticsMetricCard
          v-for="metric in metrics"
          :key="metric.label"
          :label="metric.label"
          :value="metric.value"
          :tone="metric.tone"
        />
      </div>

      <div class="grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
        <div class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-gray-900">关键转化漏斗</h2>
            <span class="text-xs text-gray-400">会员发放为最终转化</span>
          </div>
          <div class="space-y-3">
            <div v-for="item in funnel" :key="item.label" class="grid grid-cols-[4rem_1fr_4rem] items-center gap-3 text-sm">
              <span class="font-medium text-gray-600">{{ item.label }}</span>
              <div class="h-2 overflow-hidden rounded-full bg-gray-100">
                <div class="h-full rounded-full bg-amber-500" :style="{ width: item.rate }" />
              </div>
              <span class="text-right text-gray-500">{{ item.rate }}</span>
            </div>
          </div>
        </div>

        <div class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-gray-900">采集健康</h2>
            <NuxtLink to="/admin/analytics/health" class="text-xs text-blue-600 hover:underline">查看详情</NuxtLink>
          </div>
          <dl class="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt class="text-xs text-gray-400">Accepted</dt>
              <dd class="mt-1 font-semibold text-gray-900">{{ formatAnalyticsNumber(analytics.data.value.health?.accepted_count) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-gray-400">Rejected</dt>
              <dd class="mt-1 font-semibold text-red-600">{{ formatAnalyticsNumber(analytics.data.value.health?.rejected_count) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-gray-400">Rows written</dt>
              <dd class="mt-1 font-semibold text-gray-900">{{ formatAnalyticsNumber(analytics.data.value.health?.estimated_rows_written) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-gray-400">最近采集</dt>
              <dd class="mt-1 font-semibold text-gray-900">{{ formatAnalyticsDateTime(analytics.data.value.health?.last_ingested_at) }}</dd>
            </div>
          </dl>
        </div>
      </div>

      <section>
        <h2 class="mb-2 text-sm font-semibold text-gray-900">日趋势</h2>
        <AnalyticsDataTable
          :columns="[
            { key: 'date', label: '日期', sortable: true },
            { key: 'visitor_count', label: '访客', type: 'number', sortable: true },
            { key: 'session_count', label: 'Session', type: 'number', sortable: true },
            { key: 'page_view_count', label: 'PV', type: 'number', sortable: true },
            { key: 'register_count', label: '注册', type: 'number', sortable: true },
            { key: 'contact_click_count', label: '联系', type: 'number', sortable: true },
            { key: 'membership_grant_count', label: '会员', type: 'number', sortable: true },
          ]"
          :rows="analytics.data.value.trend"
        />
      </section>

      <div class="grid gap-5 xl:grid-cols-3">
        <section>
          <h2 class="mb-2 text-sm font-semibold text-gray-900">Top 来源</h2>
          <AnalyticsDataTable
            :columns="[
              { key: 'source_channel', label: '渠道' },
              { key: 'source_name', label: '来源' },
              { key: 'session_count', label: 'Session', type: 'number', sortable: true },
              { key: 'register_count', label: '注册', type: 'number', sortable: true },
            ]"
            :rows="analytics.data.value.topSources"
          />
        </section>
        <section>
          <h2 class="mb-2 text-sm font-semibold text-gray-900">Top 页面</h2>
          <AnalyticsDataTable
            :columns="[
              { key: 'route_name', label: 'Route' },
              { key: 'page_view_count', label: 'PV', type: 'number', sortable: true },
              { key: 'active_seconds_total', label: '时长', type: 'duration', sortable: true },
            ]"
            :rows="analytics.data.value.topPages"
          />
        </section>
        <section>
          <h2 class="mb-2 text-sm font-semibold text-gray-900">Top 点击</h2>
          <AnalyticsDataTable
            :columns="[
              { key: 'element_id', label: '元素' },
              { key: 'location', label: '位置' },
              { key: 'raw_click_count', label: '点击', type: 'number', sortable: true },
            ]"
            :rows="analytics.data.value.topClicks"
          />
        </section>
      </div>
    </template>
  </AnalyticsPageShell>
</template>
