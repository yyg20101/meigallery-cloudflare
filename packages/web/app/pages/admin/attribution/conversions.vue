<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsTrendPanel from '~/components/admin/analytics/AnalyticsTrendPanel.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'

definePageMeta({ layout: 'admin' })

interface ConversionData {
  byAction: Array<Record<string, unknown>>
  bySource: Array<Record<string, unknown>>
  samples: Array<Record<string, unknown>>
}

interface OverviewTrend {
  trend: Array<Record<string, unknown>>
}

const conversions = useAdminAttribution<ConversionData>('/api/admin/attribution/conversions')
const overview = useAdminAttribution<OverviewTrend>('/api/admin/attribution/overview')

watch([conversions.range, conversions.date], ([range, date]) => {
  overview.range.value = range
  overview.date.value = date
})

const trendSeries = [
  { label: '有效联系', key: 'contact_count', tone: 'gold' as const },
  { label: 'Lead', key: 'lead_count', tone: 'blue' as const },
  { label: '注册', key: 'complete_registration_count', tone: 'green' as const },
]

const sourceRows = computed(() => (conversions.data.value?.bySource ?? []).map(row => {
  const total = ['contact_count', 'lead_count', 'complete_registration_count', 'start_trial_count', 'membership_grant_count']
    .reduce((sum, key) => sum + Number(row[key] ?? 0), 0)
  return {
    ...row,
    contact_rate: Number(row.contact_count ?? 0) / Math.max(1, total),
    register_rate: Number(row.complete_registration_count ?? 0) / Math.max(1, total),
    meta_status: '查看 Meta 同步',
  }
}))

function refreshAll() {
  void Promise.all([conversions.refresh(), overview.refresh()])
}
</script>

<template>
  <AttributionPageShell
    v-model:range="conversions.range.value"
    v-model:date="conversions.date.value"
    title="转化明细"
    description="按动作、来源、campaign 和 content 检查有效联系、Lead、注册和最近样本。"
    :loading="conversions.loading.value || overview.loading.value"
    :error="conversions.error.value || overview.error.value"
    :usage="conversions.usage.value"
    @refresh="refreshAll"
  >
    <template v-if="conversions.data.value">
      <AnalyticsTrendPanel
        title="转化趋势"
        description="按日查看有效联系、Lead 和完成注册的变化。"
        :rows="overview.data.value?.trend || []"
        :series="trendSeries"
      />

      <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section class="space-y-3">
          <div>
            <h2 class="text-sm font-semibold text-gray-900">来源转化</h2>
            <p class="mt-1 text-sm text-gray-500">用于比较广告系列与素材版本的有效转化质量。</p>
          </div>
          <AnalyticsDataTable
            empty-title="暂无来源转化"
            empty-text="当前范围没有转化日报。"
            :columns="[
              { key: 'source_name', label: '来源', sortable: true },
              { key: 'utm_campaign', label: 'campaign', sortable: true },
              { key: 'utm_content', label: 'content', sortable: true },
              { key: 'contact_count', label: '有效联系', type: 'number', sortable: true },
              { key: 'lead_count', label: 'Lead', type: 'number', sortable: true },
              { key: 'complete_registration_count', label: '注册', type: 'number', sortable: true },
              { key: 'contact_rate', label: '联系率', type: 'percent', sortable: true },
              { key: 'register_rate', label: '注册率', type: 'percent', sortable: true },
              { key: 'meta_status', label: 'Meta 状态' },
            ]"
            :rows="sourceRows"
            compact
          />
        </section>

        <section class="space-y-3">
          <div>
            <h2 class="text-sm font-semibold text-gray-900">动作汇总</h2>
            <p class="mt-1 text-sm text-gray-500">快速核对事件动作是否完整进入账本。</p>
          </div>
          <AnalyticsDataTable
            empty-title="暂无动作数据"
            empty-text="完成注册、开始试用或联系事件上报后会出现。"
            :columns="[
              { key: 'action_type', label: '动作', sortable: true },
              { key: 'action_count', label: '次数', type: 'number', sortable: true },
              { key: 'unique_session_count', label: 'Session', type: 'number', sortable: true },
            ]"
            :rows="conversions.data.value.byAction"
            compact
          />
        </section>
      </div>

      <section class="space-y-3">
        <div>
          <h2 class="text-sm font-semibold text-gray-900">最近样本</h2>
          <p class="mt-1 text-sm text-gray-500">用于核对路径、联系方式入口和去重结果。</p>
        </div>
        <AnalyticsDataTable
          empty-title="暂无样本"
          empty-text="当前范围没有可展示的转化样本。"
          :columns="[
            { key: 'occurred_at', label: '时间', sortable: true },
            { key: 'action_type', label: '动作', sortable: true },
            { key: 'source_name', label: '来源', sortable: true },
            { key: 'utm_campaign', label: 'campaign' },
            { key: 'utm_content', label: 'content' },
            { key: 'method_type', label: '方式' },
            { key: 'action_target', label: '入口' },
            { key: 'path', label: '路径' },
            { key: 'duplicate_of', label: '重复于' },
          ]"
          :rows="conversions.data.value.samples"
          compact
        />
      </section>
    </template>
  </AttributionPageShell>
</template>
