<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

definePageMeta({ layout: 'admin' })
const { isOwner } = useAuth()
const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/clicks')
const createExport = useAnalyticsExport()
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    title="点击分析"
    description="跟踪广告、图库卡片、联系入口、规则入口、会员 CTA 和筛选操作的点击质量。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('clicks', analytics.range.value)"
  >
    <AnalyticsDataTable
      empty-title="暂无点击数据"
      empty-text="当前时间范围没有关键点击聚合。广告、图库卡片、联系入口、规则入口和筛选操作会在这里汇总。"
      empty-action-label="查看采集健康"
      empty-action-to="/admin/analytics/health"
      :columns="[
        { key: 'element_id', label: '元素', sortable: true },
        { key: 'element_type', label: '类型' },
        { key: 'location', label: '位置', sortable: true },
        { key: 'target_type', label: '目标类型' },
        { key: 'target_id', label: '目标 ID' },
        { key: 'raw_click_count', label: 'Raw', type: 'number', sortable: true },
        { key: 'effective_click_count', label: '有效', type: 'number', sortable: true },
        { key: 'duplicate_click_count', label: '重复', type: 'number', sortable: true },
        { key: 'visitor_count', label: '访客', type: 'number', sortable: true },
        { key: 'session_count', label: 'Session', type: 'number', sortable: true },
      ]"
      :rows="analytics.data.value || []"
    />
  </AnalyticsPageShell>
</template>
