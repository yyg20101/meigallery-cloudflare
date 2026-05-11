<script setup lang="ts">
const route = useRoute()
const { api } = useApi()
const { trackLeadOnce } = useFacebookPixel()

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

function openContactPanel() {
  trackLeadOnce({ location: 'testimonial_detail_cta', methodType: 'contact_owner' })
  window.dispatchEvent(new CustomEvent('meigallery:open-contact-panel'))
}
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
        <div class="mt-7 rounded-[1.5rem] border border-[#eadfd2] bg-white/72 p-3 shadow-sm shadow-orange-950/5 backdrop-blur">
          <NuxtLink to="/testimonials" class="inline-flex text-sm font-medium text-gray-500 underline decoration-[#d6c39a] underline-offset-4 transition-colors hover:text-gray-950">返回案例列表</NuxtLink>
          <div class="mt-3 grid gap-2 sm:grid-cols-2">
            <NuxtLink to="/discover" class="inline-flex min-h-11 items-center justify-center rounded-full bg-gray-950 px-5 py-2.5 text-sm font-medium text-[#d6c39a] shadow-sm shadow-gray-950/20 transition-all hover:-translate-y-0.5 hover:bg-black">查看更多图库</NuxtLink>
            <button type="button" class="inline-flex min-h-11 items-center justify-center rounded-full border border-gray-950 bg-white px-5 py-2.5 text-sm font-medium text-gray-950 transition-all hover:-translate-y-0.5 hover:bg-gray-950 hover:text-[#d6c39a]" @click="openContactPanel">联系站长</button>
          </div>
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
