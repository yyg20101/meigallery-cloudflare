<script setup lang="ts">
import {
  adminIncidentDomainLabel,
  adminIncidentSeverityClass,
  adminIncidentSeverityLabel,
  adminIncidentStatusClass,
  adminIncidentStatusLabel,
  adminIncidentTypeLabel,
  adminOperationTime,
  type AdminOperationalControl,
  type AdminOperationalControlPreview,
  type AdminOperationalIncidentDetail,
  type AdminOperationalIncidentEvent,
  type AdminOperationalIncidentStatus,
  type AdminOperationalRunbook,
} from '~/types/admin-app-operations'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const incidentId = computed(() => String(route.params.incidentId || ''))
const actionBusy = ref('')
const actionError = ref('')
const successMessage = ref('')

const noteForm = reactive({
  reasonCode: 'incident_response_note',
  note: '',
  evidenceReference: '',
})
const statusForm = reactive({
  status: '' as AdminOperationalIncidentStatus | '',
  reasonCode: 'incident_status_update',
  note: '',
  evidenceReference: '',
  resolutionSummary: '',
  postmortemReference: '',
})
const selectedRunbookId = ref('')
const runbookReasonCode = ref('incident_runbook_linked')
const controlPreview = ref<AdminOperationalControlPreview | null>(null)
const controlPreviewLoading = ref(false)
const showControlDialog = ref(false)
const controlForm = reactive({ reasonCode: '', reasonSummary: '', evidenceReference: '' })

const { data, status, error, refresh } = await useAsyncData(
  () => `admin-app-operation-incident-${incidentId.value}`,
  () => api<{ data: AdminOperationalIncidentDetail }>(`/api/admin/app/operations/incidents/${encodeURIComponent(incidentId.value)}`),
)
const { data: runbookData, status: runbookStatus } = await useAsyncData(
  'admin-app-operation-runbooks',
  () => api<{ data: AdminOperationalRunbook[] }>('/api/admin/app/operations/runbooks'),
)

const detail = computed(() => data.value?.data ?? null)
const runbooks = computed(() => runbookData.value?.data ?? [])
const detailError = computed(() => error.value
  ? resolveApiErrorMessage(error.value, '事件详情加载失败，请返回事件中心重试。')
  : '')
const terminalTarget = computed(() => statusForm.status === 'resolved' || statusForm.status === 'false_positive')
const timeline = computed(() => detail.value ? [...detail.value.events].reverse() : [])
const availableStatuses = computed(() => detail.value ? nextStatuses(detail.value.status) : [])
const previewAction = computed<'pause' | 'restore'>(() => controlPreview.value?.control.state === 'paused' ? 'restore' : 'pause')
const previewCanSubmit = computed(() => {
  if (!controlPreview.value) return false
  return previewAction.value === 'pause'
    ? controlPreview.value.decision.canPause
    : controlPreview.value.decision.canRestore
})

watch(detail, (value) => {
  if (!value) return
  selectedRunbookId.value = value.runbook?.id ?? ''
  if (!availableStatuses.value.includes(statusForm.status as AdminOperationalIncidentStatus)) {
    statusForm.status = availableStatuses.value[0] ?? ''
  }
}, { immediate: true })

async function claimIncident() {
  if (!detail.value?.permissions.canClaim || actionBusy.value) return
  if (import.meta.client && !window.confirm('确认领取该运营事件？领取后普通管理员才能继续记录处置与更新状态。')) return
  await performAction('claim', '事件已领取。', async () => {
    await api(`/api/admin/app/operations/incidents/${encodeURIComponent(incidentId.value)}/claim`, {
      method: 'POST',
      headers: operationHeaders('incident.claim'),
      body: { expectedVersion: detail.value!.version },
    })
  })
}

async function addNote() {
  if (!detail.value?.permissions.canRespond || actionBusy.value || noteForm.note.trim().length < 2) return
  await performAction('note', '处置记录已追加到不可变时间线。', async () => {
    await api(`/api/admin/app/operations/incidents/${encodeURIComponent(incidentId.value)}/notes`, {
      method: 'POST',
      headers: operationHeaders('incident.note'),
      body: {
        expectedVersion: detail.value!.version,
        reasonCode: noteForm.reasonCode,
        note: noteForm.note,
        evidenceReference: noteForm.evidenceReference || undefined,
      },
    })
    noteForm.note = ''
    noteForm.evidenceReference = ''
  })
}

async function changeStatus() {
  if (!detail.value?.permissions.canRespond || !statusForm.status || actionBusy.value) return
  if (terminalTarget.value && (!statusForm.resolutionSummary.trim() || !statusForm.evidenceReference.trim())) {
    actionError.value = '关闭事件必须填写结论摘要与证据引用。'
    return
  }
  const targetLabel = adminIncidentStatusLabel(statusForm.status)
  if (import.meta.client && !window.confirm(`确认把事件状态更新为“${targetLabel}”？每次迁移都会写入事件时间线和审计日志。`)) return
  await performAction('status', `事件状态已更新为“${targetLabel}”。`, async () => {
    await api(`/api/admin/app/operations/incidents/${encodeURIComponent(incidentId.value)}/status`, {
      method: 'POST',
      headers: operationHeaders('incident.status'),
      body: {
        expectedVersion: detail.value!.version,
        status: statusForm.status,
        reasonCode: statusForm.reasonCode,
        note: statusForm.note || undefined,
        evidenceReference: statusForm.evidenceReference || undefined,
        resolutionSummary: statusForm.resolutionSummary || undefined,
        postmortemReference: statusForm.postmortemReference || undefined,
      },
    })
    statusForm.note = ''
    statusForm.evidenceReference = ''
    statusForm.resolutionSummary = ''
    statusForm.postmortemReference = ''
  })
}

async function linkRunbook() {
  if (!detail.value?.permissions.canRespond || !selectedRunbookId.value || actionBusy.value) return
  await performAction('runbook', 'Runbook 已关联到当前事件版本。', async () => {
    await api(`/api/admin/app/operations/incidents/${encodeURIComponent(incidentId.value)}/runbook`, {
      method: 'POST',
      headers: operationHeaders('incident.runbook'),
      body: {
        expectedVersion: detail.value!.version,
        runbookId: selectedRunbookId.value,
        reasonCode: runbookReasonCode.value,
      },
    })
  })
}

async function openControlPreview(control: AdminOperationalControl) {
  if (!detail.value?.permissions.canOperateSafetyControls || controlPreviewLoading.value) return
  controlPreviewLoading.value = true
  actionError.value = ''
  controlPreview.value = null
  showControlDialog.value = true
  try {
    const response = await api<{ data: AdminOperationalControlPreview }>(
      `/api/admin/app/operations/safety-controls/${encodeURIComponent(control.key)}/preview`,
      { query: { incidentId: incidentId.value } },
    )
    controlPreview.value = response.data
    const action = response.data.control.state === 'paused' ? 'restore' : 'pause'
    controlForm.reasonCode = action === 'pause' ? 'incident_safety_pause' : 'incident_safety_restore'
    controlForm.reasonSummary = action === 'pause'
      ? `因 ${detail.value.title} 暂停 ${response.data.control.displayName}`
      : `已验证 ${detail.value.title} 的缓解措施，恢复 ${response.data.control.displayName}`
    controlForm.evidenceReference = ''
  }
  catch (previewError) {
    actionError.value = resolveApiErrorMessage(previewError, '安全控制影响预览失败，未执行任何变更。')
    showControlDialog.value = false
  }
  finally {
    controlPreviewLoading.value = false
  }
}

async function changeSafetyControl() {
  const preview = controlPreview.value
  if (!preview || !previewCanSubmit.value || actionBusy.value) return
  if (previewAction.value === 'restore' && !controlForm.evidenceReference.trim()) {
    actionError.value = '恢复安全控制必须填写验证证据引用。'
    return
  }
  await performAction('control', previewAction.value === 'pause' ? '安全控制已暂停。' : '安全控制已恢复。', async () => {
    await api('/api/admin/app/operations/safety-controls/change', {
      method: 'POST',
      headers: operationHeaders(`control.${previewAction.value}`),
      body: {
        action: previewAction.value,
        controlKey: preview.control.key,
        expectedControlVersion: preview.control.version,
        incidentId: preview.incident.incidentId,
        expectedIncidentVersion: preview.incident.version,
        reasonCode: controlForm.reasonCode,
        reasonSummary: controlForm.reasonSummary,
        evidenceReference: controlForm.evidenceReference || undefined,
      },
    })
    showControlDialog.value = false
    controlPreview.value = null
  })
}

async function performAction(key: string, success: string, operation: () => Promise<void>) {
  actionBusy.value = key
  actionError.value = ''
  successMessage.value = ''
  try {
    await operation()
    successMessage.value = success
    await refresh()
  }
  catch (operationError) {
    actionError.value = resolveApiErrorMessage(operationError, '事件操作失败，数据可能已变化，请刷新后重试。')
    await refresh().catch(() => undefined)
    if (key === 'control') {
      showControlDialog.value = false
      controlPreview.value = null
    }
  }
  finally {
    actionBusy.value = ''
  }
}

function operationHeaders(prefix: string) {
  return { 'Idempotency-Key': `${prefix}.${crypto.randomUUID().replaceAll('-', '')}` }
}

function nextStatuses(current: AdminOperationalIncidentStatus): AdminOperationalIncidentStatus[] {
  const transitions: Record<AdminOperationalIncidentStatus, AdminOperationalIncidentStatus[]> = {
    open: ['acknowledged', 'investigating', 'mitigated', 'resolved', 'false_positive'],
    acknowledged: ['investigating', 'mitigated', 'resolved', 'false_positive'],
    investigating: ['mitigated', 'resolved', 'false_positive'],
    mitigated: ['investigating', 'resolved', 'false_positive'],
    resolved: ['open'],
    false_positive: ['open'],
  }
  return transitions[current]
}

function eventTypeLabel(value: string) {
  return ({
    detected: '检测器创建事件',
    signal_refreshed: '检测信号刷新',
    reopened: '事件重新打开',
    claimed: '负责人领取',
    note_added: '追加处置记录',
    status_changed: '状态更新',
    resolved: '事件解决',
    false_positive: '确认误报',
    runbook_linked: '关联 Runbook',
    control_paused: '暂停安全控制',
    control_restored: '恢复安全控制',
  } as Record<string, string>)[value] ?? value
}

function blockerLabel(value: string) {
  return ({
    CONTROL_LINKED_TO_ANOTHER_INCIDENT: '该控制由另一事件暂停，只能在原事件中恢复',
    INCIDENT_SEVERITY_TOO_LOW: '只有 P0/P1 事件可以触发安全暂停',
    INCIDENT_ALREADY_CLOSED: '已关闭事件不能触发安全暂停',
  } as Record<string, string>)[value] ?? value
}

function safeSummary(event: AdminOperationalIncidentEvent) {
  const entries = Object.entries(event.safeSummary)
  if (!entries.length) return ''
  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(' · ')
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader page-id="ADM-OV-03" :route="route.path" title="异常详情" :description="`记录影响、时间线、处置动作和受控安全开关 · ${incidentId}`" :state="status === 'pending' ? '加载中' : detailError ? '加载失败' : detail ? adminIncidentStatusLabel(detail.status) : '正常'" :figma-state="detailError ? '证据不足' : detail?.status === 'open' && (detail.severity === 'p0' || detail.severity === 'p1') ? '影响扩大' : '正常'" :state-tone="detailError ? 'danger' : status === 'pending' ? 'warning' : detail?.severity === 'p0' || detail?.severity === 'p1' ? 'danger' : 'info'">
      <template #actions><NuxtLink to="/admin/app/incidents" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-[#eaded8] bg-white px-4 text-sm font-medium text-stone-700 hover:bg-[#fff7f2]">返回事件中心</NuxtLink></template>
    </AdminAppPageHeader>

    <p v-if="actionError" class="rounded-xl border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-700">{{ actionError }}</p>
    <p v-if="successMessage" class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-800">{{ successMessage }}</p>
    <div v-if="status === 'pending'" class="rounded-xl border border-gray-200 bg-white p-12 text-center text-sm text-gray-500">正在读取事件详情…</div>
    <p v-else-if="detailError || !detail" class="rounded-xl border border-red-200 bg-red-50 p-5 text-sm leading-6 text-red-700">{{ detailError || '事件详情不存在或当前不可访问。' }}</p>

    <template v-else>
      <section class="rounded-2xl border border-gray-200 bg-white p-4 sm:p-6">
        <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="adminIncidentSeverityClass(detail.severity)">{{ adminIncidentSeverityLabel(detail.severity) }}</span>
              <span class="rounded-full px-2 py-1 text-xs font-medium ring-1 ring-inset" :class="adminIncidentStatusClass(detail.status)">{{ adminIncidentStatusLabel(detail.status) }}</span>
              <span class="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">{{ adminIncidentDomainLabel(detail.domain) }}</span>
            </div>
            <h2 class="mt-3 break-words text-xl font-semibold text-gray-950">{{ detail.title }}</h2>
            <p class="mt-2 max-w-4xl break-words text-sm leading-6 text-gray-600">{{ detail.summary }}</p>
            <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500"><span>{{ adminIncidentTypeLabel(detail.type) }}</span><span>信号 {{ detail.signalCount }}</span><span>{{ detail.impact.count === null ? '影响数量未知' : `影响 ${detail.impact.count} 项` }}</span><span>事件 v{{ detail.version }}</span></div>
          </div>
          <button v-if="detail.permissions.canClaim" type="button" :disabled="Boolean(actionBusy)" class="min-h-11 w-full shrink-0 rounded-lg bg-gray-950 px-5 text-sm font-medium text-white disabled:opacity-50 sm:w-auto" @click="claimIncident">{{ actionBusy === 'claim' ? '领取中…' : '领取事件' }}</button>
        </div>
        <dl class="mt-5 grid min-w-0 gap-4 border-t border-gray-100 pt-5 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <div class="min-w-0"><dt class="text-xs text-gray-500">负责人</dt><dd class="mt-1 truncate font-medium text-gray-900" :title="detail.owner?.label || '尚未分配'">{{ detail.owner?.label || '尚未分配' }}</dd></div>
          <div class="min-w-0"><dt class="text-xs text-gray-500">首次发现</dt><dd class="mt-1 text-gray-900">{{ adminOperationTime(detail.timestamps.firstSeenAt) }}</dd></div>
          <div class="min-w-0"><dt class="text-xs text-gray-500">最后信号</dt><dd class="mt-1 text-gray-900">{{ adminOperationTime(detail.timestamps.lastSeenAt) }}</dd></div>
          <div class="min-w-0"><dt class="text-xs text-gray-500">信号引用</dt><dd class="mt-1 break-all font-mono text-xs text-gray-900">{{ detail.source.reference }}</dd></div>
        </dl>
      </section>

      <section v-if="detail.resolution" class="rounded-xl border border-emerald-200 bg-emerald-50 p-4 sm:p-5">
        <h2 class="text-sm font-semibold text-emerald-950">关闭结论</h2>
        <p class="mt-2 break-words text-sm leading-6 text-emerald-900">{{ detail.resolution.summary }}</p>
        <div class="mt-2 flex flex-col gap-1 break-all font-mono text-xs text-emerald-800"><span>原因：{{ detail.resolution.code }}</span><span>证据：{{ detail.resolution.evidenceReference }}</span><span v-if="detail.resolution.postmortemReference">复盘：{{ detail.resolution.postmortemReference }}</span></div>
      </section>

      <section class="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
        <div class="min-w-0 space-y-5">
          <form class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5" @submit.prevent="addNote">
            <div><h2 class="text-base font-semibold text-gray-950">追加处置记录</h2><p class="mt-1 text-xs leading-5 text-gray-500">记录会进入不可变时间线；请勿写入用户密码、令牌或非必要个人信息。</p></div>
            <fieldset :disabled="!detail.permissions.canRespond || Boolean(actionBusy)" class="mt-4 grid min-w-0 gap-4 disabled:opacity-60">
              <label class="min-w-0 text-sm font-medium text-gray-700">稳定原因码<input v-model.trim="noteForm.reasonCode" required pattern="[a-z0-9_]{3,80}" maxlength="80" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" /></label>
              <label class="min-w-0 text-sm font-medium text-gray-700">处置说明<textarea v-model.trim="noteForm.note" required minlength="2" maxlength="1000" rows="4" class="mt-1 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6" placeholder="说明已核查内容、当前判断与下一步。" /></label>
              <label class="min-w-0 text-sm font-medium text-gray-700">证据引用（可选）<input v-model.trim="noteForm.evidenceReference" maxlength="192" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" placeholder="audit:...、detection:... 或 https://..." /></label>
              <button type="submit" :disabled="noteForm.note.trim().length < 2 || Boolean(actionBusy)" class="min-h-11 w-full rounded-lg bg-gray-950 px-5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-fit">{{ actionBusy === 'note' ? '提交中…' : '追加到时间线' }}</button>
            </fieldset>
            <p v-if="!detail.permissions.canRespond" class="mt-3 text-xs text-amber-700">普通管理员需先领取事件；Owner 可直接处置。</p>
          </form>

          <form class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5" @submit.prevent="changeStatus">
            <div><h2 class="text-base font-semibold text-gray-950">更新事件状态</h2><p class="mt-1 text-xs leading-5 text-gray-500">只提供服务端允许的下一状态；关闭必须具备结论摘要和可追溯证据。</p></div>
            <fieldset :disabled="!detail.permissions.canRespond || Boolean(actionBusy)" class="mt-4 grid min-w-0 gap-4 disabled:opacity-60 sm:grid-cols-2">
              <label class="min-w-0 text-sm font-medium text-gray-700">下一状态<select v-model="statusForm.status" required class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm"><option v-for="nextStatus in availableStatuses" :key="nextStatus" :value="nextStatus">{{ adminIncidentStatusLabel(nextStatus) }}</option></select></label>
              <label class="min-w-0 text-sm font-medium text-gray-700">稳定原因码<input v-model.trim="statusForm.reasonCode" required pattern="[a-z0-9_]{3,80}" maxlength="80" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" /></label>
              <label class="min-w-0 text-sm font-medium text-gray-700 sm:col-span-2">本次说明（可选）<textarea v-model.trim="statusForm.note" maxlength="1000" rows="3" class="mt-1 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6" /></label>
              <template v-if="terminalTarget">
                <label class="min-w-0 text-sm font-medium text-gray-700 sm:col-span-2">关闭结论摘要<textarea v-model.trim="statusForm.resolutionSummary" required maxlength="500" rows="3" class="mt-1 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6" /></label>
                <label class="min-w-0 text-sm font-medium text-gray-700">验证证据引用<input v-model.trim="statusForm.evidenceReference" required maxlength="192" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" /></label>
                <label class="min-w-0 text-sm font-medium text-gray-700">复盘文档引用（可选）<input v-model.trim="statusForm.postmortemReference" maxlength="240" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" /></label>
              </template>
              <label v-else class="min-w-0 text-sm font-medium text-gray-700 sm:col-span-2">证据引用（可选）<input v-model.trim="statusForm.evidenceReference" maxlength="192" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" /></label>
              <button type="submit" :disabled="!statusForm.status || Boolean(actionBusy)" class="min-h-11 w-full rounded-lg bg-gray-950 px-5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 sm:col-span-2 sm:w-fit">{{ actionBusy === 'status' ? '更新中…' : '确认状态迁移' }}</button>
            </fieldset>
          </form>
        </div>

        <aside class="min-w-0 space-y-5">
          <form class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5" @submit.prevent="linkRunbook">
            <h2 class="text-base font-semibold text-gray-950">处置 Runbook</h2>
            <p class="mt-1 text-xs leading-5 text-gray-500">关联固定版本，后续文档更新不会静默改变本次事件依据。</p>
            <fieldset :disabled="!detail.permissions.canRespond || Boolean(actionBusy) || runbookStatus === 'pending'" class="mt-4 space-y-4 disabled:opacity-60">
              <label class="block min-w-0 text-sm font-medium text-gray-700">选择 Runbook<select v-model="selectedRunbookId" required class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm"><option value="" disabled>请选择</option><option v-for="runbook in runbooks" :key="runbook.runbookId" :value="runbook.runbookId">{{ runbook.title }} · v{{ runbook.version }}</option></select></label>
              <label class="block min-w-0 text-sm font-medium text-gray-700">关联原因码<input v-model.trim="runbookReasonCode" required pattern="[a-z0-9_]{3,80}" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" /></label>
              <button type="submit" :disabled="!selectedRunbookId || selectedRunbookId === detail.runbook?.id || Boolean(actionBusy)" class="min-h-11 w-full rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 disabled:cursor-not-allowed disabled:opacity-50">{{ actionBusy === 'runbook' ? '关联中…' : '关联所选版本' }}</button>
            </fieldset>
            <div v-if="detail.runbook" class="mt-4 min-w-0 rounded-lg bg-gray-50 p-3"><p class="break-words text-sm font-medium text-gray-900">{{ detail.runbook.title }}</p><p class="mt-1 break-words text-xs leading-5 text-gray-500">{{ detail.runbook.summary }}</p><p class="mt-2 break-all font-mono text-[10px] leading-5 text-gray-500">{{ detail.runbook.documentReference }}</p></div>
          </form>

          <section class="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
            <div><h2 class="text-base font-semibold text-gray-950">跨域安全控制</h2><p class="mt-1 text-xs leading-5 text-gray-500">切换前必须查看影响预览；仅 Owner 可操作。</p></div>
            <div class="mt-4 space-y-3">
              <article v-for="control in detail.controls" :key="control.key" class="min-w-0 rounded-lg border p-3" :class="control.state === 'paused' ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'">
                <div class="flex min-w-0 items-start justify-between gap-2"><div class="min-w-0"><p class="break-words text-sm font-medium text-gray-950">{{ control.displayName }}</p><p class="mt-1 break-all font-mono text-[10px] text-gray-500">{{ control.key }} · v{{ control.version }}</p></div><span class="shrink-0 rounded-full px-2 py-1 text-[11px] font-medium" :class="control.state === 'paused' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'">{{ control.state === 'paused' ? '已暂停' : '可用' }}</span></div>
                <p v-if="control.state === 'paused'" class="mt-2 break-words text-xs leading-5 text-red-700">{{ control.linkedToThisIncident ? '由当前事件暂停' : '由其他事件暂停' }}</p>
                <button v-if="detail.permissions.canOperateSafetyControls" type="button" :disabled="controlPreviewLoading || Boolean(actionBusy)" class="mt-3 min-h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 disabled:opacity-50" @click="openControlPreview(control)">查看{{ control.state === 'paused' ? '恢复' : '暂停' }}影响</button>
              </article>
            </div>
          </section>
        </aside>
      </section>

      <section class="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div class="border-b border-gray-200 px-4 py-4 sm:px-5"><h2 class="text-base font-semibold text-gray-950">不可变处置时间线</h2><p class="mt-1 text-xs text-gray-500">最新事件优先；原记录不会被覆盖或删除。</p></div>
        <div class="divide-y divide-gray-100">
          <article v-for="event in timeline" :key="event.eventId" class="grid min-w-0 gap-3 p-4 sm:p-5 xl:grid-cols-[150px_minmax(0,1fr)_180px]">
            <div><p class="text-sm font-medium text-gray-900">{{ eventTypeLabel(event.type) }}</p><p class="mt-1 text-xs text-gray-500">事件 v{{ event.incidentVersion }} · #{{ event.sequence }}</p></div>
            <div class="min-w-0"><p v-if="event.transition" class="text-sm text-gray-700">{{ adminIncidentStatusLabel(event.transition.from as AdminOperationalIncidentStatus) }} → {{ adminIncidentStatusLabel(event.transition.to as AdminOperationalIncidentStatus) }}</p><p v-if="event.responseNote" class="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-gray-700">{{ event.responseNote }}</p><p v-if="safeSummary(event)" class="mt-2 break-all font-mono text-[10px] leading-5 text-gray-400">{{ safeSummary(event) }}</p><div class="mt-2 flex flex-col gap-1 break-all font-mono text-[10px] text-gray-500"><span>原因：{{ event.reasonCode }}</span><span v-if="event.evidenceReference">证据：{{ event.evidenceReference }}</span></div></div>
            <div class="text-xs leading-5 text-gray-500 xl:text-right"><p>{{ event.actor.label }}</p><p>{{ adminOperationTime(event.createdAt) }}</p></div>
          </article>
        </div>
      </section>
    </template>

    <div v-if="showControlDialog" class="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-3 sm:p-5" role="presentation" @click.self="showControlDialog = false">
      <div class="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl sm:p-6" role="dialog" aria-modal="true" aria-labelledby="control-preview-title">
        <div class="flex items-start justify-between gap-4"><div class="min-w-0"><h2 id="control-preview-title" class="break-words text-lg font-semibold text-gray-950">安全控制影响确认</h2><p class="mt-1 text-xs leading-5 text-gray-500">此窗口关闭前不会修改任何运行状态。</p></div><button type="button" class="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700" @click="showControlDialog = false">关闭</button></div>
        <div v-if="controlPreviewLoading" class="py-12 text-center text-sm text-gray-500">正在计算影响范围…</div>
        <template v-else-if="controlPreview">
          <div class="mt-5 rounded-xl border p-4" :class="previewAction === 'pause' ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'"><p class="text-sm font-semibold" :class="previewAction === 'pause' ? 'text-red-950' : 'text-emerald-950'">{{ previewAction === 'pause' ? `暂停 ${controlPreview.control.displayName}` : `恢复 ${controlPreview.control.displayName}` }}</p><p class="mt-1 text-xs leading-5 opacity-80">控制 v{{ controlPreview.control.version }} · 事件 v{{ controlPreview.incident.version }}。提交时会同时校验两个版本。</p></div>
          <div class="mt-4 grid gap-4 sm:grid-cols-2">
            <section class="min-w-0 rounded-xl border border-red-200 bg-red-50 p-4"><h3 class="text-sm font-semibold text-red-950">将被阻断</h3><ul class="mt-2 space-y-2 text-sm leading-5 text-red-900"><li v-for="item in controlPreview.impact.blockedOperations" :key="item" class="break-words">• {{ item }}</li></ul></section>
            <section class="min-w-0 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><h3 class="text-sm font-semibold text-emerald-950">保持可用</h3><ul class="mt-2 space-y-2 text-sm leading-5 text-emerald-900"><li v-for="item in controlPreview.impact.unaffectedOperations" :key="item" class="break-words">• {{ item }}</li></ul></section>
          </div>
          <div v-if="controlPreview.decision.blockers.length" class="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4"><h3 class="text-sm font-semibold text-amber-950">当前不可执行</h3><ul class="mt-2 space-y-1 text-sm leading-6 text-amber-900"><li v-for="blocker in controlPreview.decision.blockers" :key="blocker">• {{ blockerLabel(blocker) }}</li></ul></div>
          <form class="mt-5 space-y-4" @submit.prevent="changeSafetyControl">
            <label class="block min-w-0 text-sm font-medium text-gray-700">稳定原因码<input v-model.trim="controlForm.reasonCode" required pattern="[a-z0-9_]{3,80}" maxlength="80" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" /></label>
            <label class="block min-w-0 text-sm font-medium text-gray-700">影响与决策说明<textarea v-model.trim="controlForm.reasonSummary" required minlength="3" maxlength="500" rows="3" class="mt-1 w-full resize-y rounded-lg border border-gray-300 px-3 py-2 text-sm leading-6" /></label>
            <label class="block min-w-0 text-sm font-medium text-gray-700">验证证据引用{{ previewAction === 'restore' ? '（恢复必填）' : '（可选）' }}<input v-model.trim="controlForm.evidenceReference" :required="previewAction === 'restore'" maxlength="192" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 font-mono text-sm" /></label>
            <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" class="min-h-11 w-full rounded-lg border border-gray-300 px-4 text-sm font-medium text-gray-700 sm:w-auto" @click="showControlDialog = false">取消</button><button type="submit" :disabled="!previewCanSubmit || !controlForm.reasonSummary.trim() || Boolean(actionBusy)" class="min-h-11 w-full rounded-lg px-5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto" :class="previewAction === 'pause' ? 'bg-red-700' : 'bg-emerald-700'">{{ actionBusy === 'control' ? '提交中…' : previewAction === 'pause' ? '确认暂停控制' : '确认验证并恢复' }}</button></div>
          </form>
        </template>
      </div>
    </div>
  </div>
</template>
