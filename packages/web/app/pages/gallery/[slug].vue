<script setup lang="ts">
const route = useRoute()
const { api } = useApi()
const { isLoggedIn, membershipRank } = useAuth()


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
    <!-- 面包屑 -->
    <BreadcrumbNav :items="breadcrumbs" class="mb-4" />

    <!-- 双栏布局 -->
    <div class="lg:flex lg:gap-8">
      <!-- 左栏：主内容 -->
      <main class="lg:flex-[3] min-w-0">
        <!-- 封面大图 -->
        <div class="aspect-video rounded-md overflow-hidden bg-gray-100 mb-6">
          <img
            v-if="gallery.coverUrl"
            :src="gallery.coverUrl"
            :alt="gallery.title"
            class="h-full w-full object-cover"
          />
          <div v-else class="h-full w-full bg-gradient-to-br from-gray-200 to-gray-300" />
        </div>

        <!-- 标题区 -->
        <header class="mb-6">
          <h1 class="text-2xl font-bold text-gray-900">{{ gallery.title }}</h1>
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <TagChip v-for="tag in gallery.tags" :key="tag.id" :tag="tag" linkable />
            <MembershipBadge v-if="gallery.requiredLevelRank > 0" :rank="gallery.requiredLevelRank" />
          </div>
          <p class="mt-2 text-xs text-gray-400">
            {{ formattedDate }}
            <span v-if="images.length"> · {{ images.length }}张图片</span>
            <span v-if="videos.length"> · {{ videos.length }}个视频</span>
          </p>
        </header>

        <!-- 摘要 -->
        <p
          v-if="gallery.summary"
          class="text-gray-600 text-sm leading-relaxed border-b border-gray-100 pb-4 mb-6"
        >
          {{ gallery.summary }}
        </p>

        <!-- 公开图片区 -->
        <section v-if="publicImages.length > 0" class="mb-6">
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <div
              v-for="img in publicImages"
              :key="img.id"
              class="aspect-[3/4] rounded-lg overflow-hidden bg-gray-100"
            >
              <img
                :src="img.thumbnailUrl || img.url"
                :alt="gallery.title"
                class="h-full w-full object-cover"
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
        <section v-if="videos.length > 0" class="mb-6">
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
          <div class="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <h3 class="font-semibold text-amber-900 text-sm">解锁全部内容</h3>
            <p class="mt-1 text-xs text-amber-700">成为会员即可查看所有高清图片和完整视频</p>
            <NuxtLink
              :to="isLoggedIn ? '/user' : '/login'"
              class="mt-3 block w-full text-center rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 transition-colors"
            >
              {{ isLoggedIn ? '查看会员权益' : '登录 / 注册' }}
            </NuxtLink>
          </div>

          <!-- 联系站长 -->
          <ContactPanel />

          <!-- 相关推荐 -->
          <RelatedGalleries v-if="relatedGalleries.length > 0" :galleries="relatedGalleries" />
        </div>
      </aside>
    </div>
  </div>
</template>
