<script setup lang="ts">
import type {
  AdminConversationDetail,
  AdminConversationMessage,
  AdminConversationMessagePage,
  AdminConversationQueueStatus,
  AdminConversationSummary,
} from '~/types/admin-app-messaging'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const queueStatus = ref<AdminConversationQueueStatus | ''>('awaiting_operator')
const selectedId = ref<string | null>(null)
const detail = ref<AdminConversationDetail | null>(null)
const messages = ref<AdminConversationMessage[]>([])
const replyText = ref('')
const listError = ref('')
const detailError = ref('')
const sendError = ref('')
const detailLoading = ref(false)
const sending = ref(false)

const { data, status, refresh } = await useAsyncData('admin-app-conversations', async () => {
  listError.value = ''
  try {
    return await api<{ data: AdminConversationSummary[] }>('/api/admin/app/conversations', {
      query: {
        queueStatus: queueStatus.value || undefined,
        limit: 100,
      },
    })
  }
  catch (error) {
    listError.value = apiErrorMessage(error, '平台话题队列加载失败。')
    return { data: [] }
  }
}, { watch: [queueStatus] })

const conversations = computed(() => data.value?.data ?? [])
const selectedSummary = computed(() => conversations.value.find(item => item.conversationId === selectedId.value) ?? null)

watch(conversations, (items) => {
  if (selectedId.value && items.some(item => item.conversationId === selectedId.value)) return
  selectedId.value = items[0]?.conversationId ?? null
}, { immediate: true })

watch(selectedId, async (conversationId) => {
  detail.value = null
  messages.value = []
  detailError.value = ''
  sendError.value = ''
  replyText.value = ''
  if (!conversationId) return
  await loadConversation(conversationId)
})

async function loadConversation(conversationId = selectedId.value) {
  if (!conversationId) return
  detailLoading.value = true
  detailError.value = ''
  try {
    const [detailResponse, messageResponse] = await Promise.all([
      api<{ data: AdminConversationDetail }>(`/api/admin/app/conversations/${conversationId}`, {
        query: { accessReason: 'service_operation' },
      }),
      api<{ data: AdminConversationMessagePage }>(`/api/admin/app/conversations/${conversationId}/messages`, {
        query: { accessReason: 'service_operation', afterSequence: 0, limit: 100 },
      }),
    ])
    if (selectedId.value !== conversationId) return
    detail.value = detailResponse.data
    messages.value = messageResponse.data.items
    const lastSequence = messageResponse.data.items.at(-1)?.sequence ?? detailResponse.data.lastSequence
    if (lastSequence > detailResponse.data.operatorReadSequence) {
      await api(`/api/admin/app/conversations/${conversationId}/read`, {
        method: 'POST',
        body: { sequence: lastSequence },
      })
      detail.value = { ...detailResponse.data, operatorReadSequence: lastSequence, unreadViewerCount: 0 }
    }
  }
  catch (error) {
    detailError.value = apiErrorMessage(error, '话题正文加载失败，请重试。')
  }
  finally {
    detailLoading.value = false
  }
}

async function refreshWorkbench() {
  await refresh()
  await loadConversation()
}

async function sendReply() {
  const conversationId = selectedId.value
  const text = replyText.value.trim()
  if (!conversationId || !text || sending.value || !canReply.value) return
  if (!window.confirm('确认以“平台运营”身份发送这条回复？正文不会显示为真人本人回复。')) return
  sending.value = true
  sendError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    const response = await api<{ data: { message: AdminConversationMessage; replayed: boolean } }>(
      `/api/admin/app/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `operator.reply.${operationId}` },
        body: {
          clientMessageId: `operator.${operationId}`,
          contentType: 'text',
          text,
        },
      },
    )
    if (!messages.value.some(message => message.messageId === response.data.message.messageId)) {
      messages.value = [...messages.value, response.data.message]
    }
    replyText.value = ''
    await refresh()
    await loadConversation(conversationId)
  }
  catch (error) {
    sendError.value = apiErrorMessage(error, '运营回复发送失败，请检查文案后重试。')
  }
  finally {
    sending.value = false
  }
}

const canReply = computed(() => detail.value?.status === 'active')

function queueLabel(value: AdminConversationQueueStatus) {
  if (value === 'awaiting_operator') return '待运营回复'
  if (value === 'awaiting_viewer') return '待观看者回复'
  return '已关闭'
}

function statusLabel(value: AdminConversationDetail['status']) {
  if (value === 'restricted') return '已受限'
  if (value === 'closed') return '已关闭'
  return '进行中'
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date)
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
    <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div class="min-w-0">
        <h1 class="text-xl font-bold text-gray-950">App 平台话题</h1>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
          处理由观看者发起的平台话题。所有回复固定显示为“平台运营”，不得冒充真人本人或承诺见面、回复时效与关系结果。
        </p>
      </div>
      <button
        class="inline-flex min-h-10 shrink-0 items-center justify-center self-start rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        :disabled="status === 'pending' || detailLoading"
        @click="refreshWorkbench"
      >
        刷新队列
      </button>
    </div>

    <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
      <span class="font-semibold">服务边界：</span>
      当前真人资料并非本人入驻，消息由平台运营统一接收与处理。Message-1 仅支持手动刷新和文本/表情，不含实时消息、媒体、礼物、支付或自动回复。
    </div>

    <div class="grid min-w-0 gap-4 xl:grid-cols-[minmax(18rem,23rem)_minmax(0,1fr)]">
      <section class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div class="border-b border-gray-200 p-3 sm:p-4">
          <label class="block min-w-0">
            <span class="mb-1.5 block text-xs font-medium text-gray-600">队列状态</span>
            <select v-model="queueStatus" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
              <option value="awaiting_operator">待运营回复</option>
              <option value="awaiting_viewer">待观看者回复</option>
              <option value="closed">已关闭</option>
              <option value="">全部话题</option>
            </select>
          </label>
        </div>

        <div v-if="listError" class="m-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-5 text-red-700 sm:m-4">
          {{ listError }}
        </div>
        <div v-else-if="status === 'pending'" class="px-5 py-12 text-center text-sm text-gray-500">正在加载话题队列…</div>
        <div v-else-if="!conversations.length" class="px-5 py-12 text-center">
          <h2 class="text-sm font-semibold text-gray-900">当前队列为空</h2>
          <p class="mt-2 text-xs leading-5 text-gray-500">切换状态或稍后手动刷新。</p>
        </div>
        <div v-else class="max-h-[42rem] divide-y divide-gray-100 overflow-y-auto">
          <button
            v-for="item in conversations"
            :key="item.conversationId"
            class="block min-h-24 w-full min-w-0 p-4 text-left transition-colors hover:bg-gray-50"
            :class="selectedId === item.conversationId ? 'bg-rose-50 ring-1 ring-inset ring-rose-200' : ''"
            @click="selectedId = item.conversationId"
          >
            <span class="flex min-w-0 items-start justify-between gap-3">
              <span class="min-w-0">
                <span class="block truncate text-sm font-semibold text-gray-950">{{ item.profile.displayName }}</span>
                <span class="mt-1 block truncate text-xs text-gray-500">{{ item.account.nickname || '未设置昵称' }} · {{ item.account.accountId }}</span>
              </span>
              <span v-if="item.unreadViewerCount" class="inline-flex min-w-6 shrink-0 items-center justify-center rounded-full bg-rose-500 px-1.5 py-1 text-xs font-semibold text-white">
                {{ item.unreadViewerCount > 99 ? '99+' : item.unreadViewerCount }}
              </span>
            </span>
            <span class="mt-3 flex min-w-0 items-center justify-between gap-2 text-xs">
              <span class="truncate text-gray-600">{{ queueLabel(item.queueStatus) }}</span>
              <span class="shrink-0 text-gray-400">{{ formatDate(item.lastMessageAt) }}</span>
            </span>
          </button>
        </div>
      </section>

      <section class="flex min-h-[38rem] min-w-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div v-if="!selectedId" class="grid flex-1 place-items-center p-8 text-center">
          <div>
            <h2 class="text-base font-semibold text-gray-900">选择一个平台话题</h2>
            <p class="mt-2 text-sm text-gray-500">消息正文仅用于服务处理，查看行为会写入审计日志。</p>
          </div>
        </div>
        <template v-else>
          <header class="min-w-0 border-b border-gray-200 px-4 py-4 sm:px-5">
            <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <h2 class="truncate text-base font-semibold text-gray-950">{{ detail?.profile.displayName || selectedSummary?.profile.displayName || '平台话题' }}</h2>
                <p class="mt-1 break-all text-xs leading-5 text-gray-500">{{ selectedId }}</p>
              </div>
              <div class="flex flex-wrap items-center justify-end gap-2 text-xs">
                <span class="rounded-full bg-rose-50 px-2.5 py-1 text-rose-700 ring-1 ring-inset ring-rose-200">平台运营接收</span>
                <span v-if="detail" class="rounded-full bg-gray-100 px-2.5 py-1 text-gray-700">{{ statusLabel(detail.status) }}</span>
              </div>
            </div>
          </header>

          <div v-if="detailError" class="m-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {{ detailError }}
            <button class="ml-2 font-medium underline" @click="loadConversation()">重试</button>
          </div>
          <div v-else-if="detailLoading" class="grid flex-1 place-items-center p-8 text-sm text-gray-500">正在读取话题正文并记录访问审计…</div>
          <template v-else>
            <div class="border-b border-rose-100 bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-900 sm:px-5">
              话题由平台运营接收与处理，不代表真人本人已入驻或回复；平台不保证固定回复时间、线下见面或关系结果。
            </div>
            <div class="flex-1 space-y-4 overflow-y-auto bg-gray-50/70 px-3 py-5 sm:px-5">
              <div v-for="message in messages" :key="message.messageId" class="min-w-0">
                <div v-if="message.senderType === 'system'" class="mx-auto max-w-xl rounded-lg bg-white px-4 py-3 text-center text-xs leading-5 text-gray-600 ring-1 ring-gray-200">
                  {{ message.text }}
                </div>
                <div v-else class="flex min-w-0" :class="message.senderType === 'platform_operator' ? 'justify-end' : 'justify-start'">
                  <div class="max-w-[88%] min-w-0 sm:max-w-[75%]">
                    <div class="mb-1 px-1 text-xs text-gray-500" :class="message.senderType === 'platform_operator' ? 'text-right' : ''">
                      {{ message.senderLabel }} · {{ formatDate(message.createdAt) }}
                    </div>
                    <div
                      class="whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm"
                      :class="message.senderType === 'platform_operator' ? 'rounded-br-md bg-rose-500 text-white' : 'rounded-bl-md bg-white text-gray-900 ring-1 ring-gray-200'"
                    >
                      {{ message.text }}
                    </div>
                    <div v-if="message.senderType === 'platform_operator'" class="mt-1 px-1 text-right text-[11px] text-gray-400">
                      {{ message.readByReceiver ? '观看者已读' : '已发送' }}
                    </div>
                  </div>
                </div>
              </div>
              <div v-if="!messages.length" class="py-10 text-center text-sm text-gray-500">暂无消息。</div>
            </div>

            <form class="border-t border-gray-200 bg-white p-3 sm:p-4" @submit.prevent="sendReply">
              <div class="mb-2 flex min-w-0 items-center justify-between gap-3 text-xs text-gray-500">
                <span class="min-w-0 truncate">发送身份：平台运营</span>
                <span class="shrink-0">{{ replyText.length }} / 1000</span>
              </div>
              <textarea
                v-model="replyText"
                :disabled="!canReply || sending"
                maxlength="1000"
                rows="3"
                class="w-full min-w-0 resize-y rounded-xl border border-gray-300 px-3 py-2.5 text-sm leading-6 outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100 disabled:cursor-not-allowed disabled:bg-gray-100"
                :placeholder="canReply ? '输入平台运营回复，不得冒充真人或承诺结果…' : '当前话题只能查看历史'"
              />
              <div v-if="sendError" class="mt-2 break-words text-sm text-red-700">{{ sendError }}</div>
              <div class="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p class="min-w-0 text-xs leading-5 text-gray-500">仅支持文本与表情；点击发送前会再次确认身份。</p>
                <button
                  type="submit"
                  class="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg bg-rose-500 px-5 py-2 text-sm font-medium text-white hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
                  :disabled="!canReply || !replyText.trim() || sending"
                >
                  {{ sending ? '发送中…' : '以平台运营身份发送' }}
                </button>
              </div>
            </form>
          </template>
        </template>
      </section>
    </div>
  </div>
</template>
