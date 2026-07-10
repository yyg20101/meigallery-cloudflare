<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsMetricCard from '~/components/admin/analytics/AnalyticsMetricCard.vue'
import AttributionHealthStrip from '~/components/admin/attribution/AttributionHealthStrip.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'

definePageMeta({ layout: 'admin' })

interface MetaData {
  totals: Record<string, unknown>
  deliveries: Array<Record<string, unknown>>
  lastSentAt: string
  secretPresent?: boolean
  testEventCodePresent?: boolean
  queueBindingPresent?: boolean
  settings: Record<string, unknown>
}

const { api } = useApi()
const { isOwner } = useAuth()
const toast = useToast()
const attribution = useAdminAttribution<MetaData>('/api/admin/attribution/meta')
const testing = ref(false)

const data = computed(() => attribution.data.value)
const totals = computed(() => data.value?.totals ?? {})
const settings = computed(() => data.value?.settings ?? {})
function presenceStatus(present: boolean | undefined) {
  return present === true
    ? { value: '存在', tone: 'green' as const }
    : { value: '缺失', tone: 'red' as const }
}

const metrics = computed(() => [
  { label: 'Meta 模式', value: String(settings.value.meta_tracking_mode || 'disabled'), hint: settings.value.meta_capi_enabled === true ? 'CAPI 开关已开启' : 'CAPI 开关关闭', tone: settings.value.meta_tracking_mode === 'production' ? 'blue' as const : 'default' as const },
  { label: 'CAPI token', ...presenceStatus(data.value?.secretPresent), hint: '仅展示布尔状态，不返回凭证' },
  { label: 'Test Event Code', ...presenceStatus(data.value?.testEventCodePresent), hint: '仅展示布尔状态，不返回 code' },
  { label: 'Queue binding', ...presenceStatus(data.value?.queueBindingPresent), hint: 'API Worker 运行时绑定状态' },
  { label: '重试耗尽', value: formatAnalyticsNumber(totals.value.retry_exhausted_count), hint: 'failed / retry_exhausted', tone: Number(totals.value.retry_exhausted_count ?? 0) > 0 ? 'red' as const : 'default' as const },
  { label: '最近 CAPI 成功', value: formatAnalyticsDateTime(data.value?.lastSentAt), hint: `CAPI sent ${formatAnalyticsNumber(totals.value.capi_sent_count)}`, tone: 'green' as const },
])

async function sendTestEvent() {
  testing.value = true
  try {
    const response = await api<{ data: { status?: string; eventsReceived?: number } }>('/api/admin/attribution/meta/test-event', { method: 'POST' })
    if (response.data.status !== 'sent' || response.data.eventsReceived !== 1) {
      throw new Error('Meta 未确认接收测试事件')
    }
    toast.add({ title: 'Meta 已接收 1 条测试事件', color: 'success' })
    await attribution.refresh()
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, 'Test Event 触发失败'), color: 'error' })
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <AttributionPageShell
    v-model:range="attribution.range.value"
    v-model:date="attribution.date.value"
    title="Meta 同步"
    description="查看 Pixel、CAPI、事件投递状态、错误分类和最近成功时间。"
    :loading="attribution.loading.value"
    :error="attribution.error.value"
    :usage="attribution.usage.value"
    @refresh="attribution.refresh"
  >
    <template v-if="data">
      <AttributionHealthStrip
        :pixel-enabled="settings.facebook_pixel_enabled === true"
        :capi-enabled="settings.meta_capi_enabled === true"
        :pixel-attempted-count="Number(totals.pixel_attempted_count ?? 0)"
        :capi-sent-count="Number(totals.capi_sent_count ?? 0)"
        :failed-count="Number(totals.capi_failed_count ?? 0)"
        :skipped-count="Number(totals.capi_skipped_count ?? 0)"
        :last-sent-at="data.lastSentAt"
      />

      <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <AnalyticsMetricCard v-for="metric in metrics" :key="metric.label" v-bind="metric" />
      </div>

      <section class="space-y-3">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="text-sm font-semibold text-gray-900">投递分类</h2>
            <p class="mt-1 text-sm text-gray-500">按 channel、事件名、状态和跳过原因聚合。</p>
          </div>
          <button v-if="isOwner" class="rounded-lg bg-gray-950 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60" type="button" :disabled="testing" @click="sendTestEvent">
            {{ testing ? '发送中...' : '发送 Test Event' }}
          </button>
        </div>
        <AnalyticsDataTable
          empty-title="暂无 Meta 投递"
          empty-text="可映射的转化事件产生后，会在这里展示 Pixel 和 CAPI 投递状态。"
          :columns="[
            { key: 'channel', label: '渠道', sortable: true },
            { key: 'event_name', label: '事件', sortable: true },
            { key: 'status', label: '状态', sortable: true },
            { key: 'skip_reason', label: '原因' },
            { key: 'delivery_count', label: '次数', type: 'number', sortable: true },
          ]"
          :rows="data.deliveries"
          compact
        />
      </section>
    </template>
  </AttributionPageShell>
</template>
