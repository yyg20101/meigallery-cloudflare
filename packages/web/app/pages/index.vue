<script setup lang="ts">
const { api } = useApi()

interface GallerySummary {
  id: string
  title: string
  slug: string
  summary: string | null
  coverUrl: string | null
  requiredLevelRank: number
  publishedAt: string | null
  tags: Array<{ id: string; type: string; name: string; slug: string }>
}

interface TagGroup {
  [type: string]: Array<{ id: string; name: string; slug: string }>
}

// 获取最新图库
const { data: galleriesData } = await useAsyncData('home-galleries', () =>
  api<{ data: GallerySummary[]; total: number }>('/api/galleries', { query: { pageSize: '24' } }),
)

// 获取标签（用于热门标签展示）
const { data: tagsData } = await useAsyncData('home-tags', () =>
  api<{ data: TagGroup }>('/api/tags'),
)

const galleries = computed(() => galleriesData.value?.data ?? [])
const hotTags = computed(() => {
  if (!tagsData.value?.data) return []
  const all: Array<{ id: string; name: string; slug: string; type: string }> = []
  for (const [type, items] of Object.entries(tagsData.value.data)) {
    for (const item of items.slice(0, 5)) {
      all.push({ ...item, type })
    }
  }
  return all.slice(0, 20)
})

useSeoMeta({
  title: 'MeiGallery - 精选写真图库',
  description: '精选写真、时尚、生活、艺术类图片和视频，覆盖国内外多城市地区',
  ogTitle: 'MeiGallery - 精选写真图库',
  ogDescription: '精选写真、时尚、生活、艺术类图片和视频',
  ogType: 'website',
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 pb-20 sm:pb-6">
    <!-- 热门标签 -->
    <section v-if="hotTags.length > 0" class="mb-8">
      <h2 class="text-lg font-semibold text-gray-900 mb-3">热门标签</h2>
      <div class="flex flex-wrap gap-2">
        <NuxtLink
          v-for="tag in hotTags"
          :key="tag.slug"
          :to="`/search?tag=${tag.slug}`"
          class="rounded-full bg-gray-100 px-3 py-1 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 transition-colors"
        >
          {{ tag.name }}
        </NuxtLink>
      </div>
    </section>

    <!-- 最新图库 -->
    <section>
      <h2 class="text-lg font-semibold text-gray-900 mb-4">最新图库</h2>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        <GalleryCard v-for="g in galleries" :key="g.id" :gallery="g" />
      </div>
      <div v-if="galleries.length === 0" class="py-20 text-center text-gray-400">
        暂无图库内容
      </div>
    </section>
  </div>
</template>
