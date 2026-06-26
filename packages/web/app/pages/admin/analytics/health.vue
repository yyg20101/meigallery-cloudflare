<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsEmptyState from '~/components/admin/analytics/AnalyticsEmptyState.vue'
import AnalyticsHealthStrip from '~/components/admin/analytics/AnalyticsHealthStrip.vue'
import AnalyticsMetricCard from '~/components/admin/analytics/AnalyticsMetricCard.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

definePageMeta({ layout: 'admin' })

interface HealthData {
  totals: Record<string, unknown> | null
  daily: Array<Record<string, unknown>>
}

const analytics = useAdminAnalytics<HealthData>('/api/admin/analytics/health')

const hasDailyRows = computed(() => (analytics.data.value?.daily.length ?? 0) > 0)
const totals = computed(() => analytics.data.value?.totals ?? null)
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    v-model:date="analytics.date.value"
    title="采集健康"
    description="查看接收、拒绝、去重、敏感 URL 拦截和 D1 预算估算，用于判断采集是否健康。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="false"
    @refresh="analytics.refresh"
  >
    <template v-if="analytics.data.value">
      <AnalyticsHealthStrip :health="totals" :usage="analytics.usage.value" />

      <AnalyticsEmptyState
        v-if="!hasDailyRows"
        title="暂无采集健康记录"
        description="当前时间范围没有健康日报。开启站内分析并产生前台访问后，这里会显示接收、拒绝、去重和 D1 rows 估算。"
        action-label="刷新健康数据"
        secondary-label="返回总览"
        secondary-to="/admin/analytics"
        tone="gold"
        @action="analytics.refresh"
      />

      <template v-else>
        <div v-if="totals" class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <AnalyticsMetricCard label="已接收" :value="formatAnalyticsNumber(totals.accepted_count)" tone="green" />
          <AnalyticsMetricCard label="拒绝" :value="formatAnalyticsNumber(totals.rejected_count)" tone="red" />
          <AnalyticsMetricCard label="去重" :value="formatAnalyticsNumber(totals.duplicate_count)" />
          <AnalyticsMetricCard label="写入行数" :value="formatAnalyticsNumber(totals.estimated_rows_written)" tone="gold" />
        </div>

        <AnalyticsDataTable
          class="mt-5"
          empty-title="暂无健康日报"
          empty-text="当前时间范围没有采集健康日报。"
          :columns="[
            { key: 'date', label: '日期', sortable: true },
            { key: 'accepted_count', label: '已接收', type: 'number', sortable: true },
            { key: 'rejected_count', label: '拒绝', type: 'number', sortable: true },
            { key: 'duplicate_count', label: '去重', type: 'number', sortable: true },
            { key: 'sensitive_blocked_count', label: '敏感拦截', type: 'number', sortable: true },
            { key: 'sampled_count', label: '采样', type: 'number', sortable: true },
            { key: 'estimated_rows_read', label: '读取行数', type: 'number', sortable: true },
            { key: 'estimated_rows_written', label: '写入行数', type: 'number', sortable: true },
            { key: 'max_duration_ms', label: '最大耗时', type: 'number', sortable: true },
            { key: 'last_ingested_at', label: '最近采集' },
          ]"
          :rows="analytics.data.value.daily"
        />
      </template>
    </template>
  </AnalyticsPageShell>
</template>
