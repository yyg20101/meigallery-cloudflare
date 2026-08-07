<script setup lang="ts">
import type { AdminSafetyAppealDetail, AdminSafetyAppealSummary } from '~/types/admin-app-safety'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const appealId = computed(() => String(route.params.appealId ?? ''))
const summary = ref<AdminSafetyAppealSummary | null>(null)
const detail = ref<AdminSafetyAppealDetail | null>(null)
const loading = ref(true)
const claiming = ref(false)
const deciding = ref(false)
const errorMessage = ref('')
const outcome = ref<'upheld' | 'changed'>('upheld')
const reasonCode = ref('independent_review_upheld')
const userVisibleMessage = ref('独立复核已完成，维持原举报结论。')

watch(outcome, (value) => {
  if (value === 'upheld') {
    reasonCode.value = 'independent_review_upheld'
    userVisibleMessage.value = '独立复核已完成，维持原举报结论。'
  }
  else {
    reasonCode.value = 'independent_review_changed'
    userVisibleMessage.value = '独立复核后，举报已重新进入审核。'
  }
})

await load()

async function load() {
  loading.value = true
  errorMessage.value = ''
  detail.value = null
  try {
    const response = await api<{ data: AdminSafetyAppealSummary[] }>(
      '/api/admin/app/safety/appeals',
      { query: { status: 'all', limit: 100 } },
    )
    summary.value = response.data.find(item => item.appealId === appealId.value) ?? null
    if (!summary.value) {
      errorMessage.value = '申诉不存在、已不可见或不在当前工作队列中。'
      return
    }
    if (summary.value.assignedToMe) await loadDetail()
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '申诉摘要加载失败。')
  }
  finally {
    loading.value = false
  }
}

async function loadDetail() {
  const response = await api<{ data: AdminSafetyAppealDetail }>(
    `/api/admin/app/safety/appeals/${appealId.value}`,
    { query: { accessReason: 'appeal_review' } },
  )
  detail.value = response.data
  summary.value = response.data
}

async function claimAppeal() {
  if (!summary.value?.canClaim || claiming.value) return
  claiming.value = true
  errorMessage.value = ''
  try {
    const operationId = crypto.randomUUID().replaceAll('-', '')
    await api(`/api/admin/app/safety/appeals/${appealId.value}/claim`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `appeal.claim.${operationId}` },
    })
    await load()
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '申诉领取失败，请刷新后重试。')
  }
  finally {
    claiming.value = false
  }
}

async function submitDecision() {
  if (!detail.value || deciding.value || isFinal.value) return
  const action = outcome.value === 'upheld'
    ? '维持原“未发现违规”结论'
    : '把原举报重新打开并交由当前复核人继续审核'
  if (!window.confirm(`确认${action}？用户会看到填写的说明；历史结论不会被删除。`)) return
  deciding.value = true
  errorMessage.value = ''
  try {
    const operationId = crypto.randomUUID().replaceAll('-', '')
    await api(`/api/admin/app/safety/appeals/${appealId.value}/decision`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `appeal.decision.${operationId}` },
      body: {
        expectedVersion: detail.value.version,
        outcome: outcome.value,
        reasonCode: reasonCode.value,
        userVisibleMessage: userVisibleMessage.value,
      },
    })
    await load()
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '复核结论提交失败，请刷新案件版本后重试。')
  }
  finally {
    deciding.value = false
  }
}

const isFinal = computed(() => summary.value ? ['upheld', 'changed', 'closed'].includes(summary.value.status) : false)

function statusLabel(value: AdminSafetyAppealSummary['status']) {
  if (value === 'submitted') return '待领取'
  if (value === 'processing') return '独立复核中'
  if (value === 'upheld') return '维持原结论'
  if (value === 'changed') return '已重开调查'
  return '已关闭'
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
        <NuxtLink to="/admin/app/appeals" class="text-sm text-rose-700 hover:underline">← 返回申诉队列</NuxtLink>
        <h1 class="mt-2 text-xl font-bold text-gray-950">申诉详情与独立复核</h1>
        <p class="mt-1 break-all text-xs text-gray-500">{{ appealId }}</p>
      </div>
      <button class="min-h-10 rounded-lg border border-gray-300 bg-white px-4 text-sm text-gray-700" @click="load()">刷新</button>
    </div>

    <div v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{{ errorMessage }}</div>
    <div v-if="loading" class="rounded-xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">正在加载申诉…</div>

    <template v-else-if="summary">
      <section class="grid gap-4 rounded-xl border border-gray-200 bg-white p-5 sm:grid-cols-2 xl:grid-cols-4">
        <div><p class="text-xs text-gray-500">当前状态</p><p class="mt-1 text-sm font-semibold text-gray-950">{{ statusLabel(summary.status) }}</p></div>
        <div><p class="text-xs text-gray-500">原举报</p><p class="mt-1 break-all text-sm font-medium text-gray-950">{{ summary.reportId }}</p></div>
        <div><p class="text-xs text-gray-500">原结论版本</p><p class="mt-1 text-sm font-medium text-gray-950">{{ summary.originalReportVersion }}</p></div>
        <div><p class="text-xs text-gray-500">提交时间</p><p class="mt-1 text-sm text-gray-700">{{ formatDate(summary.submittedAt) }}</p></div>
      </section>

      <section v-if="summary.isolationBlocked" class="rounded-xl border border-red-200 bg-red-50 p-5">
        <h2 class="font-semibold text-red-900">职责隔离：你不能领取此申诉</h2>
        <p class="mt-2 text-sm leading-6 text-red-800">你是原举报结论的审核人。请返回队列，由其他具备权限的审核人员独立复核。</p>
      </section>
      <section v-else-if="!summary.assignedToMe && !isFinal" class="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <h2 class="font-semibold text-amber-950">领取后才能读取说明与证据</h2>
        <p class="mt-2 text-sm leading-6 text-amber-900">领取前只展示案件安全引用。领取会写入审计，并由服务端再次检查原审核人隔离。</p>
        <button v-if="summary.canClaim" class="mt-4 min-h-10 rounded-lg bg-amber-800 px-5 text-sm font-medium text-white disabled:opacity-50" :disabled="claiming" @click="claimAppeal">{{ claiming ? '领取中…' : '领取并开始独立复核' }}</button>
        <p v-else class="mt-4 text-sm font-medium text-amber-900">该案件已由其他复核人领取。</p>
      </section>

      <template v-if="detail">
        <div class="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.72fr)]">
          <div class="min-w-0 space-y-5">
            <section class="rounded-xl border border-gray-200 bg-white p-5"><h2 class="text-sm font-semibold text-gray-950">用户申诉说明</h2><p class="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-gray-700">{{ detail.statement }}</p></section>
            <section class="rounded-xl border border-gray-200 bg-white p-5"><h2 class="text-sm font-semibold text-gray-950">原举报与最小证据</h2><dl class="mt-4 grid gap-4 text-sm sm:grid-cols-2"><div><dt class="text-xs text-gray-500">举报原因</dt><dd class="mt-1 font-medium text-gray-950">{{ detail.report.reasonLabel }}</dd></div><div><dt class="text-xs text-gray-500">当前举报状态</dt><dd class="mt-1 text-gray-800">{{ detail.report.status }} · v{{ detail.report.version }}</dd></div><div><dt class="text-xs text-gray-500">人物资料</dt><dd class="mt-1 break-all text-gray-800">{{ detail.report.profileId }}</dd></div><div><dt class="text-xs text-gray-500">目标类型</dt><dd class="mt-1 text-gray-800">{{ detail.report.targetType }}</dd></div><div class="sm:col-span-2"><dt class="text-xs text-gray-500">原举报说明</dt><dd class="mt-1 whitespace-pre-wrap break-words leading-6 text-gray-800">{{ detail.report.description || '未填写' }}</dd></div><div class="sm:col-span-2"><dt class="text-xs text-gray-500">证据摘要</dt><dd class="mt-1 break-all font-mono text-xs text-gray-700">{{ detail.report.evidence.evidenceDigest }}</dd></div></dl></section>
            <section class="rounded-xl border border-gray-200 bg-white p-5"><h2 class="text-sm font-semibold text-gray-950">用户可见时间线</h2><ol class="mt-4 space-y-4"><li v-for="event in detail.timeline" :key="event.sequence" class="border-l-2 border-rose-200 pl-4"><div class="flex flex-wrap justify-between gap-2"><strong class="text-sm text-gray-950">{{ statusLabel(event.status) }}</strong><span class="text-xs text-gray-500">{{ formatDate(event.createdAt) }}</span></div><p class="mt-1 text-sm leading-6 text-gray-600">{{ event.message }}</p></li></ol></section>
          </div>

          <section class="h-fit rounded-xl border p-5" :class="isFinal ? 'border-gray-200 bg-white' : 'border-rose-200 bg-rose-50'">
            <h2 class="font-semibold text-gray-950">{{ isFinal ? '复核结论' : '形成复核结论' }}</h2>
            <p v-if="isFinal" class="mt-3 text-sm leading-6 text-gray-700">{{ summary.userVisibleMessage }}</p>
            <form v-else class="mt-4 space-y-4" @submit.prevent="submitDecision">
              <label class="block text-sm text-gray-700">结论<select v-model="outcome" class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3"><option value="upheld">维持原结论</option><option value="changed">重新进入举报审核</option></select></label>
              <p class="rounded-lg bg-white p-3 text-xs leading-5 text-gray-600 ring-1 ring-gray-200">{{ outcome === 'changed' ? '改判不会自动执行封禁或下架，只会把原举报恢复为调查中并交由你继续审核。' : '维持结论不会删除申诉或原举报历史。' }}</p>
              <label class="block text-sm text-gray-700">原因码<input v-model.trim="reasonCode" pattern="[a-z0-9_]{3,80}" required class="mt-1 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3"></label>
              <label class="block text-sm text-gray-700">用户可见说明<textarea v-model="userVisibleMessage" maxlength="300" rows="4" required class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"></textarea><span class="mt-1 block text-right text-xs text-gray-500">{{ userVisibleMessage.length }}/300</span></label>
              <button type="submit" class="min-h-10 w-full rounded-lg bg-rose-600 px-5 text-sm font-medium text-white disabled:opacity-50" :disabled="deciding">{{ deciding ? '提交中…' : '确认并提交复核结论' }}</button>
            </form>
          </section>
        </div>
      </template>
    </template>
  </div>
</template>
