<script setup lang="ts">
import { buildAbsoluteSeoUrl, buildCanonicalUrl, buildJsonLdScript, buildWebSiteJsonLd, normalizeSeoSiteUrl } from '~/utils/seoMetadata'

const { fetchSettings, siteName, seoTitle, seoKeywords, siteDescription, ogTitle, ogDescription, ogImage, siteIcon } = useSiteSettings()
const { fetchUser } = useAuth()
const config = useRuntimeConfig()
const route = useRoute()
const isDevEnvironment = computed(() => config.public.appEnv !== 'production')
const siteUrl = computed(() => normalizeSeoSiteUrl(config.public.siteUrl))
const canonicalUrl = computed(() => buildCanonicalUrl(siteUrl.value, route.fullPath))
const ogImageUrl = computed(() => buildAbsoluteSeoUrl(siteUrl.value, ogImage.value) || undefined)
const webSiteJsonLd = computed(() => buildJsonLdScript(buildWebSiteJsonLd({
  siteUrl: siteUrl.value,
  siteName: siteName.value,
  description: siteDescription.value,
  logoUrl: siteIcon.value,
  keywords: seoKeywords.value,
})))

// 加载站点设置（SSR + 客户端均执行一次）
await fetchSettings()
// 刷新公开页面时也恢复登录态，避免仅受保护路由才读取会话。
await fetchUser()

// 全局 SEO meta（子页面可覆盖）
useHead(() => ({
  title: seoTitle.value,
  meta: [
    ...(isDevEnvironment.value ? [{ name: 'robots', content: 'noindex, nofollow' }] : []),
    ...(seoKeywords.value.length ? [{ key: 'keywords', name: 'keywords', content: seoKeywords.value.join(', ') }] : []),
  ],
  link: [
    { rel: 'canonical', href: canonicalUrl.value },
    ...(siteIcon.value
      ? [
        { rel: 'icon', href: siteIcon.value },
        { rel: 'shortcut icon', href: siteIcon.value },
        { rel: 'apple-touch-icon', href: siteIcon.value },
      ]
      : []),
  ],
  script: route.path === '/'
    ? [webSiteJsonLd.value]
    : [],
}))

useSeoMeta({
  description: () => siteDescription.value,
  ogTitle: () => ogTitle.value,
  ogDescription: () => ogDescription.value || siteDescription.value,
  ogImage: () => ogImageUrl.value,
  ogUrl: () => canonicalUrl.value,
  ogType: 'website',
  twitterCard: 'summary_large_image',
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
