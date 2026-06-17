<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

definePageMeta({ layout: 'admin' })
const route = useRoute()
const { isOwner } = useAuth()
const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/source-pages')
const createExport = useAnalyticsExport()

const activeSourceCode = computed(() => String(route.query.sourceCode || route.query.sourceName || '').trim())
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    v-model:date="analytics.date.value"
    title="来源内容分析"
    description="按站内归因来源查看页面访问、入口、退出、跳出、联系和注册贡献。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('source-pages', analytics.range.value, analytics.date.value)"
  >
    <div class="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-800">
      <template v-if="activeSourceCode">
        当前来源 code：<span class="font-mono">{{ activeSourceCode }}</span>。
      </template>
      本页按站内 UTM、推广链接或 referrer 归因聚合，不读取 Meta Pixel 回传。
    </div>

    <AnalyticsDataTable
      empty-title="暂无来源内容数据"
      empty-text="当前时间范围没有来源维度页面聚合。带来源访问页面后会在这里汇总。"
      empty-action-label="查看来源分析"
      empty-action-to="/admin/analytics/sources"
      :columns="[
        { key: 'source_label', label: '来源', sortable: true },
        { key: 'source_channel_label', label: '渠道', sortable: true },
        { key: 'sourceCode', label: 'code', sortable: true },
        { key: 'route_label', label: '页面', sortable: true },
        { key: 'path', label: '路径' },
        { key: 'page_view_count', label: 'PV', type: 'number', sortable: true },
        { key: 'visitor_count', label: '访客', type: 'number', sortable: true },
        { key: 'session_count', label: 'Session', type: 'number', sortable: true },
        { key: 'entry_count', label: '入口', type: 'number', sortable: true },
        { key: 'exit_count', label: '退出', type: 'number', sortable: true },
        { key: 'bounce_count', label: '跳出', type: 'number', sortable: true },
        { key: 'contact_click_count', label: '联系', type: 'number', sortable: true },
        { key: 'register_count', label: '注册', type: 'number', sortable: true },
        { key: 'active_seconds_total', label: '有效时长', type: 'duration', sortable: true },
      ]"
      :rows="analytics.data.value || []"
    />
  </AnalyticsPageShell>
</template>
