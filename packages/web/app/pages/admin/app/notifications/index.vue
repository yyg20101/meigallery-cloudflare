<script setup lang="ts">
import type {
  AdminNotificationCategory,
  AdminNotificationDefinition,
  AdminNotificationDelivery,
  AdminNotificationDeliveryStatus,
  AdminNotificationOverview,
  AdminNotificationTemplate,
  AdminNotificationTemplateWorkspace,
} from '~/types/admin-app-notifications'
import type { AdminFigmaPageId } from '~/utils/admin-figma-pages'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const routeTemplateId = computed(() => typeof route.params.templateId === 'string' ? route.params.templateId : null)
const initialTab = route.path.endsWith('/deliveries')
  ? 'deliveries'
  : route.path.includes('/templates') ? 'templates' : 'events'
const activeTab = ref<'events' | 'templates' | 'deliveries'>(initialTab)
type NotificationPageContext = { pageId: AdminFigmaPageId; route: string; title: string; description: string }
const pageContext = computed<NotificationPageContext>(() => {
  if (activeTab.value === 'templates') {
    return {
      pageId: 'ADM-NTF-02',
      route: route.path,
      title: '通知模板版本',
      description: '维护用户安全文案、变量、地区与语言版本，并通过审核后生效。',
    }
  }
  if (activeTab.value === 'deliveries') {
    return {
      pageId: 'ADM-NTF-03',
      route: '/admin/app/notifications/deliveries',
      title: '通知生成结果',
      description: '查询事件生成、失败、抑制与防重结果，不展示不必要的消息正文。',
    }
  }
  return {
    pageId: 'ADM-NTF-01',
    route: '/admin/app/notifications/events',
    title: '通知事件定义',
    description: '查看事件 Schema、必要性、敏感字段策略、消费者与版本状态。',
  }
})
const deliveryStatus = ref<AdminNotificationDeliveryStatus | ''>('')
const deliveryCategory = ref<AdminNotificationCategory | ''>('')
const errorMessage = ref('')
const templateErrorCode = ref('')
const successMessage = ref('')
const templateBusy = ref('')
const reviewNote = ref('')
const templateForm = reactive({
  proposedTemplateId: '',
  versionCode: '',
  locale: 'zh-CN' as const,
  regionScope: 'all' as const,
  variableAllowlistText: '',
  title: '',
  summary: '',
  body: '',
})
const tabs: Array<{ key: 'events' | 'templates' | 'deliveries'; label: string }> = [
  { key: 'events', label: '事件定义' },
  { key: 'templates', label: '安全模板' },
  { key: 'deliveries', label: '投影记录' },
]

watch(() => route.path, (path) => {
  activeTab.value = path.endsWith('/deliveries') ? 'deliveries' : path.includes('/templates') ? 'templates' : 'events'
})

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
const { data: templateWorkspaceData, status: templateWorkspaceStatus, refresh: refreshTemplateWorkspace } = await useAsyncData(
  () => `admin-app-notification-template-${routeTemplateId.value || 'none'}`,
  async () => routeTemplateId.value
    ? api<{ data: AdminNotificationTemplateWorkspace }>(`/api/admin/app/notifications/templates/${routeTemplateId.value}`)
    : null,
  { watch: [routeTemplateId] },
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
const visibleTemplates = computed(() => routeTemplateId.value
  ? templates.value.filter(item => item.templateId === routeTemplateId.value)
  : templates.value)
const deliveries = computed(() => deliveryData.value?.data ?? [])
const templateWorkspace = computed(() => templateWorkspaceData.value?.data ?? null)
const templateRequest = computed(() => templateWorkspace.value?.request ?? null)
const templateVariableCatalog = computed(() => templateWorkspace.value?.template.variableCatalog ?? [])
const templateEditorLocked = computed(() => !templateWorkspace.value?.canCreateDraft && !templateRequest.value?.canEdit)
const canSaveTemplateDraft = computed(() => Boolean(
  templateWorkspace.value?.canCreateDraft || templateRequest.value?.canEdit,
))
const isLoading = computed(() => [
  overviewStatus.value,
  eventStatus.value,
  templateStatus.value,
  deliveryLoadStatus.value,
].some(value => value === 'pending'))
const figmaState = computed(() => {
  if (activeTab.value === 'events') {
    if (definitions.value.some(item => item.active && !item.template)) return '未登记'
    if (definitions.value.length > 0 && definitions.value.every(item => !item.active)) return '已停用'
    return '正常'
  }
  if (activeTab.value === 'templates') {
    if (templateErrorCode.value === 'TEMPLATE_REGION_CONFLICT') return '地区冲突'
    if (templateErrorCode.value === 'TEMPLATE_LOCALE_CONFLICT') return '语言冲突'
    if (templateErrorCode.value.startsWith('TEMPLATE_VARIABLE')) return '变量缺失'
    return '正常'
  }
  if (deliveries.value.some(item => item.status === 'failed' || item.status === 'dead_letter')) return '模板失败'
  if (deliveries.value.some(item => item.status === 'pending' || item.status === 'processing')) return '积压'
  if (deliveries.value.some(item => item.duplicateSuppressionCount > 0)) return '重复抑制'
  return '正常'
})

watch(templateWorkspace, (workspace) => {
  if (!workspace) return
  const source = workspace.request ?? {
    proposedTemplateId: nextTemplateId(workspace.template.templateId),
    versionCode: nextVersionCode(workspace.template.version),
    locale: workspace.template.locale,
    regionScope: workspace.template.regionScope,
    variableAllowlist: workspace.template.variableAllowlist,
    title: workspace.template.title,
    summary: workspace.template.summary,
    body: workspace.template.body,
  }
  templateForm.proposedTemplateId = source.proposedTemplateId
  templateForm.versionCode = source.versionCode
  templateForm.variableAllowlistText = source.variableAllowlist.join(', ')
  templateForm.title = source.title
  templateForm.summary = source.summary
  templateForm.body = source.body
  reviewNote.value = workspace.request?.reviewNote ?? ''
}, { immediate: true })

async function refreshAll() {
  errorMessage.value = ''
  templateErrorCode.value = ''
  try {
    await Promise.all([
      refreshOverview(),
      refreshEvents(),
      refreshTemplates(),
      refreshDeliveries(),
      ...(routeTemplateId.value ? [refreshTemplateWorkspace()] : []),
    ])
  }
  catch (error) {
    errorMessage.value = apiErrorMessage(error, '通知运行数据刷新失败。')
  }
}

async function saveTemplateDraft() {
  if (!routeTemplateId.value || !canSaveTemplateDraft.value || templateBusy.value) return
  templateBusy.value = 'save'
  errorMessage.value = ''
  templateErrorCode.value = ''
  successMessage.value = ''
  try {
    await api(`/api/admin/app/notifications/templates/${routeTemplateId.value}/draft`, {
      method: 'PUT',
      body: {
        expectedVersion: templateRequest.value?.version,
        proposedTemplateId: templateForm.proposedTemplateId,
        versionCode: templateForm.versionCode,
        locale: templateForm.locale,
        regionScope: templateForm.regionScope,
        variableAllowlist: [...new Set(templateForm.variableAllowlistText.split(/[，,]/u).map(value => value.trim()).filter(Boolean))],
        title: templateForm.title,
        summary: templateForm.summary,
        body: templateForm.body,
      },
    })
    await refreshTemplateWorkspace()
    successMessage.value = '模板草稿已保存，尚未影响用户通知。'
  }
  catch (error) {
    templateErrorCode.value = apiErrorCode(error)
    errorMessage.value = apiErrorMessage(error, '模板草稿保存失败，已保留输入内容。')
  }
  finally {
    templateBusy.value = ''
  }
}

async function submitTemplateReview() {
  const request = templateRequest.value
  if (!routeTemplateId.value || !request?.canSubmit || templateBusy.value) return
  if (!window.confirm('确认提交模板审核？提交后草稿将锁定，必须由另一位 Owner 独立复核。')) return
  templateBusy.value = 'submit'
  errorMessage.value = ''
  templateErrorCode.value = ''
  successMessage.value = ''
  try {
    await api(`/api/admin/app/notifications/templates/${routeTemplateId.value}/requests/${request.requestId}/submit`, {
      method: 'POST',
      body: { expectedVersion: request.version },
    })
    await refreshTemplateWorkspace()
    successMessage.value = '模板已提交审核，等待独立 Owner 复核。'
  }
  catch (error) {
    templateErrorCode.value = apiErrorCode(error)
    errorMessage.value = apiErrorMessage(error, '模板审核提交失败，已保留输入内容。')
  }
  finally {
    templateBusy.value = ''
  }
}

async function reviewTemplate(decision: 'approve' | 'reject') {
  const request = templateRequest.value
  if (!routeTemplateId.value || !request?.canReview || templateBusy.value) return
  if (reviewNote.value.trim().length < 2) {
    templateErrorCode.value = ''
    errorMessage.value = '独立复核说明至少填写 2 个字符。'
    return
  }
  if (!window.confirm(decision === 'approve' ? '确认批准并发布该通知模板版本？' : '确认拒绝该通知模板版本？')) return
  templateBusy.value = decision
  errorMessage.value = ''
  templateErrorCode.value = ''
  successMessage.value = ''
  try {
    await api(`/api/admin/app/notifications/templates/${routeTemplateId.value}/requests/${request.requestId}/review`, {
      method: 'POST',
      body: { expectedVersion: request.version, decision, reviewNote: reviewNote.value },
    })
    await Promise.all([refreshTemplateWorkspace(), refreshTemplates()])
    if (decision === 'approve') {
      await navigateTo('/admin/app/notifications/deliveries')
      successMessage.value = '模板版本已发布并写入不可变审计。'
    }
    else {
      successMessage.value = '模板版本已拒绝。'
    }
  }
  catch (error) {
    templateErrorCode.value = apiErrorCode(error)
    errorMessage.value = apiErrorMessage(error, '模板复核失败，请刷新版本后重试。')
  }
  finally {
    templateBusy.value = ''
  }
}

function nextTemplateId(value: string) {
  const matched = value.match(/^(.*)_v(\d+)$/u)
  return matched ? `${matched[1]}_v${Number(matched[2]) + 1}` : `${value}_v2`
}

function nextVersionCode(value: string) {
  const matched = value.match(/^(.*)-v(\d+)$/u)
  return matched ? `${matched[1]}-v${Number(matched[2]) + 1}` : `${value}-v2`
}

function requestStatusLabel(value: string) {
  return {
    draft: '草稿',
    pending_review: '待独立复核',
    executing: '发布处理中',
    approved: '已发布',
    rejected: '已拒绝',
    stale: '已失效',
  }[value] ?? value
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

function apiErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return ''
  const candidate = error as { data?: unknown }
  let data = candidate.data
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    }
    catch {
      return ''
    }
  }
  if (!data || typeof data !== 'object') return ''
  const code = (data as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <AdminAppPageHeader
      :page-id="pageContext.pageId"
      :route="pageContext.route"
      :title="pageContext.title"
      :description="pageContext.description"
      :state="templateRequest ? requestStatusLabel(templateRequest.status) : '正常'"
      :figma-state="figmaState"
      :state-tone="templateRequest?.status === 'pending_review' ? 'warning' : templateRequest?.status === 'approved' ? 'success' : 'neutral'"
    >
      <template #actions>
        <NuxtLink v-if="routeTemplateId" to="/admin/app/notifications/templates" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-[#eaded8] bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-[#fff7f2]">返回模板列表</NuxtLink>
        <button class="shrink-0 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50" :disabled="isLoading" @click="refreshAll">{{ isLoading ? '刷新中…' : '刷新' }}</button>
        <button v-if="routeTemplateId && canSaveTemplateDraft" class="inline-flex min-h-10 items-center justify-center rounded-lg border border-[#dc7798] bg-white px-4 py-2 text-sm font-medium text-[#bd2756] disabled:opacity-50" :disabled="Boolean(templateBusy)" @click="saveTemplateDraft">{{ templateBusy === 'save' ? '保存中…' : '保存草稿' }}</button>
        <button v-if="templateRequest?.canSubmit" class="inline-flex min-h-10 items-center justify-center rounded-lg bg-[#d62f65] px-4 py-2 text-sm font-medium text-white disabled:opacity-50" :disabled="Boolean(templateBusy)" @click="submitTemplateReview">{{ templateBusy === 'submit' ? '提交中…' : '提交模板审核' }}</button>
      </template>
    </AdminAppPageHeader>

    <p v-if="errorMessage" class="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {{ errorMessage }}
    </p>
    <p v-if="successMessage" class="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{{ successMessage }}</p>

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
        <NuxtLink v-for="tab in tabs" :key="tab.key" :to="tab.key === 'events' ? '/admin/app/notifications/events' : tab.key === 'deliveries' ? '/admin/app/notifications/deliveries' : (routeTemplateId ? route.fullPath : '/admin/app/notifications/templates')" class="shrink-0 rounded-lg px-4 py-2 text-sm font-medium" :class="activeTab === tab.key ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'">
          {{ tab.label }}
        </NuxtLink>
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

      <div v-else-if="activeTab === 'templates' && routeTemplateId" class="p-4 sm:p-5">
        <div v-if="templateWorkspaceStatus === 'pending'" class="rounded-xl bg-gray-50 p-10 text-center text-sm text-gray-500">正在读取模板版本与治理状态…</div>
        <div v-else-if="templateWorkspace" class="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <form class="min-w-0 space-y-4 rounded-xl border border-gray-200 p-4 sm:p-5" @submit.prevent="saveTemplateDraft">
            <div><h2 class="font-semibold text-gray-900">通知模板版本 · 表单</h2><p class="mt-1 text-xs leading-5 text-gray-500">保存草稿不产生业务生效；提交后进入独立复核与发布流程。</p></div>
            <label class="block text-sm text-gray-700">模板标识<input v-model.trim="templateForm.proposedTemplateId" :disabled="templateEditorLocked" required maxlength="96" pattern="ntv_[A-Za-z0-9_-]+" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 disabled:bg-gray-100" /></label>
            <label class="block text-sm text-gray-700">事件键<input :value="templateWorkspace.template.eventType" disabled class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-gray-100 px-3" /></label>
            <div class="grid gap-4 sm:grid-cols-2"><label class="text-sm text-gray-700">版本号<input v-model.trim="templateForm.versionCode" :disabled="templateEditorLocked" required maxlength="80" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 disabled:bg-gray-100" /></label><label class="text-sm text-gray-700">渠道与语言<input value="App 站内消息 · zh-CN · 全部地区" disabled class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-gray-100 px-3" /></label></div>
            <label class="block text-sm text-gray-700">变量白名单<input v-model.trim="templateForm.variableAllowlistText" :disabled="templateEditorLocked" maxlength="660" :placeholder="templateVariableCatalog.join(', ') || '当前事件不开放动态变量'" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 disabled:bg-gray-100" /><span class="mt-1 block text-xs leading-5 text-gray-500">权威可用变量：{{ templateVariableCatalog.join(', ') || '无；模板必须使用固定安全文案' }}</span></label>
            <label class="block text-sm text-gray-700">通知标题<input v-model.trim="templateForm.title" :disabled="templateEditorLocked" required maxlength="80" class="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 disabled:bg-gray-100" /></label>
            <label class="block text-sm text-gray-700">通知摘要<textarea v-model.trim="templateForm.summary" :disabled="templateEditorLocked" required maxlength="160" rows="2" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 disabled:bg-gray-100" /></label>
            <label class="block text-sm text-gray-700">模板正文<textarea v-model.trim="templateForm.body" :disabled="templateEditorLocked" required maxlength="500" rows="5" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 leading-6 disabled:bg-gray-100" /></label>
          </form>
          <aside class="min-w-0 space-y-4">
            <section class="rounded-xl border border-amber-200 bg-amber-50 p-4"><h2 class="font-semibold text-amber-950">提交前检查</h2><ul class="mt-3 space-y-3 text-sm leading-6 text-amber-900"><li>• 服务端校验对象范围、版本和变量白名单。</li><li>• 保存草稿不会替换运行时模板。</li><li>• 创建人与复核人必须不同。</li><li>• 冲突时保留输入并提示刷新。</li><li>• 成功后写入不可变审计记录。</li></ul></section>
            <section v-if="templateRequest" class="rounded-xl border border-gray-200 bg-white p-4"><h2 class="font-semibold text-gray-900">治理状态</h2><dl class="mt-3 space-y-2 text-sm text-gray-600"><div><dt class="text-xs text-gray-400">申请编号</dt><dd class="break-all font-mono text-xs">{{ templateRequest.requestId }}</dd></div><div><dt class="text-xs text-gray-400">申请人</dt><dd>{{ templateRequest.requestedBy.label }}</dd></div><div><dt class="text-xs text-gray-400">内容摘要</dt><dd class="break-all font-mono text-xs">{{ templateRequest.contentHash }}</dd></div></dl><template v-if="templateRequest.canReview"><label class="mt-4 block text-sm text-gray-700">独立复核说明<textarea v-model.trim="reviewNote" maxlength="500" rows="3" class="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2" /></label><div class="mt-3 flex flex-col gap-2"><button class="rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50" :disabled="Boolean(templateBusy)" @click="reviewTemplate('approve')">批准并发布</button><button class="rounded-lg border border-red-300 bg-white px-4 py-2.5 text-sm font-medium text-red-700 disabled:opacity-50" :disabled="Boolean(templateBusy)" @click="reviewTemplate('reject')">拒绝申请</button></div></template></section>
          </aside>
        </div>
        <div v-else class="rounded-xl border border-red-200 bg-red-50 p-10 text-center text-sm leading-6 text-red-700">
          模板版本不存在、已不可访问，或治理数据暂时读取失败。请返回列表刷新后重试。
        </div>
      </div>

      <div v-else-if="activeTab === 'templates'" class="grid gap-3 p-4 lg:grid-cols-2">
        <NuxtLink v-for="item in visibleTemplates" :key="item.templateId" :to="`/admin/app/notifications/templates/${item.templateId}`" class="block min-w-0 rounded-xl border border-gray-200 p-4 hover:border-[#dc7798]">
          <div class="flex min-w-0 items-start justify-between gap-3"><div class="min-w-0"><p class="break-all text-xs text-gray-500">{{ item.eventType }}</p><h3 class="mt-2 font-semibold text-gray-900">{{ item.title }}</h3></div><span class="shrink-0 rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600">{{ item.state }}</span></div>
          <p class="mt-3 text-sm leading-6 text-gray-700">{{ item.summary }}</p>
          <p class="mt-2 rounded-lg bg-gray-50 p-3 text-sm leading-6 text-gray-600">{{ item.body }}</p>
          <p class="mt-3 break-all text-xs text-gray-400">{{ item.version }} · {{ item.locale }}</p>
        </NuxtLink>
        <p v-if="routeTemplateId && !visibleTemplates.length" class="rounded-xl border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">未找到该模板版本，或当前账号无权查看。</p>
      </div>

      <div v-else class="min-w-0">
        <div class="flex flex-wrap gap-3 border-b border-gray-200 p-4">
          <select v-model="deliveryStatus" class="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"><option value="">全部状态</option><option v-for="value in deliveryStatuses" :key="value" :value="value">{{ statusLabel(value) }}</option></select>
          <select v-model="deliveryCategory" class="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"><option value="">全部分类</option><option v-for="item in categories" :key="item.value" :value="item.value">{{ item.label }}</option></select>
        </div>
        <div class="min-w-0 overflow-x-auto">
          <table class="w-full min-w-[980px] text-left text-sm">
            <thead class="bg-gray-50 text-xs text-gray-500"><tr><th class="px-4 py-3">创建时间</th><th class="px-4 py-3">事件</th><th class="px-4 py-3">账号</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">尝试</th><th class="px-4 py-3">错误代码</th></tr></thead>
            <tbody class="divide-y divide-gray-100"><tr v-for="item in deliveries" :key="item.outboxId"><td class="whitespace-nowrap px-4 py-3 text-gray-600">{{ formatTime(item.createdAt) }}</td><td class="px-4 py-3"><p class="font-medium text-gray-900">{{ item.eventType }}</p><p class="mt-1 text-xs text-gray-500">{{ categoryLabel(item.category) }} · {{ item.targetType }} · 重复抑制 {{ item.duplicateSuppressionCount }}</p></td><td class="px-4 py-3 text-gray-600">{{ item.accountId ?? '未映射' }}</td><td class="px-4 py-3 text-gray-700">{{ statusLabel(item.status) }}</td><td class="px-4 py-3 text-gray-700">{{ item.attempts }}</td><td class="px-4 py-3 text-gray-600">{{ item.lastErrorCode ?? '—' }}</td></tr><tr v-if="deliveries.length === 0"><td colspan="6" class="px-4 py-10 text-center text-gray-500">暂无匹配的投影记录</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>
