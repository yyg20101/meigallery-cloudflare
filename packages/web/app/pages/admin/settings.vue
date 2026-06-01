<script setup lang="ts">
import { getHomeAdTextPreviewWarnings, isScheduledSiteFeatureActive, normalizeHomeAdUrl, normalizePublicImageSettingUrl, safeHomeAdText } from '~/utils/siteSettingsSecurity'

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()
const { fetchSettings, settings: publicSettings } = useSiteSettings()

const form = reactive({
  // 基础信息
  site_name: '',
  site_description: '',
  site_icon: '',
  footer_text: '',
  // SEO / OG
  seo_title: '',
  og_title: '',
  og_description: '',
  og_image: '',
  // 其他
  membership_description: '',
  home_hero_title: '',
  home_hero_subtitle: '',
  home_featured_region_slugs: '',
  home_hot_tag_limit: '',
  home_ad_eyebrow: '',
  home_ad_title: '',
  home_ad_summary: '',
  home_ad_cta_label: '',
  home_ad_url: '',
  home_ad_sponsor: '',
  home_ad_starts_at: '',
  home_ad_ends_at: '',
  facebook_pixel_id: '',
  rules_entry_title: '',
  rules_entry_summary: '',
  rules_entry_icon: 'letter',
  rules_entry_enabled: 'true',
  rules_modal_content: '',
  rules_page_title: '',
  rules_page_summary: '',
  rules_page_content: '',
  rules_page_url: '/rules',
})
const emailVerificationEnabled = ref(false)
const videoEnabledToggle = ref(false)
const facebookPixelEnabled = ref(false)
const facebookPixelDebugEnabled = ref(false)
const homeAdEnabled = ref(false)
const loading = ref(false)
const iconUploadLoading = ref(false)
const message = ref('')
const siteIconInput = ref<HTMLInputElement | null>(null)
const safeSiteIconPreview = computed(() => normalizePublicImageSettingUrl(form.site_icon))
const safeHomeAdPreviewUrl = computed(() => normalizeHomeAdUrl(form.home_ad_url) || '/discover?sort=hot')
const unsafeHomeAdUrl = computed(() => Boolean(form.home_ad_url.trim()) && !normalizeHomeAdUrl(form.home_ad_url))
const safeHomeAdPreviewText = computed(() => ({
  eyebrow: safeHomeAdText('home_ad_eyebrow', form.home_ad_eyebrow),
  title: safeHomeAdText('home_ad_title', form.home_ad_title),
  summary: safeHomeAdText('home_ad_summary', form.home_ad_summary),
  ctaLabel: safeHomeAdText('home_ad_cta_label', form.home_ad_cta_label),
  sponsor: safeHomeAdText('home_ad_sponsor', form.home_ad_sponsor),
}))
const homeAdPreviewWarnings = computed(() => {
  return getHomeAdTextPreviewWarnings(form)
})
const homeAdPreviewActive = computed(() => isScheduledSiteFeatureActive(
  homeAdEnabled.value,
  form.home_ad_starts_at,
  form.home_ad_ends_at,
))
const homeAdScheduleStatus = computed(() => {
  if (!homeAdEnabled.value) return { label: '已关闭', class: 'text-gray-500' }
  if (!homeAdPreviewActive.value) return { label: '当前未展示', class: 'text-amber-600' }
  return { label: '当前展示中', class: 'text-green-600' }
})

// 加载现有设置
const { data: settings } = await useAsyncData('admin-settings', () =>
  api<{ data: Record<string, { value: unknown; updatedAt: string }> }>('/api/admin/settings'),
)

function parseBooleanSetting(value: unknown) {
  return value === true || value === 'true'
}

function toFormStringSetting(value: unknown) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

function toDatetimeLocalValue(value: unknown) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const date = new Date(trimmed)
  if (Number.isNaN(date.getTime())) return ''

  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return localDate.toISOString().slice(0, 16)
}

if (settings.value?.data) {
  for (const [key, val] of Object.entries(settings.value.data)) {
    if (key in form) {
      const value = key === 'home_ad_starts_at' || key === 'home_ad_ends_at'
        ? toDatetimeLocalValue(val.value)
        : toFormStringSetting(val.value)
      if (key === 'site_name') form.site_name = value
      else if (key === 'site_description') form.site_description = value
      else if (key === 'site_icon') form.site_icon = value
      else if (key === 'footer_text') form.footer_text = value
      else if (key === 'seo_title') form.seo_title = value
      else if (key === 'og_title') form.og_title = value
      else if (key === 'og_description') form.og_description = value
      else if (key === 'og_image') form.og_image = value
      else if (key === 'membership_description') form.membership_description = value
      else if (key === 'home_hero_title') form.home_hero_title = value
      else if (key === 'home_hero_subtitle') form.home_hero_subtitle = value
      else if (key === 'home_featured_region_slugs') form.home_featured_region_slugs = value
      else if (key === 'home_hot_tag_limit') form.home_hot_tag_limit = value
      else if (key === 'home_ad_eyebrow') form.home_ad_eyebrow = value
      else if (key === 'home_ad_title') form.home_ad_title = value
      else if (key === 'home_ad_summary') form.home_ad_summary = value
      else if (key === 'home_ad_cta_label') form.home_ad_cta_label = value
      else if (key === 'home_ad_url') form.home_ad_url = value
      else if (key === 'home_ad_sponsor') form.home_ad_sponsor = value
      else if (key === 'home_ad_starts_at') form.home_ad_starts_at = value
      else if (key === 'home_ad_ends_at') form.home_ad_ends_at = value
      else if (key === 'facebook_pixel_id') form.facebook_pixel_id = value
      else if (key === 'rules_entry_title') form.rules_entry_title = value
      else if (key === 'rules_entry_summary') form.rules_entry_summary = value
      else if (key === 'rules_entry_icon') form.rules_entry_icon = value
      else if (key === 'rules_entry_enabled') form.rules_entry_enabled = value
      else if (key === 'rules_modal_content') form.rules_modal_content = value
      else if (key === 'rules_page_title') form.rules_page_title = value
      else if (key === 'rules_page_summary') form.rules_page_summary = value
      else if (key === 'rules_page_content') form.rules_page_content = value
      else if (key === 'rules_page_url') form.rules_page_url = value
    }
    if (key === 'email_verification_enabled') {
      emailVerificationEnabled.value = parseBooleanSetting(val.value)
    }
    if (key === 'video_enabled') {
      videoEnabledToggle.value = parseBooleanSetting(val.value)
    }
    if (key === 'facebook_pixel_enabled') {
      facebookPixelEnabled.value = parseBooleanSetting(val.value)
    }
    if (key === 'facebook_pixel_debug_enabled') {
      facebookPixelDebugEnabled.value = parseBooleanSetting(val.value)
    }
    if (key === 'home_ad_enabled') {
      homeAdEnabled.value = parseBooleanSetting(val.value)
    }
  }
}

async function onSave() {
  loading.value = true
  message.value = ''
  try {
    const normalizeScheduleInput = (value: string) => {
      const trimmed = value.trim()
      if (!trimmed) return ''
      const parsed = new Date(trimmed)
      return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString()
    }

    await api('/api/admin/settings', {
      method: 'PATCH',
      body: {
        ...form,
        home_ad_starts_at: normalizeScheduleInput(form.home_ad_starts_at),
        home_ad_ends_at: normalizeScheduleInput(form.home_ad_ends_at),
        facebook_pixel_enabled: facebookPixelEnabled.value,
        facebook_pixel_debug_enabled: facebookPixelDebugEnabled.value,
        home_ad_enabled: homeAdEnabled.value,
      },
    })
    try {
      await fetchSettings({ force: true })
      message.value = '设置已保存'
    } catch {
      message.value = '设置已保存，但前台公开设置刷新失败，请刷新页面确认'
    }
  } catch (e: any) {
    message.value = e?.data?.message || '保存失败'
  } finally {
    loading.value = false
  }
}

function openSiteIconPicker() {
  siteIconInput.value?.click()
}

async function onSiteIconSelected(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  iconUploadLoading.value = true
  message.value = ''
  try {
    const body = new FormData()
    body.set('file', file)
    const result = await api<{ iconUrl: string }>('/api/admin/settings/site-icon', { method: 'POST', body })
    form.site_icon = result.iconUrl
    publicSettings.value = { ...publicSettings.value, site_icon: result.iconUrl }
    message.value = '站点图标已上传并同步 favicon'
  } catch (e: any) {
    message.value = e?.data?.message || '站点图标上传失败'
  } finally {
    iconUploadLoading.value = false
    if (siteIconInput.value) siteIconInput.value.value = ''
  }
}

const toggleLoading = ref(false)
async function toggleEmailVerification() {
  toggleLoading.value = true
  try {
    const newVal = !emailVerificationEnabled.value
    await api('/api/admin/settings', {
      method: 'PATCH',
      body: { email_verification_enabled: newVal },
    })
    emailVerificationEnabled.value = newVal
  } catch (e: any) {
    useToast().add({ title: e?.data?.message || '操作失败', color: 'error' })
  } finally {
    toggleLoading.value = false
  }
}

const videoToggleLoading = ref(false)
async function toggleVideo() {
  videoToggleLoading.value = true
  try {
    const newVal = !videoEnabledToggle.value
    await api('/api/admin/settings', {
      method: 'PATCH',
      body: { video_enabled: newVal },
    })
    videoEnabledToggle.value = newVal
  } catch (e: any) {
    useToast().add({ title: e?.data?.message || '操作失败', color: 'error' })
  } finally {
    videoToggleLoading.value = false
  }
}
</script>

<template>
  <div class="max-w-5xl">
    <h1 class="text-xl font-bold text-gray-900 mb-6">站点设置</h1>

    <div v-if="!isOwner" class="rounded-lg bg-yellow-50 p-4 text-sm text-yellow-800 mb-6">
      仅站长可修改站点设置
    </div>

    <form v-else class="space-y-8" @submit.prevent="onSave">
      <!-- 基础信息 -->
      <fieldset class="space-y-4">
        <legend class="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-2 w-full">基础信息</legend>
        <div>
          <label for="site-name" class="block text-sm font-medium text-gray-700 mb-1">站点名称</label>
          <input id="site-name" v-model="form.site_name" maxlength="40" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="MeiGallery" />
          <p class="text-xs text-gray-400 mt-1">显示在导航栏、页脚和浏览器标签页</p>
        </div>
        <div>
          <label for="site-description" class="block text-sm font-medium text-gray-700 mb-1">站点描述</label>
          <textarea id="site-description" v-model="form.site_description" rows="2" maxlength="180" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="精选写真、时尚、生活、艺术类图库平台" />
          <p class="text-xs text-gray-400 mt-1">用于 meta description 和默认 OG 描述</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">站点图标 URL</label>
          <input v-model="form.site_icon" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="https://example.com/icon.png" />
          <div class="mt-3 rounded-xl border border-dashed border-gray-300 bg-gray-50 p-3">
            <input ref="siteIconInput" type="file" accept="image/png,image/jpeg,image/webp,image/x-icon" class="hidden" @change="onSiteIconSelected" />
            <div class="flex flex-wrap items-center gap-3">
              <button type="button" :disabled="iconUploadLoading" class="inline-flex items-center justify-center rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:-translate-y-0.5 hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50" @click="openSiteIconPicker">
                {{ iconUploadLoading ? '上传中...' : '上传站点图标' }}
              </button>
              <img v-if="safeSiteIconPreview" :src="safeSiteIconPreview" alt="当前站点图标预览" class="h-10 w-10 rounded-lg border border-gray-200 bg-white object-contain p-1" />
            </div>
            <p class="mt-2 text-xs text-gray-500">支持 PNG、JPEG、WebP、ICO，最大 1MB；上传后会自动写入 URL，并同步用于 favicon 和 apple-touch-icon。</p>
          </div>
          <p class="text-xs text-gray-400 mt-1">也可以继续手动填写外部 URL；留空使用默认 favicon。</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">页脚文案</label>
          <input v-model="form.footer_text" maxlength="120" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="© 2026 MeiGallery. All rights reserved." />
          <p class="text-xs text-gray-400 mt-1">页面底部的版权或自定义文字</p>
        </div>
      </fieldset>

      <!-- SEO / OG 社交分享 -->
      <fieldset class="space-y-4">
        <legend class="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-2 w-full">SEO / 社交分享</legend>
        <div>
          <label for="seo-title" class="block text-sm font-medium text-gray-700 mb-1">SEO 标题</label>
          <input id="seo-title" v-model="form.seo_title" maxlength="80" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="MeiGallery - 精选写真图库" />
          <p class="text-xs text-gray-400 mt-1">搜索引擎显示的页面标题（title 标签）</p>
        </div>
        <div>
          <label for="og-title" class="block text-sm font-medium text-gray-700 mb-1">OG 标题</label>
          <input id="og-title" v-model="form.og_title" maxlength="80" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="留空则使用 SEO 标题" />
          <p class="text-xs text-gray-400 mt-1">社交平台（微信、微博等）分享时显示的标题</p>
        </div>
        <div>
          <label for="og-description" class="block text-sm font-medium text-gray-700 mb-1">OG 描述</label>
          <textarea id="og-description" v-model="form.og_description" rows="2" maxlength="220" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="留空则使用站点描述" />
          <p class="text-xs text-gray-400 mt-1">社交平台分享时显示的描述文字</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">OG 封面图 URL</label>
          <input v-model="form.og_image" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="https://example.com/og-cover.jpg" />
          <p class="text-xs text-gray-400 mt-1">社交平台分享时显示的封面图片（推荐 1200x630）</p>
        </div>
      </fieldset>

      <!-- 其他设置 -->
      <fieldset class="space-y-4">
        <legend class="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-2 w-full">其他设置</legend>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">会员说明</label>
          <textarea v-model="form.membership_description" rows="3" maxlength="300" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="会员等级权益说明..." />
        </div>
      </fieldset>

      <fieldset class="space-y-4">
        <legend class="w-full border-b border-gray-200 pb-2 text-sm font-semibold text-gray-900">首页视觉配置</legend>
        <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div class="space-y-4">
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">首页主标题</label>
              <input v-model="form.home_hero_title" maxlength="40" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="精选写真，按地区发现" />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">首页副标题</label>
              <textarea v-model="form.home_hero_subtitle" rows="2" maxlength="180" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="用于首页首屏说明" />
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">主推地区 slugs</label>
              <input v-model="form.home_featured_region_slugs" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="canada,domestic,toronto,vancouver" />
              <p class="mt-1 text-xs text-gray-400">英文逗号分隔；前台会优先展示这些地区标签。</p>
            </div>
            <div>
              <label class="mb-1 block text-sm font-medium text-gray-700">首页热门标签数量</label>
              <input v-model="form.home_hot_tag_limit" type="number" min="1" max="30" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="15" />
            </div>
            <div class="rounded-xl border border-[#eadfd2] bg-[#fffbf7] p-4">
              <label class="flex items-start gap-3">
                <input v-model="homeAdEnabled" type="checkbox" class="mt-1 h-4 w-4 rounded border-gray-300" />
                <span>
                  <span class="block text-sm font-medium text-gray-800">启用首页广告位</span>
                  <span class="mt-0.5 block text-xs leading-5 text-gray-500">展示在首页首屏轮播下方；链接只允许站内相对路径或 https 外链。</span>
                </span>
              </label>
              <div class="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">广告眉标</label>
                  <input v-model="form.home_ad_eyebrow" maxlength="12" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="本周推荐" />
                </div>
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">赞助/来源说明</label>
                  <input v-model="form.home_ad_sponsor" maxlength="30" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="MeiGallery 运营推荐" />
                </div>
              </div>
              <div class="mt-4">
                <label class="mb-1 block text-sm font-medium text-gray-700">广告标题</label>
                <input v-model="form.home_ad_title" maxlength="40" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="会员季精选内容" />
              </div>
              <div class="mt-4">
                <label class="mb-1 block text-sm font-medium text-gray-700">广告摘要</label>
                <textarea v-model="form.home_ad_summary" rows="2" maxlength="120" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="探索本周精选图库、真实案例和会员可访问内容。" />
              </div>
              <div class="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">跳转链接</label>
                  <input v-model="form.home_ad_url" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="/discover?sort=hot" />
                </div>
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">按钮文案</label>
                  <input v-model="form.home_ad_cta_label" maxlength="12" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="查看推荐" />
                </div>
              </div>
              <div class="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">开始时间</label>
                  <input v-model="form.home_ad_starts_at" type="datetime-local" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                  <p class="mt-1 text-xs text-gray-400">留空表示立即开始；提交后会转成 UTC ISO 时间。</p>
                </div>
                <div>
                  <label class="mb-1 block text-sm font-medium text-gray-700">结束时间</label>
                  <input v-model="form.home_ad_ends_at" type="datetime-local" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                  <p class="mt-1 text-xs text-gray-400">留空表示不限制结束时间；结束时间必须晚于开始时间。</p>
                </div>
              </div>
              <p class="mt-4 text-xs text-gray-500">
                当前状态：
                <span :class="homeAdEnabled ? 'text-green-600' : 'text-gray-500'">{{ homeAdEnabled ? '已启用' : '已关闭' }}</span>
                <span class="mx-2 text-gray-300">|</span>
                <span class="text-gray-500">{{ form.home_ad_starts_at || '未设置开始时间' }}</span>
                <span class="mx-2 text-gray-300">→</span>
                <span class="text-gray-500">{{ form.home_ad_ends_at || '未设置结束时间' }}</span>
              </p>
            </div>
          </div>

          <aside class="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm shadow-gray-200/60">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-xs font-semibold uppercase tracking-[0.2em] text-gray-400">广告预览</p>
                <h3 class="mt-1 text-sm font-semibold text-gray-900">首页广告位实时效果</h3>
              </div>
              <span class="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">{{ homeAdScheduleStatus.label }}</span>
            </div>
            <div v-if="homeAdEnabled" class="mt-4">
              <HomeAdBand
                :enabled="homeAdEnabled"
                preview
                :eyebrow="safeHomeAdPreviewText.eyebrow"
                :title="safeHomeAdPreviewText.title"
                :summary="safeHomeAdPreviewText.summary"
                :cta-label="safeHomeAdPreviewText.ctaLabel"
                :url="safeHomeAdPreviewUrl"
                :sponsor="safeHomeAdPreviewText.sponsor"
              />
            </div>
            <div v-else class="mt-4 rounded-2xl border border-dashed border-gray-300 bg-gray-50 px-5 py-10 text-center text-sm text-gray-500">
              广告位已关闭，保存后首页不展示。
            </div>
            <div class="mt-4 space-y-2 text-xs leading-5">
              <p :class="unsafeHomeAdUrl ? 'text-amber-700' : 'text-gray-500'">
                链接：{{ safeHomeAdPreviewUrl }}
                <span v-if="unsafeHomeAdUrl" role="status" aria-live="polite" class="ml-2 font-medium">原始链接不安全，已回退到推荐页</span>
              </p>
              <p v-if="homeAdPreviewWarnings.length > 0" role="status" aria-live="polite" class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-700">
                <span class="font-medium">预览已安全收紧：</span>
                <span>{{ homeAdPreviewWarnings.join('；') }}</span>
              </p>
              <p class="text-gray-500">
                排期：
                <span>{{ form.home_ad_starts_at || '立即开始' }}</span>
                <span class="mx-1 text-gray-300">→</span>
                <span>{{ form.home_ad_ends_at || '长期展示' }}</span>
              </p>
              <p class="text-gray-500">
                说明：预览使用公开读取侧同款清洗规则，保存前不会触发线上设置变更。
              </p>
            </div>
          </aside>
        </div>
      </fieldset>

      <!-- 规则与引导 -->
      <fieldset class="space-y-4">
        <legend class="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-2 w-full">规则与引导</legend>
        <label class="flex items-center gap-2 text-sm text-gray-700">
          <input v-model="form.rules_entry_enabled" type="checkbox" true-value="true" false-value="false" />
          开启右下角规则入口
        </label>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">悬浮入口标题</label>
          <input v-model="form.rules_entry_title" maxlength="20" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="入站规则" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">悬浮入口说明</label>
          <textarea v-model="form.rules_entry_summary" rows="2" maxlength="120" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="查看内容规则、会员说明和联系前须知。" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">入口图标</label>
          <input v-model="form.rules_entry_icon" maxlength="32" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="letter" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">弹窗 Markdown 摘要</label>
          <textarea v-model="form.rules_modal_content" rows="8" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono leading-6" placeholder="## 入站规则&#10;&#10;- 本站仅展示合法授权内容" />
          <p class="text-xs text-gray-400 mt-1">支持标题、列表、加粗、https 链接。</p>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">规则页标题</label>
            <input v-model="form.rules_page_title" maxlength="40" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="入站规则" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">规则页链接</label>
            <input v-model="form.rules_page_url" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="/rules" />
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">规则页摘要</label>
          <textarea v-model="form.rules_page_summary" rows="2" maxlength="180" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="了解 MeiGallery 的内容边界、会员访问和联系方式说明。" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">规则页 Markdown 正文</label>
          <textarea
            v-model="form.rules_page_content"
            rows="10"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono leading-6"
            placeholder="## 内容边界&#10;&#10;这里填写完整规则正文。"
          />
          <p class="text-xs text-gray-400 mt-1">支持标题、列表、加粗、https 链接。前台会安全渲染，不执行 HTML。</p>
        </div>
      </fieldset>

      <fieldset class="space-y-4">
        <legend class="w-full border-b border-gray-200 pb-2 text-sm font-semibold text-gray-900">Facebook 广告归因</legend>
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700">Meta Pixel ID</label>
          <input v-model="form.facebook_pixel_id" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="例如 123456789012345" />
          <p class="mt-1 text-xs text-gray-400">只填写数字 Pixel ID；留空或关闭开关时前台不会加载 Facebook Pixel。</p>
        </div>
        <label class="flex items-start gap-3 rounded-lg border border-gray-200 p-4">
          <input v-model="facebookPixelEnabled" type="checkbox" class="mt-1 h-4 w-4 rounded border-gray-300" />
          <span>
            <span class="block text-sm font-medium text-gray-700">启用生产 Pixel</span>
            <span class="mt-0.5 block text-xs text-gray-500">仅生产环境会读取后台 Pixel ID；dev 默认强制禁用正式 Pixel。</span>
          </span>
        </label>
        <label class="flex items-start gap-3 rounded-lg border border-gray-200 p-4">
          <input v-model="facebookPixelDebugEnabled" type="checkbox" class="mt-1 h-4 w-4 rounded border-gray-300" />
          <span>
            <span class="block text-sm font-medium text-gray-700">输出调试日志</span>
            <span class="mt-0.5 block text-xs text-gray-500">仅在浏览器控制台输出已脱敏事件；dev 加载测试 Pixel 仍需环境变量显式允许。</span>
          </span>
        </label>
      </fieldset>

      <!-- 功能开关 -->
      <fieldset class="space-y-4">
        <legend class="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-2 w-full">功能开关</legend>
        <!-- 邮箱验证开关 -->
        <div class="rounded-lg border border-gray-200 p-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-gray-700">邮箱验证</p>
              <p class="text-xs text-gray-500 mt-0.5">开启后注册和修改邮箱需要验证码（需 Workers Paid 计划）</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="切换邮箱验证功能"
              :aria-checked="emailVerificationEnabled"
              :disabled="toggleLoading"
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50"
              :class="emailVerificationEnabled ? 'bg-blue-600' : 'bg-gray-300'"
              @click="toggleEmailVerification"
            >
              <span
                class="inline-block h-4 w-4 rounded-full bg-white transition-transform"
                :class="emailVerificationEnabled ? 'translate-x-6' : 'translate-x-1'"
              />
            </button>
          </div>
        </div>

        <!-- 视频功能开关 -->
        <div class="rounded-lg border border-gray-200 p-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium text-gray-700">视频功能</p>
              <p class="text-xs text-gray-500 mt-0.5">开启后前台显示视频专区和播放器（需先接入 Cloudflare Stream）</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="切换视频功能"
              :aria-checked="videoEnabledToggle"
              :disabled="videoToggleLoading"
              class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50"
              :class="videoEnabledToggle ? 'bg-blue-600' : 'bg-gray-300'"
              @click="toggleVideo"
            >
              <span
                class="inline-block h-4 w-4 rounded-full bg-white transition-transform"
                :class="videoEnabledToggle ? 'translate-x-6' : 'translate-x-1'"
              />
            </button>
          </div>
        </div>
      </fieldset>

      <div v-if="message" class="text-sm" :class="message.includes('失败') ? 'text-red-600' : 'text-green-600'">{{ message }}</div>

      <button type="submit" :disabled="loading" class="rounded-lg bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
        {{ loading ? '保存中...' : '保存设置' }}
      </button>
    </form>
  </div>
</template>
