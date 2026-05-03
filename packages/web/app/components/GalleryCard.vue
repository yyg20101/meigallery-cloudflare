<script setup lang="ts">
import { computed } from 'vue'
import { getPrimaryRegion, getSupportTags } from '~/utils/galleryPresentation'

interface Gallery {
  id: string
  title: string
  slug: string
  coverUrl: string | null
  tags: Array<{ id?: string; name: string; slug: string; type: string }>
  requiredLevelRank: number
  publishedAt: string | null
  mediaAssets?: Array<{ type: string }>
  viewCount?: number
  likeCount?: number
}
const props = defineProps<{ gallery: Gallery }>()

const hasVideo = computed(() => {
  return props.gallery.tags.some(t => t.type === 'content_type' && t.slug === 'video') ||
    props.gallery.mediaAssets?.some(a => a.type === 'video')
})

const levelBadge = computed(() => {
  if (props.gallery.requiredLevelRank >= 20) return { label: 'SVIP', cls: 'bg-violet-700 text-white ring-violet-200/70' }
  if (props.gallery.requiredLevelRank >= 10) return { label: 'VIP', cls: 'bg-[#111] text-[#d6c39a] ring-[#d6c39a]/50' }
  return null
})

const primaryRegion = computed(() => getPrimaryRegion(props.gallery.tags))
const supportTags = computed(() => getSupportTags(props.gallery.tags, 2))
</script>

<template>
  <NuxtLink :to="`/gallery/${gallery.slug}`" class="group block overflow-hidden rounded-2xl border border-white/70 bg-white/82 shadow-sm shadow-orange-950/5 ring-1 ring-gray-100/80 transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl hover:shadow-orange-950/10 hover:ring-[#e8d5c5]">
    <div class="relative overflow-hidden rounded-b-[1.25rem]">
      <FadeImage
        v-if="gallery.coverUrl"
        :src="gallery.coverUrl"
        :alt="gallery.title"
        aspect-ratio="16/9"
        class="transition-transform duration-500 group-hover:scale-[1.035]"
      />
      <div v-else class="flex aspect-video items-center justify-center bg-gradient-to-br from-orange-50 to-gray-100 text-gray-400">
        <span class="text-sm">暂无封面</span>
      </div>
      <div class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-gray-950/35 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      <!-- VIP 角标 -->
      <span v-if="levelBadge" class="absolute right-2 top-2 z-10 rounded-full px-2 py-0.5 text-[10px] font-semibold shadow-sm ring-1 backdrop-blur" :class="levelBadge.cls">
        {{ levelBadge.label }}
      </span>
      <!-- 视频角标 -->
      <span v-if="hasVideo" class="absolute top-2 z-10 flex items-center gap-1 rounded-full bg-black/65 px-2 py-0.5 text-[10px] text-white shadow-sm backdrop-blur" :class="levelBadge ? 'left-2' : 'right-2'">
        ▶ 视频
      </span>
    </div>
    <div class="p-3.5">
      <p v-if="primaryRegion" class="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#bfa46a]">{{ primaryRegion.name }}</p>
      <h3 class="line-clamp-1 text-[12px] font-semibold tracking-tight text-gray-950 transition-colors group-hover:text-black">{{ gallery.title }}</h3>
      <div class="mt-2 flex flex-wrap gap-1.5">
        <TagChip v-for="tag in supportTags" :key="tag.slug" :tag="tag" size="sm" />
      </div>
      <GalleryHeatMeta class="mt-3" :view-count="gallery.viewCount" :like-count="gallery.likeCount" />
    </div>
  </NuxtLink>
</template>
