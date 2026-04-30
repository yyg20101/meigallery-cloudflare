<script setup lang="ts">
interface Gallery {
  id: string
  title: string
  slug: string
  summary: string | null
  coverUrl: string | null
  requiredLevelRank: number
  publishedAt: string | null
  tags: Array<{ id: string; type: string; name: string; slug: string }>
}

defineProps<{
  galleries: Gallery[]
}>()
</script>

<template>
  <div class="grid grid-cols-2 gap-2 lg:gap-3 sm:grid-cols-3 lg:grid-cols-4">
    <GalleryCard v-for="g in galleries" :key="g.id" :gallery="g" />
  </div>
</template>
