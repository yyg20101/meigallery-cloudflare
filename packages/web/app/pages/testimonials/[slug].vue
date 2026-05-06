<script setup lang="ts">
const route = useRoute()
const { api } = useApi()

interface TestimonialDetail {
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

const { data: item, error } = await useAsyncData(`testimonial-${route.params.slug}`, () =>
  api<TestimonialDetail>(`/api/testimonial-cases/${route.params.slug}`),
)

if (error.value || !item.value) {
  throw createError({ statusCode: 404, message: '真实案例不存在或暂未公开' })
}

const formattedDate = computed(() => item.value?.publishedAt?.split('T')[0] || '')

useSeoMeta({
  title: () => item.value?.seoTitle || (item.value ? `${item.value.title} - 真实案例 - MeiGallery` : '真实案例 - MeiGallery'),
  description: () => item.value?.seoDescription || item.value?.summary || '查看已授权、已脱敏的真实案例。',
  ogTitle: () => item.value?.title || '真实案例',
  ogDescription: () => item.value?.summary || '查看已授权、已脱敏的真实案例。',
  ogImage: () => item.value?.images[0]?.url || undefined,
})
</script>

<template>
  <div v-if="item" class="mx-auto max-w-7xl px-4 py-6 pb-24 sm:px-6 lg:px-8 lg:py-10">
    <BreadcrumbNav :items="[{ label: '首页', to: '/' }, { label: '真实案例', to: '/testimonials' }, { label: item.title }]" class="mb-4" />

    <section class="overflow-hidden rounded-[2rem] border border-white/80 bg-[#fffbf7] shadow-xl shadow-orange-950/6 lg:grid lg:grid-cols-[1.15fr_0.85fr]">
      <div class="relative aspect-[4/3] overflow-hidden bg-orange-50 lg:aspect-auto lg:min-h-[30rem]">
        <img v-if="item.images[0]" :src="item.images[0].url" :alt="item.images[0].alt" class="h-full w-full object-cover" fetchpriority="high" />
        <div v-else class="flex h-full items-center justify-center bg-gradient-to-br from-[#fff7ed] to-[#f8e7dc] text-sm text-gray-400">图片整理中</div>
      </div>
      <div class="flex flex-col justify-end p-6 lg:p-8">
        <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Authorized Feedback</p>
        <h1 class="mt-4 text-3xl font-semibold tracking-[-0.05em] text-gray-950 lg:text-5xl">{{ item.title }}</h1>
        <p class="mt-4 text-xs text-gray-400"><span v-if="formattedDate">{{ formattedDate }} · </span>{{ item.images.length }} 张图片</p>
        <p v-if="item.summary" class="mt-5 text-sm leading-7 text-gray-600">{{ item.summary }}</p>
        <div class="mt-6 flex flex-wrap gap-3">
          <NuxtLink to="/testimonials" class="rounded-full border border-[#eadfd2] bg-white px-4 py-2 text-sm text-gray-700 transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:text-gray-950">返回案例列表</NuxtLink>
          <NuxtLink to="/discover" class="rounded-full bg-gray-950 px-4 py-2 text-sm font-medium text-[#d6c39a] transition-all hover:-translate-y-0.5 hover:bg-black">查看更多图库</NuxtLink>
        </div>
      </div>
    </section>

    <section v-if="item.images.length" class="mt-6">
      <TestimonialGallery :images="item.images" />
    </section>

    <section v-if="item.bodyMd" class="mt-6 rounded-[1.5rem] border border-[#f0e4d8] bg-white/90 p-6 text-sm leading-7 text-gray-600 shadow-sm shadow-orange-950/5 whitespace-pre-line">
      {{ item.bodyMd }}
    </section>
  </div>
</template>
