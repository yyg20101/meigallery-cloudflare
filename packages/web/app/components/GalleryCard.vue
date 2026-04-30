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
  if (props.gallery.requiredLevelRank >= 20) return { label: 'SVIP', cls: 'bg-purple-600' }
  if (props.gallery.requiredLevelRank >= 10) return { label: 'VIP', cls: 'bg-amber-500' }
  return null
})
</script>

<template>
  <NuxtLink :to="`/gallery/${gallery.slug}`" class="group block overflow-hidden rounded-lg bg-white shadow-sm hover:shadow-md transition-shadow">
    <div class="aspect-[3/4] overflow-hidden bg-gray-100 relative">
      <img
        v-if="gallery.coverUrl"
        :src="gallery.coverUrl"
        :alt="gallery.title"
        class="h-full w-full object-cover transition-transform group-hover:scale-105"
        loading="lazy"
      />
      <div v-else class="flex h-full items-center justify-center text-gray-400">
        <span class="text-sm">暂无封面</span>
      </div>
      <!-- VIP 角标 -->
      <span v-if="levelBadge" class="absolute top-1.5 right-1.5 z-10 text-white text-[10px] px-1.5 py-0.5 rounded" :class="levelBadge.cls">
        {{ levelBadge.label }}
      </span>
      <!-- 视频角标 -->
      <span v-if="hasVideo" class="absolute top-1.5 z-10 bg-black/50 text-white text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5" :class="levelBadge ? 'left-1.5' : 'right-1.5'">
        ▶ 视频
      </span>
    </div>
    <div class="p-3">
      <h3 class="text-sm font-medium text-gray-900 line-clamp-1">{{ gallery.title }}</h3>
      <div class="mt-1.5 flex flex-wrap gap-1">
        <TagChip v-for="tag in gallery.tags.slice(0, 3)" :key="tag.slug" :tag="tag" size="sm" />
      </div>
    </div>
  </NuxtLink>
</template>
