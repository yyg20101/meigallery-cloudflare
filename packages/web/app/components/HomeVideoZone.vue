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
  <div class="overflow-hidden rounded-[1.75rem] bg-[radial-gradient(circle_at_15%_0%,rgba(214,195,154,0.22),transparent_28%),linear-gradient(135deg,#09090b,#18181b)] p-5 shadow-2xl shadow-gray-900/12 ring-1 ring-white/10">
    <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <NuxtLink
        v-for="g in galleries"
        :key="g.id"
        :to="`/gallery/${g.slug}`"
        class="group relative aspect-video overflow-hidden rounded-[1.25rem] bg-gray-800 ring-1 ring-white/10 transition-all duration-300 hover:-translate-y-1 hover:ring-[#d6c39a]/60"
      >
        <img
          v-if="g.coverUrl"
          :src="g.coverUrl"
          :alt="g.title"
          class="absolute inset-0 h-full w-full object-cover opacity-88 transition-transform duration-700 group-hover:scale-[1.04] group-hover:opacity-100"
        />
        <!-- 播放按钮 -->
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="flex h-11 w-11 items-center justify-center rounded-full bg-white/18 shadow-lg ring-1 ring-white/30 backdrop-blur-md transition-transform duration-300 group-hover:scale-110">
            <svg class="ml-0.5 h-4 w-4 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        </div>
        <!-- 底部标题 -->
        <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent p-3">
          <p class="truncate text-sm font-medium text-white">{{ g.title }}</p>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
