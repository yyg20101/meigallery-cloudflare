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
  <div class="flex snap-x snap-mandatory gap-3 overflow-x-auto scrollbar-hide lg:overflow-x-visible lg:snap-none">
    <!-- 大图 -->
    <NuxtLink
      v-if="galleries[0]"
      :to="`/gallery/${galleries[0].slug}`"
      class="group relative h-[260px] min-w-[78vw] snap-start overflow-hidden rounded-[1.75rem] bg-gradient-to-br from-[#fff7ed] to-[#e8d5c5] shadow-xl shadow-orange-950/10 ring-1 ring-white/80 transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl hover:shadow-orange-950/15 lg:h-[360px] lg:min-w-0 lg:flex-[2]"
    >
      <img
        v-if="galleries[0].coverUrl"
        :src="galleries[0].coverUrl"
        :alt="galleries[0].title"
        class="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.035]"
      />
      <div class="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
      <div class="absolute left-4 top-4 rounded-full bg-white/18 px-3 py-1 text-[10px] font-medium uppercase tracking-[0.18em] text-white ring-1 ring-white/25 backdrop-blur">Featured</div>
      <div class="absolute inset-x-0 bottom-0 p-5 lg:p-6">
        <p class="max-w-xl text-lg font-semibold tracking-tight text-white lg:text-2xl">{{ galleries[0].title }}</p>
        <p class="mt-2 text-xs text-white/78">{{ galleries[0].tags.map(t => t.name).join(' · ') }}</p>
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
      <div class="absolute inset-x-0 bottom-0 p-4">
        <p class="text-sm font-semibold text-white">{{ galleries[1].title }}</p>
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
      <div class="absolute inset-x-0 bottom-0 p-4">
        <p class="text-sm font-semibold text-white">{{ galleries[2].title }}</p>
      </div>
    </NuxtLink>

    <!-- 右侧两个小图（仅桌面端显示） -->
    <div class="hidden flex-1 flex-col gap-3 lg:flex">
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
        <div class="absolute inset-x-0 bottom-0 p-4">
          <p class="text-sm font-semibold text-white">{{ galleries[1].title }}</p>
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
        <div class="absolute inset-x-0 bottom-0 p-4">
          <p class="text-sm font-semibold text-white">{{ galleries[2].title }}</p>
        </div>
      </NuxtLink>
    </div>
  </div>
</template>
