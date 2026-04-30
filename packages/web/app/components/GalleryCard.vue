<script setup lang="ts">
interface Gallery {
  id: string
  title: string
  slug: string
  coverUrl: string | null
  tags: Array<{ name: string; slug: string; type?: string }>
  requiredLevelRank: number
  publishedAt: string | null
}
defineProps<{ gallery: Gallery }>()
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
      <MembershipBadge v-if="gallery.requiredLevelRank > 0" :rank="gallery.requiredLevelRank" class="absolute top-2 right-2" />
    </div>
    <div class="p-3">
      <h3 class="text-sm font-medium text-gray-900 line-clamp-1">{{ gallery.title }}</h3>
      <div class="mt-1.5 flex flex-wrap gap-1">
        <TagChip v-for="tag in gallery.tags.slice(0, 3)" :key="tag.slug" :tag="tag" size="sm" />
      </div>
    </div>
  </NuxtLink>
</template>
