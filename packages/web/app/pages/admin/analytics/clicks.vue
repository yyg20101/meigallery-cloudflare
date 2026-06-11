<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

definePageMeta({ layout: 'admin' })
const { isOwner } = useAuth()
const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/clicks')
const createExport = useAnalyticsExport()

const rows = computed(() => analytics.data.value || [])
const contactRows = computed(() => rows.value.filter(row => row.element_id === 'contact_method_click'))
const contactSummary = computed(() => {
  return contactRows.value.reduce((summary, row) => {
    summary.raw += Number(row.raw_click_count ?? 0)
    summary.effective += Number(row.effective_click_count ?? 0)
    summary.duplicate += Number(row.duplicate_click_count ?? 0)
    summary.sessions += Number(row.session_count ?? 0)
    return summary
  }, { raw: 0, effective: 0, duplicate: 0, sessions: 0 })
})
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    title="点击分析"
    description="跟踪广告、图库卡片、具体联系方式、规则入口、会员 CTA 和筛选操作的点击质量。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('clicks', analytics.range.value)"
  >
    <div class="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div class="rounded-lg border border-amber-200 bg-white p-4 text-amber-700 shadow-sm">
        <p class="text-xs font-medium text-gray-500">有效联系方式点击</p>
        <p class="mt-2 text-2xl font-semibold leading-none">{{ formatAnalyticsNumber(contactSummary.effective) }}</p>
        <p class="mt-2 truncate text-xs text-gray-400">对应 Meta Contact</p>
      </div>
      <div class="rounded-lg border border-gray-200 bg-white p-4 text-gray-950 shadow-sm">
        <p class="text-xs font-medium text-gray-500">Raw 联系点击</p>
        <p class="mt-2 text-2xl font-semibold leading-none">{{ formatAnalyticsNumber(contactSummary.raw) }}</p>
        <p class="mt-2 truncate text-xs text-gray-400">具体方式点击总量</p>
      </div>
      <div class="rounded-lg border border-gray-200 bg-white p-4 text-gray-950 shadow-sm">
        <p class="text-xs font-medium text-gray-500">重复联系点击</p>
        <p class="mt-2 text-2xl font-semibold leading-none">{{ formatAnalyticsNumber(contactSummary.duplicate) }}</p>
        <p class="mt-2 truncate text-xs text-gray-400">聚合去重参考</p>
      </div>
      <div class="rounded-lg border border-gray-200 bg-white p-4 text-gray-950 shadow-sm">
        <p class="text-xs font-medium text-gray-500">联系 Session</p>
        <p class="mt-2 text-2xl font-semibold leading-none">{{ formatAnalyticsNumber(contactSummary.sessions) }}</p>
        <p class="mt-2 truncate text-xs text-gray-400">发生具体点击的会话</p>
      </div>
    </div>

    <AnalyticsDataTable
      empty-title="暂无点击数据"
      empty-text="当前时间范围没有关键点击聚合。广告、图库卡片、具体联系方式、规则入口和筛选操作会在这里汇总。"
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
      :rows="rows"
    />
  </AnalyticsPageShell>
</template>
