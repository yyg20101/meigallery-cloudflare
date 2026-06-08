<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

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
      empty-title="暂无时长数据"
      empty-text="当前时间范围没有页面停留聚合。页面可见时长、路由切换和 pagehide 事件上报后会在这里展示。"
      empty-action-label="查看内容分析"
      empty-action-to="/admin/analytics/pages"
      :columns="[
        { key: 'route_label', label: '页面', sortable: true },
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
