<script setup lang="ts">
import { renderSafeMarkdown } from '~/utils/safeMarkdown'

const {
  rulesPageTitle,
  rulesPageSummary,
  rulesPageContent,
  siteName,
} = useSiteSettings()

const renderedContent = computed(() => renderSafeMarkdown(rulesPageContent.value))

useSeoMeta({
  title: () => `${rulesPageTitle.value} - ${siteName.value}`,
  description: () => rulesPageSummary.value || rulesPageTitle.value,
})
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-8 pb-24 sm:px-6 lg:px-8 lg:py-12">
    <section class="overflow-hidden rounded-[2rem] border border-white/80 bg-[#fffbf7] p-6 shadow-xl shadow-orange-950/6 lg:p-9">
      <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Site Guide</p>
      <h1 class="mt-4 text-3xl font-semibold tracking-[-0.05em] text-gray-950 lg:text-5xl">{{ rulesPageTitle }}</h1>
      <p v-if="rulesPageSummary" class="mt-4 max-w-2xl text-sm leading-7 text-gray-600 lg:text-base">
        {{ rulesPageSummary }}
      </p>
    </section>

    <article class="rules-page-content mt-6 rounded-[1.5rem] border border-[#f0e4d8] bg-white/90 p-6 text-sm leading-7 text-gray-650 shadow-sm shadow-orange-950/5 lg:p-8" v-html="renderedContent" />

    <div class="mt-6 flex flex-wrap gap-3">
      <NuxtLink to="/" class="rounded-full border border-[#eadfd2] bg-white px-4 py-2 text-sm text-gray-700 transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:text-gray-950">
        返回首页
      </NuxtLink>
      <NuxtLink to="/discover" class="rounded-full bg-gray-950 px-4 py-2 text-sm font-medium text-[#d6c39a] transition-all hover:-translate-y-0.5 hover:bg-black">
        浏览图库
      </NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.rules-page-content :deep(h2),
.rules-page-content :deep(h3) {
  margin-top: 1.35rem;
  margin-bottom: 0.5rem;
  color: #111827;
  font-weight: 700;
}

.rules-page-content :deep(p) {
  margin: 0.75rem 0;
}

.rules-page-content :deep(ul) {
  margin: 0.75rem 0;
  padding-left: 1.25rem;
  list-style: disc;
}

.rules-page-content :deep(a) {
  color: #111827;
  text-decoration: underline;
  text-decoration-color: #d6c39a;
  text-underline-offset: 4px;
}
</style>
