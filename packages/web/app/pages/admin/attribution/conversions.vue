<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionProviderSwitch from '~/components/admin/attribution/AttributionProviderSwitch.vue'
import AttributionTrendPanel from '~/components/admin/attribution/AttributionTrendPanel.vue'
import type { AttributionDashboardProvider, AttributionTrendsData } from '~/composables/useAdminAttribution'
import { attributionPlatformDefinition } from '~/utils/attributionPlatforms'

definePageMeta({ layout: 'admin' })

interface ConversionData {
  provider: AttributionDashboardProvider
  byEvent: Array<Record<string, unknown>>
  bySource: Array<Record<string, unknown>>
  samples: Array<Record<string, unknown>>
}

const rangeState = useAdminAttributionRange('7d')
const selectedProvider = useAttributionProvider()
const platform = computed(() => attributionPlatformDefinition(selectedProvider.value))
const requestOptions = { rangeState, autoRefresh: false }
const conversions = useAdminAttribution<ConversionData>('/api/admin/attribution/conversions', {
  ...requestOptions,
  query: computed(() => ({ provider: selectedProvider.value })),
})
const trends = useAdminAttribution<AttributionTrendsData>('/api/admin/attribution/trends', {
  ...requestOptions,
  query: computed(() => ({ provider: selectedProvider.value, granularity: 'day' })),
})

watch(rangeState.queryKey, () => void refreshAll())
watch(selectedProvider, () => void refreshAll())
onMounted(() => void refreshAll())

const trendSeries = [
  { label: '有效联系', key: 'business.contactCount', layer: 'business' as const },
  { label: '完成注册', key: 'business.completeRegistrationCount', layer: 'business' as const },
]

const sourceRows = computed(() => (conversions.data.value?.bySource ?? []).map(row => ({
  ...row,
  platform: platform.value.label,
})))
const sampleRows = computed(() => (conversions.data.value?.samples ?? []).map(row => ({
  ...row,
  browser_planned: Number(row.browser_planned) === 1 ? '已生成' : '无指令',
  server_status: serverStatusLabel(String(row.server_status || '')),
})))

function refreshAll() {
  void Promise.all([conversions.refresh(), trends.refresh()])
}

function serverStatusLabel(status: string) {
  return ({
    planned: '已规划', queued: '已入队', accepted: '已接收', processed: '已处理', retrying: '重试中',
    rejected: '已拒绝', dead_letter: '死信', cancelled: '已取消',
  } as Record<string, string>)[status] || '未创建'
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="转化事实"
    description="按平台检查不可变业务事实、来源维度和最终投递状态。"
    :loading="conversions.loading.value || trends.loading.value"
    :error="conversions.error.value || trends.error.value"
    :usage="conversions.usage.value"
    @refresh="refreshAll"
  >
    <AttributionProviderSwitch v-model="selectedProvider" />

    <template v-if="conversions.data.value">
      <section class="border-b border-gray-200 bg-white px-3 py-5 sm:px-5">
        <AttributionTrendPanel
          :title="`${platform.label} 转化趋势`"
          :rows="trends.data.value?.rows || []"
          :series="trendSeries"
        />
      </section>

      <section class="grid gap-5 border-b border-gray-200 bg-white px-3 py-5 sm:px-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-gray-900">来源转化</h2>
          <AnalyticsDataTable
            class="mt-3"
            empty-title="暂无来源转化"
            empty-text="当前范围没有转化事实。"
            :columns="[
              { key: 'source_name', label: '来源', sortable: true },
              { key: 'platform', label: '广告平台' },
              { key: 'utm_campaign', label: 'Campaign', sortable: true },
              { key: 'utm_content', label: 'Content', sortable: true },
              { key: 'fact_count', label: '事实', type: 'number', sortable: true },
              { key: 'contact_count', label: '有效联系', type: 'number', sortable: true },
              { key: 'complete_registration_count', label: '完成注册', type: 'number', sortable: true },
            ]"
            :rows="sourceRows"
            compact
          />
        </div>

        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-gray-900">标准事件</h2>
          <AnalyticsDataTable
            class="mt-3"
            empty-title="暂无标准事件"
            empty-text="有效联系或完成注册后会出现。"
            :columns="[
              { key: 'canonical_event', label: '标准事件', sortable: true },
              { key: 'fact_count', label: '事实数', type: 'number', sortable: true },
              { key: 'unique_session_count', label: 'Session', type: 'number', sortable: true },
            ]"
            :rows="conversions.data.value.byEvent"
            compact
          />
        </div>
      </section>

      <section class="bg-white px-3 py-5 sm:px-5">
        <h2 class="text-sm font-semibold text-gray-900">最近事实与投递</h2>
        <AnalyticsDataTable
          class="mt-3"
          empty-title="暂无事实样本"
          empty-text="当前范围没有可展示的转化事实。"
          :columns="[
            { key: 'occurred_at', label: '时间', sortable: true },
            { key: 'canonical_event', label: '标准事件', sortable: true },
            { key: 'source_name', label: '来源', sortable: true },
            { key: 'utm_campaign', label: 'Campaign' },
            { key: 'utm_content', label: 'Content' },
            { key: 'method_type', label: '方式' },
            { key: 'path', label: '路径' },
            { key: 'browser_planned', label: 'Browser 指令' },
            { key: 'server_status', label: 'Server' },
            { key: 'retry_count', label: '重试', type: 'number' },
            { key: 'external_event_id', label: '事件编号' },
          ]"
          :rows="sampleRows"
          compact
        />
      </section>
    </template>
  </AttributionPageShell>
</template>
