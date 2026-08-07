<script setup lang="ts">
import type {
  AdminNotificationCategory,
  AdminNotificationDefinition,
  AdminNotificationDelivery,
  AdminNotificationDeliveryStatus,
  AdminNotificationOverview,
  AdminNotificationTemplate,
} from '~/types/admin-app-notifications'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const activeTab = ref<'events' | 'templates' | 'deliveries'>('events')
const deliveryStatus = ref<AdminNotificationDeliveryStatus | ''>('')
const deliveryCategory = ref<AdminNotificationCategory | ''>('')
const errorMessage = ref('')
const tabs: Array<{ key: 'events' | 'templates' | 'deliveries'; label: string }> = [
  { key: 'events', label: '事件定义' },
  { key: 'templates', label: '安全模板' },
  { key: 'deliveries', label: '投影记录' },
]

const categories: Array<{ value: AdminNotificationCategory; label: string }> = [
  { value: 'message', label: '消息' },
  { value: 'interaction', label: '互动' },
  { value: 'membership_coin', label: '会员与金币' },
  { value: 'system_security', label: '系统与安全' },
  { value: 'marketing', label: '活动' },
]
const deliveryStatuses: AdminNotificationDeliveryStatus[] = [
  'pending',
  'processing',
  'delivered',
  'suppressed',
  'failed',
  'dead_letter',
]

const { data: overviewData, status: overviewStatus, refresh: refreshOverview } = await useAsyncData(
  'admin-app-notification-overview',
  async () => api<{ data: AdminNotificationOverview }>('/api/admin/app/notifications/overview'),
)
const { data: eventData, status: eventStatus, refresh: refreshEvents } = await useAsyncData(
  'admin-app-notification-events',
  async () => api<{ data: AdminNotificationDefinition[] }>('/api/admin/app/notifications/events'),
)
const { data: templateData, status: templateStatus, refresh: refreshTemplates } = await useAsyncData(
  'admin-app-notification-templates',
  async () => api<{ data: AdminNotificationTemplate[] }>('/api/admin/app/notifications/templates'),
)
const { data: deliveryData, status: deliveryLoadStatus, refresh: refreshDeliveries } = await useAsyncData(
  'admin-app-notification-deliveries',
  async () => api<{ data: AdminNotificationDelivery[] }>('/api/admin/app/notifications/deliveries', {
    query: {
      status: deliveryStatus.value || undefined,
      category: deliveryCategory.value || undefined,
      limit: 100,
    },
  }),
  { watch: [deliveryStatus, deliveryCategory] },
)

const overview = computed(() => overviewData.value?.data ?? null)
const definitions = computed(() => eventData.value?.data ?? [])
const templates = computed(() => templateData.value?.data ?? [])
const deliveries = computed(() => deliveryData.value?.data ?? [])
const isLoading = computed(() => [
  overviewStatus.value,
  eventStatus.value,
  templateStatus.value,
  deliveryLoadStatus.value,
].some(value => value === 'pending'))

async function refreshAll() {
  errorMessage.value = ''
  try {
    await Promise.all([refreshOverview(), refreshEvents(), refreshTemplates(), refreshDeliveries()])
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '通知运行数据刷新失败。')
  }
}

function categoryLabel(value: AdminNotificationCategory) {
  return categories.find(item => item.value === value)?.label ?? value
}

function statusLabel(value: AdminNotificationDeliveryStatus) {
  return {
    pending: '待投影',
    processing: '处理中',
    delivered: '已投影',
    suppressed: '已按偏好抑制',
    failed: '待重试',
    dead_letter: '死信',
  }[value]
}

function formatTime(value: string | null) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function apiErrorMessage(error: unknown, fallback: string) {
  if (!error || typeof error !== 'object') return fallback
  const candidate = error as { data?: { message?: unknown }; message?: unknown }
  if (typeof candidate.data?.message === 'string') return candidate.data.message
  if (typeof candidate.message === 'string' && candidate.message.length < 180) return candidate.message
  return fallback
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <section class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h1 class="text-xl font-semibold text-gray-900">站内通知运行台</h1>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
          只读查看事件定义、安全模板和 D1 Outbox 投影状态。本页不展示话题正文、审核证据、内部备注或访问凭证。
        </p>
      </div>
      <button class="shrink-0 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50" :disabled="isLoading" @click="refreshAll">
        {{ isLoading ? '刷新中…' : '刷新' }}
      </button>
    </section>

    <p v-if="errorMessage" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {{ errorMessage }}
    </p>

    <section v-if="overview" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <article class="rounded-xl border border-gray-200 bg-white p-4">
        <p class="text-xs text-gray-500">事件生成</p>
        <p class="mt-2 text-lg font-semibold" :class="overview.policy.generationEnabled ? 'text-emerald-700' : 'text-gray-900'">
          {{ overview.policy.generationEnabled ? '已开启' : '已关闭' }}
        </p>
        <p class="mt-1 break-all text-xs text-gray-500">{{ overview.policy.policyId }}</p>
      </article>
      <article class="rounded-xl border border-gray-200 bg-white p-4">
        <p class="text-xs text-gray-500">生产门禁</p>
        <p class="mt-2 text-lg font-semibold text-gray-900">
          {{ overview.policy.productionReady ? '已通过' : '未通过' }}
        </p>
        <p class="mt-1 text-xs text-gray-500">{{ overview.policy.state }} · 最低 App {{ overview.policy.minimumClientVersion }}</p>
      </article>
      <article class="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <p class="text-xs text-amber-700">保留期决策</p>
        <p class="mt-2 text-lg font-semibold text-amber-900">
          {{ overview.policy.decisionStatus === 'approved' ? '已批准' : '待决策' }}
        </p>
        <p class="mt-1 text-xs leading-5 text-amber-800">
          {{ overview.policy.retentionDays ? `${overview.policy.retentionDays} 天` : '未设定；禁止自动清理' }}
        </p>
      </article>
      <article class="rounded-xl border border-gray-200 bg-white p-4">
        <p class="text-xs text-gray-500">Outbox 异常</p>
        <p class="mt-2 text-lg font-semibold text-gray-900">
          {{ (overview.outbox.failed ?? 0) + (overview.outbox.dead_letter ?? 0) }}
        </p>
        <p class="mt-1 text-xs text-gray-500">待重试 {{ overview.outbox.failed ?? 0 }} · 死信 {{ overview.outbox.dead_letter ?? 0 }}</p>
      </article>
    </section>

    <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div class="flex min-w-0 gap-1 overflow-x-auto border-b border-gray-200 p-2">
        <button v-for="tab in tabs" :key="tab.key" class="shrink-0 rounded-lg px-4 py-2 text-sm font-medium" :class="activeTab === tab.key ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'" @click="activeTab = tab.key">
          {{ tab.label }}
        </button>
      </div>

      <div v-if="activeTab === 'events'" class="min-w-0 overflow-x-auto">
        <table class="w-full min-w-[980px] text-left text-sm">
          <thead class="bg-gray-50 text-xs text-gray-500"><tr><th class="px-4 py-3">事件</th><th class="px-4 py-3">分类</th><th class="px-4 py-3">必要性</th><th class="px-4 py-3">目标 / 动作</th><th class="px-4 py-3">模板</th><th class="px-4 py-3">状态</th></tr></thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="item in definitions" :key="item.definitionId" class="align-top">
              <td class="px-4 py-3"><p class="font-medium text-gray-900">{{ item.eventType }}</p><p class="mt-1 text-xs text-gray-500">{{ item.sourceDomain }} · {{ item.privacyLevel }}</p></td>
              <td class="px-4 py-3 text-gray-700">{{ categoryLabel(item.category) }}</td>
              <td class="px-4 py-3 text-gray-700">{{ item.necessity === 'required' ? '必要通知' : `可关闭：${item.preferenceKey}` }}</td>
              <td class="px-4 py-3 text-gray-700"><p>{{ item.targetType }}</p><p class="mt-1 text-xs text-gray-500">{{ item.action }}</p></td>
              <td class="px-4 py-3 text-gray-700">{{ item.template?.version ?? '缺少' }}</td>
              <td class="px-4 py-3"><span class="rounded-full px-2 py-1 text-xs" :class="item.active ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'">{{ item.active ? '启用' : '未启用' }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-else-if="activeTab === 'templates'" class="grid gap-3 p-4 lg:grid-cols-2">
        <article v-for="item in templates" :key="item.templateId" class="min-w-0 rounded-xl border border-gray-200 p-4">
          <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><p class="break-all text-xs text-gray-500">{{ item.eventType }}</p><h3 class="mt-2 font-semibold text-gray-900">{{ item.title }}</h3></div><span class="shrink-0 rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600">{{ item.state }}</span></div>
          <p class="mt-3 text-sm leading-6 text-gray-700">{{ item.summary }}</p>
          <p class="mt-2 rounded-lg bg-gray-50 p-3 text-sm leading-6 text-gray-600">{{ item.body }}</p>
          <p class="mt-3 break-all text-xs text-gray-400">{{ item.version }} · {{ item.locale }}</p>
        </article>
      </div>

      <div v-else class="min-w-0">
        <div class="flex flex-wrap gap-3 border-b border-gray-200 p-4">
          <select v-model="deliveryStatus" class="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"><option value="">全部状态</option><option v-for="value in deliveryStatuses" :key="value" :value="value">{{ statusLabel(value) }}</option></select>
          <select v-model="deliveryCategory" class="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"><option value="">全部分类</option><option v-for="item in categories" :key="item.value" :value="item.value">{{ item.label }}</option></select>
        </div>
        <div class="min-w-0 overflow-x-auto">
          <table class="w-full min-w-[980px] text-left text-sm">
            <thead class="bg-gray-50 text-xs text-gray-500"><tr><th class="px-4 py-3">创建时间</th><th class="px-4 py-3">事件</th><th class="px-4 py-3">账号</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">尝试</th><th class="px-4 py-3">错误代码</th></tr></thead>
            <tbody class="divide-y divide-gray-100"><tr v-for="item in deliveries" :key="item.outboxId"><td class="whitespace-nowrap px-4 py-3 text-gray-600">{{ formatTime(item.createdAt) }}</td><td class="px-4 py-3"><p class="font-medium text-gray-900">{{ item.eventType }}</p><p class="mt-1 text-xs text-gray-500">{{ categoryLabel(item.category) }} · {{ item.targetType }}</p></td><td class="px-4 py-3 text-gray-600">{{ item.accountId ?? '未映射' }}</td><td class="px-4 py-3 text-gray-700">{{ statusLabel(item.status) }}</td><td class="px-4 py-3 text-gray-700">{{ item.attempts }}</td><td class="px-4 py-3 text-gray-600">{{ item.lastErrorCode ?? '—' }}</td></tr><tr v-if="deliveries.length === 0"><td colspan="6" class="px-4 py-10 text-center text-gray-500">暂无匹配的投影记录</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>
