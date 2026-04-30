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

// 获取图库数据
const { data: galleriesData } = await useAsyncData('home-galleries', () =>
  api<{ data: GallerySummary[]; total: number }>('/api/galleries', { query: { pageSize: '12' } }),
)

// 获取标签
const { data: tagsData } = await useAsyncData('home-tags', () =>
  api<{ data: TagGroup }>('/api/tags'),
)

const allGalleries = computed(() => galleriesData.value?.data ?? [])

// 精选专题：前 3 条
const featured = computed(() => allGalleries.value.slice(0, 3))

// 最新图库：第 4-11 条（8 条）
const latest = computed(() => allGalleries.value.slice(3, 11))

// 视频专区：最后 3 条
const videoGalleries = computed(() => allGalleries.value.slice(-3))

// 热门标签：每类取前几个，总共最多 15 个
const hotTags = computed(() => {
  if (!tagsData.value?.data) return []
  const all: Array<{ id: string; name: string; slug: string; type: string }> = []
  for (const [type, items] of Object.entries(tagsData.value.data)) {
    for (const item of items.slice(0, 4)) {
      all.push({ ...item, type })
    }
  }
  return all.slice(0, 15)
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
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-20 sm:pb-6">
    <!-- 精选专题 -->
    <section class="mb-10">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-gray-900">精选专题</h2>
        <NuxtLink to="/discover" class="text-sm text-gray-400 hover:text-gray-600">查看全部 →</NuxtLink>
      </div>
      <HomeFeatured :galleries="featured" />
    </section>

    <!-- 热门标签 -->
    <section v-if="hotTags.length > 0" class="mb-10">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-gray-900">热门标签</h2>
      </div>
      <div class="flex flex-wrap gap-2">
        <NuxtLink
          v-for="tag in hotTags"
          :key="tag.slug"
          :to="`/discover?tag=${tag.slug}`"
        >
          <TagChip :tag="tag" />
        </NuxtLink>
      </div>
    </section>

    <!-- 最新图库 -->
    <section class="mb-10">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-gray-900">最新图库</h2>
        <NuxtLink to="/discover" class="text-sm text-gray-400 hover:text-gray-600">查看全部 →</NuxtLink>
      </div>
      <GalleryGrid :galleries="latest" />
      <div v-if="latest.length === 0" class="py-20 text-center text-gray-400">
        暂无图库内容
      </div>
    </section>

    <!-- 视频专区 -->
    <section v-if="videoGalleries.length > 0" class="mb-10">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-gray-900">视频专区</h2>
        <NuxtLink to="/discover?tag=video" class="text-sm text-gray-400 hover:text-gray-600">查看全部 →</NuxtLink>
      </div>
      <HomeVideoZone :galleries="videoGalleries" />
    </section>
  </div>
</template>
