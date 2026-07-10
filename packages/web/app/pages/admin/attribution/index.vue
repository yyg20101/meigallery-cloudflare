<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsEmptyState from '~/components/admin/analytics/AnalyticsEmptyState.vue'
import AnalyticsMetricCard from '~/components/admin/analytics/AnalyticsMetricCard.vue'
import AnalyticsTrendPanel from '~/components/admin/analytics/AnalyticsTrendPanel.vue'
import AttributionHealthStrip from '~/components/admin/attribution/AttributionHealthStrip.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'

definePageMeta({ layout: 'admin' })

interface OverviewData {
  totals: Record<string, number>
  trend: Array<Record<string, unknown>>
  meta: Record<string, unknown>
  metaTrend: Array<Record<string, unknown>>
  duplicates: Record<string, unknown>
  risks: Array<{ key: string; level: 'info' | 'warning'; message: string }>
}

interface AttributionLink {
  sourceLabel: string
  channel: string
  trackingPath: string
  utmCampaign: string
  utmContent: string
  sessionCount: number
  contactCount: number
  leadCount: number
  completeRegistrationCount: number
}

const attribution = useAdminAttribution<OverviewData>('/api/admin/attribution/overview')
const links = useAdminAttribution<{ links: AttributionLink[] }>('/api/admin/attribution/links')

watch([attribution.range, attribution.date], ([range, date]) => {
  links.range.value = range
  links.date.value = date
})

const totals = computed(() => attribution.data.value?.totals ?? {})
const meta = computed(() => attribution.data.value?.meta ?? {})
const duplicates = computed(() => attribution.data.value?.duplicates ?? {})

const trendRows = computed(() => {
  const rows = new Map<string, Record<string, unknown>>()
  for (const row of attribution.data.value?.trend ?? []) {
    const date = String(row.date ?? '')
    if (date) rows.set(date, { ...row })
  }
  for (const row of attribution.data.value?.metaTrend ?? []) {
    const date = String(row.date ?? '')
    if (!date) continue
    rows.set(date, { ...(rows.get(date) ?? { date }), failed_count: Number(row.failed_count ?? 0) })
  }
  return [...rows.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))
})

const metrics = computed(() => [
  {
    label: '有效联系',
    value: formatAnalyticsNumber(totals.value.contact_count),
    hint: `Lead ${formatAnalyticsNumber(totals.value.lead_count)}`,
    tone: 'gold' as const,
  },
  {
    label: 'Lead',
    value: formatAnalyticsNumber(totals.value.lead_count),
    hint: `联系到 Lead ${formatAnalyticsPercent(totals.value.lead_count, totals.value.contact_count)}`,
    tone: 'blue' as const,
  },
  {
    label: '完成注册',
    value: formatAnalyticsNumber(totals.value.complete_registration_count),
    hint: `注册 / Lead ${formatAnalyticsPercent(totals.value.complete_registration_count, totals.value.lead_count)}`,
    tone: 'green' as const,
  },
  {
    label: '会员发放',
    value: formatAnalyticsNumber(totals.value.membership_grant_count),
    hint: `发放 / 注册 ${formatAnalyticsPercent(totals.value.membership_grant_count, totals.value.complete_registration_count)}`,
    tone: 'default' as const,
  },
  {
    label: 'CAPI 失败',
    value: formatAnalyticsNumber(meta.value.failed_count),
    hint: `已同步 ${formatAnalyticsNumber(meta.value.sent_count)}`,
    tone: Number(meta.value.failed_count ?? 0) > 0 ? 'red' as const : 'default' as const,
  },
])

const trendSeries = [
  { label: '有效联系', key: 'contact_count', tone: 'gold' as const },
  { label: '注册', key: 'complete_registration_count', tone: 'green' as const },
  { label: 'CAPI 失败', key: 'failed_count', tone: 'red' as const },
]

const topLinkRows = computed(() => (links.data.value?.links ?? []).slice(0, 8).map(item => ({
  ...item,
  contactRate: Number(item.contactCount ?? 0) / Math.max(1, Number(item.sessionCount ?? 0)),
  registerRate: Number(item.completeRegistrationCount ?? 0) / Math.max(1, Number(item.sessionCount ?? 0)),
})))

const riskRows = computed(() => (attribution.data.value?.risks ?? []).map(item => ({
  level: item.level === 'warning' ? '警告' : '提示',
  message: item.message,
  key: item.key,
})))

function refreshAll() {
  void Promise.all([attribution.refresh(), links.refresh()])
}
</script>

<template>
  <AttributionPageShell
    v-model:range="attribution.range.value"
    v-model:date="attribution.date.value"
    title="归因中心"
    description="集中查看广告归因、有效联系、注册、Meta 同步和重复诊断。"
    :loading="attribution.loading.value || links.loading.value"
    :error="attribution.error.value || links.error.value"
    :usage="attribution.usage.value"
    @refresh="refreshAll"
  >
    <template v-if="attribution.data.value">
      <AttributionHealthStrip
        :capi-sent-count="Number(meta.sent_count ?? 0)"
        :failed-count="Number(meta.failed_count ?? 0)"
        :skipped-count="Number(meta.skipped_count ?? 0)"
        :last-sent-at="String(meta.last_sent_at ?? '')"
      />

      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <AnalyticsMetricCard v-for="metric in metrics" :key="metric.label" v-bind="metric" />
      </div>

      <AnalyticsTrendPanel
        title="归因趋势"
        description="按日对比有效联系、完成注册和 CAPI 失败，优先判断广告质量与同步稳定性。"
        :rows="trendRows"
        :series="trendSeries"
      />

      <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section class="space-y-3">
          <div>
            <h2 class="text-sm font-semibold text-gray-900">Top 投放链接</h2>
            <p class="mt-1 text-sm text-gray-500">按有效联系和注册查看当前范围内表现靠前的投放链接。</p>
          </div>
          <AnalyticsDataTable
            empty-title="暂无投放链接数据"
            empty-text="创建投放追踪链接并产生访问后，这里会展示有效联系、Lead 和注册。"
            empty-action-label="创建投放链接"
            empty-action-to="/admin/attribution/links"
            :columns="[
              { key: 'sourceLabel', label: '链接', sortable: true },
              { key: 'utmCampaign', label: 'campaign', sortable: true },
              { key: 'utmContent', label: 'content', sortable: true },
              { key: 'sessionCount', label: 'Session', type: 'number', sortable: true },
              { key: 'contactCount', label: '有效联系', type: 'number', sortable: true },
              { key: 'leadCount', label: 'Lead', type: 'number', sortable: true },
              { key: 'completeRegistrationCount', label: '注册', type: 'number', sortable: true },
              { key: 'contactRate', label: '联系率', type: 'percent', sortable: true },
              { key: 'registerRate', label: '注册率', type: 'percent', sortable: true },
            ]"
            :rows="topLinkRows"
            compact
          />
        </section>

        <section class="space-y-3">
          <div>
            <h2 class="text-sm font-semibold text-gray-900">风险提示</h2>
            <p class="mt-1 text-sm text-gray-500">优先处理可能影响广告学习和归因可信度的问题。</p>
          </div>
          <AnalyticsDataTable
            empty-title="暂无风险"
            empty-text="当前范围没有明显归因风险。"
            :columns="[
              { key: 'level', label: '级别' },
              { key: 'message', label: '说明' },
            ]"
            :rows="riskRows"
            compact
          />
        </section>
      </div>
    </template>
    <AnalyticsEmptyState
      v-else
      title="暂无归因数据"
      description="当前范围还没有转化账本或 Meta 同步数据。"
      action-label="刷新数据"
      @action="refreshAll"
    />
  </AttributionPageShell>
</template>
