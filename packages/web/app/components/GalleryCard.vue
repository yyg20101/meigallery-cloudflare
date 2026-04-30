<script setup lang="ts">
import { computed } from 'vue'

interface Gallery {
  id: string
  title: string
  slug: string
  coverUrl: string | null
  tags: Array<{ name: string; slug: string; type?: string }>
  requiredLevelRank: number
  publishedAt: string | null
  mediaAssets?: Array<{ type: string }>
}
const props = defineProps<{ gallery: Gallery }>()

const hasVideo = computed(() => {
  return props.gallery.tags.some(t => t.type === 'content_type' && t.slug === 'video') ||
    props.gallery.mediaAssets?.some(a => a.type === 'video')
})

const levelBadge = computed(() => {
  if (props.gallery.requiredLevelRank >= 20) return { label: 'SVIP', cls: 'bg-violet-600' }
  if (props.gallery.requiredLevelRank >= 10) return { label: 'VIP', cls: 'bg-amber-500' }
  return null
})
</script>

<template>
  <NuxtLink :to="`/gallery/${gallery.slug}`" class="group block overflow-hidden rounded-md bg-white shadow-sm transition-all duration-200 hover:-translate-y-[2px] hover:shadow-lg">
    <div class="relative overflow-hidden">
      <LazyImage
        v-if="gallery.coverUrl"
        :src="gallery.coverUrl"
        :alt="gallery.title"
        aspect-ratio="16/9"
        class="transition-transform group-hover:scale-105"
      />
      <div v-else class="flex aspect-video items-center justify-center bg-gray-100 text-gray-400">
        <span class="text-sm">暂无封面</span>
      </div>
      <!-- VIP 角标 -->
      <span v-if="levelBadge" class="absolute top-1.5 right-1.5 z-10 text-white text-[10px] px-1.5 py-0.5 rounded" :class="levelBadge.cls">
        {{ levelBadge.label }}
      </span>
      <!-- 视频角标 -->
      <span v-if="hasVideo" class="absolute top-1.5 z-10 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5" :class="levelBadge ? 'left-1.5' : 'right-1.5'">
        ▶ 视频
      </span>
    </div>
    <div class="p-3">
      <h3 class="text-[12px] font-medium text-gray-900 line-clamp-1">{{ gallery.title }}</h3>
      <div class="mt-1.5 flex flex-wrap gap-1">
        <TagChip v-for="tag in gallery.tags.slice(0, 3)" :key="tag.slug" :tag="tag" size="sm" />
      </div>
    </div>
  </NuxtLink>
</template>
