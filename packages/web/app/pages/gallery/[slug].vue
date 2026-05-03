<script setup lang="ts">
import { getPrimaryRegion, getSupportTags } from '~/utils/galleryPresentation'

const route = useRoute()
const { api } = useApi()
const { isLoggedIn, membershipRank } = useAuth()
const { videoEnabled } = useSiteSettings()


interface GalleryTag {
  id: string
  type: string
  name: string
  slug: string
}

interface MediaAsset {
  id: string
  type: 'image' | 'video'
  role: string
  sortOrder: number
  requiredRank: number
  thumbnailUrl?: string
  url?: string
}

interface GalleryDetail {
  id: string
  title: string
  slug: string
  summary: string | null
  bodyMd: string | null
  coverUrl: string | null
  status: string
  requiredLevelRank: number
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  tags: GalleryTag[]
  mediaAssets: MediaAsset[]
}

interface GallerySummary {
  id: string
  title: string
  slug: string
  coverUrl: string | null
  requiredLevelRank: number
  tags: GalleryTag[]
}

const { data: gallery, error } = await useAsyncData(`gallery-${route.params.slug}`, () =>
  api<GalleryDetail>(`/api/galleries/${route.params.slug}`),
)

if (error.value || !gallery.value) {
  throw createError({ statusCode: 404, message: '图库不存在' })
}

// SEO / OG meta
useSeoMeta({
  title: `${gallery.value.title} - MeiGallery`,
  description: gallery.value.summary || `${gallery.value.title} - 精选写真图库`,
  ogTitle: gallery.value.title,
  ogDescription: gallery.value.summary || `${gallery.value.title} - 精选写真图库`,
  ogImage: gallery.value.coverUrl || undefined,
  ogType: 'article',
  twitterCard: 'summary_large_image',
})

// 计算媒体分类
const images = computed(() =>
  gallery.value?.mediaAssets.filter(m => m.type === 'image').sort((a, b) => a.sortOrder - b.sortOrder) ?? [],
)
const videos = computed(() =>
  gallery.value?.mediaAssets.filter(m => m.type === 'video').sort((a, b) => a.sortOrder - b.sortOrder) ?? [],
)
const publicImages = computed(() =>
  images.value.filter(m => m.requiredRank <= 0 || membershipRank.value >= m.requiredRank),
)
const lockedImages = computed(() =>
  images.value.filter(m => m.requiredRank > 0 && membershipRank.value < m.requiredRank),
)
const previewVideos = computed(() =>
  videos.value.filter(v => v.role === 'preview' || v.requiredRank === 0),
)
const fullVideos = computed(() =>
  videos.value.filter(v => v.role === 'full' || (v.requiredRank > 0 && v.role !== 'preview')),
)

// 图片查看器状态
const viewerOpen = ref(false)
const viewerStartIndex = ref(0)

const viewerImages = computed(() =>
  publicImages.value.map(img => ({
    id: img.id,
    url: img.thumbnailUrl || img.url || '',
    alt: gallery.value?.title || '',
  })),
)

function openViewer(index: number) {
  viewerStartIndex.value = index
  viewerOpen.value = true
}

// 面包屑
const regionTag = computed(() => gallery.value?.tags.find(t => t.type === 'region' || t.type === 'region_group' || t.type === 'city'))
const breadcrumbs = computed(() => [
  { label: '首页', to: '/' },
  regionTag.value
    ? { label: regionTag.value.name, to: `/discover?tag=${regionTag.value.slug}` }
    : { label: '图库', to: '/discover' },
  { label: gallery.value?.title || '' },
])

// 相关推荐
const firstTag = computed(() => gallery.value?.tags[0])
const { data: relatedData } = await useAsyncData(
  `related-${route.params.slug}`,
  () => firstTag.value
    ? api<{ data: GallerySummary[] }>(`/api/galleries?tag=${firstTag.value.slug}&pageSize=4`)
    : Promise.resolve({ data: [] as GallerySummary[] }),
)
const relatedGalleries = computed(() =>
  (relatedData.value?.data ?? []).filter(g => g.slug !== gallery.value?.slug).slice(0, 4),
)

// 格式化日期
const formattedDate = computed(() => {
  const d = gallery.value?.publishedAt || gallery.value?.createdAt
  return d ? d.split('T')[0] : ''
})

const primaryRegion = computed(() => gallery.value ? getPrimaryRegion(gallery.value.tags) : null)
const supportTags = computed(() => gallery.value ? getSupportTags(gallery.value.tags, 8) : [])

// 锁定提示文案
const lockMessage = computed(() => {
  const count = lockedImages.value.length
  const rank = gallery.value?.requiredLevelRank ?? 0
  const levelName = rank >= 20 ? 'SVIP' : 'VIP'
  return `剩余 ${count} 张图片需要 ${levelName} 会员`
})

useSeoMeta({
  title: () => gallery.value ? `${gallery.value.title} - MeiGallery` : 'MeiGallery',
  description: () => gallery.value?.summary || '',
  ogTitle: () => gallery.value?.title || 'MeiGallery',
  ogDescription: () => gallery.value?.summary || '',
  ogImage: () => gallery.value?.coverUrl || '',
  ogType: 'article',
})
</script>

<template>
  <div v-if="gallery" class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
    <BreadcrumbNav :items="breadcrumbs" class="mb-4" />

    <section class="mb-8 overflow-hidden rounded-[2rem] border border-white/80 bg-[#fffbf7] shadow-2xl shadow-orange-950/8 lg:grid lg:grid-cols-[1.2fr_0.8fr]">
      <div class="relative aspect-[4/5] overflow-hidden bg-gradient-to-br from-orange-50 to-stone-100 lg:aspect-auto lg:min-h-[34rem]">
        <img v-if="gallery.coverUrl" :src="gallery.coverUrl" :alt="gallery.title" class="h-full w-full object-cover" />
        <div v-else class="h-full w-full bg-gradient-to-br from-[#f8e7dc] to-[#fff7ed]" />
        <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-gray-950/70 to-transparent p-5 text-white lg:hidden">
          <p v-if="primaryRegion" class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#d6c39a]">{{ primaryRegion.name }}</p>
          <h1 class="mt-2 text-2xl font-semibold tracking-tight">{{ gallery.title }}</h1>
        </div>
      </div>
      <div class="relative flex flex-col justify-end p-6 lg:p-8">
        <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Gallery Detail</p>
        <h1 class="mt-4 hidden text-4xl font-semibold tracking-[-0.055em] text-gray-950 lg:block">{{ gallery.title }}</h1>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <NuxtLink v-if="primaryRegion" :to="{ path: '/discover', query: { tag: primaryRegion.slug } }" class="rounded-full bg-gray-950 px-3 py-1 text-xs font-medium text-[#d6c39a]">{{ primaryRegion.name }}</NuxtLink>
          <TagChip v-for="tag in supportTags" :key="tag.id" :tag="tag" linkable />
          <MembershipBadge v-if="gallery.requiredLevelRank > 0" :rank="gallery.requiredLevelRank" />
        </div>
        <p class="mt-4 text-xs text-gray-400">{{ formattedDate }}<span v-if="images.length"> · {{ images.length }}张图片</span><span v-if="videos.length"> · {{ videos.length }}个视频</span></p>
        <p v-if="gallery.summary" class="mt-5 text-sm leading-7 text-gray-600">{{ gallery.summary }}</p>
      </div>
    </section>

    <!-- 双栏布局 -->
    <div class="lg:flex lg:gap-8">
      <!-- 左栏：主内容 -->
      <main class="lg:flex-[3] min-w-0">
        <!-- 公开图片区 -->
        <section v-if="publicImages.length > 0" class="mb-6">
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div
              v-for="(img, idx) in publicImages"
              :key="img.id"
              class="aspect-[3/4] cursor-pointer overflow-hidden rounded-[1.25rem] bg-gray-100 shadow-sm shadow-orange-950/5 ring-1 ring-white/80"
              @click="openViewer(idx)"
            >
              <img
                :src="img.thumbnailUrl || img.url"
                :alt="gallery.title"
                class="h-full w-full object-cover transition-transform hover:scale-105"
                loading="lazy"
              />
            </div>
          </div>
        </section>

        <!-- 锁定图片区 -->
        <section v-if="lockedImages.length > 0" class="mb-6">
          <MediaLock
            :required-rank="gallery.requiredLevelRank"
            :message="lockMessage"
          />
        </section>

        <!-- 视频区 -->
        <section v-if="videoEnabled && videos.length > 0" class="mb-6">
          <h2 class="text-lg font-semibold text-gray-900 mb-4">视频</h2>
          <div class="space-y-4">
            <!-- 预览视频 -->
            <div v-for="vid in previewVideos" :key="vid.id">
              <div class="bg-gray-900 rounded-xl aspect-video flex items-center justify-center relative cursor-pointer">
                <svg class="w-16 h-16 text-white opacity-80" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
              <p class="mt-1 text-xs text-gray-400">预览视频 · 免费</p>
            </div>

            <!-- 完整视频 -->
            <div v-for="vid in fullVideos" :key="vid.id">
              <template v-if="membershipRank >= vid.requiredRank">
                <div class="bg-gray-900 rounded-xl aspect-video flex items-center justify-center relative">
                  <svg class="w-16 h-16 text-white opacity-80" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
                <p class="mt-1 text-xs text-gray-400">完整视频</p>
              </template>
              <template v-else>
                <MediaLock
                  :required-rank="vid.requiredRank"
                  message="完整视频需要更高会员等级"
                />
              </template>
            </div>
          </div>
        </section>
      </main>

      <!-- 右栏 -->
      <aside class="mt-8 lg:mt-0 lg:flex-1 lg:min-w-[220px]">
        <div class="lg:sticky lg:top-24 space-y-4">
          <!-- 会员引导卡 -->
          <div class="overflow-hidden rounded-[1.5rem] border border-[#eadfd2] bg-[#fffbf7] p-5 shadow-sm shadow-orange-950/5">
            <p class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#bfa46a]">Membership</p>
            <h3 class="mt-2 text-base font-semibold text-gray-950">解锁完整内容</h3>
            <p class="mt-2 text-xs leading-5 text-gray-600">成为会员即可查看高清图片、完整图库和受保护内容。</p>
            <NuxtLink
              :to="isLoggedIn ? '/user' : '/login'"
              class="mt-4 block rounded-full bg-gray-950 px-4 py-2.5 text-center text-sm font-medium text-[#d6c39a] transition-all hover:-translate-y-0.5 hover:bg-black"
            >
              {{ isLoggedIn ? '查看会员权益' : '登录 / 注册' }}
            </NuxtLink>
          </div>

          <!-- 相关推荐 -->
          <RelatedGalleries v-if="relatedGalleries.length > 0" :galleries="relatedGalleries" />
        </div>
      </aside>
    </div>

    <!-- 图片查看器 -->
    <ImageViewer
      v-if="viewerOpen"
      :images="viewerImages"
      :start-index="viewerStartIndex"
      @close="viewerOpen = false"
    />
  </div>
</template>
