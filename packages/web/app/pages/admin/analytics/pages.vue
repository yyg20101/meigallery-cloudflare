<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

definePageMeta({ layout: 'admin' })
const { isOwner } = useAuth()
const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/pages')
const createExport = useAnalyticsExport()
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    title="内容分析"
    description="查看页面、图库和标签结果页的访问、入口、退出、跳出和转化贡献。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('pages', analytics.range.value)"
  >
    <AnalyticsDataTable
      empty-title="暂无内容数据"
      empty-text="当前时间范围没有页面聚合。访问首页、搜索页、图库详情或真实案例后会生成页面价值数据。"
      empty-action-label="查看总览"
      empty-action-to="/admin/analytics"
      :columns="[
        { key: 'route_name', label: 'Route', sortable: true },
        { key: 'path', label: '路径' },
        { key: 'page_title', label: '标题' },
        { key: 'page_view_count', label: 'PV', type: 'number', sortable: true },
        { key: 'visitor_count', label: '访客', type: 'number', sortable: true },
        { key: 'entry_count', label: '入口', type: 'number', sortable: true },
        { key: 'exit_count', label: '退出', type: 'number', sortable: true },
        { key: 'bounce_count', label: '跳出', type: 'number', sortable: true },
        { key: 'active_seconds_total', label: '有效时长', type: 'duration', sortable: true },
        { key: 'max_scroll_depth', label: '滚动%', type: 'number', sortable: true },
      ]"
      :rows="analytics.data.value || []"
    />
  </AnalyticsPageShell>
</template>
