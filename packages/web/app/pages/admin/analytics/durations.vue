<script setup lang="ts">
definePageMeta({ layout: 'admin' })
const { isOwner } = useAuth()
const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/durations')
const createExport = useAnalyticsExport()
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    title="时长分析"
    description="按页面和内容查看平均有效停留、跳出率和滚动深度，识别吸引力与流失点。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('durations', analytics.range.value)"
  >
    <AnalyticsDataTable
      :columns="[
        { key: 'route_name', label: 'Route', sortable: true },
        { key: 'path', label: '路径' },
        { key: 'page_view_count', label: 'PV', type: 'number', sortable: true },
        { key: 'session_count', label: 'Session', type: 'number', sortable: true },
        { key: 'active_seconds_total', label: '总时长', type: 'duration', sortable: true },
        { key: 'average_active_seconds', label: '平均停留', type: 'duration', sortable: true },
        { key: 'bounce_rate', label: '跳出率', type: 'percent', sortable: true },
        { key: 'max_scroll_depth', label: '滚动%', type: 'number', sortable: true },
      ]"
      :rows="analytics.data.value || []"
    />
  </AnalyticsPageShell>
</template>
