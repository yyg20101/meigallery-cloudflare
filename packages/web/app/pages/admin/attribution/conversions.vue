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
  byAction: Array<Record<string, unknown>>
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

const sourceRows = computed(() => (conversions.data.value?.bySource ?? []).map(row => {
  const total = ['contact_count', 'complete_registration_count']
    .reduce((sum, key) => sum + Number(row[key] ?? 0), 0)
  return {
    ...row,
    platform: platform.value.label,
    contact_rate: Number(row.contact_count ?? 0) / Math.max(1, total),
    register_rate: Number(row.complete_registration_count ?? 0) / Math.max(1, total),
  }
}))

function refreshAll() {
  void Promise.all([conversions.refresh(), trends.refresh()])
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="转化明细"
    description="按单一广告平台检查有效联系、完成注册、Campaign 与最近事件样本。"
    :loading="conversions.loading.value || trends.loading.value"
    :error="conversions.error.value || trends.error.value"
    :usage="conversions.usage.value"
    @refresh="refreshAll"
  >
    <AttributionProviderSwitch v-model="selectedProvider" />

    <template v-if="conversions.data.value">
      <AttributionTrendPanel
        :title="`${platform.label} 转化趋势`"
        description="按业务日查看当前平台的有效联系和完成注册，不混入其他广告平台。"
        :rows="trends.data.value?.rows || []"
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
              { key: 'platform', label: '广告平台' },
              { key: 'utm_campaign', label: 'campaign', sortable: true },
              { key: 'utm_content', label: 'content', sortable: true },
              { key: 'contact_count', label: '有效联系', type: 'number', sortable: true },
              { key: 'complete_registration_count', label: '注册', type: 'number', sortable: true },
              { key: 'contact_rate', label: '联系率', type: 'percent', sortable: true },
              { key: 'register_rate', label: '注册率', type: 'percent', sortable: true },
            ]"
            :rows="sourceRows"
            compact
          />
        </section>

        <section class="space-y-3">
          <div>
            <h2 class="text-sm font-semibold text-gray-900">动作汇总</h2>
            <p class="mt-1 text-sm text-gray-500">只统计明确归属于 {{ platform.label }} 且未被判重的活动转化。</p>
          </div>
          <AnalyticsDataTable
            empty-title="暂无动作数据"
            empty-text="有效联系或完成注册事件上报后会出现。"
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
            { key: 'attribution_provider', label: '平台标识' },
          ]"
          :rows="conversions.data.value.samples"
          compact
        />
      </section>
    </template>
  </AttributionPageShell>
</template>
