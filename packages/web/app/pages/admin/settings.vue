<script setup lang="ts">
import { normalizePublicImageSettingUrl, normalizeSeoKeywords, safeSiteText } from '~/utils/siteSettingsSecurity'

definePageMeta({ layout: 'admin' })

const DEFAULT_SITE_NAME = '图库站'
const LEGACY_DEFAULT_SITE_NAME = 'MeiGallery'

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
  seo_keywords: '',
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
const homeAdEnabled = ref(false)
const loading = ref(false)
const iconUploadLoading = ref(false)
const message = ref('')
const siteIconInput = ref<HTMLInputElement | null>(null)
const messageIsError = computed(() => message.value.includes('失败') || message.value.includes('不一致'))
const safeSiteIconPreview = computed(() => normalizePublicImageSettingUrl(form.site_icon))
const seoKeywordMatrix = [
  { group: '核心词', role: '站点定位', examples: ['授权图库', '写真', '时尚写真', '艺术图片'] },
  { group: '场景词', role: '内容语境', examples: ['户外写真', '棚拍', '生活方式', '清新风格'] },
  { group: '地区词', role: '地区发现', examples: ['广东写真', '广州写真', '上海写真', '城市旅拍'] },
  { group: '类型词', role: '页面覆盖', examples: ['图片合集', '视频预览', '真实案例', '会员内容'] },
]
const seoKeywordUsageRows = [
  { label: '配置位置', value: '后台 / 站点设置 / SEO / 社交分享 / SEO 关键词池' },
  { label: '公开输出', value: '首页、图库详情、真实案例的结构化数据 keywords；页面 meta keywords 作为兼容输出' },
  { label: '页面合并', value: '图库详情会叠加图库标签；真实案例会叠加“真实案例、授权反馈”' },
  { label: '排名提醒', value: 'Google 不使用 meta keywords 作为排名信号，仍要重点写好标题、描述、内容和结构化数据' },
]
const formSeoKeywords = computed(() => normalizeSeoKeywords(form.seo_keywords))

function resolveSeoSnapshot(source: Record<string, unknown>) {
  const rawSiteName = safeSiteText('site_name', source.site_name)
  const siteName = rawSiteName && rawSiteName !== LEGACY_DEFAULT_SITE_NAME ? rawSiteName : DEFAULT_SITE_NAME
  const description = safeSiteText('site_description', source.site_description)
  const seoTitle = safeSiteText('seo_title', source.seo_title) || siteName
  const seoKeywords = normalizeSeoKeywords(source.seo_keywords)
  const ogTitle = safeSiteText('og_title', source.og_title) || seoTitle
  const ogDescription = safeSiteText('og_description', source.og_description) || description

  return { siteName, description, seoTitle, seoKeywords, ogTitle, ogDescription }
}

const formSeoSnapshot = computed(() => resolveSeoSnapshot(form))
const publicSeoSnapshot = computed(() => resolveSeoSnapshot(publicSettings.value as Record<string, unknown>))
const publicSeoMatchesForm = computed(() => {
  const formSnapshot = formSeoSnapshot.value
  const publicSnapshot = publicSeoSnapshot.value
  return formSnapshot.siteName === publicSnapshot.siteName
    && formSnapshot.description === publicSnapshot.description
    && formSnapshot.seoTitle === publicSnapshot.seoTitle
    && formSnapshot.seoKeywords.join(',') === publicSnapshot.seoKeywords.join(',')
    && formSnapshot.ogTitle === publicSnapshot.ogTitle
    && formSnapshot.ogDescription === publicSnapshot.ogDescription
})
const publicSeoStatus = computed(() => {
  if (publicSeoMatchesForm.value) {
    return {
      label: '已同步',
      message: '前台已同步：SEO 标题、站点描述与公开读取一致',
      class: 'border-green-200 bg-green-50 text-green-700',
    }
  }

  return {
    label: '待同步',
    message: '前台公开读取值与当前表单不一致，保存后会重新校验公开设置。',
    class: 'border-amber-200 bg-amber-50 text-amber-700',
  }
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
      else if (key === 'seo_keywords') form.seo_keywords = value
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
        home_ad_enabled: homeAdEnabled.value,
      },
    })
    try {
      await fetchSettings({ force: true })
      message.value = publicSeoMatchesForm.value
        ? '设置已保存，前台公开 SEO 已同步'
        : '设置已保存，但前台公开 SEO 与当前表单不一致，请刷新页面确认'
    } catch {
      message.value = '设置已保存，但前台公开设置刷新失败，请刷新页面确认'
    }
  } catch (e: any) {
    message.value = resolveApiErrorMessage(e, '保存失败')
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
    message.value = resolveApiErrorMessage(e, '站点图标上传失败')
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
    useToast().add({ title: resolveApiErrorMessage(e, '操作失败'), color: 'error' })
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
    useToast().add({ title: resolveApiErrorMessage(e, '操作失败'), color: 'error' })
  } finally {
    videoToggleLoading.value = false
  }
}
</script>

<template>
  <div data-settings-page class="w-full min-w-0 max-w-5xl">
    <h1 class="text-xl font-bold text-gray-900 mb-6">站点设置</h1>

    <div v-if="!isOwner" class="rounded-lg bg-yellow-50 p-4 text-sm text-yellow-800 mb-6">
      仅站长可修改站点设置
    </div>

    <form v-else data-settings-form class="w-full min-w-0 max-w-full space-y-8" @submit.prevent="onSave">
      <!-- 基础信息 -->
      <fieldset class="space-y-4">
        <legend class="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-2 w-full">基础信息</legend>
        <div>
          <label for="site-name" class="block text-sm font-medium text-gray-700 mb-1">站点名称</label>
          <input id="site-name" v-model="form.site_name" maxlength="40" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="例如：你的图库站名称" />
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
              <img v-if="safeSiteIconPreview" :src="safeSiteIconPreview" alt="当前站点图标预览" class="h-10 w-10 rounded-lg border border-gray-200 bg-white object-contain p-1" referrerpolicy="no-referrer" />
            </div>
            <p class="mt-2 text-xs text-gray-500">支持 PNG、JPEG、WebP、ICO，最大 1MB；上传后会自动写入 URL，并同步用于 favicon 和 apple-touch-icon。</p>
          </div>
          <p class="text-xs text-gray-400 mt-1">也可以继续手动填写外部 URL；留空使用默认 favicon。</p>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">页脚文案</label>
          <input v-model="form.footer_text" maxlength="120" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="© 2026 你的站点名称" />
          <p class="text-xs text-gray-400 mt-1">页面底部的版权或自定义文字</p>
        </div>
      </fieldset>

      <!-- SEO / OG 社交分享 -->
      <fieldset class="space-y-4">
        <legend class="text-sm font-semibold text-gray-900 border-b border-gray-200 pb-2 w-full">SEO / 社交分享</legend>
        <div>
          <label for="seo-title" class="block text-sm font-medium text-gray-700 mb-1">SEO 标题</label>
          <input id="seo-title" v-model="form.seo_title" maxlength="80" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="例如：站点名称 - 精选图库" />
          <p class="text-xs text-gray-400 mt-1">搜索引擎显示的页面标题（title 标签）</p>
        </div>
        <div>
          <label for="seo-keywords" class="block text-sm font-medium text-gray-700 mb-1">SEO 关键词池</label>
          <textarea
            id="seo-keywords"
            v-model="form.seo_keywords"
            rows="3"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            placeholder="授权图库, 写真, 时尚写真, 户外写真, 广东写真, 真实案例"
          />
          <div class="mt-2 flex flex-wrap gap-2">
            <span
              v-for="keyword in formSeoKeywords"
              :key="keyword"
              class="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-700"
            >
              {{ keyword }}
            </span>
            <span v-if="form.seo_keywords && !formSeoKeywords.length" class="rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700">
              关键词格式超出限制
            </span>
            <span v-if="!form.seo_keywords" class="text-xs text-gray-400">建议 8-16 个，最多 30 个；用中文逗号、英文逗号或换行分隔。</span>
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div v-for="item in seoKeywordMatrix" :key="item.group" class="rounded-lg border border-gray-200 bg-white p-3">
            <p class="text-xs font-semibold text-gray-900">{{ item.group }}</p>
            <p class="mt-1 text-[11px] text-gray-400">{{ item.role }}</p>
            <div class="mt-3 flex flex-wrap gap-1.5">
              <span v-for="example in item.examples" :key="example" class="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600">{{ example }}</span>
            </div>
          </div>
        </div>
        <dl class="grid gap-3 text-xs sm:grid-cols-2">
          <div v-for="row in seoKeywordUsageRows" :key="row.label" class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <dt class="font-medium text-gray-500">{{ row.label }}</dt>
            <dd class="mt-1 leading-5 text-gray-700">{{ row.value }}</dd>
          </div>
        </dl>
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

        <section aria-labelledby="public-seo-sync-title" aria-label="前台同步状态" class="rounded-xl border border-gray-200 bg-gray-50 p-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="public-seo-sync-title" class="text-sm font-semibold text-gray-900">前台同步状态</h2>
              <p class="mt-1 text-xs text-gray-500">显示首页公开读取到的 SEO 值，保存后会立即刷新校验。</p>
            </div>
            <span class="rounded-full border px-3 py-1 text-xs font-medium" :class="publicSeoStatus.class">{{ publicSeoStatus.label }}</span>
          </div>
          <p class="mt-3 text-sm" :class="publicSeoStatus.class">{{ publicSeoStatus.message }}</p>
          <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-2">
            <div class="rounded-lg border border-white bg-white px-3 py-2">
              <dt class="font-medium text-gray-500">公开站点名称</dt>
              <dd class="mt-1 break-words text-gray-900">{{ publicSeoSnapshot.siteName }}</dd>
            </div>
            <div class="rounded-lg border border-white bg-white px-3 py-2">
              <dt class="font-medium text-gray-500">公开 SEO 标题</dt>
              <dd class="mt-1 break-words text-gray-900">{{ publicSeoSnapshot.seoTitle }}</dd>
            </div>
            <div class="rounded-lg border border-white bg-white px-3 py-2">
              <dt class="font-medium text-gray-500">公开 SEO 关键词</dt>
              <dd class="mt-1 break-words text-gray-900">{{ publicSeoSnapshot.seoKeywords.join('、') || '未设置' }}</dd>
            </div>
            <div class="rounded-lg border border-white bg-white px-3 py-2">
              <dt class="font-medium text-gray-500">公开站点描述</dt>
              <dd class="mt-1 break-words text-gray-900">{{ publicSeoSnapshot.description || '未设置' }}</dd>
            </div>
            <div class="rounded-lg border border-white bg-white px-3 py-2">
              <dt class="font-medium text-gray-500">公开 OG 标题 / 描述</dt>
              <dd class="mt-1 break-words text-gray-900">{{ publicSeoSnapshot.ogTitle }} / {{ publicSeoSnapshot.ogDescription || '未设置' }}</dd>
            </div>
          </dl>
        </section>
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

          <section class="rounded-xl border border-[#eadfd2] bg-[#fffbf7] p-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 class="text-sm font-semibold text-gray-950">首页广告已迁移到广告位管理</h2>
                <p class="mt-1 text-xs leading-5 text-gray-500">新入口支持首页多广告、排序、排期和大图上传；旧单广告配置仅作为公开读取兼容兜底。</p>
              </div>
              <NuxtLink
                to="/admin/ads"
                class="inline-flex items-center justify-center rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white transition hover:-translate-y-0.5 hover:bg-gray-800"
              >
                管理广告位
              </NuxtLink>
            </div>
            <p v-if="homeAdEnabled" class="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
              检测到旧首页广告开关仍为开启；当新广告位为空时，前台仍会使用旧配置兜底展示。
            </p>
          </section>
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
          <textarea v-model="form.rules_page_summary" rows="2" maxlength="180" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="了解本站的内容边界、会员访问和联系方式说明。" />
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

      <div v-if="message" class="text-sm" :class="messageIsError ? 'text-red-600' : 'text-green-600'">{{ message }}</div>

      <button type="submit" :disabled="loading" class="rounded-lg bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
        {{ loading ? '保存中...' : '保存设置' }}
      </button>
    </form>
  </div>
</template>
