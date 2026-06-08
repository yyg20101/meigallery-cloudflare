<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

definePageMeta({ layout: 'admin' })
const { isOwner } = useAuth()
const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/paths')
const createExport = useAnalyticsExport()
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    title="链路分析"
    description="查看 from route 到 to route 的聚合路径边，定位入口、详情、联系和注册之间的断点。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('paths', analytics.range.value)"
  >
    <AnalyticsDataTable
      empty-title="暂无链路数据"
      empty-text="当前时间范围没有页面跳转边。至少需要同一 session 内发生多次页面访问，才会形成链路聚合。"
      empty-action-label="查看总览"
      empty-action-to="/admin/analytics"
      :columns="[
        { key: 'from_route_label', label: '来源页面', sortable: true },
        { key: 'to_route_label', label: '去向页面', sortable: true },
        { key: 'from_path', label: 'From path' },
        { key: 'to_path', label: 'To path' },
        { key: 'transition_count', label: '跳转', type: 'number', sortable: true },
        { key: 'visitor_count', label: '访客', type: 'number', sortable: true },
        { key: 'session_count', label: 'Session', type: 'number', sortable: true },
        { key: 'conversion_count', label: '后续转化', type: 'number', sortable: true },
      ]"
      :rows="analytics.data.value || []"
    />
  </AnalyticsPageShell>
</template>
