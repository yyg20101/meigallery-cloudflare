<script setup lang="ts">
interface Gallery {
  id: string
  title: string
  slug: string
  coverUrl: string | null
}

defineProps<{
  galleries: Gallery[]
}>()
</script>

<template>
  <div class="bg-gray-900 rounded-xl p-4">
    <div class="flex justify-between items-center mb-3">
      <span class="text-white font-semibold">视频专区</span>
      <NuxtLink to="/videos" class="text-gray-400 text-xs">查看全部 →</NuxtLink>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      <NuxtLink
        v-for="g in galleries"
        :key="g.id"
        :to="`/gallery/${g.slug}`"
        class="relative rounded-lg overflow-hidden aspect-video bg-gray-800 group"
      >
        <img
          v-if="g.coverUrl"
          :src="g.coverUrl"
          :alt="g.title"
          class="absolute inset-0 w-full h-full object-cover"
        />
        <!-- 播放按钮 -->
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-10 h-10 rounded-full bg-white/30 flex items-center justify-center backdrop-blur-sm">
            <svg class="w-4 h-4 text-white ml-0.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
        <!-- 底部标题 -->
        <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-2">
          <p class="text-white text-sm truncate">{{ g.title }}</p>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
