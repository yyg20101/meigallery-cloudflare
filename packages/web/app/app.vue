<script setup lang="ts">
const { fetchSettings, seoTitle, siteDescription, ogTitle, ogDescription, ogImage, siteIcon } = useSiteSettings()

// 加载站点设置（SSR + 客户端均执行一次）
await fetchSettings()

// 全局 SEO meta（子页面可覆盖）
useHead(() => ({
  title: seoTitle.value,
  link: siteIcon.value
    ? [
        { rel: 'icon', href: siteIcon.value },
        { rel: 'apple-touch-icon', href: siteIcon.value },
      ]
    : [],
}))

useSeoMeta({
  description: () => siteDescription.value,
  ogTitle: () => ogTitle.value,
  ogDescription: () => ogDescription.value || siteDescription.value,
  ogImage: () => ogImage.value || undefined,
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
