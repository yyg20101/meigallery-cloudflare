<script setup lang="ts">
import type { RegionGuideItem } from '~/utils/galleryPresentation'

defineProps<{
  regions: RegionGuideItem[]
  compact?: boolean
}>()
</script>

<template>
  <div class="grid gap-3" :class="compact ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-[1.15fr_repeat(4,minmax(0,1fr))]'">
    <div v-if="!compact" class="relative overflow-hidden rounded-[1.5rem] bg-gray-950 p-5 text-[#d6c39a] shadow-xl shadow-gray-900/10">
      <div class="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-[#d6c39a]/20 blur-3xl" />
      <p class="relative text-[10px] font-semibold uppercase tracking-[0.22em] text-white/55">Region Guide</p>
      <h3 class="relative mt-2 text-lg font-semibold text-white">按地区发现</h3>
      <p class="relative mt-2 text-xs leading-5 text-white/60">从国家、地区组和城市进入精选图库。</p>
    </div>

    <NuxtLink
      v-for="region in regions"
      :key="region.slug"
      :to="{ path: '/discover', query: { tag: region.slug } }"
      class="group relative overflow-hidden rounded-[1.5rem] border border-[#f0e4d8] bg-white/85 p-4 shadow-sm shadow-orange-950/5 transition-all hover:-translate-y-1 hover:border-[#d6c39a] hover:shadow-xl hover:shadow-orange-950/10"
    >
      <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#bfa46a]">{{ region.label }}</span>
      <strong class="mt-2 block text-lg tracking-tight text-gray-950">{{ region.name }}</strong>
      <span class="mt-2 block text-xs leading-5 text-gray-500">{{ region.description }}</span>
      <span class="mt-4 inline-flex text-xs font-medium text-gray-900 underline decoration-[#d6c39a] underline-offset-4">进入地区</span>
    </NuxtLink>
  </div>
</template>
