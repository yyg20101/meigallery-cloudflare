<script setup lang="ts">
interface Gallery {
  id: string
  title: string
  slug: string
  summary: string | null
  coverUrl: string | null
  tags: Array<{ name: string }>
}

defineProps<{
  galleries: Gallery[]
}>()
</script>

<template>
  <!-- 移动端：横向滚动；桌面端：1大2小不对称布局 -->
  <div class="overflow-x-auto flex gap-3 snap-x snap-mandatory scrollbar-hide lg:overflow-x-visible lg:snap-none">
    <!-- 大图 -->
    <NuxtLink
      v-if="galleries[0]"
      :to="`/gallery/${galleries[0].slug}`"
      class="snap-start min-w-[75vw] lg:min-w-0 lg:flex-[2] relative rounded-xl overflow-hidden h-[240px] bg-gradient-to-br from-amber-100 to-amber-200"
    >
      <img
        v-if="galleries[0].coverUrl"
        :src="galleries[0].coverUrl"
        :alt="galleries[0].title"
        class="absolute inset-0 w-full h-full object-cover"
      />
      <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-4">
        <p class="text-white font-semibold">{{ galleries[0].title }}</p>
        <p class="text-xs text-white/80 mt-1">{{ galleries[0].tags.map(t => t.name).join(' · ') }}</p>
      </div>
    </NuxtLink>

    <!-- 第二张（移动端独立卡片，桌面端右侧上） -->
    <NuxtLink
      v-if="galleries[1]"
      :to="`/gallery/${galleries[1].slug}`"
      class="snap-start min-w-[75vw] lg:min-w-0 lg:hidden relative rounded-xl overflow-hidden h-[240px] bg-gradient-to-br from-blue-100 to-blue-200"
    >
      <img
        v-if="galleries[1].coverUrl"
        :src="galleries[1].coverUrl"
        :alt="galleries[1].title"
        class="absolute inset-0 w-full h-full object-cover"
      />
      <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-3">
        <p class="text-white font-semibold text-sm">{{ galleries[1].title }}</p>
      </div>
    </NuxtLink>

    <!-- 第三张（移动端独立卡片，桌面端右侧下） -->
    <NuxtLink
      v-if="galleries[2]"
      :to="`/gallery/${galleries[2].slug}`"
      class="snap-start min-w-[75vw] lg:min-w-0 lg:hidden relative rounded-xl overflow-hidden h-[240px] bg-gradient-to-br from-purple-100 to-purple-200"
    >
      <img
        v-if="galleries[2].coverUrl"
        :src="galleries[2].coverUrl"
        :alt="galleries[2].title"
        class="absolute inset-0 w-full h-full object-cover"
      />
      <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-3">
        <p class="text-white font-semibold text-sm">{{ galleries[2].title }}</p>
      </div>
    </NuxtLink>

    <!-- 右侧两个小图（仅桌面端显示） -->
    <div class="hidden lg:flex flex-1 flex-col gap-3">
      <NuxtLink
        v-if="galleries[1]"
        :to="`/gallery/${galleries[1].slug}`"
        class="flex-1 relative rounded-xl overflow-hidden bg-gradient-to-br from-blue-100 to-blue-200"
      >
        <img
          v-if="galleries[1].coverUrl"
          :src="galleries[1].coverUrl"
          :alt="galleries[1].title"
          class="absolute inset-0 w-full h-full object-cover"
        />
        <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-3">
          <p class="text-white font-semibold text-sm">{{ galleries[1].title }}</p>
        </div>
      </NuxtLink>

      <NuxtLink
        v-if="galleries[2]"
        :to="`/gallery/${galleries[2].slug}`"
        class="flex-1 relative rounded-xl overflow-hidden bg-gradient-to-br from-purple-100 to-purple-200"
      >
        <img
          v-if="galleries[2].coverUrl"
          :src="galleries[2].coverUrl"
          :alt="galleries[2].title"
          class="absolute inset-0 w-full h-full object-cover"
        />
        <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-3">
          <p class="text-white font-semibold text-sm">{{ galleries[2].title }}</p>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
