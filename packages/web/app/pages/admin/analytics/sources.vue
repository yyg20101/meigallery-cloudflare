<script setup lang="ts">
definePageMeta({ layout: 'admin' })
const { isOwner } = useAuth()
const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/sources')
const createExport = useAnalyticsExport()
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    title="来源分析"
    description="比较不同来源的访问、详情、联系、注册和会员发放，优先判断来源质量。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('sources', analytics.range.value)"
  >
    <AnalyticsDataTable
      :columns="[
        { key: 'source_channel', label: '渠道', sortable: true },
        { key: 'source_name', label: '来源', sortable: true },
        { key: 'invite_code_id', label: '邀请码' },
        { key: 'visitor_count', label: '访客', type: 'number', sortable: true },
        { key: 'session_count', label: 'Session', type: 'number', sortable: true },
        { key: 'page_view_count', label: 'PV', type: 'number', sortable: true },
        { key: 'gallery_detail_count', label: '详情', type: 'number', sortable: true },
        { key: 'contact_click_count', label: '联系', type: 'number', sortable: true },
        { key: 'register_count', label: '注册', type: 'number', sortable: true },
        { key: 'membership_grant_count', label: '会员', type: 'number', sortable: true },
        { key: 'active_seconds_total', label: '有效时长', type: 'duration', sortable: true },
      ]"
      :rows="analytics.data.value || []"
    />
  </AnalyticsPageShell>
</template>
