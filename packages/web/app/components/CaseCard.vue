<script setup lang="ts">
defineProps<{
  item: {
    id: string
    title: string
    slug: string
    summary: string | null
    imageCount: number
    coverImageUrl: string | null
    publishedAt: string | null
  }
}>()
</script>

<template>
  <NuxtLink :to="`/cases/${item.slug}`" class="group block overflow-hidden rounded-[1.5rem] border border-[#f0e4d8] bg-white shadow-sm shadow-orange-950/5 transition-all hover:-translate-y-1 hover:shadow-xl hover:shadow-orange-950/10">
    <div class="aspect-[4/3] overflow-hidden bg-orange-50">
      <img v-if="item.coverImageUrl" :src="item.coverImageUrl" :alt="item.title" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" referrerpolicy="no-referrer" />
      <div v-else class="flex h-full items-center justify-center bg-gradient-to-br from-[#fff7ed] to-[#f8e7dc] text-xs text-gray-400">图片整理中</div>
    </div>
    <div class="p-4">
      <p class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#bfa46a]">{{ item.imageCount }} 张图片</p>
      <h2 class="mt-2 line-clamp-2 text-lg font-semibold tracking-tight text-gray-950">{{ item.title }}</h2>
      <p v-if="item.summary" class="mt-2 line-clamp-2 text-sm leading-6 text-gray-500">{{ item.summary }}</p>
    </div>
  </NuxtLink>
</template>
