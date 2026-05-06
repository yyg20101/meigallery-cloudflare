<script setup lang="ts">
interface TestimonialSummary {
  id: string
  title: string
  slug: string
  summary: string | null
  imageCount: number
  coverImageUrl: string | null
  publishedAt: string | null
}

defineProps<{ cases: TestimonialSummary[] }>()
</script>

<template>
  <section class="overflow-hidden rounded-[2rem] border border-[#f0e4d8] bg-white p-4 shadow-xl shadow-orange-950/6 lg:p-6">
    <EditorialSectionHeading eyebrow="Testimonials" title="真实案例" description="展示已授权、已脱敏的用户反馈与站点体验案例。" action-label="查看全部案例" action-to="/testimonials" />
    <div v-if="cases.length" class="mt-5 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 lg:grid lg:grid-cols-3 lg:overflow-visible">
      <NuxtLink
        v-for="item in cases"
        :key="item.id"
        :to="`/testimonials/${item.slug}`"
        class="group min-w-[82vw] snap-start overflow-hidden rounded-[1.5rem] border border-[#f0e4d8] bg-[#fffbf7] shadow-sm shadow-orange-950/5 transition-all hover:-translate-y-1 hover:shadow-xl hover:shadow-orange-950/10 sm:min-w-[22rem] lg:min-w-0"
      >
        <div class="aspect-[4/3] overflow-hidden bg-orange-50">
          <img v-if="item.coverImageUrl" :src="item.coverImageUrl" :alt="item.title" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
          <div v-else class="flex h-full items-center justify-center bg-gradient-to-br from-[#fff7ed] to-[#f8e7dc] text-xs text-gray-400">图片整理中</div>
        </div>
        <div class="p-4">
          <p class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#bfa46a]">{{ item.imageCount }} 张图片</p>
          <h3 class="mt-2 line-clamp-2 text-lg font-semibold tracking-tight text-gray-950">{{ item.title }}</h3>
          <p v-if="item.summary" class="mt-2 line-clamp-2 text-sm leading-6 text-gray-500">{{ item.summary }}</p>
        </div>
      </NuxtLink>
    </div>
    <div v-else class="mt-5 rounded-[1.5rem] border border-orange-100 bg-[#fffbf7] px-5 py-10 text-center">
      <h3 class="text-lg font-semibold tracking-tight text-gray-950">真实案例整理中</h3>
      <p class="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500">我们正在整理已授权、已脱敏的用户反馈。你可以先浏览最新图库，或联系站长了解会员规则。</p>
      <NuxtLink to="/discover" class="mt-5 inline-flex rounded-full bg-gray-950 px-5 py-2.5 text-sm font-medium text-white transition-all hover:-translate-y-0.5 hover:bg-gray-800">浏览最新图库</NuxtLink>
    </div>
  </section>
</template>
