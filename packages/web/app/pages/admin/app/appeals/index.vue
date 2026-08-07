<script setup lang="ts">
import type { AdminSafetyAppealSummary } from '~/types/admin-app-safety'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const statusFilter = ref('open')
const errorMessage = ref('')

const { data, status, refresh } = await useAsyncData(
  'admin-app-safety-appeals',
  async () => {
    errorMessage.value = ''
    try {
      return await api<{ data: AdminSafetyAppealSummary[]; policyId: string }>(
        '/api/admin/app/safety/appeals',
        { query: { status: statusFilter.value, limit: 100 } },
      )
    }
    catch (error) {
      errorMessage.value = apiErrorMessage(error, '申诉队列加载失败。')
      return { data: [], policyId: '' }
    }
  },
  { watch: [statusFilter] },
)

const appeals = computed(() => data.value?.data ?? [])

function statusLabel(value: AdminSafetyAppealSummary['status']) {
  if (value === 'submitted') return '待领取'
  if (value === 'processing') return '复核中'
  if (value === 'upheld') return '维持原结论'
  if (value === 'changed') return '已重开调查'
  return '已关闭'
}

function statusClass(value: AdminSafetyAppealSummary['status']) {
  if (value === 'submitted') return 'bg-amber-100 text-amber-800'
  if (value === 'processing') return 'bg-blue-100 text-blue-800'
  if (value === 'upheld') return 'bg-gray-100 text-gray-700'
  if (value === 'changed') return 'bg-rose-100 text-rose-800'
  return 'bg-gray-100 text-gray-600'
}

function assignmentLabel(appeal: AdminSafetyAppealSummary) {
  if (appeal.isolationBlocked) return '职责隔离：不可领取'
  if (appeal.assignedToMe) return '由我复核'
  if (appeal.canClaim) return '待独立复核人领取'
  if (appeal.status === 'processing') return '其他复核人处理中'
  return '已形成结论'
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
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
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-bold text-gray-950">独立申诉复核</h1>
        <p class="mt-1 max-w-4xl text-sm leading-6 text-gray-600">
          队列不返回申诉说明或举报证据。领取后才可按 appeal_review 目的读取；原举报审核人不能领取对应申诉。
        </p>
      </div>
      <button class="min-h-10 rounded-lg border border-gray-300 bg-white px-4 text-sm text-gray-700 hover:bg-gray-50" @click="refresh()">刷新队列</button>
    </div>

    <section class="rounded-xl border border-gray-200 bg-white p-4">
      <label class="block max-w-xs text-sm text-gray-700">
        状态
        <select v-model="statusFilter" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 px-3">
          <option value="open">全部待处理</option>
          <option value="submitted">待领取</option>
          <option value="processing">复核中</option>
          <option value="upheld">维持原结论</option>
          <option value="changed">已重开调查</option>
          <option value="closed">已关闭</option>
          <option value="all">全部状态（最多 100 条）</option>
        </select>
      </label>
      <p v-if="data?.policyId" class="mt-3 break-all text-xs text-gray-500">当前开发策略：{{ data.policyId }}</p>
    </section>

    <div v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {{ errorMessage }}
    </div>
    <div v-else-if="status === 'pending'" class="rounded-xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
      正在加载申诉队列…
    </div>
    <div v-else-if="!appeals.length" class="rounded-xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">
      当前筛选下没有申诉。
    </div>
    <section v-else class="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div class="hidden grid-cols-[minmax(13rem,1.2fr)_minmax(13rem,1fr)_9rem_12rem_8rem] gap-4 border-b border-gray-200 bg-gray-50 px-5 py-3 text-xs font-semibold text-gray-600 lg:grid">
        <span>申诉</span><span>原举报</span><span>状态</span><span>分配</span><span>提交时间</span>
      </div>
      <NuxtLink
        v-for="appeal in appeals"
        :key="appeal.appealId"
        :to="`/admin/app/appeals/${appeal.appealId}`"
        class="grid min-w-0 gap-3 border-b border-gray-100 px-4 py-4 last:border-b-0 hover:bg-gray-50 lg:grid-cols-[minmax(13rem,1.2fr)_minmax(13rem,1fr)_9rem_12rem_8rem] lg:items-center lg:px-5"
      >
        <span class="min-w-0"><strong class="block truncate text-sm text-gray-950">结论独立复核</strong><small class="mt-1 block break-all text-xs text-gray-500">{{ appeal.appealId }}</small></span>
        <span class="min-w-0"><span class="block break-all text-sm text-gray-800">{{ appeal.reportId }}</span><small class="text-xs text-gray-500">结论版本 {{ appeal.originalReportVersion }}</small></span>
        <span><span class="inline-flex rounded-full px-2.5 py-1 text-xs font-medium" :class="statusClass(appeal.status)">{{ statusLabel(appeal.status) }}</span></span>
        <span class="text-sm" :class="appeal.isolationBlocked ? 'font-medium text-red-700' : 'text-gray-600'">{{ assignmentLabel(appeal) }}</span>
        <span class="text-xs text-gray-500">{{ formatDate(appeal.submittedAt) }}</span>
      </NuxtLink>
    </section>
  </div>
</template>
