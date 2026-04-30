<script setup lang="ts">
const route = useRoute()
const { api } = useApi()
const { isLoggedIn, membershipRank } = useAuth()

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
  tags: Array<{ id: string; type: string; name: string; slug: string }>
  mediaAssets: Array<{
    id: string
    type: string
    role: string
    sortOrder: number
    requiredRank: number
    thumbnailUrl?: string
  }>
}

const { data: gallery, error } = await useAsyncData(`gallery-${route.params.slug}`, () =>
  api<GalleryDetail>(`/api/galleries/${route.params.slug}`),
)

if (error.value || !gallery.value) {
  throw createError({ statusCode: 404, message: '图库不存在' })
}

const images = computed(() =>
  gallery.value?.mediaAssets.filter(m => m.type === 'image') ?? [],
)
const videos = computed(() =>
  gallery.value?.mediaAssets.filter(m => m.type === 'video') ?? [],
)

const canAccessFull = computed(() => {
  if (!gallery.value) return false
  return membershipRank.value >= gallery.value.requiredLevelRank
})

useSeoMeta({
  title: () => gallery.value ? `${gallery.value.title} - MeiGallery` : 'MeiGallery',
  description: () => gallery.value?.summary || '',
  ogTitle: () => gallery.value?.title || 'MeiGallery',
  ogDescription: () => gallery.value?.summary || '',
  ogType: 'article',
})
</script>

<template>
  <div v-if="gallery" class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 pb-20 sm:pb-6">
    <!-- 标题区 -->
    <header class="mb-6">
      <h1 class="text-2xl font-bold text-gray-900">{{ gallery.title }}</h1>
      <p v-if="gallery.summary" class="mt-2 text-gray-600">{{ gallery.summary }}</p>
      <div class="mt-3 flex flex-wrap items-center gap-2">
        <NuxtLink
          v-for="tag in gallery.tags"
          :key="tag.slug"
          :to="`/search?tag=${tag.slug}`"
        >
          <TagChip :tag="tag" />
        </NuxtLink>
        <MembershipBadge v-if="gallery.requiredLevelRank > 0" :rank="gallery.requiredLevelRank" />
      </div>
      <p class="mt-2 text-xs text-gray-400">{{ gallery.publishedAt?.split('T')[0] }}</p>
    </header>

    <!-- 正文 -->
    <div v-if="gallery.bodyMd" class="prose prose-sm max-w-none mb-8 text-gray-700">
      {{ gallery.bodyMd }}
    </div>

    <!-- 图片区域 -->
    <section v-if="images.length > 0" class="mb-8">
      <h2 class="text-lg font-semibold text-gray-900 mb-4">图片 ({{ images.length }})</h2>
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        <template v-for="img in images" :key="img.id">
          <div v-if="img.requiredRank <= membershipRank || !isLoggedIn && img.requiredRank === 0" class="aspect-[3/4] overflow-hidden rounded-lg bg-gray-100">
            <img
              :src="img.thumbnailUrl"
              :alt="gallery.title"
              class="h-full w-full object-cover"
              loading="lazy"
            />
          </div>
          <MediaLock v-else :required-rank="img.requiredRank" />
        </template>
      </div>
    </section>

    <!-- 视频区域 -->
    <section v-if="videos.length > 0" class="mb-8">
      <h2 class="text-lg font-semibold text-gray-900 mb-4">视频</h2>
      <div class="space-y-4">
        <div v-for="vid in videos" :key="vid.id">
          <div v-if="vid.requiredRank > membershipRank" class="rounded-lg overflow-hidden">
            <MediaLock :required-rank="vid.requiredRank" message="需要更高会员等级观看完整视频" />
          </div>
          <div v-else class="rounded-lg bg-gray-900 aspect-video flex items-center justify-center text-gray-400">
            <!-- 视频播放器占位，实际使用 Stream Player -->
            <span class="text-sm">视频播放器</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 权限提示 -->
    <div v-if="!canAccessFull && gallery.requiredLevelRank > 0" class="rounded-lg bg-blue-50 border border-blue-200 p-4 text-center">
      <p class="text-sm text-blue-800">部分内容需要 <MembershipBadge :rank="gallery.requiredLevelRank" /> 等级才能查看</p>
      <NuxtLink to="/user" class="mt-2 inline-block text-sm text-blue-600 hover:underline">
        {{ isLoggedIn ? '查看会员权益' : '登录后查看更多' }}
      </NuxtLink>
    </div>
  </div>
</template>
