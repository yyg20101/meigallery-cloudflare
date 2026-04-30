<script setup lang="ts">
interface RelatedGallery {
  id: string
  title: string
  slug: string
  coverUrl: string | null
  tags: Array<{ name: string }>
}
defineProps<{ galleries: RelatedGallery[]; layout?: 'list' | 'grid' }>()
</script>

<template>
  <div>
    <h4 class="font-semibold text-sm mb-3">相关推荐</h4>
    <!-- 网格布局（移动端） -->
    <div v-if="layout === 'grid'" class="grid grid-cols-2 gap-3">
      <NuxtLink
        v-for="g in galleries"
        :key="g.id"
        :to="`/gallery/${g.slug}`"
        class="block rounded-md overflow-hidden bg-gray-100"
      >
        <div class="aspect-[4/3] overflow-hidden">
          <img v-if="g.coverUrl" :src="g.coverUrl" :alt="g.title" class="w-full h-full object-cover" loading="lazy" />
          <div v-else class="w-full h-full flex items-center justify-center text-gray-400 text-xs">暂无封面</div>
        </div>
        <div class="p-2">
          <p class="text-sm font-medium line-clamp-1">{{ g.title }}</p>
          <p class="text-xs text-gray-400 line-clamp-1">{{ g.tags.map(t => t.name).join(' ') }}</p>
        </div>
      </NuxtLink>
    </div>
    <!-- 列表布局（桌面端默认） -->
    <div v-else>
      <NuxtLink
        v-for="g in galleries"
        :key="g.id"
        :to="`/gallery/${g.slug}`"
        class="flex gap-3 items-center mb-3"
      >
        <div class="w-16 h-12 rounded-md bg-gray-200 overflow-hidden flex-shrink-0">
          <img v-if="g.coverUrl" :src="g.coverUrl" :alt="g.title" class="w-full h-full object-cover" loading="lazy" />
        </div>
        <div>
          <p class="text-sm font-medium line-clamp-1">{{ g.title }}</p>
          <p class="text-xs text-gray-400 line-clamp-1">{{ g.tags.map(t => t.name).join(' ') }}</p>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
