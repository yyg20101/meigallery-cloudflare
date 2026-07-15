<script setup lang="ts">
import type { AdPlatformProvider } from '@meigallery/shared'
import AnalyticsDataTable from '~/components/admin/analytics/AnalyticsDataTable.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionProviderSwitch from '~/components/admin/attribution/AttributionProviderSwitch.vue'

definePageMeta({ layout: 'admin' })

interface AttributionLink {
  id: string
  sourceLabel: string
  channel: string
  slug: string
  sourceCode: string
  targetPath: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  utmContent: string
  adProvider: AdPlatformProvider | ''
  status: string
  note: string
  trackingPath: string
  sessionCount: number
  pageViewCount: number
  contactCount: number
  historical: { leadCount: number }
  completeRegistrationCount: number
}

const { api } = useApi()
const toast = useToast()
const rangeState = useAdminAttributionRange('7d')
const selectedProvider = useAttributionProvider()
const attribution = useAdminAttribution<{ provider: AdPlatformProvider; links: AttributionLink[] }>('/api/admin/attribution/links', {
  rangeState,
  query: computed(() => ({ provider: selectedProvider.value })),
})

const creating = ref(false)
const createError = ref('')
const form = reactive<{
  sourceLabel: string
  channel: string
  adProvider: AdPlatformProvider | ''
  targetPath: string
  utmMedium: string
  utmCampaign: string
  utmContent: string
  note: string
}>({
  sourceLabel: '',
  channel: 'ad',
  adProvider: selectedProvider.value,
  targetPath: '/',
  utmMedium: 'paid_social',
  utmCampaign: '',
  utmContent: '',
  note: '',
})

const channelOptions = [
  { label: '广告', value: 'ad', medium: 'paid_social' },
  { label: '社交媒体', value: 'social', medium: 'social' },
  { label: '合作/互推', value: 'referral', medium: 'referral' },
  { label: '搜索', value: 'search', medium: 'search' },
  { label: '站内', value: 'internal', medium: 'internal' },
]

watch(() => form.channel, (channel) => {
  const option = channelOptions.find(item => item.value === channel)
  if (option) form.utmMedium = option.medium
  form.adProvider = channel === 'ad' ? (form.adProvider || selectedProvider.value) : ''
})

watch(selectedProvider, (provider) => {
  if (form.channel === 'ad') form.adProvider = provider
})

const linkRows = computed(() => (attribution.data.value?.links ?? []).map(item => ({
  ...item,
  adProviderLabel: adProviderLabel(item),
  historicalLeadCount: Number(item.historical?.leadCount ?? 0),
  contactRate: Number(item.contactCount ?? 0) / Math.max(1, Number(item.sessionCount ?? 0)),
  registerRate: Number(item.completeRegistrationCount ?? 0) / Math.max(1, Number(item.sessionCount ?? 0)),
})))

function adProviderLabel(item: Pick<AttributionLink, 'channel' | 'adProvider'>) {
  if (item.adProvider === 'meta') return 'Meta'
  if (item.adProvider === 'tiktok') return 'TikTok'
  if (item.adProvider === 'google') return 'Google Ads'
  return item.channel === 'ad' ? '未绑定（不投递）' : '非广告'
}

const previewPath = computed(() => buildTrackingPathPreview({
  targetPath: form.targetPath,
  sourceCode: normalizeUtmValue(form.sourceLabel || 'ad-test'),
  utmMedium: form.utmMedium,
  utmCampaign: normalizeUtmValue(form.utmCampaign),
  utmContent: normalizeUtmValue(form.utmContent),
}))

async function createTrackingLink() {
  createError.value = ''
  if (!form.sourceLabel.trim()) {
    createError.value = '请填写链接名称'
    return
  }
  creating.value = true
  try {
    const result = await api<{ data: AttributionLink }>('/api/admin/tracking-sources', {
      method: 'POST',
      body: {
        sourceLabel: form.sourceLabel,
        channel: form.channel,
        adProvider: form.adProvider || undefined,
        targetPath: form.targetPath,
        utmMedium: form.utmMedium,
        utmCampaign: form.utmCampaign || undefined,
        utmContent: form.utmContent || undefined,
        note: form.note,
      },
    })
    toast.add({ title: '投放追踪链接已创建', color: 'success' })
    await copyTrackingLink(result.data)
    form.sourceLabel = ''
    form.targetPath = '/'
    form.utmCampaign = ''
    form.utmContent = ''
    form.note = ''
    await attribution.refresh()
  } catch (error) {
    createError.value = resolveApiErrorMessage(error, '投放追踪链接创建失败')
  } finally {
    creating.value = false
  }
}

async function copyTrackingLink(item: Pick<AttributionLink, 'trackingPath'>) {
  if (!import.meta.client) return
  const link = `${window.location.origin}${item.trackingPath}`
  await navigator.clipboard?.writeText(link)
  toast.add({ title: '追踪链接已复制', color: 'success' })
}

function buildTrackingPathPreview(input: {
  targetPath: string
  sourceCode: string
  utmMedium: string
  utmCampaign: string
  utmContent: string
}) {
  try {
    const url = new URL(input.targetPath || '/', 'https://site.local')
    if (!url.pathname.startsWith('/') || url.pathname.startsWith('/admin') || url.pathname.startsWith('/api')) {
      return '/?mg_source=ad-test&utm_source=ad-test&utm_medium=paid_social'
    }
    url.searchParams.set('mg_source', input.sourceCode)
    url.searchParams.set('utm_source', input.sourceCode)
    url.searchParams.set('utm_medium', input.utmMedium)
    if (input.utmCampaign) url.searchParams.set('utm_campaign', input.utmCampaign)
    if (input.utmContent) url.searchParams.set('utm_content', input.utmContent)
    return `${url.pathname}${url.search}`
  } catch {
    return '/?mg_source=ad-test&utm_source=ad-test&utm_medium=paid_social'
  }
}

function normalizeUtmValue(value: string) {
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
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="投放追踪链接"
    description="为 Meta、TikTok 等渠道创建明确绑定平台的投放链接，按广告版本查看有效联系和注册。"
    :loading="attribution.loading.value"
    :error="attribution.error.value"
    :usage="attribution.usage.value"
    :show-range-controls="false"
    @refresh="attribution.refresh"
  >
    <AttributionProviderSwitch v-model="selectedProvider" />

    <section class="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-900">
      广告链接必须绑定唯一平台；链接来源只会进入对应平台的 Pixel 与 Server API。
    </section>

    <div class="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section class="min-w-0 space-y-3">
        <div>
          <h2 class="text-sm font-semibold text-gray-900">链接表现</h2>
          <p class="mt-1 text-sm text-gray-500">按链接查看 Session、有效联系、注册和历史 Lead 对照。</p>
        </div>
        <AnalyticsDataTable
          empty-title="暂无投放追踪链接"
          empty-text="当前还没有投放追踪链接。创建链接后，可按广告版本查看有效联系和注册。"
          :columns="[
            { key: 'sourceLabel', label: '链接', sortable: true },
            { key: 'adProviderLabel', label: '广告平台', sortable: true },
            { key: 'channel', label: '渠道', sortable: true },
            { key: 'utmCampaign', label: 'campaign', sortable: true },
            { key: 'utmContent', label: 'content', sortable: true },
            { key: 'sessionCount', label: 'Session', type: 'number', sortable: true },
            { key: 'pageViewCount', label: 'PV', type: 'number', sortable: true },
            { key: 'contactCount', label: '有效联系', type: 'number', sortable: true },
            { key: 'historicalLeadCount', label: '历史 Lead', type: 'number' },
            { key: 'completeRegistrationCount', label: '注册', type: 'number', sortable: true },
            { key: 'contactRate', label: '联系率', type: 'percent', sortable: true },
            { key: 'registerRate', label: '注册率', type: 'percent', sortable: true },
          ]"
          :rows="linkRows"
          compact
        />

        <div v-if="attribution.data.value?.links?.length" class="grid gap-3 md:grid-cols-2">
          <article v-for="item in attribution.data.value.links" :key="item.id" class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="truncate text-sm font-semibold text-gray-900">{{ item.sourceLabel }}</h3>
                <p class="mt-1 break-all font-mono text-xs text-gray-500">{{ item.trackingPath }}</p>
              </div>
              <span :class="['shrink-0 rounded-full px-2 py-0.5 text-xs', item.status === 'active' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500']">{{ item.status }}</span>
            </div>
            <div class="mt-3 flex flex-wrap gap-3 text-xs text-gray-500">
              <span>有效联系 {{ formatAnalyticsNumber(item.contactCount) }}</span>
              <span>注册 {{ formatAnalyticsNumber(item.completeRegistrationCount) }}</span>
              <span>平台 {{ adProviderLabel(item) }}</span>
              <span>content {{ item.utmContent || '-' }}</span>
            </div>
            <button class="mt-3 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-700 hover:bg-gray-50" type="button" @click="copyTrackingLink(item)">
              复制链接
            </button>
          </article>
        </div>
      </section>

      <aside class="min-w-0 max-w-full">
        <section class="min-w-0 max-w-full rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <h2 class="text-sm font-semibold text-gray-900">创建链接</h2>
          <form class="mt-4 space-y-3" @submit.prevent="createTrackingLink">
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-gray-600">链接名称</span>
              <input v-model="form.sourceLabel" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="例如 Meta 广告 A｜聊天 CTA" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-gray-600">渠道</span>
              <select v-model="form.channel" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option v-for="option in channelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </label>
            <label v-if="form.channel === 'ad'" class="block">
              <span class="mb-1 block text-xs font-medium text-gray-600">广告平台</span>
              <select v-model="form.adProvider" required class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="meta">Meta</option>
                <option value="tiktok">TikTok</option>
              </select>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-gray-600">落地页</span>
              <input v-model="form.targetPath" class="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" placeholder="/" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-gray-600">utm_campaign</span>
              <input v-model="form.utmCampaign" class="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" placeholder="meta-contact-july" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-gray-600">utm_content</span>
              <input v-model="form.utmContent" class="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm" placeholder="chat-a" />
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-medium text-gray-600">备注</span>
              <textarea v-model="form.note" rows="3" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="内部备注" />
            </label>
            <div class="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
              <p class="text-xs font-medium text-gray-700">链接预览</p>
              <p class="mt-1 break-all font-mono text-xs leading-5 text-gray-600">{{ previewPath }}</p>
            </div>
            <p v-if="createError" class="text-xs text-red-600">{{ createError }}</p>
            <button class="w-full rounded-lg bg-gray-950 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60" type="submit" :disabled="creating">
              {{ creating ? '创建中...' : '创建并复制链接' }}
            </button>
          </form>
        </section>
      </aside>
    </div>
  </AttributionPageShell>
</template>
