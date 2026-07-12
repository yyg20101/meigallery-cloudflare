<script setup lang="ts">
import type { AttributionSummaryData, MetaConnectionStatusData } from '~/composables/useAdminAttribution'
import {
  canVerifyMetaConnection,
  metaConnectionReasonLabel,
  metaConnectionStateLabel,
} from '~/composables/useAdminAttribution'

const props = withDefaults(defineProps<{
  connection: MetaConnectionStatusData | null
  activity?: AttributionSummaryData | null
  isOwner?: boolean
}>(), {
  activity: null,
  isOwner: false,
})
const emit = defineEmits<{ refreshed: [] }>()
const { api } = useApi()
const { sendMetaLiveChallenge } = useTracking()
const verifying = ref(false)
const evidencing = ref(false)
const message = ref('')
const messageTone = ref<'success' | 'error'>('success')
const canVerify = computed(() => canVerifyMetaConnection(props.connection, props.isOwner))
const busy = computed(() => verifying.value || evidencing.value)

const connectionItems = computed(() => [
  { label: '连接验证', value: props.connection ? metaConnectionStateLabel(props.connection.state) : '未确认', ok: props.connection?.state === 'verified' },
  { label: 'Pixel ID', value: props.connection?.pixelIdConfigured ? '已配置' : '未配置', ok: props.connection?.pixelIdConfigured === true },
  { label: 'CAPI token', value: props.connection?.tokenConfigured ? '已配置' : '未配置', ok: props.connection?.tokenConfigured === true },
  { label: 'Graph API', value: props.connection?.graphApiVersion || '未确认', ok: Boolean(props.connection?.graphApiVersion) },
])

async function verifyConnection() {
  if (busy.value) return
  verifying.value = true
  message.value = ''
  try {
    const response = await api<{ data: { status?: string; eventsReceived?: number } }>('/api/admin/attribution/meta/test-event', { method: 'POST' })
    if (response.data.status !== 'verified' || response.data.eventsReceived !== 1) throw new Error('Meta 未确认接收测试事件')
    messageTone.value = 'success'
    message.value = 'MetaConnection 验证成功'
    emit('refreshed')
  }
  catch (error) {
    messageTone.value = 'error'
    message.value = resolveApiErrorMessage(error, 'MetaConnection 验证失败')
  }
  finally {
    verifying.value = false
  }
}

async function runLiveEvidence() {
  if (busy.value) return
  if (props.connection?.environment !== 'production') return
  evidencing.value = true
  message.value = ''
  try {
    const challenge = await api<{ data: {
      challengeId: string
      pixelId: string
      eventIds: { Contact: string; CompleteRegistration: string }
    } }>('/api/admin/attribution/meta/live-challenge', { method: 'POST' })
    if (!sendMetaLiveChallenge(challenge.data)) throw new Error('浏览器 Pixel 事件发送失败')
    const consumed = await api<{ data: { status?: string; eventsReceived?: number } }>(
      '/api/admin/attribution/meta/live-challenge/consume',
      { method: 'POST', body: { challengeId: challenge.data.challengeId } },
    )
    if (consumed.data.status !== 'server_sent' || consumed.data.eventsReceived !== 2) {
      throw new Error('Meta 未确认接收两条服务端测试事件')
    }
    messageTone.value = 'success'
    message.value = 'Browser 与 Server 测试事件已发送，请在 Events Manager 确认去重后记录证据'
    emit('refreshed')
  }
  catch (error) {
    messageTone.value = 'error'
    message.value = resolveApiErrorMessage(error, 'Live Evidence 执行失败')
  }
  finally {
    evidencing.value = false
  }
}
</script>

<template>
  <div data-meta-connection-status class="min-w-0">
    <div class="grid min-w-0 grid-cols-2 border-y border-gray-200 lg:grid-cols-4">
      <div v-for="item in connectionItems" :key="item.label" class="min-w-0 border-b border-gray-100 px-3 py-3 lg:border-b-0 lg:not-last:border-r">
        <p class="text-xs text-gray-500">{{ item.label }}</p>
        <p :class="item.ok ? 'text-emerald-700' : 'text-amber-700'" class="mt-1 truncate text-sm font-semibold">{{ item.value }}</p>
      </div>
    </div>
    <div class="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <p class="min-w-0 text-xs leading-5 text-gray-500">
        {{ connection ? metaConnectionReasonLabel(connection.invalidationReason) : '连接状态未返回' }}
        <span v-if="connection"> · {{ connection.environment }}</span>
      </p>
      <div v-if="canVerify" class="flex shrink-0 gap-2">
        <button
          data-meta-connection-verify
          class="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
          type="button"
          :disabled="busy"
          @click="verifyConnection"
        >
          {{ verifying ? '验证中...' : '验证连接' }}
        </button>
        <button
          v-if="connection?.environment === 'production'"
          data-meta-live-evidence
          class="rounded-md bg-gray-950 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
          type="button"
          :disabled="busy"
          @click="runLiveEvidence"
        >
          {{ evidencing ? '执行中...' : 'Live Evidence' }}
        </button>
      </div>
    </div>
    <p v-if="message" role="status" :class="messageTone === 'error' ? 'text-red-700' : 'text-emerald-700'" class="mt-2 text-sm">{{ message }}</p>
  </div>
</template>
