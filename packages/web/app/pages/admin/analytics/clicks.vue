<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

definePageMeta({ layout: 'admin' })
const { isOwner } = useAuth()
const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/clicks')
const createExport = useAnalyticsExport()

interface ContactClickSummary {
  raw: number
  effective: number
  duplicate: number
  visitors: number
  sessions: number
}

const rows = computed(() => analytics.data.value || [])
const contactRows = computed(() => rows.value.filter(row => row.element_id === 'contact_conversion'))
const contactSummary = computed(() => {
  return contactRows.value.reduce<ContactClickSummary>((summary, row) => {
    summary.raw += Number(row.raw_click_count ?? 0)
    summary.effective += Number(row.effective_click_count ?? 0)
    summary.duplicate += Number(row.duplicate_click_count ?? 0)
    summary.visitors += Number(row.visitor_count ?? 0)
    summary.sessions += Number(row.session_count ?? 0)
    return summary
  }, { raw: 0, effective: 0, duplicate: 0, visitors: 0, sessions: 0 })
})
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    v-model:date="analytics.date.value"
    title="点击分析"
    description="Contact 使用唯一转化事实；广告、图库卡片、规则入口、会员 CTA 和筛选操作使用站内行为聚合。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('clicks', analytics.range.value, analytics.date.value)"
  >
    <div class="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div class="rounded-lg border border-amber-200 bg-white p-4 text-amber-700 shadow-sm">
        <p class="text-xs font-medium text-gray-500">有效联系</p>
        <p class="mt-2 text-2xl font-semibold leading-none">{{ formatAnalyticsNumber(contactSummary.effective) }}</p>
        <p class="mt-2 truncate text-xs text-gray-400">唯一转化事实口径</p>
      </div>
      <div class="rounded-lg border border-gray-200 bg-white p-4 text-gray-950 shadow-sm">
        <p class="text-xs font-medium text-gray-500">联系访客</p>
        <p class="mt-2 text-2xl font-semibold leading-none">{{ formatAnalyticsNumber(contactSummary.visitors) }}</p>
        <p class="mt-2 truncate text-xs text-gray-400">产生有效联系的访客</p>
      </div>
      <div class="rounded-lg border border-gray-200 bg-white p-4 text-gray-950 shadow-sm">
        <p class="text-xs font-medium text-gray-500">联系 Session</p>
        <p class="mt-2 text-2xl font-semibold leading-none">{{ formatAnalyticsNumber(contactSummary.sessions) }}</p>
        <p class="mt-2 truncate text-xs text-gray-400">产生有效联系的会话</p>
      </div>
      <div class="rounded-lg border border-gray-200 bg-white p-4 text-gray-950 shadow-sm">
        <p class="text-xs font-medium text-gray-500">重复事实</p>
        <p class="mt-2 text-2xl font-semibold leading-none">{{ formatAnalyticsNumber(contactSummary.duplicate) }}</p>
        <p class="mt-2 truncate text-xs text-gray-400">事实表唯一约束保障为 0</p>
      </div>
    </div>

    <AnalyticsDataTable
      empty-title="暂无点击数据"
      empty-text="当前时间范围没有有效联系事实或关键行为点击。"
      empty-action-label="查看采集健康"
      empty-action-to="/admin/analytics/health"
      :columns="[
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
      :rows="rows"
    />
  </AnalyticsPageShell>
</template>
