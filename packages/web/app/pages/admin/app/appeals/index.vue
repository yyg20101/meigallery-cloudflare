<script setup lang="ts">
import type { AdminSafetyAppealSummary } from '~/types/admin-app-safety'

definePageMeta({ layout: 'admin' })

type AppealQueueResponse = {
  data: {
    items: AdminSafetyAppealSummary[]
    total: number
    page: number
    pageSize: number
    totalPages: number
  }
  policyId: string
}

const { api } = useApi()
const statusFilter = ref('open')
const sourceFilter = ref('all')
const assignmentFilter = ref('all')
const searchText = ref('')
const appliedQuery = ref('')
const page = ref(1)
const pageSize = 20
const errorMessage = ref('')
const claiming = ref(false)

watch([statusFilter, sourceFilter, assignmentFilter], () => {
  page.value = 1
})

const { data, status, refresh } = await useAsyncData(
  'admin-app-safety-appeal-queue',
  async () => {
    errorMessage.value = ''
    try {
      return await api<AppealQueueResponse>('/api/admin/app/safety/appeals', {
        query: {
          status: statusFilter.value,
          sourceType: sourceFilter.value,
          assignment: assignmentFilter.value,
          query: appliedQuery.value || undefined,
          page: page.value,
          pageSize,
        },
      })
    }
    catch (error) {
      errorMessage.value = apiErrorMessage(error, '申诉队列加载失败。')
      return {
        data: { items: [], total: 0, page: 1, pageSize, totalPages: 1 },
        policyId: '',
      }
    }
  },
  { watch: [statusFilter, sourceFilter, assignmentFilter, appliedQuery, page] },
)

const queue = computed(() => data.value?.data ?? {
  items: [], total: 0, page: 1, pageSize, totalPages: 1,
})
const appeals = computed(() => queue.value.items)
const nextClaimable = computed(() => appeals.value.find(appeal => appeal.canClaim) ?? null)
const hasIsolationBlocked = computed(() => appeals.value.some(appeal => appeal.isolationBlocked))
const hasOverdue = computed(() => appeals.value.some(appeal => appeal.overdue))
const figmaState = computed(() => {
  if (hasIsolationBlocked.value) return '原审核人隔离'
  if (hasOverdue.value) return '逾期'
  return '正常'
})
const pageNumbers = computed(() => {
  const total = queue.value.totalPages
  const current = queue.value.page
  const start = Math.max(1, Math.min(current - 1, total - 2))
  return Array.from({ length: Math.min(3, total) }, (_, index) => start + index)
})

function applySearch() {
  const normalized = searchText.value.trim()
  page.value = 1
  if (normalized === appliedQuery.value) refresh()
  else appliedQuery.value = normalized
}

async function claimNextAppeal() {
  const appeal = nextClaimable.value
  if (!appeal || claiming.value) return
  if (!window.confirm(`确认领取当前队列中最早可领取的申诉 ${appeal.appealId}？领取后才能读取申诉说明与业务快照。`)) return
  claiming.value = true
  errorMessage.value = ''
  try {
    const operationId = crypto.randomUUID().replaceAll('-', '')
    await api(`/api/admin/app/safety/appeals/${appeal.appealId}/claim`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `appeal.claim.${operationId}` },
    })
    await navigateTo(`/admin/app/appeals/${appeal.appealId}`)
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '申诉分配失败，请刷新队列后重试。')
    await refresh()
  }
  finally {
    claiming.value = false
  }
}

function goToPage(target: number) {
  page.value = Math.min(Math.max(target, 1), queue.value.totalPages)
}

function statusLabel(appeal: AdminSafetyAppealSummary) {
  if (appeal.reviewState === 'evidence_insufficient') return '待补充'
  if (appeal.reviewState === 'needs_escalation') return '需要升级'
  const value = appeal.status
  if (value === 'submitted') return '待分配'
  if (value === 'processing') return '独立复核中'
  if (value === 'upheld') return '维持原结论'
  if (value === 'changed') return appeal.type === 'report_no_violation_review' ? '已重开调查' : '申诉成立'
  return '已关闭'
}

function statusClass(value: AdminSafetyAppealSummary['status']) {
  if (value === 'submitted') return 'text-[#d92d20]'
  if (value === 'processing') return 'text-[#2c2421]'
  if (value === 'changed') return 'text-emerald-600'
  return 'text-[#6a5f5a]'
}

function deadlineLabel(appeal: AdminSafetyAppealSummary) {
  if (appeal.resolvedAt) return `完成 ${formatDate(appeal.resolvedAt)}`
  if (!appeal.reviewDueAt) return '未配置正式 SLA'
  return `${appeal.overdue ? '已逾期' : '目标'} ${formatDate(appeal.reviewDueAt)}`
}

function assignmentLabel(appeal: AdminSafetyAppealSummary) {
  if (appeal.isolationBlocked) return '原审核人隔离'
  if (appeal.assignedToMe) return '由我复核'
  if (appeal.canClaim) return '待独立复核人领取'
  if (appeal.status === 'processing') return '其他复核人处理中'
  return '已形成结论'
}

function appealTitle(appeal: AdminSafetyAppealSummary) {
  if (appeal.type === 'account_restriction_review') return '账号限制独立复核'
  if (appeal.type === 'wallet_entry_review') return '金币分录独立复核'
  return '举报结论独立复核'
}

function sourceReference(appeal: AdminSafetyAppealSummary) {
  return appeal.source?.reference ?? appeal.reportId ?? '—'
}

function sourceVersion(appeal: AdminSafetyAppealSummary) {
  return appeal.source?.sourceVersion ?? String(appeal.originalReportVersion ?? '—')
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
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
    <AdminAppPageHeader
      page-id="ADM-SAF-03"
      route="/admin/app/appeals"
      title="申诉队列"
      description="把申诉分配给与原处置人员隔离的复核人员。"
      :state="errorMessage ? '加载失败' : status === 'pending' ? '加载中' : '正常'"
      :figma-state="figmaState"
      :state-tone="errorMessage ? 'danger' : status === 'pending' ? 'warning' : 'info'"
    >
      <template #actions>
        <button
          class="inline-flex min-h-10 items-center justify-center rounded-[10px] bg-[#d63363] px-5 text-sm font-medium text-white hover:bg-[#bd2756] disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!nextClaimable || claiming"
          @click="claimNextAppeal"
        >
          <span class="mr-2 text-lg leading-none">＋</span>{{ claiming ? '分配中…' : '分配申诉' }}
        </button>
      </template>
    </AdminAppPageHeader>

    <section
      v-if="!errorMessage"
      class="flex min-w-0 items-start gap-3 rounded-xl border px-4 py-3"
      :class="hasIsolationBlocked ? 'border-red-200 bg-red-50 text-red-700' : hasOverdue ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-[#b2ddff] bg-[#d1e9ff] text-[#175cd3]'"
    >
      <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-current text-xs">i</span>
      <div class="min-w-0">
        <p class="text-sm font-medium">{{ hasIsolationBlocked ? '存在原审核人隔离案件' : hasOverdue ? '存在已逾期申诉' : '当前数据可用' }}</p>
        <p class="mt-0.5 break-words text-xs leading-5">{{ hasIsolationBlocked ? '你不能领取本人形成原结论的案件；请由其他复核人员处理。' : hasOverdue ? '仅当案件快照存在已批准 SLA 时才计算逾期；请优先处理标记案件。' : '领取前只展示安全引用，领取后才读取用户说明与最小业务快照。' }}</p>
      </div>
    </section>

    <div v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {{ errorMessage }}
    </div>

    <section class="rounded-xl border border-[#f2ddd6] bg-white p-3">
      <form class="grid min-w-0 gap-3 lg:grid-cols-[minmax(15rem,1.4fr)_minmax(9rem,0.7fr)_minmax(10rem,0.8fr)_auto]" role="search" @submit.prevent="applySearch">
        <label class="flex min-h-10 min-w-0 items-center gap-2 rounded-[10px] border border-[#f2ddd6] bg-white px-3 focus-within:border-[#d63363]">
          <svg class="size-4 shrink-0 text-[#6a5f5a]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input v-model="searchText" maxlength="80" class="min-w-0 flex-1 bg-transparent text-sm text-[#2c2421] outline-none placeholder:text-[#8d817b]" placeholder="搜索申诉号、账号或业务单" />
        </label>
        <select v-model="statusFilter" aria-label="筛选申诉状态" class="min-h-10 min-w-0 rounded-[10px] border-0 bg-[#fff5f1] px-3 text-sm text-[#6a5f5a] outline-none focus:ring-2 focus:ring-[#d63363]/30">
          <option value="open">全部待处理</option>
          <option value="submitted">待分配</option>
          <option value="processing">复核中</option>
          <option value="upheld">维持原结论</option>
          <option value="changed">申诉成立</option>
          <option value="closed">已关闭</option>
          <option value="all">全部状态</option>
        </select>
        <select v-model="sourceFilter" aria-label="筛选申诉来源" class="min-h-10 min-w-0 rounded-[10px] border-0 bg-[#fff5f1] px-3 text-sm text-[#6a5f5a] outline-none focus:ring-2 focus:ring-[#d63363]/30">
          <option value="all">全部业务来源</option>
          <option value="report">举报结论</option>
          <option value="account_restriction">账号限制</option>
          <option value="wallet_entry">金币分录</option>
        </select>
        <div class="flex min-w-0 gap-2">
          <select v-model="assignmentFilter" aria-label="筛选分配状态" class="min-h-10 min-w-0 flex-1 rounded-[10px] border-0 bg-[#fff5f1] px-3 text-sm text-[#6a5f5a] outline-none focus:ring-2 focus:ring-[#d63363]/30">
            <option value="all">全部分配状态</option>
            <option value="mine">由我复核</option>
            <option value="unassigned">可领取</option>
            <option value="other">其他人处理中</option>
            <option value="isolation_blocked">原审核人隔离</option>
          </select>
          <button type="submit" class="min-h-10 shrink-0 rounded-[10px] border border-[#f2ddd6] bg-white px-4 text-sm text-[#6a5f5a] hover:bg-[#fff5f1]">搜索</button>
        </div>
      </form>
      <p v-if="data?.policyId" class="mt-2 break-all px-1 text-xs text-[#8d817b]">复核策略：{{ data.policyId }}</p>
    </section>

    <div v-if="status === 'pending'" class="rounded-xl border border-[#f2ddd6] bg-white p-12 text-center text-sm text-[#6a5f5a]">
      正在加载申诉队列…
    </div>
    <div v-else-if="!appeals.length && !errorMessage" class="rounded-xl border border-[#f2ddd6] bg-white p-12 text-center text-sm text-[#6a5f5a]">
      当前筛选下没有申诉。
    </div>
    <section v-else-if="appeals.length" class="overflow-hidden rounded-xl border border-[#f2ddd6] bg-white">
      <div class="hidden grid-cols-[minmax(13rem,1.25fr)_minmax(10rem,0.85fr)_minmax(11rem,0.9fr)_8rem] gap-4 border-b border-[#f2ddd6] bg-[#fff5f1] px-5 py-3 text-xs font-medium text-[#6a5f5a] lg:grid">
        <span>申诉单 / 原案件</span><span>申诉人</span><span>复核状态</span><span>SLA / 完成时间</span>
      </div>
      <NuxtLink
        v-for="appeal in appeals"
        :key="appeal.appealId"
        :to="`/admin/app/appeals/${appeal.appealId}`"
        class="grid min-w-0 gap-3 border-b border-[#f2ddd6] px-4 py-4 last:border-b-0 hover:bg-[#fffaf7] lg:grid-cols-[minmax(13rem,1.25fr)_minmax(10rem,0.85fr)_minmax(11rem,0.9fr)_8rem] lg:items-center lg:px-5"
      >
        <span class="min-w-0">
          <strong class="block truncate text-sm font-medium text-[#2c2421]">{{ appeal.appealId }} · {{ sourceReference(appeal) }}</strong>
          <small class="mt-1 block truncate text-xs text-[#8d817b]">{{ appealTitle(appeal) }} · 版本 {{ sourceVersion(appeal) }}</small>
        </span>
        <span class="min-w-0 break-all text-sm text-[#2c2421]">{{ appeal.accountPublicId || '账号引用不可用' }}</span>
        <span class="min-w-0">
          <strong class="block text-sm font-medium" :class="statusClass(appeal.status)">{{ statusLabel(appeal) }}</strong>
          <small class="mt-1 block break-words text-xs" :class="appeal.isolationBlocked ? 'font-medium text-red-700' : 'text-[#8d817b]'">{{ assignmentLabel(appeal) }}</small>
        </span>
        <span class="text-xs" :class="appeal.overdue ? 'font-medium text-red-700' : 'text-[#6a5f5a]'">{{ deadlineLabel(appeal) }}</span>
      </NuxtLink>
    </section>

    <nav v-if="queue.total > 0" aria-label="申诉队列分页" class="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs text-[#6a5f5a]">
      <span class="mr-1">共 {{ queue.total }} 条</span>
      <button class="min-h-8 rounded-lg bg-[#fff5f1] px-3 disabled:opacity-40" :disabled="queue.page <= 1" @click="goToPage(queue.page - 1)">上一页</button>
      <button
        v-for="pageNumber in pageNumbers"
        :key="pageNumber"
        class="min-h-8 min-w-8 rounded-lg px-2"
        :class="pageNumber === queue.page ? 'bg-[#d63363] text-white' : 'bg-[#fff5f1] text-[#6a5f5a]'"
        @click="goToPage(pageNumber)"
      >{{ pageNumber }}</button>
      <button class="min-h-8 rounded-lg bg-[#fff5f1] px-3 disabled:opacity-40" :disabled="queue.page >= queue.totalPages" @click="goToPage(queue.page + 1)">下一页</button>
    </nav>
  </div>
</template>
