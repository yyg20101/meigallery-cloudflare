<script setup lang="ts">
const { api } = useApi()
const { videoEnabled } = useSiteSettings()

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

const PAGE_SIZE = 12

// 获取图库数据
const { data: galleriesData } = await useAsyncData('home-galleries', () =>
  api<{ data: GallerySummary[]; total: number }>('/api/galleries', { query: { pageSize: String(PAGE_SIZE) } }),
)

// 获取标签
const { data: tagsData } = await useAsyncData('home-tags', () =>
  api<{ data: TagGroup }>('/api/tags'),
)

// 无限加载状态
const allGalleries = ref<GallerySummary[]>(galleriesData.value?.data ?? [])
const totalGalleries = computed(() => galleriesData.value?.total ?? 0)
const currentPage = ref(1)
const loadingMore = ref(false)
const hasMore = computed(() => allGalleries.value.length < totalGalleries.value)

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const nextPage = currentPage.value + 1
    const data = await api<{ data: GallerySummary[]; total: number }>('/api/galleries', {
      query: { pageSize: String(PAGE_SIZE), page: String(nextPage) },
    })
    allGalleries.value.push(...data.data)
    currentPage.value = nextPage
  } finally {
    loadingMore.value = false
  }
}

// 精选专题：前 3 条
const featured = computed(() => allGalleries.value.slice(0, 3))

// 最新图库：第 4 条起
const latest = computed(() => allGalleries.value.slice(3))

// 视频专区：筛选包含视频标签的图库，最多显示 3 条
const videoGalleries = computed(() =>
  allGalleries.value
    .filter(g => g.tags.some(t => t.slug === 'video' || t.name === '视频'))
    .slice(0, 3),
)

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

// 无限滚动哨兵
const sentinel = ref<HTMLElement | null>(null)

onMounted(() => {
  if (!sentinel.value) return
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && hasMore.value && !loadingMore.value) {
        loadMore()
      }
    },
    { rootMargin: '200px' },
  )
  observer.observe(sentinel.value)
  onUnmounted(() => observer.disconnect())
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
  <div class="max-w-7xl mx-auto px-4 lg:px-6 py-6 pb-20 lg:pb-6">
    <!-- 精选专题 -->
    <section class="mb-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-[13px] font-semibold text-gray-900">精选专题</h2>
        <NuxtLink to="/discover" class="text-sm text-gray-400 hover:text-gray-600">查看全部 →</NuxtLink>
      </div>
      <template v-if="galleriesData">
        <HomeFeatured :galleries="featured" />
      </template>
      <div v-else class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div v-for="i in 3" :key="i" class="aspect-video bg-gray-200 animate-pulse rounded-md" />
      </div>
    </section>

    <!-- 最新图库 -->
    <section class="mb-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-[13px] font-semibold text-gray-900">最新图库</h2>
        <NuxtLink to="/discover" class="text-sm text-gray-400 hover:text-gray-600">查看全部 →</NuxtLink>
      </div>
      <template v-if="galleriesData">
        <GalleryGrid :galleries="latest" />
        <div v-if="latest.length === 0" class="py-20 text-center text-gray-400">
          暂无图库内容
        </div>
        <!-- 加载更多 -->
        <div v-if="loadingMore" class="py-6 text-center text-gray-400 text-sm">加载中...</div>
        <div v-if="hasMore" ref="sentinel" class="h-px" />
        <div v-if="!hasMore && allGalleries.length > PAGE_SIZE" class="py-6 text-center text-sm text-gray-400">
          已展示全部图库
        </div>
      </template>
      <div v-else class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div v-for="i in 8" :key="i">
          <div class="aspect-[3/4] bg-gray-200 animate-pulse rounded-md" />
          <div class="mt-2 h-4 w-3/4 bg-gray-200 animate-pulse rounded" />
        </div>
      </div>
    </section>

    <!-- 热门标签 -->
    <section v-if="hotTags.length > 0 || !tagsData" class="mb-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-[13px] font-semibold text-gray-900">热门标签</h2>
      </div>
      <template v-if="tagsData">
        <div class="flex flex-wrap gap-2">
          <NuxtLink
            v-for="tag in hotTags"
            :key="tag.slug"
            :to="`/discover?tag=${tag.slug}`"
          >
            <TagChip :tag="tag" />
          </NuxtLink>
        </div>
      </template>
      <div v-else class="flex flex-wrap gap-2">
        <div v-for="i in 8" :key="i" class="h-6 w-14 bg-gray-200 animate-pulse rounded-full" />
      </div>
    </section>

    <!-- 视频专区 -->
    <section v-if="videoEnabled && videoGalleries.length > 0" class="mb-5">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-[13px] font-semibold text-gray-900">视频专区</h2>
        <NuxtLink to="/discover?tag=video" class="text-sm text-gray-400 hover:text-gray-600">查看全部 →</NuxtLink>
      </div>
      <HomeVideoZone :galleries="videoGalleries" />
    </section>
  </div>
</template>
