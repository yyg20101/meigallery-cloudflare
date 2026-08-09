<script setup lang="ts">
import {
  formatAdminAuditTime,
  type AdminAppAuditIntegrityCheck,
  type AdminAppAuditIntegrityFinding,
  type AdminAppAuditIntegrityOverview,
} from '~/types/admin-app-audit'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const overview = ref<AdminAppAuditIntegrityOverview | null>(null)
const checks = ref<AdminAppAuditIntegrityCheck[]>([])
const selectedCheck = ref<AdminAppAuditIntegrityCheck | null>(null)
const startSequence = ref('')
const endSequence = ref('')
const loading = ref(true)
const running = ref(false)
const detailLoading = ref(false)
const errorMessage = ref('')
const successMessage = ref('')

onMounted(loadWorkspace)

async function loadWorkspace() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [overviewResponse, checksResponse] = await Promise.all([
      api<{ data: AdminAppAuditIntegrityOverview }>('/api/admin/app/audit/integrity/overview'),
      api<{ data: AdminAppAuditIntegrityCheck[] }>('/api/admin/app/audit/integrity/checks'),
    ])
    overview.value = overviewResponse.data
    checks.value = checksResponse.data
    if (!startSequence.value && overview.value.maximumSequence !== null) {
      const minimum = overview.value.minimumSequence ?? 1
      startSequence.value = String(Math.max(minimum, overview.value.maximumSequence - 999))
      endSequence.value = String(overview.value.maximumSequence)
    }
    if (!selectedCheck.value && checks.value[0]) await loadCheck(checks.value[0].checkId)
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '完整性工作区加载失败。该页面仅限有效 Owner。')
  }
  finally {
    loading.value = false
  }
}

async function runCheck() {
  running.value = true
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const response = await api<{ data: AdminAppAuditIntegrityCheck; replayed: boolean }>('/api/admin/app/audit/integrity/checks', {
      method: 'POST',
      headers: { 'Idempotency-Key': `audit-integrity-${crypto.randomUUID()}` },
      body: {
        startSequence: startSequence.value,
        endSequence: endSequence.value,
      },
    })
    selectedCheck.value = response.data
    successMessage.value = response.replayed ? '已返回同一检查结果。' : '已追加完整性清单；原审计事件未被修改。'
    await loadWorkspace()
    await loadCheck(response.data.checkId)
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '完整性检查未完成，请核对连续序号范围。')
  }
  finally {
    running.value = false
  }
}

async function loadCheck(checkId: string) {
  detailLoading.value = true
  errorMessage.value = ''
  try {
    const response = await api<{ data: AdminAppAuditIntegrityCheck }>(`/api/admin/app/audit/integrity/checks/${encodeURIComponent(checkId)}`)
    selectedCheck.value = response.data
  }
  catch (error) {
    errorMessage.value = resolveApiErrorMessage(error, '完整性检查详情读取失败。')
  }
  finally {
    detailLoading.value = false
  }
}

function findingLabel(value: AdminAppAuditIntegrityFinding['type']) {
  return {
    sequence_gap: '序号缺口',
    missing_index: '事实缺少索引',
    malformed_payload: '载荷格式异常',
    sensitive_key: '敏感字段键',
    unregistered_action: 'Action 未登记',
    business_without_audit: '业务事实缺少审计',
    manifest_changed: '同范围摘要变化',
  }[value]
}

function findingClass(value: AdminAppAuditIntegrityFinding['severity']) {
  if (value === 'critical') return 'bg-red-100 text-red-800 ring-red-200'
  if (value === 'warning') return 'bg-amber-100 text-amber-900 ring-amber-200'
  return 'bg-blue-100 text-blue-800 ring-blue-200'
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <header class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div class="min-w-0">
        <NuxtLink to="/admin/app/audit" class="text-sm font-medium text-gray-600 hover:text-gray-950">← 返回审计查询</NuxtLink>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <h1 class="text-xl font-bold text-gray-950">审计完整性</h1>
          <span class="rounded-full bg-red-100 px-2.5 py-1 text-xs font-medium text-red-800">Owner 专属</span>
        </div>
        <p class="mt-1 max-w-4xl text-sm leading-6 text-gray-600">检查稳定序号、事实索引、JSON 载荷、敏感字段、Action 登记、关键业务事实反向审计覆盖和同范围 SHA-256 清单。检查只追加结果，不自动修补或重写历史。</p>
      </div>
      <NuxtLink to="/admin/app/audit/registry" class="inline-flex min-h-10 max-w-full shrink-0 items-center justify-center whitespace-normal rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">治理 Action 口径</NuxtLink>
    </header>

    <p v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ errorMessage }}</p>
    <p v-if="successMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-700">{{ successMessage }}</p>
    <p v-if="loading" class="rounded-xl border border-gray-200 bg-white p-10 text-center text-sm text-gray-500">正在读取审计完整性状态…</p>

    <template v-if="overview">
      <section class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">源事实 / 稳定索引</p><p class="mt-1 text-2xl font-semibold text-gray-950">{{ overview.sourceEventCount }} / {{ overview.indexedEventCount }}</p><p class="mt-1 text-xs text-gray-500">缺少索引 {{ overview.missingIndexCount }}</p></div>
        <div class="rounded-xl border border-gray-200 bg-white p-4"><p class="text-xs text-gray-500">当前序号范围</p><p class="mt-1 font-mono text-lg font-semibold text-gray-950">{{ overview.minimumSequence ?? '—' }} — {{ overview.maximumSequence ?? '—' }}</p></div>
        <div class="rounded-xl border border-violet-200 bg-violet-50 p-4"><p class="text-xs text-violet-700">Action 登记</p><p class="mt-1 text-2xl font-semibold text-violet-950">{{ overview.activeRegistryCount }} / {{ overview.distinctActionCount }}</p><p class="mt-1 text-xs text-violet-700">未登记 {{ overview.unregisteredActionCount }}</p></div>
        <div class="rounded-xl border p-4" :class="overview.productionReady ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'"><p class="text-xs" :class="overview.productionReady ? 'text-emerald-700' : 'text-amber-800'">生产就绪判定</p><p class="mt-1 text-lg font-semibold" :class="overview.productionReady ? 'text-emerald-950' : 'text-amber-950'">{{ overview.productionReady ? '门禁已关闭' : '尚未就绪' }}</p></div>
      </section>

      <section v-if="overview.blockers.length" class="rounded-xl border border-amber-200 bg-amber-50 p-5">
        <h2 class="text-sm font-semibold text-amber-950">当前阻断项</h2>
        <ul class="mt-2 space-y-1 text-sm leading-6 text-amber-900">
          <li v-for="item in overview.blockers" :key="item">• {{ item }}</li>
        </ul>
        <p class="mt-3 text-xs leading-5 text-amber-800">系统不会自动登记 Action 或批准治理策略；正式口径必须进入 Owner 双人复核，保留期与自动运行配置仍在统一配置阶段处理，因此“尚未就绪”是预期安全状态。</p>
      </section>

      <section class="rounded-xl border border-gray-200 bg-white p-5">
        <div class="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div><h2 class="text-base font-semibold text-gray-950">追加一次检查清单</h2><p class="mt-1 text-xs leading-5 text-gray-500">单次最多 5,000 个连续序号；建议先检查最近 1,000 个。重复范围会与上一份清单摘要比较。</p></div>
          <span class="text-xs text-gray-500">不会执行 migration、修复或删除</span>
        </div>
        <form class="mt-4 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" @submit.prevent="runCheck">
          <label class="min-w-0 text-sm text-gray-700">开始序号
            <input v-model="startSequence" inputmode="numeric" required class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono" />
          </label>
          <label class="min-w-0 text-sm text-gray-700">结束序号
            <input v-model="endSequence" inputmode="numeric" required class="mt-1 min-h-11 w-full min-w-0 rounded-lg border border-gray-300 px-3 font-mono" />
          </label>
          <button type="submit" :disabled="running" class="min-h-11 rounded-lg bg-gray-950 px-5 text-sm font-medium text-white hover:bg-black disabled:opacity-50">{{ running ? '正在生成…' : '运行完整性检查' }}</button>
        </form>
      </section>

      <section class="grid min-w-0 gap-4 xl:grid-cols-[minmax(260px,0.8fr)_minmax(0,2fr)]">
        <aside class="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div class="border-b border-gray-200 px-4 py-3"><h2 class="text-sm font-semibold text-gray-950">最近检查</h2></div>
          <div v-if="checks.length" class="divide-y divide-gray-100">
            <button v-for="check in checks" :key="check.checkId" type="button" class="block w-full min-w-0 px-4 py-3 text-left hover:bg-gray-50" :class="selectedCheck?.checkId === check.checkId ? 'bg-gray-50' : ''" @click="loadCheck(check.checkId)">
              <span class="flex items-center justify-between gap-2"><span class="font-mono text-xs font-semibold text-gray-900">{{ check.startSequence }}—{{ check.endSequence }}</span><span class="rounded-full px-2 py-0.5 text-[11px]" :class="check.status === 'passed' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'">{{ check.status === 'passed' ? '通过' : '有发现' }}</span></span>
              <span class="mt-1 block text-[11px] text-gray-500">{{ formatAdminAuditTime(check.createdAt) }} · {{ check.createdBy.label }}</span>
            </button>
          </div>
          <p v-else class="p-6 text-center text-sm text-gray-500">尚无检查清单</p>
        </aside>

        <section class="min-w-0 rounded-xl border border-gray-200 bg-white p-5" aria-label="完整性检查详情">
          <p v-if="detailLoading" class="py-12 text-center text-sm text-gray-500">正在读取清单详情…</p>
          <template v-else-if="selectedCheck">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0"><h2 class="text-base font-semibold text-gray-950">检查 #{{ selectedCheck.startSequence }}—{{ selectedCheck.endSequence }}</h2><p class="mt-1 break-all font-mono text-[11px] text-gray-500">{{ selectedCheck.checkId }}</p></div>
              <span class="self-start rounded-full px-2.5 py-1 text-xs font-medium" :class="selectedCheck.status === 'passed' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-900'">{{ selectedCheck.status === 'passed' ? '检查通过' : '存在 finding' }}</span>
            </div>
            <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
              <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">序号缺口</p><p class="mt-1 text-lg font-semibold">{{ selectedCheck.counts.sequenceGap }}</p></div>
              <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">缺少索引</p><p class="mt-1 text-lg font-semibold">{{ selectedCheck.counts.missingIndex }}</p></div>
              <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">格式异常</p><p class="mt-1 text-lg font-semibold">{{ selectedCheck.counts.malformedPayload }}</p></div>
              <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">敏感字段</p><p class="mt-1 text-lg font-semibold">{{ selectedCheck.counts.sensitiveKey }}</p></div>
              <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">未登记事件</p><p class="mt-1 text-lg font-semibold">{{ selectedCheck.counts.unregisteredAction }}</p></div>
              <div class="rounded-lg bg-gray-50 p-3"><p class="text-xs text-gray-500">业务缺审计</p><p class="mt-1 text-lg font-semibold">{{ selectedCheck.counts.businessWithoutAudit }}</p></div>
            </div>
            <div class="mt-4 rounded-lg bg-gray-950 p-4 text-gray-100"><p class="text-xs text-gray-400">Manifest SHA-256 · {{ selectedCheck.manifestVersion }}</p><p class="mt-1 break-all font-mono text-xs leading-5">{{ selectedCheck.manifestDigest }}</p><p class="mt-2 text-[11px] text-gray-400">检查事件 {{ selectedCheck.eventCount }} 个 · 上一同范围同算法清单 {{ selectedCheck.previousManifestCheckId || '无' }}</p></div>

            <div v-if="selectedCheck.findings.length" class="mt-5 overflow-hidden rounded-lg border border-gray-200">
              <article v-for="finding in selectedCheck.findings" :key="finding.findingId" class="grid min-w-0 gap-3 border-b border-gray-100 p-4 last:border-b-0 md:grid-cols-[120px_minmax(0,1fr)_120px] md:items-center">
                <div><span class="inline-flex rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="findingClass(finding.severity)">{{ finding.severity }}</span><p class="mt-1 text-xs text-gray-600">{{ findingLabel(finding.type) }}</p></div>
                <div class="min-w-0"><p class="break-words text-sm font-medium text-gray-900">{{ finding.summaryCode }}</p><p class="mt-1 break-all font-mono text-[10px] text-gray-500">{{ finding.evidenceDigest }}</p></div>
                <NuxtLink v-if="finding.eventId" :to="{ path: `/admin/app/audit/${finding.eventId}`, query: { purpose: 'compliance_audit' } }" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 hover:bg-gray-50">查看 #{{ finding.sequence }}</NuxtLink>
                <span v-else class="text-xs text-gray-500 md:text-right">{{ finding.type === 'business_without_audit' ? '业务事实级 finding' : '范围级 finding' }}</span>
              </article>
              <p v-if="selectedCheck.findings.length >= 50" class="border-t border-gray-200 bg-gray-50 p-3 text-xs leading-5 text-gray-600">单份清单最多保存并展示前 50 条 finding，分类总数以上方计数为准。</p>
            </div>
            <p v-else class="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">该范围未发现序号、索引、载荷、敏感字段、Action 登记、关键业务审计覆盖或摘要变化问题。</p>
          </template>
          <p v-else class="py-12 text-center text-sm text-gray-500">选择或运行一项检查以查看详情。</p>
        </section>
      </section>
    </template>
  </div>
</template>
