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
  galleries: HeroGallery[]
}>()

const activeIndex = ref(0)
const isPaused = ref(false)
const prefersReducedMotion = ref(false)
const safeCtaUrl = computed(() => {
  const value = props.ctaUrl.trim()
  return value.startsWith('/') && !value.startsWith('//') ? value : '/discover'
})
const visibleGalleries = computed(() => props.galleries.filter(g => Boolean(g.coverUrl)).slice(0, 6))
const activeGallery = computed(() => visibleGalleries.value[activeIndex.value] || visibleGalleries.value[0] || null)
const region = computed(() => activeGallery.value ? getPrimaryRegion(activeGallery.value.tags) : null)
const supportTags = computed(() => activeGallery.value ? getSupportTags(activeGallery.value.tags, 3) : [])
const previewGalleries = computed(() => {
  if (visibleGalleries.value.length <= 1) return []
  return visibleGalleries.value
    .map((gallery, index) => ({ gallery, index }))
    .filter(item => item.index !== activeIndex.value)
    .slice(0, 3)
})

function goToSlide(index: number) {
  activeIndex.value = index
}

function shouldAutoPlay() {
  return visibleGalleries.value.length > 1 && !isPaused.value && !prefersReducedMotion.value
}

function stopCarousel() {
  if (!carouselTimer) return
  clearInterval(carouselTimer)
  carouselTimer = null
}

function startCarousel() {
  if (carouselTimer || !shouldAutoPlay()) return
  carouselTimer = setInterval(nextSlide, 5000)
}

function pauseCarousel() {
  isPaused.value = true
}

function resumeCarousel() {
  isPaused.value = false
}

function handleFocusOut(event: FocusEvent) {
  const nextTarget = event.relatedTarget
  const currentTarget = event.currentTarget
  if (nextTarget instanceof Node && currentTarget instanceof HTMLElement && currentTarget.contains(nextTarget)) return
  resumeCarousel()
}

function nextSlide() {
  if (visibleGalleries.value.length <= 1) return
  activeIndex.value = (activeIndex.value + 1) % visibleGalleries.value.length
}

function prevSlide() {
  if (visibleGalleries.value.length <= 1) return
  activeIndex.value = (activeIndex.value - 1 + visibleGalleries.value.length) % visibleGalleries.value.length
}

watch(visibleGalleries, (items) => {
  if (activeIndex.value >= items.length) activeIndex.value = 0
})

let carouselTimer: ReturnType<typeof setInterval> | null = null
let reducedMotionQuery: MediaQueryList | null = null

function syncCarousel() {
  if (shouldAutoPlay()) startCarousel()
  else stopCarousel()
}

function updateReducedMotionPreference() {
  prefersReducedMotion.value = Boolean(reducedMotionQuery?.matches)
}

watch([visibleGalleries, isPaused, prefersReducedMotion], syncCarousel)

onMounted(() => {
  reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  updateReducedMotionPreference()
  reducedMotionQuery.addEventListener('change', updateReducedMotionPreference)
  syncCarousel()
})
onUnmounted(() => {
  stopCarousel()
  reducedMotionQuery?.removeEventListener('change', updateReducedMotionPreference)
})
</script>

<template>
  <section
    class="relative min-h-[31rem] overflow-hidden rounded-[2rem] border border-white/80 bg-gray-950 shadow-2xl shadow-orange-950/12 ring-1 ring-[#f8e7dc]/80 lg:min-h-[36rem]"
    @mouseenter="pauseCarousel"
    @mouseleave="resumeCarousel"
    @focusin="pauseCarousel"
    @focusout="handleFocusOut"
  >
    <template v-if="activeGallery">
      <img
        v-if="activeGallery.coverUrl"
        :key="activeGallery.slug"
        :src="activeGallery.coverUrl"
        alt=""
        class="absolute inset-0 h-full w-full object-cover opacity-96 transition-transform duration-[1600ms] ease-out motion-safe:animate-[fade-in_0.8s_ease-out]"
      />
      <div v-else class="absolute inset-0 bg-gradient-to-br from-[#f8e7dc] to-[#2b211b]" />
    </template>
    <div class="absolute inset-0 bg-[radial-gradient(circle_at_18%_18%,rgba(255,251,247,0.34),transparent_26%),linear-gradient(90deg,rgba(10,10,10,0.78),rgba(10,10,10,0.42)_46%,rgba(10,10,10,0.12))]" />
    <div class="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-gray-950 via-gray-950/44 to-transparent" />

    <div class="relative z-10 flex min-h-[31rem] flex-col justify-end p-5 lg:min-h-[36rem] lg:p-8">
      <div class="max-w-3xl pb-2 lg:pb-0">
        <p class="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#d6c39a]">Selected Portrait Carousel</p>
        <h1 class="mt-4 max-w-2xl text-4xl font-semibold leading-[0.92] tracking-[-0.07em] text-white drop-shadow-xl lg:text-6xl">{{ title }}</h1>
        <p class="mt-5 max-w-xl text-sm leading-7 text-white/74 lg:text-base">{{ subtitle }}</p>
        <div class="mt-6 flex flex-wrap gap-2">
          <NuxtLink :to="safeCtaUrl" class="rounded-full bg-[#fffbf7] px-5 py-3 text-sm font-medium text-gray-950 shadow-lg shadow-black/20 transition-all hover:-translate-y-0.5 hover:bg-white">
            {{ ctaLabel }}
          </NuxtLink>
          <NuxtLink v-if="region" :to="{ path: '/discover', query: { tag: region.slug } }" class="rounded-full border border-white/18 bg-white/12 px-5 py-3 text-sm font-medium text-white backdrop-blur transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:bg-white/18">
            {{ region.name }}精选
          </NuxtLink>
        </div>
      </div>

      <div v-if="activeGallery" class="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-end">
        <NuxtLink :to="`/gallery/${activeGallery.slug}`" class="group block max-w-2xl rounded-[1.5rem] border border-white/14 bg-black/22 p-4 text-white shadow-2xl shadow-black/20 backdrop-blur-md transition-all hover:-translate-y-0.5 hover:bg-black/30">
          <p v-if="region" class="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#d6c39a]">{{ region.name }}</p>
          <h2 class="mt-2 line-clamp-2 text-2xl font-semibold tracking-[-0.035em] lg:text-3xl">{{ activeGallery.title }}</h2>
          <p v-if="activeGallery.summary" class="mt-2 line-clamp-2 text-sm leading-6 text-white/68">{{ activeGallery.summary }}</p>
          <div class="mt-4 flex flex-wrap gap-1.5">
            <span v-for="tag in supportTags" :key="tag.slug" class="rounded-full bg-white/14 px-2.5 py-1 text-[10px] text-white/84 ring-1 ring-white/18 backdrop-blur">{{ tag.name }}</span>
          </div>
        </NuxtLink>

        <div v-if="previewGalleries.length" class="hidden gap-2 lg:grid lg:grid-cols-3">
          <button
            v-for="item in previewGalleries"
            :key="item.gallery.slug"
            type="button"
            class="group relative h-32 overflow-hidden rounded-[1.25rem] border border-white/18 bg-white/10 text-left shadow-xl shadow-black/20 ring-1 ring-white/8 transition-all hover:-translate-y-1 hover:border-[#d6c39a]"
            @click="goToSlide(item.index)"
          >
            <img v-if="item.gallery.coverUrl" :src="item.gallery.coverUrl" :alt="item.gallery.title" class="h-full w-full object-cover opacity-82 transition-transform duration-500 group-hover:scale-105 group-hover:opacity-100" />
            <span class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 text-[11px] font-medium leading-4 text-white">{{ item.gallery.title }}</span>
          </button>
        </div>
      </div>

      <div v-if="visibleGalleries.length > 1" class="mt-5 flex items-center justify-between gap-4">
        <div class="flex items-center gap-2">
          <button
            v-for="(_, index) in visibleGalleries"
            :key="index"
            type="button"
            class="h-1.5 rounded-full transition-all"
            :class="index === activeIndex ? 'w-8 bg-[#d6c39a]' : 'w-3 bg-white/35 hover:bg-white/60'"
            :aria-label="`切换到第 ${index + 1} 张`"
            :aria-current="index === activeIndex ? 'true' : undefined"
            @click="goToSlide(index)"
          />
        </div>
        <div class="flex gap-2">
          <button type="button" aria-label="上一张" class="flex h-10 w-10 items-center justify-center rounded-full border border-white/18 bg-white/12 text-white backdrop-blur transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:bg-white/18" @click="prevSlide">‹</button>
          <button type="button" aria-label="下一张" class="flex h-10 w-10 items-center justify-center rounded-full border border-white/18 bg-white/12 text-white backdrop-blur transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:bg-white/18" @click="nextSlide">›</button>
        </div>
      </div>
    </div>
  </section>
</template>
