<script setup lang="ts">
import type { AdminMembershipReviewRequest, AdminMembershipReviewStatus } from '~/types/admin-app-membership-review'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const statusFilter = ref<AdminMembershipReviewStatus | 'all'>('pending_review')
const operationFilter = ref<'grant' | 'revoke' | 'all'>('all')
const errorMessage = ref('')

const { data, status, refresh } = await useAsyncData(
  'admin-app-membership-reviews',
  async () => {
    errorMessage.value = ''
    try {
      return await api<{ data: AdminMembershipReviewRequest[] }>('/api/admin/app/memberships/reviews', {
        query: {
          status: statusFilter.value === 'all' ? undefined : statusFilter.value,
          operation: operationFilter.value === 'all' ? undefined : operationFilter.value,
          limit: 100,
        },
      })
    }
    catch (error) {
      errorMessage.value = apiErrorMessage(error, '会员独立复核队列加载失败。')
      return { data: [] }
    }
  },
  { watch: [statusFilter, operationFilter] },
)

const requests = computed(() => data.value?.data ?? [])
const reviewableCount = computed(() => requests.value.filter(item => item.canReview).length)

function statusLabel(value: AdminMembershipReviewStatus) {
  return {
    pending_review: '待复核',
    executing: '执行中',
    approved: '已通过并生效',
    rejected: '已拒绝',
    stale: '账号变化已失效',
    cancelled: '已取消',
  }[value]
}

function statusClass(value: AdminMembershipReviewStatus) {
  if (value === 'approved') return 'bg-emerald-100 text-emerald-800 ring-emerald-200'
  if (value === 'pending_review' || value === 'executing') return 'bg-violet-100 text-violet-800 ring-violet-200'
  if (value === 'rejected' || value === 'stale') return 'bg-amber-100 text-amber-900 ring-amber-200'
  return 'bg-gray-100 text-gray-700 ring-gray-200'
}

function operationLabel(item: AdminMembershipReviewRequest) {
  if (item.operation === 'revoke') return `撤销 ${item.revokeTarget?.tierName ?? '会员'}`
  return `${item.grantChange?.action === 'renew' ? '续期' : '发放'} ${item.grantChange?.tierName ?? '会员'}`
}

function sourceLabel(item: AdminMembershipReviewRequest) {
  return item.source.type === 'membership_application' ? '会员申请' : '管理员创建'
}

function formatDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false,
    timeZone: 'Asia/Shanghai',
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
    <header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <h1 class="text-xl font-bold text-gray-950">App 会员独立复核</h1>
          <span class="rounded-full bg-violet-100 px-2.5 py-1 text-xs font-medium text-violet-800">双人分离</span>
        </div>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-gray-600">队列不展示内部备注正文。进入逐单详情后才记录受控读取；发起人不能复核自己的变更。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <NuxtLink to="/admin/app/membership/applications" class="inline-flex min-h-10 items-center rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">会员申请</NuxtLink>
        <NuxtLink to="/admin/app/membership/grants/new" class="inline-flex min-h-10 items-center rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-black">创建变更</NuxtLink>
      </div>
    </header>

    <section class="grid gap-3 sm:grid-cols-3">
      <div class="rounded-xl border border-gray-200 bg-white p-4">
        <p class="text-xs text-gray-500">当前筛选</p>
        <p class="mt-1 text-2xl font-semibold text-gray-950">{{ requests.length }}</p>
      </div>
      <div class="rounded-xl border border-violet-200 bg-violet-50 p-4">
        <p class="text-xs text-violet-700">可由我复核</p>
        <p class="mt-1 text-2xl font-semibold text-violet-950">{{ reviewableCount }}</p>
      </div>
      <div class="rounded-xl border border-amber-200 bg-amber-50 p-4">
        <p class="text-xs text-amber-800">默认风险边界</p>
        <p class="mt-1 text-sm font-semibold leading-7 text-amber-950">未发布策略时全部复核</p>
      </div>
    </section>

    <section class="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 sm:flex-row sm:items-center">
      <label class="min-w-0 text-sm text-gray-700 sm:w-52">处理状态
        <select v-model="statusFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
          <option value="all">全部状态</option>
          <option value="pending_review">待复核</option>
          <option value="executing">执行中</option>
          <option value="approved">已通过并生效</option>
          <option value="rejected">已拒绝</option>
          <option value="stale">账号变化已失效</option>
          <option value="cancelled">已取消</option>
        </select>
      </label>
      <label class="min-w-0 text-sm text-gray-700 sm:w-52">变更类型
        <select v-model="operationFilter" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3">
          <option value="all">全部类型</option>
          <option value="grant">发放 / 续期</option>
          <option value="revoke">撤销</option>
        </select>
      </label>
      <button type="button" class="min-h-11 rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:mt-6" @click="refresh">刷新队列</button>
    </section>

    <p v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ errorMessage }}</p>
    <p v-if="status === 'pending'" class="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">正在加载复核队列…</p>

    <section v-else-if="requests.length" class="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div class="hidden grid-cols-[minmax(150px,1fr)_minmax(150px,1fr)_minmax(150px,1.2fr)_120px_130px] gap-4 border-b border-gray-200 bg-gray-50 px-5 py-3 text-xs font-medium text-gray-500 lg:grid">
        <span>账号 / 来源</span><span>变更</span><span>有效期 / 业务单号</span><span>状态</span><span class="text-right">操作</span>
      </div>
      <article v-for="item in requests" :key="item.requestId" class="grid min-w-0 gap-3 border-b border-gray-100 p-5 last:border-b-0 lg:grid-cols-[minmax(150px,1fr)_minmax(150px,1fr)_minmax(150px,1.2fr)_120px_130px] lg:items-center lg:gap-4">
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold text-gray-950">{{ item.account.emailMasked }}</p>
          <p class="mt-1 truncate text-xs text-gray-500">{{ sourceLabel(item) }} · 发起人 #{{ item.requestedBy.id }}</p>
          <p class="mt-1 truncate font-mono text-[11px] text-gray-400">{{ item.requestId }}</p>
        </div>
        <div class="min-w-0">
          <p class="break-words text-sm font-medium text-gray-900">{{ operationLabel(item) }}</p>
          <p class="mt-1 text-xs text-gray-500">{{ item.operation === 'grant' ? `Rank ${item.grantChange?.rank ?? '—'} · ${item.grantChange?.durationDays ?? '—'} 天` : `Rank ${item.revokeTarget?.rank ?? '—'}` }}</p>
        </div>
        <div class="min-w-0 text-xs leading-5 text-gray-600">
          <p v-if="item.grantChange">{{ formatDate(item.grantChange.startsAt) }} — {{ formatDate(item.grantChange.expiresAt) }}</p>
          <p v-else>{{ formatDate(item.revokeTarget?.startsAt ?? null) }} — {{ formatDate(item.revokeTarget?.expiresAt ?? null) }}</p>
          <p class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ item.businessReference }}</p>
        </div>
        <div>
          <span class="inline-flex rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span>
          <p v-if="item.status === 'pending_review' && !item.canReview" class="mt-1 text-[11px] text-amber-700">本人发起，不可自审</p>
        </div>
        <div class="lg:text-right">
          <NuxtLink :to="`/admin/app/membership/reviews/${item.requestId}`" class="inline-flex min-h-10 items-center justify-center rounded-lg px-4 text-sm font-medium" :class="item.canReview ? 'bg-violet-700 text-white hover:bg-violet-800' : 'border border-gray-300 bg-white text-gray-700 hover:bg-gray-50'">{{ item.canReview ? '进入复核' : '查看详情' }}</NuxtLink>
        </div>
      </article>
    </section>

    <section v-else-if="!errorMessage" class="rounded-xl border border-dashed border-gray-300 bg-white p-12 text-center">
      <p class="text-sm font-medium text-gray-700">当前筛选下没有会员变更申请</p>
      <p class="mt-2 text-xs leading-5 text-gray-500">发放、续期或撤销提交后会出现在这里。</p>
    </section>
  </div>
</template>
