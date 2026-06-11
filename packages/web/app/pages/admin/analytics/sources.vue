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
  channel: string
  slug: string
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
const createError = ref('')
const form = reactive({
  name: '',
  channel: 'referral',
  slug: '',
  targetPath: '/',
  utmSource: '',
  utmMedium: 'referral',
  utmCampaign: '',
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

watch(() => form.slug, (slug, oldSlug) => {
  if (!form.utmSource || form.utmSource === normalizeSlugForForm(oldSlug || '')) {
    form.utmSource = normalizeSlugForForm(slug)
  }
})

async function createTrackingSource() {
  createError.value = ''
  if (!form.name.trim()) {
    createError.value = '请填写来源名称'
    return
  }
  creating.value = true
  try {
    const result = await api<{ data: TrackingSourceMetric }>('/api/admin/tracking-sources', {
      method: 'POST',
      body: {
        name: form.name,
        channel: form.channel,
        slug: form.slug || undefined,
        targetPath: form.targetPath,
        utmSource: form.utmSource || undefined,
        utmMedium: form.utmMedium,
        utmCampaign: form.utmCampaign || undefined,
        note: form.note,
      },
    })
    toast.add({ title: '推广来源已创建', color: 'success' })
    await copyTrackingLink(result.data)
    form.name = ''
    form.slug = ''
    form.targetPath = '/'
    form.utmSource = ''
    form.utmCampaign = ''
    form.note = ''
    await analytics.refresh()
  } catch (error) {
    createError.value = resolveApiErrorMessage(error, '推广来源创建失败')
  } finally {
    creating.value = false
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

async function copyTrackingLink(item: Pick<TrackingSourceMetric, 'trackingPath'>) {
  if (!import.meta.client) return
  await navigator.clipboard?.writeText(fullTrackingLink(item))
  toast.add({ title: '追踪链接已复制', color: 'success' })
}

function normalizeSlugForForm(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
}
</script>

<template>
  <AnalyticsPageShell
    v-model:range="analytics.range.value"
    title="来源分析"
    description="比较不同来源的访问、详情、联系、注册和会员发放，优先判断来源质量。"
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
          <p class="mt-1 text-sm text-gray-500">自动归因结果包含邀请码、推广来源、UTM、referrer 和直接访问。</p>
        </div>
        <AnalyticsDataTable
          empty-title="暂无来源数据"
          empty-text="当前时间范围没有来源聚合。创建推广来源或产生前台访问后，系统会按来源渠道归因。"
          empty-action-label="查看采集健康"
          empty-action-to="/admin/analytics/health"
          :columns="[
            { key: 'source_channel', label: '渠道', sortable: true },
            { key: 'source_name', label: '来源', sortable: true },
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
        <section class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <div class="flex items-center justify-between gap-3">
            <div>
              <h2 class="text-sm font-semibold text-gray-900">推广来源</h2>
              <p class="mt-1 text-xs text-gray-500">创建标准追踪链接，区分从哪里进入站点。</p>
            </div>
            <button class="rounded-lg bg-gray-950 px-3 py-2 text-xs font-medium text-white hover:bg-gray-800" type="button" @click="createOpen = !createOpen">
              {{ createOpen ? '收起' : '创建' }}
            </button>
          </div>

          <form v-if="createOpen" class="mt-4 space-y-3" @submit.prevent="createTrackingSource">
            <input v-model="form.name" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="名称，例如 Telegram 六月互推" />
            <select v-model="form.channel" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option v-for="option in channelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <input v-model="form.slug" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="短标识，例如 telegram-june" />
            <input v-model="form.targetPath" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="落地页，例如 / 或 /discover" />
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <input v-model="form.utmSource" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" placeholder="utm_source" />
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
                  <p class="truncate text-sm font-medium text-gray-900">{{ item.name }}</p>
                  <p class="mt-1 break-all font-mono text-xs text-gray-500">{{ item.trackingPath }}</p>
                </div>
                <span :class="['shrink-0 rounded-full px-2 py-0.5 text-xs', item.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500']">{{ item.status }}</span>
              </div>
              <div class="mt-3 grid grid-cols-3 gap-2 text-xs text-gray-500">
                <span>Session {{ formatAnalyticsNumber(item.sessionCount) }}</span>
                <span>联系入口 {{ formatAnalyticsNumber(item.contactClickCount) }}</span>
                <span>注册 {{ formatAnalyticsNumber(item.registerCount) }}</span>
              </div>
              <div class="mt-3 flex flex-wrap gap-3 text-xs">
                <button class="text-gray-900 hover:underline" type="button" @click="copyTrackingLink(item)">复制链接</button>
                <button v-if="item.status !== 'disabled'" class="text-red-600 hover:underline" type="button" @click="disableTrackingSource(item)">停用</button>
              </div>
            </article>
          </div>
        </section>
      </aside>
    </div>
  </AnalyticsPageShell>
</template>
