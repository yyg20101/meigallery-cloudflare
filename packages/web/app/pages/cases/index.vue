<script setup lang="ts">
const { api } = useApi()

interface TestimonialSummary {
  id: string
  title: string
  slug: string
  summary: string | null
  imageCount: number
  coverImageUrl: string | null
  publishedAt: string | null
}

const { data } = await useAsyncData('cases-list', () =>
  api<{ data: TestimonialSummary[]; total: number }>('/api/testimonial-cases', { query: { pageSize: '12' } }),
)

const cases = computed(() => data.value?.data ?? [])

useSeoMeta({
  title: '真实案例 - MeiGallery',
  description: '查看已授权、已脱敏的用户反馈和真实案例。',
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-6 pb-24 sm:px-6 lg:px-8 lg:py-10">
    <section class="overflow-hidden rounded-[2rem] border border-white/80 bg-[#fffbf7] px-5 py-8 shadow-xl shadow-orange-950/6 lg:px-8 lg:py-10">
      <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Case Stories</p>
      <h1 class="mt-4 text-3xl font-semibold tracking-[-0.05em] text-gray-950 lg:text-5xl">真实案例</h1>
      <p class="mt-4 max-w-2xl text-sm leading-7 text-gray-600 lg:text-base">集中查看已授权、已脱敏的用户反馈和站点体验案例，了解内容浏览、会员咨询和规则说明。</p>
    </section>

    <div v-if="cases.length" class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <TestimonialCard v-for="item in cases" :key="item.id" :item="item" />
    </div>

    <div v-else class="mt-6 rounded-[1.5rem] border border-[#f0e4d8] bg-white/90 px-5 py-16 text-center shadow-sm shadow-orange-950/5">
      <h2 class="text-xl font-semibold tracking-tight text-gray-950">真实案例整理中</h2>
      <p class="mx-auto mt-3 max-w-md text-sm leading-6 text-gray-500">当前暂无公开案例，后续会展示经过授权和脱敏的用户反馈。</p>
      <div class="mt-6 flex flex-wrap justify-center gap-3">
        <NuxtLink to="/" class="rounded-full border border-[#eadfd2] bg-white px-4 py-2 text-sm text-gray-700 transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:text-gray-950">返回首页</NuxtLink>
        <NuxtLink to="/discover" class="rounded-full bg-gray-950 px-4 py-2 text-sm font-medium text-[#d6c39a] transition-all hover:-translate-y-0.5 hover:bg-black">浏览图库</NuxtLink>
      </div>
    </div>
  </div>
</template>
