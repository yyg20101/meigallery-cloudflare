<script setup lang="ts">
import type {
  AdminConversationDetail,
  AdminConversationAssignmentResult,
  AdminConversationMessage,
  AdminConversationMessagePage,
  AdminConversationInternalNote,
  AdminConversationInternalNoteType,
  AdminConversationOperator,
  AdminConversationQueueStatus,
  AdminConversationSummary,
  AdminConversationTransfer,
  AdminConversationTransferReason,
} from '~/types/admin-app-messaging'
import type {
  AdminConversationSafetyEscalationPriority,
  AdminConversationSafetyEscalationReason,
  AdminConversationSafetyEscalationSummary,
} from '~/types/admin-app-safety'

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
const claiming = ref(false)
const releasing = ref(false)
const closing = ref(false)
const operationError = ref('')
const internalNotes = ref<AdminConversationInternalNote[]>([])
const operators = ref<AdminConversationOperator[]>([])
const noteType = ref<AdminConversationInternalNoteType>('operation')
const noteText = ref('')
const targetAdminId = ref<number | ''>('')
const transferReason = ref<AdminConversationTransferReason>('shift_handoff')
const handoffNote = ref('')
const collaborationError = ref('')
const savingNote = ref(false)
const transferring = ref(false)
const escalating = ref(false)
const createdEscalation = ref<AdminConversationSafetyEscalationSummary | null>(null)
const escalationForm = reactive({
  priority: 'p2' as AdminConversationSafetyEscalationPriority,
  reasonCode: 'harassment_threat' as AdminConversationSafetyEscalationReason,
  targetMessageId: '',
  summary: '',
})

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
  operationError.value = ''
  collaborationError.value = ''
  replyText.value = ''
  internalNotes.value = []
  operators.value = []
  noteText.value = ''
  targetAdminId.value = ''
  handoffNote.value = ''
  createdEscalation.value = null
  escalationForm.priority = 'p2'
  escalationForm.reasonCode = 'harassment_threat'
  escalationForm.targetMessageId = ''
  escalationForm.summary = ''
  if (!conversationId) return
  if (selectedSummary.value?.assignment.status === 'mine') {
    await loadConversation(conversationId)
  }
})

async function loadConversation(conversationId = selectedId.value) {
  if (!conversationId) return
  detailLoading.value = true
  detailError.value = ''
  try {
    const [detailResponse, messageResponse, noteResponse, operatorResponse] = await Promise.all([
      api<{ data: AdminConversationDetail }>(`/api/admin/app/conversations/${conversationId}`, {
        query: { accessReason: 'service_operation' },
      }),
      api<{ data: AdminConversationMessagePage }>(`/api/admin/app/conversations/${conversationId}/messages`, {
        query: { accessReason: 'service_operation', afterSequence: 0, limit: 100 },
      }),
      api<{ data: { items: AdminConversationInternalNote[] } }>(`/api/admin/app/conversations/${conversationId}/internal-notes`, {
        query: { accessReason: 'service_operation', limit: 50 },
      }),
      api<{ data: AdminConversationOperator[] }>('/api/admin/app/conversations/operators'),
    ])
    if (selectedId.value !== conversationId) return
    detail.value = detailResponse.data
    messages.value = messageResponse.data.items
    internalNotes.value = noteResponse.data.items
    operators.value = operatorResponse.data
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

async function claimConversation() {
  const conversationId = selectedId.value
  if (!conversationId || claiming.value) return
  claiming.value = true
  operationError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    await api<{ data: AdminConversationAssignmentResult }>(
      `/api/admin/app/conversations/${conversationId}/claim`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `operator.claim.${operationId}` },
      },
    )
    await refresh()
    await loadConversation(conversationId)
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '话题领取失败，请刷新队列后重试。')
  }
  finally {
    claiming.value = false
  }
}

async function releaseConversation() {
  const conversationId = selectedId.value
  if (!conversationId || releasing.value) return
  if (!window.confirm('确认释放该话题？释放后你将立即失去正文读取和回复权限。')) return
  releasing.value = true
  operationError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    await api<{ data: AdminConversationAssignmentResult }>(
      `/api/admin/app/conversations/${conversationId}/release`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `operator.release.${operationId}` },
      },
    )
    detail.value = null
    messages.value = []
    await refresh()
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '话题释放失败，请刷新后重试。')
  }
  finally {
    releasing.value = false
  }
}

async function closeConversation() {
  const conversationId = selectedId.value
  if (!conversationId || closing.value || detail.value?.status !== 'active') return
  if (!window.confirm('确认关闭该话题？关闭后观看者与运营都只能查看历史，且该话题不能重新打开。')) return
  closing.value = true
  operationError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    await api(`/api/admin/app/conversations/${conversationId}/close`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `operator.close.${operationId}` },
    })
    detail.value = null
    messages.value = []
    await refresh()
  }
  catch (error) {
    operationError.value = apiErrorMessage(error, '话题关闭失败，请刷新后重试。')
  }
  finally {
    closing.value = false
  }
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

async function saveInternalNote() {
  const conversationId = selectedId.value
  const text = noteText.value.trim()
  if (!conversationId || !text || savingNote.value || !canCollaborate.value) return
  savingNote.value = true
  collaborationError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    const response = await api<{ data: { note: AdminConversationInternalNote; replayed: boolean } }>(
      `/api/admin/app/conversations/${conversationId}/internal-notes`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `operator.note.${operationId}` },
        body: { noteType: noteType.value, text },
      },
    )
    if (!internalNotes.value.some(note => note.noteId === response.data.note.noteId)) {
      internalNotes.value = [response.data.note, ...internalNotes.value]
    }
    noteText.value = ''
  }
  catch (error) {
    collaborationError.value = apiErrorMessage(error, '内部备注保存失败，已保留输入内容。')
  }
  finally {
    savingNote.value = false
  }
}

async function transferConversation() {
  const conversationId = selectedId.value
  const targetId = Number(targetAdminId.value)
  const target = operators.value.find(operator => operator.adminId === targetId)
  const note = handoffNote.value.trim()
  if (
    !conversationId
    || !target
    || !target.canReceiveTransfer
    || !note
    || transferring.value
    || !canTransfer.value
    || !detail.value
  ) return
  if (!window.confirm(`确认把该话题转派给“${target.displayName}”？转派成功后你将立即失去正文和写权限。`)) return
  transferring.value = true
  collaborationError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    await api<{ data: { transfer: AdminConversationTransfer; replayed: boolean } }>(
      `/api/admin/app/conversations/${conversationId}/transfer`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `operator.transfer.${operationId}` },
        body: {
          targetAdminId: target.adminId,
          expectedAssignmentVersion: detail.value.assignment.version,
          reasonCode: transferReason.value,
          handoffNote: note,
        },
      },
    )
    detail.value = null
    messages.value = []
    internalNotes.value = []
    targetAdminId.value = ''
    handoffNote.value = ''
    await refresh()
  }
  catch (error) {
    collaborationError.value = apiErrorMessage(error, '话题转派失败，已保留交接说明。')
  }
  finally {
    transferring.value = false
  }
}

async function createSafetyEscalation() {
  const conversationId = selectedId.value
  const summary = escalationForm.summary.trim()
  if (!conversationId || !summary || escalating.value || !canCollaborate.value) return
  if (!window.confirm('确认创建内部安全升级案件？案件不会伪装成用户举报，也不会自动限制话题；发起人不能审核本人案件。')) return
  escalating.value = true
  collaborationError.value = ''
  const operationId = crypto.randomUUID().replaceAll('-', '')
  try {
    const response = await api<{ data: { escalation: AdminConversationSafetyEscalationSummary; replayed: boolean } }>(
      `/api/admin/app/conversations/${conversationId}/safety-escalations`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `operator.escalation.${operationId}` },
        body: {
          priority: escalationForm.priority,
          reasonCode: escalationForm.reasonCode,
          targetMessageId: escalationForm.targetMessageId || null,
          summary,
        },
      },
    )
    createdEscalation.value = response.data.escalation
    escalationForm.summary = ''
    escalationForm.targetMessageId = ''
  }
  catch (error) {
    collaborationError.value = apiErrorMessage(error, '安全升级案件创建失败，已保留输入内容。')
  }
  finally {
    escalating.value = false
  }
}

const canReply = computed(() => detail.value?.status === 'active' && detail.value.assignment.status === 'mine')
const canCollaborate = computed(() => detail.value?.assignment.status === 'mine')
const canTransfer = computed(() => canCollaborate.value && detail.value?.status !== 'closed')
const availableOperators = computed(() => operators.value.filter(operator => !operator.isCurrentAdmin))
const escalationTargetMessages = computed(() => messages.value.filter(message => message.senderType !== 'system'))

function assignmentLabel(value: AdminConversationSummary['assignment']['status']) {
  if (value === 'mine') return '由我处理'
  if (value === 'other') return '其他运营处理中'
  return '待领取'
}

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

function routingAccessLabel(item: AdminConversationSummary) {
  if (item.assignment.status === 'mine' || item.assignment.status === 'other') {
    return item.routing.groupName || '已分配话题'
  }
  if (item.routing.claimAccess === 'no_matching_rule') return '未命中分配规则'
  if (item.routing.claimAccess === 'not_group_member') return `${item.routing.groupName || '目标运营组'} · 非本组`
  if (item.routing.claimAccess === 'no_active_shift') return `${item.routing.groupName || '目标运营组'} · 当前无班次`
  return item.routing.groupName || '未配置运营组范围'
}

function noteTypeLabel(value: AdminConversationInternalNoteType) {
  if (value === 'handoff') return '交接记录'
  if (value === 'quality') return '质量备注'
  return '运营备注'
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
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          <h1 class="text-xl font-bold text-gray-950">App 平台话题</h1>
          <span class="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">ADM-MSG-01 / 02</span>
        </div>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-gray-600">
          处理由观看者发起的平台话题。所有回复固定显示为“平台运营”，不得冒充真人本人或承诺见面、回复时效与关系结果。
        </p>
      </div>
      <div class="flex shrink-0 flex-wrap gap-2">
        <NuxtLink to="/admin/app/conversation-quality" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          质量与抽检
        </NuxtLink>
        <NuxtLink to="/admin/app/conversation-groups" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
          运营组与班次
        </NuxtLink>
        <button
          class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          :disabled="status === 'pending' || detailLoading"
          @click="refreshWorkbench"
        >
          刷新队列
        </button>
      </div>
    </div>

    <div class="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
      <span class="font-semibold">服务边界：</span>
      当前真人资料并非本人入驻，消息由平台运营统一接收与处理。Message-2 要求先领取限时会话分配才能读取正文、已读、回复或关闭；不含实时消息、媒体、礼物、支付或自动回复。
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
              <span class="min-w-0 truncate text-gray-600">{{ queueLabel(item.queueStatus) }} · {{ assignmentLabel(item.assignment.status) }}</span>
              <span class="shrink-0 text-gray-400">{{ formatDate(item.lastMessageAt) }}</span>
            </span>
            <span class="mt-1 block truncate text-xs text-gray-400">{{ routingAccessLabel(item) }}</span>
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
                <button
                  v-if="selectedSummary?.assignment.status === 'mine'"
                  type="button"
                  class="min-h-8 rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  :disabled="claiming || releasing || closing"
                  @click="claimConversation"
                >
                  {{ claiming ? '续租中…' : '续租' }}
                </button>
                <button
                  v-if="selectedSummary?.assignment.status === 'mine'"
                  type="button"
                  class="min-h-8 rounded-lg border border-gray-300 bg-white px-3 py-1.5 font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  :disabled="claiming || releasing || closing"
                  @click="releaseConversation"
                >
                  {{ releasing ? '释放中…' : '释放' }}
                </button>
                <button
                  v-if="selectedSummary?.assignment.status === 'mine' && detail?.status === 'active'"
                  type="button"
                  class="min-h-8 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 font-medium text-red-700 hover:bg-red-100 disabled:opacity-50"
                  :disabled="claiming || releasing || closing"
                  @click="closeConversation"
                >
                  {{ closing ? '关闭中…' : '关闭话题' }}
                </button>
              </div>
            </div>
            <p v-if="selectedSummary?.assignment.status === 'mine' && selectedSummary.assignment.leaseExpiresAt" class="mt-2 text-xs text-gray-500">
              当前分配有效至 {{ formatDate(selectedSummary.assignment.leaseExpiresAt) }}；到期后正文与写权限立即失效。
            </p>
          </header>

          <div v-if="operationError" class="m-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {{ operationError }}
          </div>
          <div v-if="detailError" class="m-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {{ detailError }}
            <button class="ml-2 font-medium underline" @click="loadConversation()">重试</button>
          </div>
          <div v-else-if="detailLoading" class="grid flex-1 place-items-center p-8 text-sm text-gray-500">正在读取话题正文并记录访问审计…</div>
          <div v-else-if="selectedSummary?.assignment.status !== 'mine'" class="grid flex-1 place-items-center p-8 text-center">
            <div class="max-w-md">
              <h3 class="text-base font-semibold text-gray-950">
                {{ selectedSummary?.assignment.status === 'other' ? '该话题正在由其他运营处理' : '领取后才能查看正文' }}
              </h3>
              <p class="mt-2 text-sm leading-6 text-gray-600">
                未领取时列表仅显示账号、人物、队列和时间信息，不返回任何消息正文。领取为限时权限，所有访问都会写入审计。
              </p>
              <p v-if="selectedSummary && !selectedSummary.assignment.canClaim && selectedSummary.assignment.status === 'unassigned'" class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
                {{ routingAccessLabel(selectedSummary) }}。请由运营组长调整规则、成员或班次，当前账号不能绕过范围直接领取。
              </p>
              <button
                v-if="selectedSummary?.assignment.canClaim"
                type="button"
                class="mt-5 inline-flex min-h-10 items-center justify-center rounded-lg bg-rose-500 px-5 py-2 text-sm font-medium text-white hover:bg-rose-600 disabled:opacity-50"
                :disabled="claiming"
                @click="claimConversation"
              >
                {{ claiming ? '领取中…' : '领取并查看正文' }}
              </button>
            </div>
          </div>
          <template v-else>
            <div class="border-b border-rose-100 bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-900 sm:px-5">
              话题由平台运营接收与处理，不代表真人本人已入驻或回复；平台不保证固定回复时间、线下见面或关系结果。
            </div>
            <section class="grid min-w-0 border-b border-gray-200 bg-white lg:grid-cols-2">
              <div class="min-w-0 border-b border-gray-200 p-4 lg:border-b-0 lg:border-r sm:p-5">
                <div class="flex min-w-0 items-start justify-between gap-3">
                  <div class="min-w-0">
                    <h3 class="text-sm font-semibold text-gray-950">内部备注</h3>
                    <p class="mt-1 text-xs leading-5 text-gray-500">仅当前受权运营可见；审计只保存摘要，不复制正文。</p>
                  </div>
                  <span class="shrink-0 rounded-full bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200">内部可见</span>
                </div>

                <form class="mt-4 space-y-3" @submit.prevent="saveInternalNote">
                  <select v-model="noteType" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                    <option value="operation">运营备注</option>
                    <option value="quality">质量备注</option>
                  </select>
                  <textarea
                    v-model="noteText"
                    :disabled="!canCollaborate || savingNote"
                    maxlength="1000"
                    rows="3"
                    class="w-full min-w-0 resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6 outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100 disabled:bg-gray-100"
                    placeholder="记录后续处理所需的最小必要信息…"
                  />
                  <div class="flex min-w-0 items-center justify-between gap-3">
                    <span class="text-xs text-gray-400">{{ noteText.length }} / 1000</span>
                    <button
                      type="submit"
                      class="inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg border border-gray-300 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                      :disabled="!canCollaborate || !noteText.trim() || savingNote"
                    >
                      {{ savingNote ? '保存中…' : '保存备注' }}
                    </button>
                  </div>
                </form>

                <div class="mt-4 max-h-48 space-y-2 overflow-y-auto pr-1">
                  <article v-for="note in internalNotes" :key="note.noteId" class="min-w-0 rounded-lg bg-gray-50 p-3 ring-1 ring-inset ring-gray-200">
                    <div class="flex min-w-0 items-center justify-between gap-3 text-[11px] text-gray-500">
                      <span class="min-w-0 truncate font-medium text-gray-700">{{ noteTypeLabel(note.noteType) }} · {{ note.author.displayName }}</span>
                      <time class="shrink-0">{{ formatDate(note.createdAt) }}</time>
                    </div>
                    <p class="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-gray-700">{{ note.text }}</p>
                  </article>
                  <p v-if="!internalNotes.length" class="py-4 text-center text-xs text-gray-400">暂无内部备注。</p>
                </div>
              </div>

              <div class="min-w-0 p-4 sm:p-5">
                <h3 class="text-sm font-semibold text-gray-950">转派话题</h3>
                <p class="mt-1 text-xs leading-5 text-gray-500">服务端会重新校验目标状态和容量；成功后原租约立即失效。</p>

                <form class="mt-4 space-y-3" @submit.prevent="transferConversation">
                  <label class="block min-w-0">
                    <span class="mb-1.5 block text-xs font-medium text-gray-600">目标运营人员</span>
                    <select v-model="targetAdminId" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                      <option value="">请选择目标人员</option>
                      <option
                        v-for="operator in availableOperators"
                        :key="operator.adminId"
                        :value="operator.adminId"
                        :disabled="!operator.canReceiveTransfer"
                      >
                        {{ operator.displayName }} · {{ operator.activeAssignmentCount }}/{{ operator.capacityLimit }}{{ operator.canReceiveTransfer ? '' : '（已满）' }}
                      </option>
                    </select>
                  </label>
                  <label class="block min-w-0">
                    <span class="mb-1.5 block text-xs font-medium text-gray-600">转派原因</span>
                    <select v-model="transferReason" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                      <option value="shift_handoff">班次交接</option>
                      <option value="workload_balance">工作量平衡</option>
                      <option value="expertise_required">需要专项能力</option>
                      <option value="supervisor_review">主管复核</option>
                      <option value="other">其他原因</option>
                    </select>
                  </label>
                  <label class="block min-w-0">
                    <span class="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-gray-600">
                      <span>交接说明</span>
                      <span class="font-normal text-gray-400">{{ handoffNote.length }} / 500</span>
                    </span>
                    <textarea
                      v-model="handoffNote"
                      :disabled="!canTransfer || transferring"
                      maxlength="500"
                      rows="3"
                      class="w-full min-w-0 resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6 outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100 disabled:bg-gray-100"
                      placeholder="说明已处理事项、待办和风险，不填写无关敏感信息…"
                    />
                  </label>
                  <button
                    type="submit"
                    class="inline-flex min-h-10 w-full items-center justify-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                    :disabled="!canTransfer || !targetAdminId || !handoffNote.trim() || transferring"
                  >
                    {{ transferring ? '转派中…' : '确认转派' }}
                  </button>
                </form>
              </div>
              <div class="min-w-0 border-t border-gray-200 bg-red-50/40 p-4 lg:col-span-2 sm:p-5">
                <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div class="min-w-0">
                    <h3 class="text-sm font-semibold text-red-950">升级安全审核</h3>
                    <p class="mt-1 max-w-3xl text-xs leading-5 text-red-900/75">
                      创建独立内部案件并固定当前最小消息证据；不会伪装成用户举报，也不会自动限制话题。发起人不能审核本人案件。
                    </p>
                  </div>
                  <NuxtLink
                    v-if="createdEscalation"
                    :to="`/admin/app/safety?tab=escalations&escalationId=${createdEscalation.escalationId}`"
                    class="inline-flex min-h-9 shrink-0 items-center justify-center rounded-lg border border-red-200 bg-white px-4 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
                  >
                    查看案件 {{ createdEscalation.escalationId }}
                  </NuxtLink>
                </div>

                <form class="mt-4 grid min-w-0 gap-3 lg:grid-cols-2" @submit.prevent="createSafetyEscalation">
                  <label class="block min-w-0">
                    <span class="mb-1.5 block text-xs font-medium text-gray-700">优先级</span>
                    <select v-model="escalationForm.priority" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                      <option value="p0">P0 · 现实人身安全紧急风险</option>
                      <option value="p1">P1 · 高风险，需尽快复核</option>
                      <option value="p2">P2 · 一般安全问题</option>
                      <option value="p3">P3 · 低风险信息核查</option>
                    </select>
                  </label>
                  <label class="block min-w-0">
                    <span class="mb-1.5 block text-xs font-medium text-gray-700">稳定原因</span>
                    <select v-model="escalationForm.reasonCode" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                      <option value="suspected_impersonation">疑似冒名或身份误导</option>
                      <option value="harassment_threat">骚扰、威胁或不当沟通</option>
                      <option value="fraud_inducement">诈骗、金钱或站外诱导</option>
                      <option value="privacy_exposure">隐私或敏感信息暴露</option>
                      <option value="minor_safety">疑似未成年人安全风险</option>
                      <option value="imminent_danger">现实人身安全紧急风险</option>
                      <option value="other">其他需独立安全复核的问题</option>
                    </select>
                  </label>
                  <label class="block min-w-0 lg:col-span-2">
                    <span class="mb-1.5 block text-xs font-medium text-gray-700">目标消息（可选）</span>
                    <select v-model="escalationForm.targetMessageId" class="min-h-10 w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
                      <option value="">整个话题，不指定单条消息</option>
                      <option v-for="message in escalationTargetMessages" :key="message.messageId" :value="message.messageId">
                        #{{ message.sequence }} · {{ message.senderLabel }} · {{ message.text.slice(0, 48) }}
                      </option>
                    </select>
                  </label>
                  <label class="block min-w-0 lg:col-span-2">
                    <span class="mb-1.5 flex items-center justify-between gap-3 text-xs font-medium text-gray-700">
                      <span>内部升级说明</span>
                      <span class="font-normal text-gray-500">{{ escalationForm.summary.length }} / 1000</span>
                    </span>
                    <textarea
                      v-model="escalationForm.summary"
                      :disabled="!canCollaborate || escalating"
                      maxlength="1000"
                      rows="3"
                      required
                      class="w-full min-w-0 resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100 disabled:bg-gray-100"
                      placeholder="只记录安全审核所需事实、已观察行为和需要复核的问题…"
                    />
                  </label>
                  <div class="flex min-w-0 flex-col gap-2 lg:col-span-2 sm:flex-row sm:items-center sm:justify-between">
                    <p class="text-xs leading-5 text-gray-600">P0/P1 不会自动处置；现实紧急风险仍需按值班 Runbook 线下升级。</p>
                    <button
                      type="submit"
                      class="inline-flex min-h-10 shrink-0 items-center justify-center rounded-lg bg-red-700 px-5 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-40"
                      :disabled="!canCollaborate || !escalationForm.summary.trim() || escalating"
                    >
                      {{ escalating ? '创建中…' : '创建内部安全案件' }}
                    </button>
                  </div>
                </form>
              </div>
              <div v-if="collaborationError" class="border-t border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 lg:col-span-2 sm:px-5">
                {{ collaborationError }}
              </div>
            </section>
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
