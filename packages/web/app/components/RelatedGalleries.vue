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
    <h4 class="mb-3 text-sm font-semibold text-gray-950">相关推荐</h4>
    <!-- 网格布局（移动端） -->
    <div v-if="layout === 'grid'" class="grid grid-cols-2 gap-3">
      <NuxtLink
        v-for="g in galleries"
        :key="g.id"
        :to="`/gallery/${g.slug}`"
        class="block overflow-hidden rounded-[1.25rem] border border-white/80 bg-[#fffbf7] shadow-sm shadow-orange-950/5"
      >
        <div class="aspect-[4/3] overflow-hidden">
          <img v-if="g.coverUrl" :src="g.coverUrl" :alt="g.title" class="w-full h-full object-cover" loading="lazy" referrerpolicy="no-referrer" />
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
        class="mb-3 flex items-center gap-3 rounded-[1.25rem] border border-white/80 bg-[#fffbf7] p-2 shadow-sm shadow-orange-950/5"
      >
        <div class="w-16 h-12 flex-shrink-0 overflow-hidden rounded-[0.9rem] bg-gray-200">
          <img v-if="g.coverUrl" :src="g.coverUrl" :alt="g.title" class="w-full h-full object-cover" loading="lazy" referrerpolicy="no-referrer" />
        </div>
        <div>
          <p class="text-sm font-medium line-clamp-1">{{ g.title }}</p>
          <p class="text-xs text-gray-400 line-clamp-1">{{ g.tags.map(t => t.name).join(' ') }}</p>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
