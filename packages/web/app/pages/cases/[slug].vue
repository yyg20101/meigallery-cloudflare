<script setup lang="ts">
import { buildAbsoluteSeoUrl, buildArticleJsonLd, buildCanonicalUrl, buildJsonLdScript, normalizeSeoSiteUrl } from '~/utils/seoMetadata'

const route = useRoute()
const config = useRuntimeConfig()
const { api } = useApi()
const { siteName, seoKeywords, siteIcon } = useSiteSettings()

interface CaseDetail {
  id: string
  title: string
  slug: string
  summary: string | null
  bodyMd: string | null
  seoTitle: string | null
  seoDescription: string | null
  publishedAt: string | null
  images: Array<{ id: string; url: string; alt: string; sortOrder: number }>
}

const { data: item, error } = await useAsyncData(`case-${route.params.slug}`, () =>
  api<CaseDetail>(`/api/cases/${route.params.slug}`),
)

if (error.value || !item.value) {
  throw createError({ statusCode: 404, message: '真实案例不存在或暂未公开' })
}

const formattedDate = computed(() => item.value?.publishedAt?.split('T')[0] || '')
const coverImage = computed(() => item.value?.images[0] || null)
const galleryImages = computed(() => item.value?.images.slice(1) ?? [])
const siteUrl = computed(() => normalizeSeoSiteUrl(config.public.siteUrl))
const canonicalUrl = computed(() => buildCanonicalUrl(siteUrl.value, route.fullPath))
const caseSeoDescription = computed(() => item.value?.seoDescription || item.value?.summary || '查看已授权、已脱敏的真实案例。')
const caseOgImage = computed(() => buildAbsoluteSeoUrl(siteUrl.value, item.value?.images[0]?.url) || undefined)
const caseSeoKeywords = computed(() => mergeKeywords([
  ...seoKeywords.value,
  '真实案例',
  '授权反馈',
]))
const caseJsonLd = computed(() => {
  if (!item.value) return null

  return buildJsonLdScript(buildArticleJsonLd({
    siteUrl: siteUrl.value,
    path: route.fullPath,
    siteName: siteName.value,
    title: item.value.seoTitle || item.value.title,
    description: caseSeoDescription.value,
    imageUrls: item.value.images.map(image => image.url),
    datePublished: item.value.publishedAt,
    logoUrl: siteIcon.value,
    keywords: caseSeoKeywords.value,
  }))
})

useSeoMeta({
  title: () => item.value?.seoTitle || (item.value ? `${item.value.title} - 真实案例 - ${siteName.value}` : `真实案例 - ${siteName.value}`),
  description: () => caseSeoDescription.value,
  ogTitle: () => item.value?.title || '真实案例',
  ogDescription: () => caseSeoDescription.value,
  ogImage: () => caseOgImage.value,
  ogUrl: () => canonicalUrl.value,
  ogType: 'article',
  twitterCard: 'summary_large_image',
  articlePublishedTime: () => item.value?.publishedAt || undefined,
})

useHead(() => ({
  meta: caseSeoKeywords.value.length ? [{ key: 'keywords', name: 'keywords', content: caseSeoKeywords.value.join(', ') }] : [],
  script: caseJsonLd.value ? [caseJsonLd.value] : [],
}))

function mergeKeywords(values: string[]) {
  const keywords: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const keyword = value.trim().replace(/\s+/g, ' ')
    if (!keyword) continue
    const key = keyword.toLowerCase()
    if (seen.has(key)) continue
    keywords.push(keyword)
    seen.add(key)
  }
  return keywords
}

function openContactPanel() {
  window.dispatchEvent(new CustomEvent('meigallery:open-contact-panel'))
}
</script>

<template>
  <div v-if="item" class="mx-auto max-w-7xl px-4 py-6 pb-24 sm:px-6 lg:px-8 lg:py-10">
    <BreadcrumbNav :items="[{ label: '首页', to: '/' }, { label: '真实案例', to: '/cases' }, { label: item.title }]" class="mb-4" />

    <section data-testid="case-detail-hero" class="relative overflow-hidden rounded-[2rem] border border-[#efe4d8] bg-[#fffbf7] shadow-[0_24px_80px_rgba(124,45,18,0.09)] lg:grid lg:grid-cols-[1fr_26rem]">
      <div class="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_12%_12%,rgba(214,195,154,0.20),transparent_32%),linear-gradient(135deg,rgba(255,255,255,0.72),transparent_46%)]" />
      <div class="relative p-3 sm:p-4 lg:p-5">
        <div class="relative aspect-[4/3] overflow-hidden rounded-[1.55rem] bg-orange-50 shadow-inner shadow-orange-950/8 lg:h-full lg:max-h-[34rem] lg:min-h-[28rem] lg:aspect-auto">
          <img v-if="coverImage" :src="coverImage.url" :alt="coverImage.alt" class="h-full w-full object-cover" fetchpriority="high" referrerpolicy="no-referrer" />
          <div v-else class="flex h-full items-center justify-center bg-gradient-to-br from-[#fff7ed] to-[#f8e7dc] text-sm text-gray-400">图片整理中</div>
          <div class="absolute inset-0 bg-[linear-gradient(180deg,rgba(17,17,17,0.02),rgba(17,17,17,0.34))]" />
          <div class="absolute bottom-4 left-4 rounded-full border border-white/20 bg-black/34 px-3.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#f0dca7] backdrop-blur">Cover Story</div>
        </div>
      </div>

      <div class="relative flex flex-col justify-between gap-7 p-6 lg:p-8">
        <div>
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Authorized Case File</p>
              <p class="mt-3 text-xs text-gray-400"><span v-if="formattedDate">{{ formattedDate }} · </span>{{ item.images.length }} 张图片</p>
            </div>
            <NuxtLink to="/cases" class="shrink-0 rounded-full border border-[#eadfd2] bg-white/80 px-3.5 py-2 text-xs font-medium text-gray-600 shadow-sm shadow-orange-950/5 transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:text-gray-950">返回案例列表</NuxtLink>
          </div>
          <h1 class="mt-6 text-3xl font-semibold leading-[0.95] tracking-[-0.055em] text-gray-950 lg:text-5xl">{{ item.title }}</h1>
          <p v-if="item.summary" class="mt-5 text-sm leading-7 text-gray-600 lg:max-w-md">{{ item.summary }}</p>
        </div>

        <div class="grid gap-3">
          <div class="grid grid-cols-2 overflow-hidden rounded-[1.45rem] border border-[#eadfd2] bg-white/70 text-center shadow-sm shadow-orange-950/5 backdrop-blur">
            <div class="border-r border-[#eadfd2] p-4">
              <p class="text-2xl font-semibold tracking-[-0.05em] text-gray-950">{{ item.images.length }}</p>
              <p class="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#bfa46a]">Images</p>
            </div>
            <div class="p-4">
              <p class="text-2xl font-semibold tracking-[-0.05em] text-gray-950">已授权</p>
              <p class="mt-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#bfa46a]">Status</p>
            </div>
          </div>

          <div class="rounded-[1.55rem] border border-[#eadfd2] bg-white/82 p-4 shadow-[0_18px_50px_rgba(124,45,18,0.08)] backdrop-blur">
            <p class="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#bfa46a]">Next Step</p>
            <p class="mt-2 text-sm leading-6 text-gray-500">继续探索图库内容，或直接联系站长确认会员与访问规则。</p>
            <div class="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <NuxtLink to="/discover" class="inline-flex min-h-12 items-center justify-center rounded-full bg-gray-950 px-5 py-3 text-sm font-medium text-[#d6c39a] shadow-sm shadow-gray-950/20 transition-all hover:-translate-y-0.5 hover:bg-black">查看更多图库</NuxtLink>
              <button type="button" class="inline-flex min-h-12 items-center justify-center rounded-full border border-gray-950 bg-white px-5 py-3 text-sm font-medium text-gray-950 transition-all hover:-translate-y-0.5 hover:bg-gray-950 hover:text-[#d6c39a]" @click="openContactPanel">联系站长</button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section v-if="galleryImages.length" class="mt-6 lg:mt-8">
      <div class="mb-4 flex items-end justify-between gap-4">
        <div>
          <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Photo Notes</p>
          <h2 class="mt-2 text-2xl font-semibold tracking-[-0.05em] text-gray-950">内容图片</h2>
        </div>
        <p class="text-xs text-gray-400">封面已单独展示，下方从第 2 张开始</p>
      </div>
      <CaseGallery :images="galleryImages" />
    </section>

    <section v-else class="mt-6 rounded-[1.5rem] border border-[#f0e4d8] bg-white/90 px-5 py-8 text-center text-sm text-gray-500 shadow-sm shadow-orange-950/5">
      当前案例仅包含封面图片，更多内容整理中。
    </section>

    <section v-if="item.bodyMd" class="mt-6 rounded-[1.5rem] border border-[#f0e4d8] bg-white/90 p-6 text-sm leading-7 text-gray-600 shadow-sm shadow-orange-950/5 whitespace-pre-line">
      {{ item.bodyMd }}
    </section>
  </div>
</template>
