<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

definePageMeta({ layout: 'admin' })
const { isOwner } = useAuth()
const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/sources')
const createExport = useAnalyticsExport()

</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    v-model:date="analytics.date.value"
    title="来源分析"
    description="比较站内归因来源的访问、详情、联系、注册和会员发放，优先判断来源质量。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('sources', analytics.range.value, analytics.date.value)"
  >
    <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section class="space-y-4">
        <div>
          <h2 class="text-sm font-semibold text-gray-900">来源表现</h2>
          <p class="mt-1 text-sm text-gray-500">自动归因结果包含邀请码、推广来源、UTM、referrer 和直接访问；FB/Facebook 不是 Pixel 回传。</p>
        </div>
        <div class="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-900">
          FB、Facebook 或 Meta 来源来自站内 UTM、推广链接或 referrer；Meta Pixel 只用于向 Meta 后台发送 Contact、CompleteRegistration 转化事件。
        </div>
        <AnalyticsDataTable
          empty-title="暂无来源数据"
          empty-text="当前时间范围没有来源聚合。创建推广来源或产生前台访问后，系统会按来源渠道归因。"
          empty-action-label="查看采集健康"
          empty-action-to="/admin/analytics/health"
          :columns="[
            { key: 'source_channel_label', label: '渠道', sortable: true },
            { key: 'source_label', label: '来源', sortable: true },
            { key: 'sourceCode', label: 'code', sortable: true },
            { key: 'invite_code_id', label: '邀请码' },
            { key: 'visitor_count', label: '访客', type: 'number', sortable: true },
            { key: 'session_count', label: 'Session', type: 'number', sortable: true },
            { key: 'page_view_count', label: 'PV', type: 'number', sortable: true },
            { key: 'gallery_detail_count', label: '详情', type: 'number', sortable: true },
            { key: 'contact_click_count', label: '联系入口', type: 'number', sortable: true },
            { key: 'register_count', label: '注册', type: 'number', sortable: true },
            { key: 'membership_grant_count', label: '会员', type: 'number', sortable: true },
            { key: 'active_seconds_total', label: '有效时长', type: 'duration', sortable: true },
          ]"
          :rows="analytics.data.value || []"
        />
      </section>

      <aside class="space-y-4">
        <section class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-sm font-semibold text-gray-900">投放追踪链接</h2>
              <p class="mt-1 text-xs leading-5 text-gray-500">投放链接统一在归因中心创建并绑定平台；本页只分析来源数据。</p>
            </div>
            <NuxtLink to="/admin/attribution/links" class="inline-flex items-center rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
              管理投放追踪链接
            </NuxtLink>
          </div>
        </section>
      </aside>
    </div>
  </AnalyticsPageShell>
</template>
