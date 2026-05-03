<script setup lang="ts">
interface Gallery {
  id: string
  title: string
  slug: string
  summary: string | null
  coverUrl: string | null
  tags: Array<{ name: string }>
  viewCount?: number
  likeCount?: number
}

defineProps<{
  galleries: Gallery[]
}>()
</script>

<template>
  <!-- 移动端：横向滚动；桌面端：1大2小不对称布局 -->
  <div class="flex snap-x snap-mandatory gap-3 overflow-x-auto scrollbar-hide lg:grid lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)] lg:overflow-x-visible lg:snap-none">
    <!-- 大图 -->
    <NuxtLink
      v-if="galleries[0]"
      :to="`/gallery/${galleries[0].slug}`"
      class="group relative h-[260px] min-w-[78vw] snap-start overflow-hidden rounded-[2rem] bg-gradient-to-br from-[#fff7ed] to-[#e8d5c5] shadow-xl shadow-orange-950/10 ring-1 ring-white/80 transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl hover:shadow-orange-950/15 lg:h-[390px] lg:min-w-0"
    >
      <img
        v-if="galleries[0].coverUrl"
        :src="galleries[0].coverUrl"
        :alt="galleries[0].title"
        class="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.035]"
      />
      <div class="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
      <div class="absolute left-4 top-4 rounded-full bg-black/72 px-3 py-1 text-[10px] font-semibold tracking-[0.18em] text-[#d6c39a] ring-1 ring-[#d6c39a]/40 backdrop-blur">热榜 01</div>
      <div class="absolute inset-x-0 bottom-0 p-5 lg:p-6">
        <p class="max-w-xl text-lg font-semibold tracking-tight text-white lg:text-2xl">{{ galleries[0].title }}</p>
        <p class="mt-2 line-clamp-1 text-xs text-white/78">{{ galleries[0].tags.map(t => t.name).join(' · ') }}</p>
        <GalleryHeatMeta class="mt-3" tone="dark" :view-count="galleries[0].viewCount" :like-count="galleries[0].likeCount" />
      </div>
    </NuxtLink>

    <!-- 第二张（移动端独立卡片，桌面端右侧上） -->
    <NuxtLink
      v-if="galleries[1]"
      :to="`/gallery/${galleries[1].slug}`"
      class="group relative h-[260px] min-w-[78vw] snap-start overflow-hidden rounded-[1.75rem] bg-gradient-to-br from-[#fff7ed] to-gray-100 shadow-lg shadow-orange-950/8 ring-1 ring-white/80 transition-all duration-300 hover:-translate-y-1 lg:hidden lg:min-w-0"
    >
      <img
        v-if="galleries[1].coverUrl"
        :src="galleries[1].coverUrl"
        :alt="galleries[1].title"
        class="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.035]"
      />
      <div class="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent" />
      <div class="absolute left-4 top-4 rounded-full bg-black/72 px-3 py-1 text-[10px] font-semibold tracking-[0.18em] text-[#d6c39a] ring-1 ring-[#d6c39a]/40 backdrop-blur">热榜 02</div>
      <div class="absolute inset-x-0 bottom-0 p-4">
        <p class="line-clamp-1 text-sm font-semibold text-white">{{ galleries[1].title }}</p>
        <GalleryHeatMeta class="mt-3" tone="dark" :view-count="galleries[1].viewCount" :like-count="galleries[1].likeCount" />
      </div>
    </NuxtLink>

    <!-- 第三张（移动端独立卡片，桌面端右侧下） -->
    <NuxtLink
      v-if="galleries[2]"
      :to="`/gallery/${galleries[2].slug}`"
      class="group relative h-[260px] min-w-[78vw] snap-start overflow-hidden rounded-[1.75rem] bg-gradient-to-br from-[#fff7ed] to-gray-100 shadow-lg shadow-orange-950/8 ring-1 ring-white/80 transition-all duration-300 hover:-translate-y-1 lg:hidden lg:min-w-0"
    >
      <img
        v-if="galleries[2].coverUrl"
        :src="galleries[2].coverUrl"
        :alt="galleries[2].title"
        class="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.035]"
      />
      <div class="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent" />
      <div class="absolute left-4 top-4 rounded-full bg-black/72 px-3 py-1 text-[10px] font-semibold tracking-[0.18em] text-[#d6c39a] ring-1 ring-[#d6c39a]/40 backdrop-blur">热榜 03</div>
      <div class="absolute inset-x-0 bottom-0 p-4">
        <p class="line-clamp-1 text-sm font-semibold text-white">{{ galleries[2].title }}</p>
        <GalleryHeatMeta class="mt-3" tone="dark" :view-count="galleries[2].viewCount" :like-count="galleries[2].likeCount" />
      </div>
    </NuxtLink>

    <!-- 右侧两个小图（仅桌面端显示） -->
    <div class="hidden min-w-0 flex-col gap-3 lg:flex">
      <NuxtLink
        v-if="galleries[1]"
        :to="`/gallery/${galleries[1].slug}`"
        class="group relative flex-1 overflow-hidden rounded-[1.5rem] bg-gradient-to-br from-[#fff7ed] to-gray-100 shadow-lg shadow-orange-950/8 ring-1 ring-white/80 transition-all duration-300 hover:-translate-y-1"
      >
        <img
          v-if="galleries[1].coverUrl"
          :src="galleries[1].coverUrl"
          :alt="galleries[1].title"
          class="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
        />
        <div class="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent" />
        <div class="absolute left-3 top-3 rounded-full bg-black/72 px-3 py-1 text-[10px] font-semibold tracking-[0.18em] text-[#d6c39a] ring-1 ring-[#d6c39a]/40 backdrop-blur">热榜 02</div>
        <div class="absolute inset-x-0 bottom-0 p-4">
          <p class="line-clamp-1 text-sm font-semibold text-white">{{ galleries[1].title }}</p>
          <GalleryHeatMeta class="mt-3" tone="dark" :view-count="galleries[1].viewCount" :like-count="galleries[1].likeCount" />
        </div>
      </NuxtLink>

      <NuxtLink
        v-if="galleries[2]"
        :to="`/gallery/${galleries[2].slug}`"
        class="group relative flex-1 overflow-hidden rounded-[1.5rem] bg-gradient-to-br from-[#fff7ed] to-gray-100 shadow-lg shadow-orange-950/8 ring-1 ring-white/80 transition-all duration-300 hover:-translate-y-1"
      >
        <img
          v-if="galleries[2].coverUrl"
          :src="galleries[2].coverUrl"
          :alt="galleries[2].title"
          class="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.04]"
        />
        <div class="absolute inset-0 bg-gradient-to-t from-black/65 via-transparent to-transparent" />
        <div class="absolute left-3 top-3 rounded-full bg-black/72 px-3 py-1 text-[10px] font-semibold tracking-[0.18em] text-[#d6c39a] ring-1 ring-[#d6c39a]/40 backdrop-blur">热榜 03</div>
        <div class="absolute inset-x-0 bottom-0 p-4">
          <p class="line-clamp-1 text-sm font-semibold text-white">{{ galleries[2].title }}</p>
          <GalleryHeatMeta class="mt-3" tone="dark" :view-count="galleries[2].viewCount" :like-count="galleries[2].likeCount" />
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
