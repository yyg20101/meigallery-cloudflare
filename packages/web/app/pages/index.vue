<script setup lang="ts">
import { collectRegionGuideItems } from '~/utils/galleryPresentation'

const { api } = useApi()
const {
  videoEnabled,
  homeHeroTitle,
  homeHeroSubtitle,
  homeHeroCtaLabel,
  homeHeroCtaUrl,
  homeFeaturedRegionSlugs,
  homeHotTagLimit,
} = useSiteSettings()

interface GallerySummary {
  id: string
  title: string
  slug: string
  summary: string | null
  coverUrl: string | null
  requiredLevelRank: number
  publishedAt: string | null
  tags: Array<{ id: string; type: string; name: string; slug: string }>
  viewCount?: number
  likeCount?: number
}

interface TagGroup {
  [type: string]: Array<{ id: string; name: string; slug: string }>
}

const PAGE_SIZE = 12

// 获取图库数据
const { data: galleriesData } = await useAsyncData('home-galleries', () =>
  api<{ data: GallerySummary[]; total: number }>('/api/galleries', { query: { pageSize: String(PAGE_SIZE) } }),
)

const { data: hotGalleriesData } = await useAsyncData('home-hot-galleries', () =>
  api<{ data: GallerySummary[]; total: number }>('/api/galleries', { query: { pageSize: '3', sort: 'hot' } }),
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

// 顶部轮播：前 6 条，避免首屏浪费并展示更多内容
const heroGalleries = computed(() => allGalleries.value.slice(0, 6))

// 热门推荐：优先使用热度排序，失败时回退到首屏后段内容，不影响无限加载分页。
const featured = computed(() => hotGalleriesData.value?.data ?? allGalleries.value.slice(6, 9))

// 最新图库：第 10 条起
const latest = computed(() => allGalleries.value.slice(9))

// 视频专区：筛选包含视频标签的图库，最多显示 3 条
const videoGalleries = computed(() =>
  allGalleries.value
    .filter(g => g.tags.some(t => t.slug === 'video' || t.name === '视频'))
    .slice(0, 3),
)

const regionGuideItems = computed(() => {
  if (!tagsData.value?.data) return []
  return collectRegionGuideItems(tagsData.value.data, homeFeaturedRegionSlugs.value, 4)
})

const hotTags = computed(() => {
  if (!tagsData.value?.data) return []
  const all: Array<{ id: string; name: string; slug: string; type: string }> = []
  for (const [type, items] of Object.entries(tagsData.value.data)) {
    if (['region', 'region_scope', 'region_group', 'city', 'city_country'].includes(type)) continue
    for (const item of items.slice(0, 4)) {
      all.push({ ...item, type })
    }
  }
  return all.slice(0, homeHotTagLimit.value)
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
  <div class="mx-auto max-w-7xl px-4 py-5 pb-24 lg:px-6 lg:py-8">
    <HomeEditorialHero
      :title="homeHeroTitle"
      :subtitle="homeHeroSubtitle"
      :cta-label="homeHeroCtaLabel"
      :cta-url="homeHeroCtaUrl"
      :galleries="heroGalleries"
    />

    <section v-if="regionGuideItems.length > 0" class="mt-6 lg:mt-8">
      <RegionGuide :regions="regionGuideItems" />
    </section>

    <section class="mt-8 lg:mt-10">
      <EditorialSectionHeading eyebrow="人气热榜" title="热门推荐" description="按访问与点赞热度生成的人气内容。" action-label="查看全部" action-to="/discover?sort=hot" />
      <template v-if="galleriesData">
        <HomeFeatured v-if="featured.length > 0" :galleries="featured" />
        <div v-else class="rounded-[1.5rem] border border-orange-100 bg-white/80 py-14 text-center text-gray-400">暂无更多精选内容</div>
      </template>
      <div v-else class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div v-for="i in 3" :key="i" class="aspect-video animate-pulse rounded-[1.5rem] bg-orange-50" />
      </div>
    </section>

    <section class="mt-8 lg:mt-10">
      <EditorialSectionHeading eyebrow="New Arrival" title="最新图库" description="持续更新授权写真、时尚、生活与艺术类图库。" action-label="查看全部" action-to="/discover" />
      <template v-if="galleriesData">
        <GalleryGrid :galleries="latest" variant="magazine" />
        <div v-if="latest.length === 0" class="rounded-[1.5rem] border border-orange-100 bg-white/80 py-20 text-center text-gray-400">暂无更多最新内容</div>
        <div v-if="loadingMore" class="py-6 text-center text-sm text-gray-400">加载中...</div>
        <div v-if="hasMore" ref="sentinel" class="h-px" />
        <div v-if="!hasMore && allGalleries.length > PAGE_SIZE" class="py-6 text-center text-sm text-gray-400">已展示全部图库</div>
      </template>
    </section>

    <section v-if="hotTags.length > 0 || !tagsData" class="mt-8 lg:mt-10">
      <EditorialSectionHeading eyebrow="Style Tags" title="风格标签" description="用标签补充筛选人物气质、服饰、场景和内容类型。" />
      <div v-if="tagsData" class="flex flex-wrap gap-2">
        <NuxtLink v-for="tag in hotTags" :key="tag.slug" :to="{ path: '/discover', query: { tag: tag.slug } }">
          <TagChip :tag="tag" />
        </NuxtLink>
      </div>
      <div v-else class="flex flex-wrap gap-2">
        <div v-for="i in 8" :key="i" class="h-6 w-14 animate-pulse rounded-full bg-orange-50" />
      </div>
    </section>

    <section v-if="videoEnabled && videoGalleries.length > 0" class="mt-8 lg:mt-10">
      <EditorialSectionHeading eyebrow="Video" title="视频专区" description="视频功能开启后展示可浏览的视频内容。" action-label="查看视频" action-to="/discover?tag=video" />
      <HomeVideoZone :galleries="videoGalleries" />
    </section>
  </div>
</template>
