<script setup lang="ts">
import type {
  AdminConversationDispatchResult,
  AdminConversationGroup,
  AdminConversationGroupShift,
  AdminConversationRoutingMutationResult,
  AdminConversationRoutingRule,
  AdminConversationRoutingSnapshot,
  ConversationGroupMemberRole,
  ConversationGroupStatus,
  ConversationRoutingMatchType,
  ConversationRoutingMode,
} from '~/types/admin-app-conversation-routing'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const activeTab = ref<'overview' | 'groups' | 'rules'>('overview')
const pageError = ref('')
const successMessage = ref('')
const saving = ref('')
const selectedGroupId = ref<string | null>(null)
const editingShiftId = ref<string | null>(null)
const editingRuleId = ref<string | null>(null)
const lastDispatch = ref<AdminConversationDispatchResult | null>(null)
const tabs = [
  { key: 'overview', label: '策略与容量' },
  { key: 'groups', label: '运营组与班次' },
  { key: 'rules', label: '路由规则' },
] as const

const { data, status, refresh } = await useAsyncData('admin-app-conversation-routing', async () => {
  pageError.value = ''
  try {
    return await api<{ data: AdminConversationRoutingSnapshot }>('/api/admin/app/conversation-groups')
  }
  catch (error) {
    pageError.value = apiErrorMessage(error, '运营组与班次加载失败。')
    return null
  }
})

const snapshot = computed(() => data.value?.data ?? null)
const selectedGroup = computed(() => (
  snapshot.value?.groups.find(group => group.groupId === selectedGroupId.value) ?? null
))
const canManageSelectedGroup = computed(() => Boolean(
  selectedGroup.value
  && snapshot.value?.permissions.manageableGroupIds.includes(selectedGroup.value.groupId),
))
const activeGroups = computed(() => snapshot.value?.groups.filter(group => group.status === 'active') ?? [])

const policyDraft = reactive({
  mode: 'manual' as ConversationRoutingMode,
  maxDispatchBatch: 20,
  expectedVersion: 0,
})
const groupCreate = reactive({
  code: '',
  name: '',
  maxActiveAssignments: 20,
  maxNewFirstResponsesPerServiceDay: 30,
})
const groupEdit = reactive({
  code: '',
  name: '',
  status: 'active' as ConversationGroupStatus,
  maxActiveAssignments: 20,
  maxNewFirstResponsesPerServiceDay: 30,
  expectedVersion: 0,
})
const memberDraft = reactive({
  adminId: '' as number | '',
  memberRole: 'operator' as ConversationGroupMemberRole,
  status: 'active' as ConversationGroupStatus,
  acceptsNewAssignments: true,
  maxActiveAssignments: 20,
  maxNewFirstResponsesPerServiceDay: 30,
  expectedVersion: 0,
})
const shiftDraft = reactive({
  name: '日间班次',
  weekday: 1,
  startMinute: 600,
  endMinute: 1320,
  status: 'active' as ConversationGroupStatus,
  expectedVersion: 0,
})
const ruleDraft = reactive({
  name: '',
  matchType: 'default' as ConversationRoutingMatchType,
  matchValue: '*',
  groupId: '',
  priority: 100,
  status: 'active' as ConversationGroupStatus,
  expectedVersion: 0,
})

watch(snapshot, (value) => {
  if (!value) return
  policyDraft.mode = value.policy?.mode ?? 'manual'
  policyDraft.maxDispatchBatch = value.policy?.maxDispatchBatch ?? 20
  policyDraft.expectedVersion = value.policy?.version ?? 0
  if (!selectedGroupId.value || !value.groups.some(group => group.groupId === selectedGroupId.value)) {
    selectedGroupId.value = value.groups[0]?.groupId ?? null
  }
  if (!ruleDraft.groupId || !value.groups.some(group => group.groupId === ruleDraft.groupId)) {
    ruleDraft.groupId = value.groups.find(group => group.status === 'active')?.groupId ?? value.groups[0]?.groupId ?? ''
  }
}, { immediate: true })

watch(selectedGroup, (group) => {
  if (!group) return
  groupEdit.code = group.code
  groupEdit.name = group.name
  groupEdit.status = group.status
  groupEdit.maxActiveAssignments = group.maxActiveAssignments
  groupEdit.maxNewFirstResponsesPerServiceDay = group.maxNewFirstResponsesPerServiceDay
  groupEdit.expectedVersion = group.version
  memberDraft.adminId = ''
  resetMemberDraft()
  resetShiftDraft()
}, { immediate: true })

watch(() => memberDraft.adminId, (adminId) => {
  const member = selectedGroup.value?.members.find(item => item.adminId === adminId)
  if (!member) {
    resetMemberDraft(false)
    return
  }
  memberDraft.memberRole = member.memberRole
  memberDraft.status = member.status
  memberDraft.acceptsNewAssignments = member.acceptsNewAssignments
  memberDraft.maxActiveAssignments = member.maxActiveAssignments
  memberDraft.maxNewFirstResponsesPerServiceDay = member.maxNewFirstResponsesPerServiceDay
  memberDraft.expectedVersion = member.version
})

watch(() => ruleDraft.matchType, (matchType) => {
  if (!editingRuleId.value) ruleDraft.matchValue = matchType === 'default' ? '*' : ''
})

async function mutate(
  label: string,
  path: string,
  method: 'POST' | 'PUT' | 'PATCH',
  body?: Record<string, unknown>,
) {
  if (saving.value) return null
  saving.value = label
  pageError.value = ''
  successMessage.value = ''
  try {
    const response = await api<{ message: string; data: AdminConversationRoutingMutationResult }>(path, {
      method,
      headers: { 'Idempotency-Key': `conversation.routing.${crypto.randomUUID().replaceAll('-', '')}` },
      body,
    })
    data.value = { data: response.data.snapshot }
    successMessage.value = response.message
    return response.data.snapshot
  }
  catch (error) {
    pageError.value = apiErrorMessage(error, `${label}失败，请刷新后重试。`)
    return null
  }
  finally {
    saving.value = ''
  }
}

async function savePolicy() {
  if (policyDraft.mode === 'automatic') {
    const confirmed = window.confirm(
      '确认启用自动分配？只有命中生效规则、处于当前班次且未超过个人与运营组容量的管理员会被分配；无合格候选时话题保持未分配。',
    )
    if (!confirmed) return
  }
  await mutate('保存分配策略', '/api/admin/app/conversation-groups/policy', 'PUT', { ...policyDraft })
}

async function createGroup() {
  const result = await mutate('创建运营组', '/api/admin/app/conversation-groups', 'POST', { ...groupCreate })
  if (!result) return
  const created = result.groups.find(group => group.code === groupCreate.code.trim())
  selectedGroupId.value = created?.groupId ?? selectedGroupId.value
  groupCreate.code = ''
  groupCreate.name = ''
  activeTab.value = 'groups'
}

async function saveGroup() {
  const group = selectedGroup.value
  if (!group) return
  await mutate('保存运营组', `/api/admin/app/conversation-groups/${group.groupId}`, 'PATCH', { ...groupEdit })
}

async function saveMember() {
  const group = selectedGroup.value
  if (!group || memberDraft.adminId === '') return
  const target = snapshot.value?.operators.find(operator => operator.adminId === memberDraft.adminId)
  if (!target || target.accountStatus !== 'active') {
    pageError.value = '只能选择有效管理员账号。'
    return
  }
  const saved = await mutate(
    '保存运营组成员',
    `/api/admin/app/conversation-groups/${group.groupId}/members/${memberDraft.adminId}`,
    'PUT',
    { ...memberDraft, adminId: undefined },
  )
  if (saved) memberDraft.expectedVersion = selectedGroup.value?.members.find(
    member => member.adminId === memberDraft.adminId,
  )?.version ?? 0
}

async function saveShift() {
  const group = selectedGroup.value
  if (!group) return
  const body = {
    name: shiftDraft.name,
    weekday: shiftDraft.weekday,
    startMinute: shiftDraft.startMinute,
    endMinute: shiftDraft.endMinute,
    ...(editingShiftId.value ? {
      status: shiftDraft.status,
      expectedVersion: shiftDraft.expectedVersion,
    } : {}),
  }
  const saved = await mutate(
    editingShiftId.value ? '更新班次' : '创建班次',
    editingShiftId.value
      ? `/api/admin/app/conversation-groups/${group.groupId}/shifts/${editingShiftId.value}`
      : `/api/admin/app/conversation-groups/${group.groupId}/shifts`,
    editingShiftId.value ? 'PATCH' : 'POST',
    body,
  )
  if (saved) resetShiftDraft()
}

function editShift(shift: AdminConversationGroupShift) {
  editingShiftId.value = shift.shiftId
  shiftDraft.name = shift.name
  shiftDraft.weekday = shift.weekday
  shiftDraft.startMinute = shift.startMinute
  shiftDraft.endMinute = shift.endMinute
  shiftDraft.status = shift.status
  shiftDraft.expectedVersion = shift.version
}

async function saveRule() {
  if (!ruleDraft.groupId) {
    pageError.value = '请先创建并选择运营组。'
    return
  }
  const body = {
    name: ruleDraft.name,
    matchType: ruleDraft.matchType,
    matchValue: ruleDraft.matchType === 'default' ? '*' : ruleDraft.matchValue,
    groupId: ruleDraft.groupId,
    priority: ruleDraft.priority,
    ...(editingRuleId.value ? {
      status: ruleDraft.status,
      expectedVersion: ruleDraft.expectedVersion,
    } : {}),
  }
  const saved = await mutate(
    editingRuleId.value ? '更新分配规则' : '创建分配规则',
    editingRuleId.value
      ? `/api/admin/app/conversation-groups/rules/${editingRuleId.value}`
      : '/api/admin/app/conversation-groups/rules',
    editingRuleId.value ? 'PATCH' : 'POST',
    body,
  )
  if (saved) resetRuleDraft()
}

function editRule(rule: AdminConversationRoutingRule) {
  editingRuleId.value = rule.ruleId
  ruleDraft.name = rule.name
  ruleDraft.matchType = rule.matchType
  ruleDraft.matchValue = rule.matchValue
  ruleDraft.groupId = rule.groupId
  ruleDraft.priority = rule.priority
  ruleDraft.status = rule.status
  ruleDraft.expectedVersion = rule.version
  activeTab.value = 'rules'
}

async function dispatchQueue() {
  if (saving.value) return
  if (!window.confirm('运行一次待处理队列分配？操作只处理当前策略单次上限内的话题，并保留逐条自动分配事实。')) return
  saving.value = '运行队列分配'
  pageError.value = ''
  successMessage.value = ''
  try {
    const response = await api<{ message: string; data: AdminConversationDispatchResult }>(
      '/api/admin/app/conversation-groups/dispatch',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': `conversation.dispatch.${crypto.randomUUID().replaceAll('-', '')}` },
      },
    )
    lastDispatch.value = response.data
    successMessage.value = `${response.message}：成功 ${response.data.assigned}，跳过 ${response.data.skipped}。`
    await refresh()
  }
  catch (error) {
    pageError.value = apiErrorMessage(error, '队列分配失败，请刷新后重试。')
  }
  finally {
    saving.value = ''
  }
}

function resetMemberDraft(clearAdmin = true) {
  if (clearAdmin) memberDraft.adminId = ''
  memberDraft.memberRole = 'operator'
  memberDraft.status = 'active'
  memberDraft.acceptsNewAssignments = true
  memberDraft.maxActiveAssignments = 20
  memberDraft.maxNewFirstResponsesPerServiceDay = 30
  memberDraft.expectedVersion = 0
}

function resetShiftDraft() {
  editingShiftId.value = null
  shiftDraft.name = '日间班次'
  shiftDraft.weekday = 1
  shiftDraft.startMinute = 600
  shiftDraft.endMinute = 1320
  shiftDraft.status = 'active'
  shiftDraft.expectedVersion = 0
}

function resetRuleDraft() {
  editingRuleId.value = null
  ruleDraft.name = ''
  ruleDraft.matchType = 'default'
  ruleDraft.matchValue = '*'
  ruleDraft.groupId = activeGroups.value[0]?.groupId ?? snapshot.value?.groups[0]?.groupId ?? ''
  ruleDraft.priority = 100
  ruleDraft.status = 'active'
  ruleDraft.expectedVersion = 0
}

function stateLabel(value: AdminConversationRoutingSnapshot['diagnostics']['state']) {
  return ({
    normal: '正常',
    no_shift: '当前无值班',
    overloaded: '容量过载',
    configuration_conflict: '配置冲突',
  } as const)[value]
}

function modeLabel(value: ConversationRoutingMode) {
  return ({ manual: '人工领取', automatic: '自动分配' } as const)[value]
}

function roleLabel(value: ConversationGroupMemberRole) {
  return ({ operator: '一线运营', lead: '运营组长', quality: '质检人员' } as const)[value]
}

function matchLabel(rule: AdminConversationRoutingRule) {
  if (rule.matchType === 'default') return '全部未命中话题'
  if (rule.matchType === 'profile') return `真人 ${rule.matchValue}`
  return `地区 ${rule.matchValue}`
}

function weekdayLabel(value: number) {
  return ['一', '二', '三', '四', '五', '六', '日'][value - 1] ?? '?'
}

function minuteLabel(value: number) {
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}
</script>

<template>
  <div class="mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-5">
    <header class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div class="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2 text-xs font-semibold text-rose-600">
            <span>ADM-MSG-03</span>
            <span aria-hidden="true">·</span>
            <span>/admin/app/conversation-groups</span>
          </div>
          <h1 class="mt-2 text-2xl font-bold tracking-tight text-gray-950">运营组、班次与自动分配</h1>
          <p class="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
            维护平台话题的受控路由。规则只决定运营租约，不改变平台接收身份，也不会自动生成或发送任何用户消息。
          </p>
        </div>
        <div class="flex shrink-0 flex-wrap gap-2">
          <NuxtLink to="/admin/app/conversations" class="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            返回会话队列
          </NuxtLink>
          <button class="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50" :disabled="status === 'pending'" @click="refresh()">
            刷新权威状态
          </button>
        </div>
      </div>
    </header>

    <div v-if="pageError" role="alert" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-800 [overflow-wrap:anywhere]">
      {{ pageError }}
    </div>
    <div v-if="successMessage" role="status" class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-800 [overflow-wrap:anywhere]">
      {{ successMessage }}
    </div>

    <div v-if="status === 'pending' && !snapshot" class="rounded-2xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
      正在加载运营路由权威状态…
    </div>

    <template v-else-if="snapshot">
      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <article class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p class="text-xs font-medium text-gray-500">当前运行状态</p>
          <p class="mt-2 text-xl font-bold text-gray-950">{{ stateLabel(snapshot.diagnostics.state) }}</p>
          <p class="mt-1 text-xs text-gray-500">上海时间 {{ snapshot.localTime.slice(0, 16).replace('T', ' ') }}</p>
        </article>
        <article class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p class="text-xs font-medium text-gray-500">待平台处理</p>
          <p class="mt-2 text-xl font-bold text-gray-950">{{ snapshot.queue.awaitingOperator }}</p>
          <p class="mt-1 text-xs text-gray-500">未分配 {{ snapshot.queue.unassignedAwaitingOperator }} · 已分配 {{ snapshot.queue.assignedAwaitingOperator }}</p>
        </article>
        <article class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p class="text-xs font-medium text-gray-500">分配模式</p>
          <p class="mt-2 text-xl font-bold text-gray-950">{{ snapshot.policy ? modeLabel(snapshot.policy.mode) : '尚未配置' }}</p>
          <p class="mt-1 text-xs text-gray-500">未命中或无容量时固定保持未分配</p>
        </article>
        <article class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <p class="text-xs font-medium text-gray-500">当前值班组</p>
          <p class="mt-2 text-xl font-bold text-gray-950">{{ snapshot.groups.filter(group => group.onDuty).length }}</p>
          <p class="mt-1 text-xs text-gray-500">生效组 {{ activeGroups.length }} · 生效规则 {{ snapshot.rules.filter(rule => rule.status === 'active').length }}</p>
        </article>
      </section>

      <section :class="['rounded-2xl border p-4', snapshot.diagnostics.state === 'normal' ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50']">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div class="min-w-0">
            <p class="text-sm font-semibold text-gray-900">运行诊断 · {{ stateLabel(snapshot.diagnostics.state) }}</p>
            <ul class="mt-1 space-y-1 text-sm leading-6 text-gray-700">
              <li v-for="message in snapshot.diagnostics.messages" :key="message" class="[overflow-wrap:anywhere]">{{ message }}</li>
            </ul>
          </div>
          <button
            v-if="snapshot.permissions.canManageGlobal"
            class="shrink-0 rounded-lg bg-gray-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="Boolean(saving) || snapshot.policy?.mode !== 'automatic' || snapshot.queue.unassignedAwaitingOperator === 0"
            @click="dispatchQueue"
          >
            {{ saving === '运行队列分配' ? '分配中…' : '运行一次队列分配' }}
          </button>
        </div>
      </section>

      <nav class="flex min-w-0 gap-1 overflow-x-auto rounded-xl border border-gray-200 bg-white p-1" aria-label="话题排班工作区">
        <button v-for="tab in tabs" :key="tab.key" :class="['shrink-0 rounded-lg px-4 py-2 text-sm font-medium', activeTab === tab.key ? 'bg-gray-950 text-white' : 'text-gray-600 hover:bg-gray-100']" @click="activeTab = tab.key">
          {{ tab.label }}
        </button>
      </nav>

      <section v-if="activeTab === 'overview'" class="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <article class="min-w-0 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-950">全局分配策略</h2>
          <p class="mt-1 text-sm leading-6 text-gray-600">策略使用固定算法：最低负载优先，同负载时选择最久未自动分配的管理员。</p>
          <div class="mt-5 grid gap-4 sm:grid-cols-2">
            <label class="min-w-0 text-sm font-medium text-gray-700">
              分配模式
              <select v-model="policyDraft.mode" :disabled="!snapshot.permissions.canManageGlobal" class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-gray-900 disabled:bg-gray-100">
                <option value="manual">人工领取</option>
                <option value="automatic">自动分配</option>
              </select>
            </label>
            <label class="min-w-0 text-sm font-medium text-gray-700">
              单次补偿分配上限
              <input v-model.number="policyDraft.maxDispatchBatch" type="number" min="1" max="200" :disabled="!snapshot.permissions.canManageGlobal" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 disabled:bg-gray-100">
            </label>
          </div>
          <div class="mt-4 rounded-xl bg-gray-50 p-4 text-sm leading-6 text-gray-600">
            <p>固定时区：Asia/Shanghai</p>
            <p>未分配行为：保留在队列，不发送占位回复</p>
            <p>选择顺序：真人规则 → 地区规则 → 默认规则</p>
          </div>
          <button v-if="snapshot.permissions.canManageGlobal" class="mt-5 rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50" :disabled="Boolean(saving)" @click="savePolicy">
            {{ saving === '保存分配策略' ? '保存中…' : '保存分配策略' }}
          </button>
          <p v-else class="mt-5 text-sm text-amber-700">全局策略仅站长可修改；你仍可查看诊断和被授权的运营组。</p>
        </article>

        <article class="min-w-0 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-950">容量概览</h2>
          <div v-if="snapshot.groups.length" class="mt-4 space-y-4">
            <button v-for="group in snapshot.groups" :key="group.groupId" class="block w-full min-w-0 rounded-xl border border-gray-200 p-4 text-left hover:border-gray-400" @click="selectedGroupId = group.groupId; activeTab = 'groups'">
              <div class="flex min-w-0 items-center justify-between gap-3">
                <span class="min-w-0 truncate font-semibold text-gray-900">{{ group.name }}</span>
                <span :class="['shrink-0 rounded-full px-2 py-1 text-xs font-medium', group.onDuty ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600']">{{ group.onDuty ? '值班中' : '非值班' }}</span>
              </div>
              <div class="mt-3 h-2 overflow-hidden rounded-full bg-gray-100"><div class="h-full rounded-full bg-rose-500" :style="{ width: `${Math.min(100, group.loadPercent)}%` }" /></div>
              <p class="mt-2 text-xs text-gray-500">待处理 {{ group.activeAssignmentCount }}/{{ group.maxActiveAssignments }} · 今日首次响应 {{ group.newFirstResponsesToday }}/{{ group.maxNewFirstResponsesPerServiceDay }}</p>
            </button>
          </div>
          <p v-else class="mt-4 rounded-xl bg-gray-50 p-5 text-center text-sm text-gray-500">尚未创建运营组，自动分配保持不可用。</p>
        </article>
      </section>

      <section v-else-if="activeTab === 'groups'" class="grid min-w-0 gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside class="min-w-0 space-y-4">
          <article v-if="snapshot.permissions.canManageGlobal" class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <h2 class="font-semibold text-gray-950">创建运营组</h2>
            <div class="mt-3 space-y-3">
              <input v-model="groupCreate.name" maxlength="80" placeholder="运营组名称" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <input v-model="groupCreate.code" maxlength="40" placeholder="稳定编码，如 shanghai-a" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <div class="grid grid-cols-2 gap-2">
                <input v-model.number="groupCreate.maxActiveAssignments" type="number" min="1" max="10000" aria-label="组待处理上限" class="min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <input v-model.number="groupCreate.maxNewFirstResponsesPerServiceDay" type="number" min="1" max="10000" aria-label="组每日首次响应上限" class="min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm">
              </div>
              <button class="w-full rounded-lg bg-gray-950 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50" :disabled="Boolean(saving) || !groupCreate.name || !groupCreate.code" @click="createGroup">创建运营组</button>
            </div>
          </article>
          <article class="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <button v-for="group in snapshot.groups" :key="group.groupId" :class="['block w-full min-w-0 border-b border-gray-100 px-4 py-3 text-left last:border-b-0', selectedGroupId === group.groupId ? 'bg-rose-50' : 'hover:bg-gray-50']" @click="selectedGroupId = group.groupId">
              <span class="block truncate text-sm font-semibold text-gray-900">{{ group.name }}</span>
              <span class="mt-1 block truncate text-xs text-gray-500">{{ group.code }} · {{ group.members.length }} 人 · {{ group.shifts.length }} 班次</span>
            </button>
            <p v-if="!snapshot.groups.length" class="p-5 text-center text-sm text-gray-500">暂无运营组</p>
          </article>
        </aside>

        <div v-if="selectedGroup" class="min-w-0 space-y-5">
          <article class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div class="flex flex-wrap items-center justify-between gap-3"><h2 class="text-lg font-semibold text-gray-950">运营组设置</h2><span class="text-xs text-gray-500">version {{ selectedGroup.version }}</span></div>
            <div class="mt-4 grid gap-4 sm:grid-cols-2">
              <label class="text-sm font-medium text-gray-700">名称<input v-model="groupEdit.name" :disabled="!canManageSelectedGroup" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 disabled:bg-gray-100"></label>
              <label class="text-sm font-medium text-gray-700">稳定编码<input v-model="groupEdit.code" :disabled="!canManageSelectedGroup" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 disabled:bg-gray-100"></label>
              <label class="text-sm font-medium text-gray-700">状态<select v-model="groupEdit.status" :disabled="!canManageSelectedGroup" class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 disabled:bg-gray-100"><option value="active">生效</option><option value="inactive">停用</option></select></label>
              <div class="grid min-w-0 grid-cols-2 gap-2">
                <label class="min-w-0 text-sm font-medium text-gray-700">待处理上限<input v-model.number="groupEdit.maxActiveAssignments" type="number" min="1" max="10000" :disabled="!canManageSelectedGroup" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 disabled:bg-gray-100"></label>
                <label class="min-w-0 text-sm font-medium text-gray-700">日首次响应<input v-model.number="groupEdit.maxNewFirstResponsesPerServiceDay" type="number" min="1" max="10000" :disabled="!canManageSelectedGroup" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 disabled:bg-gray-100"></label>
              </div>
            </div>
            <button v-if="canManageSelectedGroup" class="mt-4 rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" :disabled="Boolean(saving)" @click="saveGroup">保存运营组</button>
          </article>

          <div class="grid min-w-0 gap-5 2xl:grid-cols-2">
            <article class="min-w-0 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h2 class="text-lg font-semibold text-gray-950">成员与个人容量</h2>
              <div class="mt-4 space-y-3">
                <div v-for="member in selectedGroup.members" :key="member.adminId" class="min-w-0 rounded-xl border border-gray-200 p-3">
                  <div class="flex min-w-0 items-center justify-between gap-2"><span class="truncate text-sm font-semibold text-gray-900">{{ member.displayName }}</span><span class="shrink-0 text-xs text-gray-500">{{ roleLabel(member.memberRole) }}</span></div>
                  <p class="mt-1 text-xs text-gray-500">待处理 {{ member.activeAssignmentCount }}/{{ member.maxActiveAssignments }} · 今日首次响应 {{ member.newFirstResponsesToday }}/{{ member.maxNewFirstResponsesPerServiceDay }} · {{ member.acceptsNewAssignments ? '接收新分配' : '暂停接单' }}</p>
                </div>
                <p v-if="!selectedGroup.members.length" class="rounded-xl bg-gray-50 p-4 text-center text-sm text-gray-500">尚无成员</p>
              </div>
              <div v-if="canManageSelectedGroup" class="mt-5 border-t border-gray-200 pt-5">
                <select v-model="memberDraft.adminId" class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm"><option value="">选择管理员</option><option v-for="operator in snapshot.operators" :key="operator.adminId" :value="operator.adminId">{{ operator.displayName }} · {{ operator.accountRole }}</option></select>
                <div class="mt-3 grid gap-3 sm:grid-cols-2">
                  <select v-model="memberDraft.memberRole" class="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm"><option value="operator">一线运营</option><option value="lead">运营组长</option><option value="quality">质检人员</option></select>
                  <select v-model="memberDraft.status" class="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm"><option value="active">生效</option><option value="inactive">停用</option></select>
                  <input v-model.number="memberDraft.maxActiveAssignments" type="number" min="1" max="1000" aria-label="个人待处理上限" class="rounded-lg border border-gray-300 px-3 py-2.5 text-sm">
                  <input v-model.number="memberDraft.maxNewFirstResponsesPerServiceDay" type="number" min="1" max="1000" aria-label="个人日首次响应上限" class="rounded-lg border border-gray-300 px-3 py-2.5 text-sm">
                </div>
                <label class="mt-3 flex items-center gap-2 text-sm text-gray-700"><input v-model="memberDraft.acceptsNewAssignments" type="checkbox">接收新自动分配</label>
                <button class="mt-3 rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" :disabled="Boolean(saving) || memberDraft.adminId === ''" @click="saveMember">保存成员</button>
              </div>
            </article>

            <article class="min-w-0 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div class="flex items-center justify-between gap-3"><h2 class="text-lg font-semibold text-gray-950">上海时区班次</h2><button v-if="editingShiftId" class="text-sm text-gray-500 hover:text-gray-900" @click="resetShiftDraft">取消编辑</button></div>
              <div class="mt-4 space-y-3">
                <button v-for="shift in selectedGroup.shifts" :key="shift.shiftId" class="block w-full min-w-0 rounded-xl border border-gray-200 p-3 text-left hover:border-gray-400" @click="editShift(shift)">
                  <span class="block truncate text-sm font-semibold text-gray-900">{{ shift.name }} · 周{{ weekdayLabel(shift.weekday) }}</span>
                  <span class="mt-1 block text-xs text-gray-500">{{ minuteLabel(shift.startMinute) }}–{{ minuteLabel(shift.endMinute) }}{{ shift.overnight ? '（跨日）' : '' }} · {{ shift.status === 'active' ? '生效' : '停用' }}</span>
                </button>
                <p v-if="!selectedGroup.shifts.length" class="rounded-xl bg-gray-50 p-4 text-center text-sm text-gray-500">尚无班次；该组不会获得自动分配。</p>
              </div>
              <div v-if="canManageSelectedGroup" class="mt-5 border-t border-gray-200 pt-5">
                <input v-model="shiftDraft.name" maxlength="80" placeholder="班次名称" class="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm">
                <div class="mt-3 grid grid-cols-3 gap-2">
                  <select v-model.number="shiftDraft.weekday" class="min-w-0 rounded-lg border border-gray-300 bg-white px-2 py-2.5 text-sm"><option v-for="day in 7" :key="day" :value="day">周{{ weekdayLabel(day) }}</option></select>
                  <input v-model.number="shiftDraft.startMinute" type="number" min="0" max="1439" aria-label="开始分钟" class="min-w-0 rounded-lg border border-gray-300 px-2 py-2.5 text-sm">
                  <input v-model.number="shiftDraft.endMinute" type="number" min="0" max="1439" aria-label="结束分钟" class="min-w-0 rounded-lg border border-gray-300 px-2 py-2.5 text-sm">
                </div>
                <p class="mt-2 text-xs leading-5 text-gray-500">分钟从 00:00 起计算，例如 600=10:00、1320=22:00；结束小于开始表示跨日。</p>
                <select v-if="editingShiftId" v-model="shiftDraft.status" class="mt-3 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm"><option value="active">生效</option><option value="inactive">停用</option></select>
                <button class="mt-3 rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" :disabled="Boolean(saving) || !shiftDraft.name" @click="saveShift">{{ editingShiftId ? '更新班次' : '创建班次' }}</button>
              </div>
            </article>
          </div>
        </div>
        <div v-else class="rounded-2xl border border-dashed border-gray-300 bg-white p-10 text-center text-sm text-gray-500">选择或创建运营组后配置成员与班次。</div>
      </section>

      <section v-else class="grid min-w-0 gap-5 xl:grid-cols-[minmax(340px,0.75fr)_minmax(0,1.25fr)]">
        <article class="min-w-0 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <div class="flex items-center justify-between gap-3"><h2 class="text-lg font-semibold text-gray-950">{{ editingRuleId ? '编辑路由规则' : '创建路由规则' }}</h2><button v-if="editingRuleId" class="text-sm text-gray-500 hover:text-gray-900" @click="resetRuleDraft">取消编辑</button></div>
          <p class="mt-1 text-sm leading-6 text-gray-600">同一匹配条件只能有一条生效规则；真人规则优先于地区规则，地区规则优先于默认规则。</p>
          <div class="mt-4 space-y-3">
            <label class="block text-sm font-medium text-gray-700">规则名称<input v-model="ruleDraft.name" :disabled="!snapshot.permissions.canManageGlobal" maxlength="80" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 disabled:bg-gray-100"></label>
            <label class="block text-sm font-medium text-gray-700">匹配类型<select v-model="ruleDraft.matchType" :disabled="!snapshot.permissions.canManageGlobal" class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 disabled:bg-gray-100"><option value="default">默认兜底</option><option value="region">地区编码</option><option value="profile">指定真人 profileId</option></select></label>
            <label class="block text-sm font-medium text-gray-700">匹配值<input v-model="ruleDraft.matchValue" :disabled="!snapshot.permissions.canManageGlobal || ruleDraft.matchType === 'default'" :placeholder="ruleDraft.matchType === 'region' ? '如 cn-shanghai' : '如 pp_xxx'" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 disabled:bg-gray-100"></label>
            <label class="block text-sm font-medium text-gray-700">目标运营组<select v-model="ruleDraft.groupId" :disabled="!snapshot.permissions.canManageGlobal" class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 disabled:bg-gray-100"><option value="">选择运营组</option><option v-for="group in snapshot.groups" :key="group.groupId" :value="group.groupId">{{ group.name }} · {{ group.status === 'active' ? '生效' : '停用' }}</option></select></label>
            <label class="block text-sm font-medium text-gray-700">同类型优先级<input v-model.number="ruleDraft.priority" type="number" min="0" max="10000" :disabled="!snapshot.permissions.canManageGlobal" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 disabled:bg-gray-100"></label>
            <label v-if="editingRuleId" class="block text-sm font-medium text-gray-700">状态<select v-model="ruleDraft.status" :disabled="!snapshot.permissions.canManageGlobal" class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 disabled:bg-gray-100"><option value="active">生效</option><option value="inactive">停用</option></select></label>
          </div>
          <button v-if="snapshot.permissions.canManageGlobal" class="mt-5 rounded-lg bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" :disabled="Boolean(saving) || !ruleDraft.name || !ruleDraft.groupId" @click="saveRule">{{ editingRuleId ? '保存规则修改' : '创建分配规则' }}</button>
          <p v-else class="mt-5 text-sm text-amber-700">路由规则影响全局话题，仅站长可以修改。</p>
        </article>

        <article class="min-w-0 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 class="text-lg font-semibold text-gray-950">规则优先顺序</h2>
          <div v-if="snapshot.rules.length" class="mt-4 space-y-3">
            <button v-for="rule in snapshot.rules" :key="rule.ruleId" class="block w-full min-w-0 rounded-xl border border-gray-200 p-4 text-left hover:border-gray-400" @click="editRule(rule)">
              <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><p class="truncate text-sm font-semibold text-gray-900">{{ rule.name }}</p><p class="mt-1 break-all text-xs text-gray-500">{{ matchLabel(rule) }}</p></div><span :class="['shrink-0 rounded-full px-2 py-1 text-xs font-medium', rule.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600']">{{ rule.status === 'active' ? '生效' : '停用' }}</span></div>
              <p class="mt-3 text-xs text-gray-500">→ {{ rule.groupName }} · 同类型优先级 {{ rule.priority }} · version {{ rule.version }}</p>
            </button>
          </div>
          <p v-else class="mt-4 rounded-xl bg-gray-50 p-8 text-center text-sm text-gray-500">尚无路由规则；即使策略设为自动，话题也会安全地保持未分配。</p>
        </article>
      </section>

      <section v-if="lastDispatch" class="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 class="text-lg font-semibold text-gray-950">最近一次手动触发结果</h2>
        <p class="mt-2 text-sm text-gray-600">请求 {{ lastDispatch.requested }} · 新分配 {{ lastDispatch.assigned }} · 已被领取 {{ lastDispatch.alreadyAssigned }} · 跳过 {{ lastDispatch.skipped }}</p>
        <div class="mt-3 max-h-56 overflow-auto rounded-xl bg-gray-50 p-3 text-xs text-gray-600">
          <p v-for="item in lastDispatch.outcomes" :key="item.conversationId" class="break-all py-1">{{ item.conversationId }} · {{ item.status }}<span v-if="item.adminId"> · 管理员 #{{ item.adminId }}</span></p>
          <p v-if="!lastDispatch.outcomes.length">当前没有需要补偿分配的话题。</p>
        </div>
      </section>
    </template>
  </div>
</template>
