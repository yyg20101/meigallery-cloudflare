<script setup lang="ts">
const { api } = useApi()
const {
  videoEnabled,
  homeHeroTitle,
  homeHeroSubtitle,
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

interface TestimonialSummary {
  id: string
  title: string
  slug: string
  summary: string | null
  imageCount: number
  coverImageUrl: string | null
  publishedAt: string | null
}

const PAGE_SIZE = 12

// 获取图库数据
const { data: galleriesData } = await useAsyncData('home-galleries', () =>
  api<{ data: GallerySummary[]; total: number }>('/api/galleries', { query: { pageSize: String(PAGE_SIZE) } }),
)

const { data: hotGalleriesData } = await useAsyncData('home-hot-galleries', () =>
  api<{ data: GallerySummary[]; total: number }>('/api/galleries', { query: { pageSize: '9', sort: 'hot' } }),
)

// 获取标签
const { data: tagsData } = await useAsyncData('home-tags', () =>
  api<{ data: TagGroup }>('/api/tags'),
)

const { data: testimonialsData } = await useAsyncData('home-testimonials', () =>
  api<{ data: TestimonialSummary[] }>('/api/testimonial-cases', { query: { featured: 'true', pageSize: '6' } }),
)

const allGalleries = computed(() => galleriesData.value?.data ?? [])

// 顶部轮播：前 6 条，避免首屏浪费并展示更多内容
const heroGalleries = computed(() => allGalleries.value.slice(0, 6))

function galleryKey(gallery: GallerySummary) {
  return gallery.id || gallery.slug
}

function appendUniqueGalleries(source: GallerySummary[], target: GallerySummary[], excludedKeys: Set<string>, limit: number) {
  const pickedKeys = new Set(target.map(galleryKey))

  for (const gallery of source) {
    const key = galleryKey(gallery)
    if (excludedKeys.has(key) || pickedKeys.has(key)) continue

    target.push(gallery)
    pickedKeys.add(key)
    if (target.length >= limit) break
  }

  return target
}

// 热门推荐：优先使用热度排序，失败时回退到首屏后段内容，不影响无限加载分页。
const featured = computed(() => {
  const heroKeys = new Set(heroGalleries.value.map(galleryKey))
  const picked = appendUniqueGalleries(hotGalleriesData.value?.data ?? [], [], heroKeys, 3)

  if (picked.length < 3) {
    appendUniqueGalleries(allGalleries.value, picked, heroKeys, 3)
  }

  return picked
})

// 视频专区：筛选包含视频标签的图库，最多显示 3 条
const videoGalleries = computed(() => {
  const displayedKeys = new Set([...heroGalleries.value, ...featured.value].map(galleryKey))

  return allGalleries.value
    .filter(g => !displayedKeys.has(galleryKey(g)))
    .filter(g => g.tags.some(t => t.slug === 'video' || t.name === '视频'))
    .slice(0, 3)
})

// 最新图库：按 hero → featured → video → latest 顺序排除，避免同屏重复。
const latest = computed(() => {
  const displayedGalleries = [...heroGalleries.value, ...featured.value]
  if (videoEnabled.value && videoGalleries.value.length > 0) {
    displayedGalleries.push(...videoGalleries.value)
  }

  const displayedKeys = new Set(displayedGalleries.map(galleryKey))
  return allGalleries.value.filter(gallery => !displayedKeys.has(galleryKey(gallery)))
})

function flattenTags(types: string[], limit: number) {
  if (!tagsData.value?.data) return []
  const result: Array<{ id: string; name: string; slug: string; type: string }> = []
  for (const type of types) {
    for (const item of tagsData.value.data[type] || []) {
      result.push({ ...item, type })
      if (result.length >= limit) return result
    }
  }
  return result
}

const cityTags = computed(() => flattenTags(['city', 'city_country'], 8))
const regionTags = computed(() => flattenTags(['region_scope', 'region_group'], 8))
const styleTags = computed(() => flattenTags(['style', 'personality', 'scene'], homeHotTagLimit.value))
const testimonials = computed(() => testimonialsData.value?.data ?? [])

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
      :galleries="heroGalleries"
    />

    <section class="mt-6 lg:mt-8">
      <HomeTagNavigator :cities="cityTags" :regions="regionTags" :styles="styleTags" />
    </section>

    <section class="mt-8 lg:mt-10">
      <TestimonialCarousel :cases="testimonials" />
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
      <EditorialSectionHeading eyebrow="最新上新" title="最新图库" description="持续更新授权写真、时尚、生活与艺术类图库。" action-label="查看全部" action-to="/discover" />
      <template v-if="galleriesData">
        <GalleryGrid :galleries="latest.slice(0, 12)" variant="magazine" />
        <div v-if="latest.length === 0" class="rounded-[1.5rem] border border-orange-100 bg-white/80 py-20 text-center text-gray-400">暂无更多最新内容</div>
        <div class="mt-6 text-center">
          <NuxtLink to="/discover" class="inline-flex rounded-full bg-gray-950 px-5 py-3 text-sm font-medium text-white shadow-sm shadow-gray-900/15 transition-all hover:-translate-y-0.5 hover:bg-gray-800">
            查看更多图库
          </NuxtLink>
        </div>
      </template>
    </section>

    <section v-if="videoEnabled && videoGalleries.length > 0" class="mt-8 lg:mt-10">
      <EditorialSectionHeading eyebrow="视频专区" title="视频专区" description="视频功能开启后展示可浏览的视频内容。" action-label="查看视频" action-to="/discover?tag=video" />
      <HomeVideoZone :galleries="videoGalleries" />
    </section>
  </div>
</template>
