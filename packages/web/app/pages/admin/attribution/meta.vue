<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsMetricCard from '~/components/admin/analytics/AnalyticsMetricCard.vue'
import AttributionHealthStrip from '~/components/admin/attribution/AttributionHealthStrip.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import type { MetaConnectionStatus } from '~/composables/useAdminAttribution'
import {
  canVerifyMetaConnection,
  metaConnectionReasonLabel,
  metaConnectionStateLabel,
} from '~/composables/useAdminAttribution'

definePageMeta({ layout: 'admin' })

interface MetaData {
  totals: Record<string, unknown>
  deliveries: Array<Record<string, unknown>>
  lastSentAt: string
  queueBindingPresent?: boolean
  connection: MetaConnectionStatus
  keyRotation: MetaCapiKeyRotationStatus
  settings: Record<string, unknown>
}

interface MetaCapiKeyRotationStatus {
  currentKeyValid: boolean
  previousKeyConfigured: boolean
  previousKeyValid: boolean
  previousSameAsCurrent: boolean
  previousOutboxCount: number
  previousActiveDeliveryCount: number
  canRemovePrevious: boolean
}

const { api } = useApi()
const { isOwner } = useAuth()
const toast = useToast()
const attribution = useAdminAttribution<MetaData>('/api/admin/attribution/meta')
const testing = ref(false)

const data = computed(() => attribution.data.value)
const totals = computed(() => data.value?.totals ?? {})
const settings = computed(() => data.value?.settings ?? {})
const connection = computed(() => data.value?.connection ?? null)
const keyRotation = computed<MetaCapiKeyRotationStatus>(() => data.value?.keyRotation ?? {
  currentKeyValid: false,
  previousKeyConfigured: false,
  previousKeyValid: false,
  previousSameAsCurrent: false,
  previousOutboxCount: 0,
  previousActiveDeliveryCount: 0,
  canRemovePrevious: false,
})
const connectionCanVerify = computed(() => canVerifyMetaConnection(connection.value, isOwner.value))

const keyRotationHint = computed(() => {
  const status = keyRotation.value
  if (!status.currentKeyValid) return '当前密钥无效，禁止轮换操作'
  if (!status.previousKeyConfigured) return '未配置上一把密钥'
  if (!status.previousKeyValid) return '上一把密钥无效，禁止移除'
  if (status.previousSameAsCurrent) return '上一把密钥与当前密钥相同，可移除冗余配置'
  if (status.canRemovePrevious) return '引用已清零，可移除上一把密钥'
  return '仍有引用，暂不可移除'
})

function presenceStatus(present: boolean | undefined, configuredLabels = false) {
  return present === true
    ? { value: configuredLabels ? '已配置' : '存在', tone: 'green' as const }
    : { value: configuredLabels ? '未配置' : '缺失', tone: 'red' as const }
}

const metrics = computed(() => [
  { label: 'Meta 模式', value: String(settings.value.meta_tracking_mode || 'disabled'), hint: settings.value.meta_capi_enabled === true ? 'CAPI 开关已开启' : 'CAPI 开关关闭', tone: settings.value.meta_tracking_mode === 'production' ? 'blue' as const : 'default' as const },
  { label: 'Pixel ID 配置', ...presenceStatus(connection.value?.pixelIdConfigured, true), hint: '仅展示配置状态' },
  { label: 'CAPI token 配置', ...presenceStatus(connection.value?.tokenConfigured, true), hint: '仅展示配置状态' },
  { label: 'Test Event Code', ...presenceStatus(connection.value?.testEventCodeConfigured, true), hint: '仅展示配置状态' },
  {
    label: '连接验证',
    value: connection.value ? metaConnectionStateLabel(connection.value.state) : '未确认',
    hint: connection.value ? metaConnectionReasonLabel(connection.value.invalidationReason) : '连接状态未返回',
    tone: connection.value?.state === 'verified'
      ? 'green' as const
      : connection.value?.state === 'configuration_changed'
        ? 'red' as const
        : 'gold' as const,
  },
  { label: 'Graph API', value: connection.value?.graphApiVersion || '未确认', hint: `环境：${connection.value?.environment || '未确认'}`, tone: 'blue' as const },
  { label: '验证时间', value: formatAnalyticsDateTime(connection.value?.verifiedAt), hint: connection.value?.verifiedCommit ? `commit ${connection.value.verifiedCommit.slice(0, 12)}` : '尚无验证 commit', tone: connection.value?.verifiedAt ? 'green' as const : 'default' as const },
  { label: 'Queue binding', ...presenceStatus(data.value?.queueBindingPresent), hint: 'API Worker 运行时绑定状态' },
  { label: '重试耗尽', value: formatAnalyticsNumber(totals.value.retry_exhausted_count), hint: 'failed / retry_exhausted', tone: Number(totals.value.retry_exhausted_count ?? 0) > 0 ? 'red' as const : 'default' as const },
  { label: '最近 CAPI 成功', value: formatAnalyticsDateTime(data.value?.lastSentAt), hint: `CAPI sent ${formatAnalyticsNumber(totals.value.capi_sent_count)}`, tone: 'green' as const },
])

async function sendTestEvent() {
  testing.value = true
  try {
    const response = await api<{ data: { status?: string; eventsReceived?: number; connection?: MetaConnectionStatus } }>('/api/admin/attribution/meta/test-event', { method: 'POST' })
    if (response.data.status !== 'verified' || response.data.eventsReceived !== 1) {
      throw new Error('Meta 未确认接收测试事件')
    }
    toast.add({ title: 'MetaConnection 验证成功', color: 'success' })
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

      <section data-meta-key-rotation class="border-y border-gray-200 py-4">
        <div class="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <h2 class="text-sm font-semibold text-gray-900">数据密钥轮换</h2>
          <p class="text-sm" :class="keyRotation.canRemovePrevious && keyRotation.previousKeyConfigured ? 'text-emerald-700' : 'text-gray-600'">
            {{ keyRotationHint }}
          </p>
        </div>
        <dl class="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-4">
          <div>
            <dt class="text-gray-500">当前密钥</dt>
            <dd class="mt-1 font-medium text-gray-900">{{ keyRotation.currentKeyValid ? '有效' : '无效' }}</dd>
          </div>
          <div>
            <dt class="text-gray-500">上一把密钥</dt>
            <dd class="mt-1 font-medium text-gray-900">
              {{ !keyRotation.previousKeyConfigured ? '未配置' : keyRotation.previousKeyValid ? '有效' : '无效' }}
            </dd>
          </div>
          <div>
            <dt class="text-gray-500">Outbox 残留</dt>
            <dd class="mt-1 font-medium tabular-nums text-gray-900">{{ keyRotation.previousOutboxCount }}</dd>
          </div>
          <div>
            <dt class="text-gray-500">活动 delivery</dt>
            <dd class="mt-1 font-medium tabular-nums text-gray-900">{{ keyRotation.previousActiveDeliveryCount }}</dd>
          </div>
        </dl>
      </section>

      <section class="space-y-3">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="text-sm font-semibold text-gray-900">投递分类</h2>
            <p class="mt-1 text-sm text-gray-500">按 channel、事件名、状态和跳过原因聚合。</p>
          </div>
          <button v-if="connectionCanVerify" data-meta-connection-verify class="rounded-lg bg-gray-950 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60" type="button" :disabled="testing" @click="sendTestEvent">
            {{ testing ? '验证中...' : '验证 MetaConnection' }}
          </button>
          <p v-else-if="isOwner && connection?.environment === 'production'" class="text-sm text-amber-700">production 验证门禁尚未开放</p>
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
