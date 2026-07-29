<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

definePageMeta({ layout: 'admin' })
const route = useRoute()
const { isOwner } = useAuth()
const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/source-clicks')
const createExport = useAnalyticsExport()

const activeSourceCode = computed(() => String(route.query.sourceCode || route.query.sourceName || '').trim())
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    v-model:date="analytics.date.value"
    title="来源点击分析"
    description="按站内归因来源查看有效联系事实与其他关键行为点击。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('source-clicks', analytics.range.value, analytics.date.value)"
  >
    <div class="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-800">
      <template v-if="activeSourceCode">
        当前来源 code：<span class="font-mono">{{ activeSourceCode }}</span>。
      </template>
      Contact 直接读取唯一转化事实；其他点击读取站内行为聚合。本页不读取广告平台回传。
    </div>

    <AnalyticsDataTable
      empty-title="暂无来源点击数据"
      empty-text="当前时间范围没有来源维度点击聚合。带来源产生关键点击后会在这里汇总。"
      empty-action-label="查看来源分析"
      empty-action-to="/admin/analytics/sources"
      :columns="[
        { key: 'source_label', label: '来源', sortable: true },
        { key: 'source_channel_label', label: '渠道', sortable: true },
        { key: 'sourceCode', label: 'code', sortable: true },
        { key: 'element_label', label: '点击元素', sortable: true },
        { key: 'element_type_label', label: '类型' },
        { key: 'location_label', label: '位置', sortable: true },
        { key: 'target_label', label: '目标' },
        { key: 'raw_click_count', label: 'Raw', type: 'number', sortable: true },
        { key: 'effective_click_count', label: '去重', type: 'number', sortable: true },
        { key: 'duplicate_click_count', label: '重复', type: 'number', sortable: true },
        { key: 'visitor_count', label: '访客', type: 'number', sortable: true },
        { key: 'session_count', label: 'Session', type: 'number', sortable: true },
      ]"
      :rows="analytics.data.value || []"
    />
  </AnalyticsPageShell>
</template>
