<script setup lang="ts">
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AnalyticsPageShell from '~/components/admin/analytics/AnalyticsPageShell.vue'

definePageMeta({ layout: 'admin' })
const { api } = useApi()
const { isOwner } = useAuth()
const toast = useToast()
const analytics = useAdminAnalytics<Array<Record<string, unknown>>>('/api/admin/analytics/sources')
const createExport = useAnalyticsExport()

interface TrackingSourceMetric {
  id: string
  name: string
  sourceLabel: string
  channel: string
  slug: string
  sourceCode: string
  targetPath: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  status: 'active' | 'disabled'
  note: string
  trackingPath: string
  sessionCount: number
  pageViewCount: number
  contactClickCount: number
  registerCount: number
  membershipGrantCount: number
}

const trackingSources = computed(() => {
  const raw = analytics.extra.value.trackingSources
  return Array.isArray(raw) ? raw as TrackingSourceMetric[] : []
})

const createOpen = ref(true)
const creating = ref(false)
const metaCreating = ref(false)
const createError = ref('')
const metaCreateError = ref('')
const editingId = ref('')
const savingId = ref('')
const form = reactive({
  sourceLabel: '',
  channel: 'referral',
  targetPath: '/',
  utmMedium: 'referral',
  utmCampaign: '',
  note: '',
})
const metaForm = reactive({
  sourceLabel: '',
  targetPath: '/',
  utmCampaign: '',
  note: '',
})
const editForm = reactive({
  sourceLabel: '',
  note: '',
})

const channelOptions = [
  { label: '合作/互推', value: 'referral', medium: 'referral' },
  { label: '社交媒体', value: 'social', medium: 'social' },
  { label: '搜索', value: 'search', medium: 'search' },
  { label: '广告', value: 'ad', medium: 'ad' },
  { label: '直接访问', value: 'direct', medium: 'direct' },
  { label: '站内', value: 'internal', medium: 'internal' },
]

watch(() => form.channel, (channel) => {
  const option = channelOptions.find(item => item.value === channel)
  if (option && (!form.utmMedium || channelOptions.some(item => item.medium === form.utmMedium))) {
    form.utmMedium = option.medium
  }
})

const metaPreviewPath = computed(() => {
  return buildTrackingPathPreview({
    targetPath: metaForm.targetPath,
    sourceCode: 'ad-auto-code',
    utmMedium: 'paid_social',
    utmCampaign: normalizeUtmPreview(metaForm.utmCampaign || metaForm.sourceLabel || 'meta-test'),
  })
})

async function createTrackingSource() {
  createError.value = ''
  if (!form.sourceLabel.trim()) {
    createError.value = '请填写自定义文案'
    return
  }
  creating.value = true
  try {
    const result = await api<{ data: TrackingSourceMetric }>('/api/admin/tracking-sources', {
      method: 'POST',
      body: {
        sourceLabel: form.sourceLabel,
        channel: form.channel,
        targetPath: form.targetPath,
        utmMedium: form.utmMedium,
        utmCampaign: form.utmCampaign || undefined,
        note: form.note,
      },
    })
    toast.add({ title: '推广来源已创建', color: 'success' })
    await copyTrackingLink(result.data)
    form.sourceLabel = ''
    form.targetPath = '/'
    form.utmCampaign = ''
    form.note = ''
    await analytics.refresh()
  } catch (error) {
    createError.value = resolveApiErrorMessage(error, '推广来源创建失败')
  } finally {
    creating.value = false
  }
}

async function createMetaTrackingSource() {
  metaCreateError.value = ''
  if (!metaForm.sourceLabel.trim()) {
    metaCreateError.value = '请填写广告测试名称'
    return
  }
  metaCreating.value = true
  try {
    const campaign = normalizeUtmPreview(metaForm.utmCampaign || metaForm.sourceLabel)
    const result = await api<{ data: TrackingSourceMetric }>('/api/admin/tracking-sources', {
      method: 'POST',
      body: {
        sourceLabel: metaForm.sourceLabel,
        channel: 'ad',
        targetPath: metaForm.targetPath,
        utmMedium: 'paid_social',
        utmCampaign: campaign || undefined,
        note: metaForm.note || 'Meta 广告测试链接',
      },
    })
    toast.add({ title: 'Meta 像素测试地址已创建', color: 'success' })
    await copyTrackingLink(result.data)
    metaForm.sourceLabel = ''
    metaForm.targetPath = '/'
    metaForm.utmCampaign = ''
    metaForm.note = ''
    await analytics.refresh()
  } catch (error) {
    metaCreateError.value = resolveApiErrorMessage(error, 'Meta 像素测试地址创建失败')
  } finally {
    metaCreating.value = false
  }
}

function startEdit(item: TrackingSourceMetric) {
  editingId.value = item.id
  editForm.sourceLabel = item.sourceLabel || item.name
  editForm.note = item.note || ''
}

function cancelEdit() {
  editingId.value = ''
  editForm.sourceLabel = ''
  editForm.note = ''
}

async function saveTrackingSource(item: TrackingSourceMetric) {
  if (!editForm.sourceLabel.trim()) {
    toast.add({ title: '请填写自定义文案', color: 'error' })
    return
  }
  savingId.value = item.id
  try {
    await api(`/api/admin/tracking-sources/${item.id}`, {
      method: 'PATCH',
      body: {
        sourceLabel: editForm.sourceLabel,
        note: editForm.note,
      },
    })
    toast.add({ title: '来源文案已更新', color: 'success' })
    cancelEdit()
    await analytics.refresh()
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, '来源更新失败'), color: 'error' })
  } finally {
    savingId.value = ''
  }
}

async function disableTrackingSource(item: TrackingSourceMetric) {
  if (item.status === 'disabled') return
  try {
    await api(`/api/admin/tracking-sources/${item.id}`, {
      method: 'PATCH',
      body: { disable: true },
    })
    toast.add({ title: '推广来源已停用', color: 'success' })
    await analytics.refresh()
  } catch (error) {
    toast.add({ title: resolveApiErrorMessage(error, '推广来源停用失败'), color: 'error' })
  }
}

function fullTrackingLink(item: Pick<TrackingSourceMetric, 'trackingPath'>) {
  if (!import.meta.client) return item.trackingPath
  return `${window.location.origin}${item.trackingPath}`
}

function sourcePagesLink(item: TrackingSourceMetric) {
  return `/admin/analytics/source-pages?sourceCode=${encodeURIComponent(item.sourceCode || item.slug)}`
}

function sourceClicksLink(item: TrackingSourceMetric) {
  return `/admin/analytics/source-clicks?sourceCode=${encodeURIComponent(item.sourceCode || item.slug)}`
}

async function copyTrackingLink(item: Pick<TrackingSourceMetric, 'trackingPath'>) {
  if (!import.meta.client) return
  await navigator.clipboard?.writeText(fullTrackingLink(item))
  toast.add({ title: '追踪链接已复制', color: 'success' })
}

function buildTrackingPathPreview(input: {
  targetPath: string
  sourceCode: string
  utmMedium: string
  utmCampaign: string
}) {
  try {
    const url = new URL(input.targetPath || '/', 'https://616618.xyz')
    if (!url.pathname.startsWith('/') || url.pathname.startsWith('/admin') || url.pathname.startsWith('/api')) {
      return '/?mg_source=ad-auto-code&utm_source=ad-auto-code&utm_medium=paid_social'
    }
    url.searchParams.set('mg_source', input.sourceCode)
    url.searchParams.set('utm_source', input.sourceCode)
    url.searchParams.set('utm_medium', input.utmMedium)
    if (input.utmCampaign) url.searchParams.set('utm_campaign', input.utmCampaign)
    return `${url.pathname}${url.search}`
  } catch {
    return '/?mg_source=ad-auto-code&utm_source=ad-auto-code&utm_medium=paid_social'
  }
}

function normalizeUtmPreview(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/[-_.]{2,}/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 80)
}

</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    title="来源分析"
    description="比较站内归因来源的访问、详情、联系、注册和会员发放，优先判断来源质量。"
    :loading="analytics.loading.value"
    :error="analytics.error.value"
    :usage="analytics.usage.value"
    :show-export="isOwner"
    @refresh="analytics.refresh"
    @export="createExport('sources', analytics.range.value)"
  >
    <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section class="space-y-4">
        <div>
          <h2 class="text-sm font-semibold text-gray-900">来源表现</h2>
          <p class="mt-1 text-sm text-gray-500">自动归因结果包含邀请码、推广来源、UTM、referrer 和直接访问；FB/Facebook 不是 Pixel 回传。</p>
        </div>
        <div class="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-900">
          FB、Facebook 或 Meta 来源来自站内 UTM、推广链接或 referrer；Meta Pixel 只用于向 Meta 后台发送 Contact、Lead 等转化事件。
        </div>
        <AnalyticsDataTable
          empty-title="暂无来源数据"
          empty-text="当前时间范围没有来源聚合。创建推广来源或产生前台访问后，系统会按来源渠道归因。"
          empty-action-label="查看采集健康"
          empty-action-to="/admin/analytics/health"
          :columns="[
            { key: 'source_channel_label', label: '渠道', sortable: true },
            { key: 'source_label', label: '来源', sortable: true },
            { key: 'sourceCode', label: 'code', sortable: true },
            { key: 'invite_code_id', label: '邀请码' },
            { key: 'visitor_count', label: '访客', type: 'number', sortable: true },
            { key: 'session_count', label: 'Session', type: 'number', sortable: true },
            { key: 'page_view_count', label: 'PV', type: 'number', sortable: true },
            { key: 'gallery_detail_count', label: '详情', type: 'number', sortable: true },
            { key: 'contact_click_count', label: '联系入口', type: 'number', sortable: true },
            { key: 'register_count', label: '注册', type: 'number', sortable: true },
            { key: 'membership_grant_count', label: '会员', type: 'number', sortable: true },
            { key: 'active_seconds_total', label: '有效时长', type: 'duration', sortable: true },
          ]"
          :rows="analytics.data.value || []"
        />
      </section>

      <aside class="space-y-4">
        <section class="overflow-hidden rounded-lg border border-indigo-100 bg-white shadow-sm">
          <div class="border-b border-indigo-100 bg-indigo-950 px-4 py-4 text-white">
            <h2 class="text-sm font-semibold">Meta 像素测试地址</h2>
            <p class="mt-1 text-xs leading-5 text-indigo-100">每个广告版本创建一条地址，用来源 code 比较联系、注册和会员转化。</p>
          </div>

          <form class="space-y-3 p-4" @submit.prevent="createMetaTrackingSource">
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-gray-600">广告测试名称</span>
              <input v-model="metaForm.sourceLabel" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="例如 Meta 广告 A｜聊天 CTA" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-gray-600">落地页</span>
              <input v-model="metaForm.targetPath" class="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" placeholder="例如 / 或 /gallery/summer-portrait" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-gray-600">活动标识</span>
              <input v-model="metaForm.utmCampaign" class="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" placeholder="例如 meta-contact-a" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-gray-600">内部备注</span>
              <textarea v-model="metaForm.note" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="例如 主图版本 A，目标 Contact" />
            </label>

            <div class="rounded-lg border border-indigo-100 bg-indigo-50 px-3 py-2">
              <p class="text-xs font-medium text-indigo-900">链接预览</p>
              <p class="mt-1 break-all font-mono text-xs leading-5 text-indigo-800">https://616618.xyz{{ metaPreviewPath }}</p>
            </div>

            <p v-if="metaCreateError" class="text-xs text-red-600">{{ metaCreateError }}</p>
            <button class="w-full rounded-lg bg-indigo-950 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-900 disabled:opacity-60" type="submit" :disabled="metaCreating">
              {{ metaCreating ? '创建中...' : '创建并复制像素地址' }}
            </button>
          </form>
        </section>

        <section class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h2 class="text-sm font-semibold text-gray-900">推广来源</h2>
              <p class="mt-1 text-xs text-gray-500">创建标准 UTM 追踪链接，区分从哪里进入站点。</p>
            </div>
            <button class="rounded-lg bg-gray-950 px-3 py-2 text-xs font-medium text-white hover:bg-gray-800" type="button" @click="createOpen = !createOpen">
              {{ createOpen ? '收起' : '创建' }}
            </button>
          </div>

          <form v-if="createOpen" class="mt-4 space-y-3" @submit.prevent="createTrackingSource">
            <select v-model="form.channel" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option v-for="option in channelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <input v-model="form.sourceLabel" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="自定义文案，例如 FB 六月投放" />
            <input v-model="form.targetPath" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="落地页，例如 / 或 /discover" />
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input v-model="form.utmMedium" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="utm_medium" />
              <input v-model="form.utmCampaign" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="utm_campaign" />
            </div>
            <textarea v-model="form.note" rows="3" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="内部备注" />
            <p v-if="createError" class="text-xs text-red-600">{{ createError }}</p>
            <button class="w-full rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60" type="submit" :disabled="creating">
              {{ creating ? '创建中...' : '创建并复制链接' }}
            </button>
          </form>
        </section>

        <section class="rounded-lg border border-gray-200 bg-white shadow-sm">
          <div class="border-b border-gray-100 px-4 py-3 text-sm font-semibold text-gray-900">
            已创建来源
          </div>
          <div v-if="trackingSources.length === 0" class="px-4 py-6 text-sm text-gray-400">
            暂无推广来源
          </div>
          <div v-else class="divide-y divide-gray-100">
            <article v-for="item in trackingSources.slice(0, 10)" :key="item.id" class="px-4 py-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-gray-900">{{ item.sourceLabel || item.name }}</p>
                  <p class="mt-1 font-mono text-xs text-gray-500">code: {{ item.sourceCode || item.slug }}</p>
                  <p class="mt-1 break-all font-mono text-xs text-gray-500">{{ item.trackingPath }}</p>
                </div>
                <span :class="['shrink-0 rounded-full px-2 py-0.5 text-xs', item.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500']">{{ item.status }}</span>
              </div>
              <div class="mt-3 grid grid-cols-3 gap-2 text-xs text-gray-500">
                <span>Session {{ formatAnalyticsNumber(item.sessionCount) }}</span>
                <span>联系入口 {{ formatAnalyticsNumber(item.contactClickCount) }}</span>
                <span>注册 {{ formatAnalyticsNumber(item.registerCount) }}</span>
              </div>
              <form v-if="editingId === item.id" class="mt-3 space-y-2 rounded-lg border border-gray-100 bg-gray-50 p-3" @submit.prevent="saveTrackingSource(item)">
                <input v-model="editForm.sourceLabel" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="自定义文案" />
                <textarea v-model="editForm.note" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="内部备注" />
                <div class="flex gap-2">
                  <button class="rounded-lg bg-gray-950 px-3 py-2 text-xs font-medium text-white disabled:opacity-60" type="submit" :disabled="savingId === item.id">
                    {{ savingId === item.id ? '保存中...' : '保存' }}
                  </button>
                  <button class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700" type="button" @click="cancelEdit">
                    取消
                  </button>
                </div>
              </form>
              <div class="mt-3 flex flex-wrap gap-3 text-xs">
                <button class="text-gray-900 hover:underline" type="button" @click="copyTrackingLink(item)">复制链接</button>
                <button class="text-gray-900 hover:underline" type="button" @click="startEdit(item)">编辑文案</button>
                <NuxtLink class="text-blue-600 hover:underline" :to="sourcePagesLink(item)">页面</NuxtLink>
                <NuxtLink class="text-blue-600 hover:underline" :to="sourceClicksLink(item)">点击</NuxtLink>
                <button v-if="item.status !== 'disabled'" class="text-red-600 hover:underline" type="button" @click="disableTrackingSource(item)">停用</button>
              </div>
            </article>
          </div>
        </section>
      </aside>
    </div>
  </AnalyticsPageShell>
</template>
