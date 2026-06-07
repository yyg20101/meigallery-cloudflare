<script setup lang="ts">
definePageMeta({ layout: 'admin' })

interface HealthData {
  totals: Record<string, unknown> | null
  daily: Array<Record<string, unknown>>
}

const analytics = useAdminAnalytics<HealthData>('/api/admin/analytics/health')
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    title="采集健康"
    description="查看 accepted、rejected、duplicate、敏感 URL 拦截和 D1 预算估算，用于判断采集是否健康。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="false"
    @refresh="analytics.refresh"
  >
    <div v-if="analytics.data.value?.totals" class="grid grid-cols-2 gap-3 md:grid-cols-4">
      <AnalyticsMetricCard label="Accepted" :value="formatAnalyticsNumber(analytics.data.value.totals.accepted_count)" tone="green" />
      <AnalyticsMetricCard label="Rejected" :value="formatAnalyticsNumber(analytics.data.value.totals.rejected_count)" tone="red" />
      <AnalyticsMetricCard label="Duplicate" :value="formatAnalyticsNumber(analytics.data.value.totals.duplicate_count)" />
      <AnalyticsMetricCard label="Rows written" :value="formatAnalyticsNumber(analytics.data.value.totals.estimated_rows_written)" tone="gold" />
    </div>

    <AnalyticsDataTable
      class="mt-5"
      :columns="[
        { key: 'date', label: '日期', sortable: true },
        { key: 'accepted_count', label: 'Accepted', type: 'number', sortable: true },
        { key: 'rejected_count', label: 'Rejected', type: 'number', sortable: true },
        { key: 'duplicate_count', label: 'Duplicate', type: 'number', sortable: true },
        { key: 'sensitive_blocked_count', label: '敏感拦截', type: 'number', sortable: true },
        { key: 'sampled_count', label: '采样', type: 'number', sortable: true },
        { key: 'estimated_rows_read', label: 'Rows read', type: 'number', sortable: true },
        { key: 'estimated_rows_written', label: 'Rows written', type: 'number', sortable: true },
        { key: 'max_duration_ms', label: '最大耗时', type: 'number', sortable: true },
        { key: 'last_ingested_at', label: '最近采集' },
      ]"
      :rows="analytics.data.value?.daily || []"
    />
  </AnalyticsPageShell>
</template>
