<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsMetricCard from '~/components/admin/analytics/AnalyticsMetricCard.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'

definePageMeta({ layout: 'admin' })

interface DuplicateData {
  duplicateSuppressedCount: number
  duplicateActionCount: number
  duplicateRate: number
  samples: Array<Record<string, unknown>>
}

const attribution = useAdminAttribution<DuplicateData>('/api/admin/attribution/duplicates')
const data = computed(() => attribution.data.value)

const metrics = computed(() => [
  { label: '相同 external_event_id', value: formatAnalyticsNumber(data.value?.duplicateSuppressedCount), hint: 'Meta 投递层重复抑制', tone: Number(data.value?.duplicateSuppressedCount ?? 0) > 0 ? 'gold' as const : 'default' as const },
  { label: '相同 dedupe_key', value: formatAnalyticsNumber(data.value?.duplicateActionCount), hint: '站内转化账本重复样本', tone: Number(data.value?.duplicateActionCount ?? 0) > 0 ? 'gold' as const : 'default' as const },
  { label: '短时间重复点击', value: formatAnalyticsNumber(data.value?.samples?.length), hint: '最近重复样本数', tone: Number(data.value?.samples?.length ?? 0) > 0 ? 'blue' as const : 'default' as const },
  { label: '重复率', value: `${((data.value?.duplicateRate ?? 0) * 100).toFixed(1)}%`, hint: 'duplicate_suppressed / delivery total', tone: Number(data.value?.duplicateRate ?? 0) >= 0.1 ? 'red' as const : 'default' as const },
])
</script>

<template>
  <AttributionPageShell
    v-model:range="attribution.range.value"
    v-model:date="attribution.date.value"
    title="重复诊断"
    description="定位重复点击、相同 dedupe_key 和 Meta external_event_id 抑制。"
    :loading="attribution.loading.value"
    :error="attribution.error.value"
    :usage="attribution.usage.value"
    @refresh="attribution.refresh"
  >
    <template v-if="data">
      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <AnalyticsMetricCard v-for="metric in metrics" :key="metric.label" v-bind="metric" />
      </div>

      <section class="space-y-3">
        <div>
          <h2 class="text-sm font-semibold text-gray-900">最近重复样本</h2>
          <p class="mt-1 text-sm text-gray-500">样本只用于诊断，不进入转化日报和 Meta delivery。</p>
        </div>
        <AnalyticsDataTable
          empty-title="暂无重复样本"
          empty-text="当前范围没有站内重复转化样本。"
          :columns="[
            { key: 'occurred_at', label: '时间', sortable: true },
            { key: 'action_type', label: '动作', sortable: true },
            { key: 'source_name', label: '来源' },
            { key: 'utm_campaign', label: 'campaign' },
            { key: 'utm_content', label: 'content' },
            { key: 'method_type', label: '方式' },
            { key: 'action_target', label: '入口' },
            { key: 'duplicate_of', label: '重复于' },
          ]"
          :rows="data.samples"
          compact
        />
      </section>
    </template>
  </AttributionPageShell>
</template>
