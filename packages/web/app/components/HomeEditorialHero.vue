<script setup lang="ts">
import { getPrimaryRegion, getSupportTags, type PresentationTag } from '~/utils/galleryPresentation'

interface HeroGallery {
  title: string
  slug: string
  summary: string | null
  coverUrl: string | null
  requiredLevelRank: number
  tags: PresentationTag[]
}

const props = defineProps<{
  title: string
  subtitle: string
  ctaLabel: string
  ctaUrl: string
  gallery: HeroGallery | null
}>()

const region = computed(() => props.gallery ? getPrimaryRegion(props.gallery.tags) : null)
const supportTags = computed(() => props.gallery ? getSupportTags(props.gallery.tags, 3) : [])
</script>

<template>
  <section class="relative overflow-hidden rounded-[2rem] border border-white/80 bg-[#fffbf7] px-5 py-6 shadow-2xl shadow-orange-950/8 ring-1 ring-[#f8e7dc]/80 lg:grid lg:grid-cols-[1.02fr_0.98fr] lg:gap-8 lg:px-8 lg:py-9">
    <div class="absolute -left-24 -top-24 h-72 w-72 rounded-full bg-[#f8e7dc]/80 blur-3xl" />
    <div class="absolute -right-20 top-1/3 h-64 w-64 rounded-full bg-[#fff7ed] blur-3xl" />

    <div class="relative z-10 flex flex-col justify-end">
      <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Selected Portrait Archive</p>
      <h1 class="mt-4 max-w-2xl text-4xl font-semibold leading-[0.95] tracking-[-0.065em] text-gray-950 lg:text-6xl">{{ title }}</h1>
      <p class="mt-5 max-w-xl text-sm leading-7 text-gray-600 lg:text-base">{{ subtitle }}</p>
      <div class="mt-6 flex flex-wrap gap-2">
        <NuxtLink :to="ctaUrl" class="rounded-full bg-gray-950 px-5 py-3 text-sm font-medium text-[#d6c39a] shadow-lg shadow-gray-900/15 transition-all hover:-translate-y-0.5 hover:bg-black">
          {{ ctaLabel }}
        </NuxtLink>
        <NuxtLink v-if="region" :to="`/discover?tag=${region.slug}`" class="rounded-full border border-[#eadfd2] bg-white/80 px-5 py-3 text-sm font-medium text-gray-700 transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:text-gray-950">
          {{ region.name }}精选
        </NuxtLink>
      </div>
    </div>

    <NuxtLink v-if="gallery" :to="`/gallery/${gallery.slug}`" class="group relative z-10 mt-7 block lg:mt-0">
      <div class="relative ml-auto aspect-[4/5] max-h-[34rem] overflow-hidden rounded-[2rem] bg-gradient-to-br from-[#eadfd2] to-[#fff7ed] shadow-[0_32px_90px_rgba(77,48,34,0.22)] ring-1 ring-white/80">
        <img v-if="gallery.coverUrl" :src="gallery.coverUrl" :alt="gallery.title" class="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.035]" />
        <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-gray-950/72 via-gray-950/12 to-transparent p-5 text-white">
          <p v-if="region" class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#d6c39a]">{{ region.name }}</p>
          <h2 class="mt-2 line-clamp-2 text-xl font-semibold tracking-tight">{{ gallery.title }}</h2>
          <div class="mt-3 flex flex-wrap gap-1.5">
            <span v-for="tag in supportTags" :key="tag.slug" class="rounded-full bg-white/16 px-2.5 py-1 text-[10px] text-white/85 ring-1 ring-white/18 backdrop-blur">{{ tag.name }}</span>
          </div>
        </div>
      </div>
    </NuxtLink>
  </section>
</template>
