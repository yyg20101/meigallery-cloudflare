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

withDefaults(defineProps<{
  galleries: Gallery[]
  variant?: 'default' | 'magazine'
}>(), {
  variant: 'default',
})
</script>

<template>
  <div :class="variant === 'magazine' ? 'grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 lg:gap-4' : 'grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4 lg:gap-3'">
    <GalleryCard v-for="g in galleries" :key="g.id" :gallery="g" />
  </div>
</template>
