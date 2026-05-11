<script setup lang="ts">
interface TestimonialSummary {
  id: string
  title: string
  slug: string
  summary: string | null
  imageCount: number
  coverImageUrl: string | null
  publishedAt: string | null
}

const props = defineProps<{ cases: TestimonialSummary[] }>()

const activeIndex = ref(0)
const isPaused = ref(false)
const prefersReducedMotion = ref(false)
const mobileRail = ref<HTMLElement | null>(null)
const isSyncingMobileRail = ref(false)
const visibleCases = computed(() => props.cases.slice(0, 6))
const activeCase = computed(() => visibleCases.value[activeIndex.value] || visibleCases.value[0] || null)
const previewCases = computed(() => {
  if (visibleCases.value.length <= 1) return []
  return visibleCases.value
    .map((item, index) => ({ item, index }))
    .filter(entry => entry.index !== activeIndex.value)
    .slice(0, 4)
})

let carouselTimer: ReturnType<typeof setInterval> | null = null
let reducedMotionQuery: MediaQueryList | null = null
let mobileRailSyncTimer: ReturnType<typeof setTimeout> | null = null

function goToSlide(index: number) {
  activeIndex.value = index
}

function syncMobileRail() {
  const rail = mobileRail.value
  const target = rail?.children.item(activeIndex.value)
  if (!(target instanceof HTMLElement)) return

  isSyncingMobileRail.value = true
  if (mobileRailSyncTimer) clearTimeout(mobileRailSyncTimer)
  target.scrollIntoView({
    block: 'nearest',
    inline: 'center',
    behavior: prefersReducedMotion.value ? 'auto' : 'smooth',
  })
  mobileRailSyncTimer = setTimeout(() => {
    isSyncingMobileRail.value = false
  }, prefersReducedMotion.value ? 0 : 520)
}

function handleMobileRailScroll() {
  if (isSyncingMobileRail.value) return
  const rail = mobileRail.value
  if (!rail) return

  const railRect = rail.getBoundingClientRect()
  const railCenter = railRect.left + railRect.width / 2
  let closestIndex = activeIndex.value
  let closestDistance = Number.POSITIVE_INFINITY

  Array.from(rail.children).forEach((child, index) => {
    if (!(child instanceof HTMLElement)) return
    const childRect = child.getBoundingClientRect()
    const childCenter = childRect.left + childRect.width / 2
    const distance = Math.abs(childCenter - railCenter)
    if (distance < closestDistance) {
      closestDistance = distance
      closestIndex = index
    }
  })

  if (closestIndex !== activeIndex.value) activeIndex.value = closestIndex
}

function nextSlide() {
  if (visibleCases.value.length <= 1) return
  activeIndex.value = (activeIndex.value + 1) % visibleCases.value.length
}

function prevSlide() {
  if (visibleCases.value.length <= 1) return
  activeIndex.value = (activeIndex.value - 1 + visibleCases.value.length) % visibleCases.value.length
}

function shouldAutoPlay() {
  return visibleCases.value.length > 1 && !isPaused.value && !prefersReducedMotion.value
}

function stopCarousel() {
  if (!carouselTimer) return
  clearInterval(carouselTimer)
  carouselTimer = null
}

function startCarousel() {
  if (carouselTimer || !shouldAutoPlay()) return
  carouselTimer = setInterval(nextSlide, 5200)
}

function syncCarousel() {
  if (shouldAutoPlay()) startCarousel()
  else stopCarousel()
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

function updateReducedMotionPreference() {
  prefersReducedMotion.value = Boolean(reducedMotionQuery?.matches)
}

watch(visibleCases, (items) => {
  if (activeIndex.value >= items.length) activeIndex.value = 0
})
watch([visibleCases, isPaused, prefersReducedMotion], syncCarousel)
watch(activeIndex, () => nextTick(syncMobileRail))

onMounted(() => {
  reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  updateReducedMotionPreference()
  reducedMotionQuery.addEventListener('change', updateReducedMotionPreference)
  syncCarousel()
  nextTick(syncMobileRail)
})

onUnmounted(() => {
  stopCarousel()
  if (mobileRailSyncTimer) clearTimeout(mobileRailSyncTimer)
  reducedMotionQuery?.removeEventListener('change', updateReducedMotionPreference)
})
</script>

<template>
  <section
    class="relative overflow-hidden rounded-[2rem] border border-[#f0e4d8] bg-white p-4 shadow-xl shadow-orange-950/6 lg:p-6"
    @mouseenter="pauseCarousel"
    @mouseleave="resumeCarousel"
    @focusin="pauseCarousel"
    @focusout="handleFocusOut"
  >
    <div class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_6%,rgba(214,195,154,0.18),transparent_32%),linear-gradient(180deg,rgba(255,251,247,0.68),transparent_45%)]" />
    <div class="relative">
    <EditorialSectionHeading eyebrow="Testimonials" title="真实案例" description="展示已授权、已脱敏的用户反馈与站点体验案例。" action-label="查看全部案例" action-to="/testimonials" />
    <div v-if="activeCase" class="mt-5 lg:grid lg:gap-4 lg:items-stretch" :class="visibleCases.length > 1 ? 'lg:grid-cols-[minmax(0,1fr)_18rem]' : ''">
      <div v-if="visibleCases.length > 1" class="lg:hidden">
        <div
          ref="mobileRail"
          data-testid="mobile-testimonial-rail"
          class="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth px-1 pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          @scroll.passive="handleMobileRailScroll"
        >
          <NuxtLink
            v-for="item in visibleCases"
            :key="item.id"
            :to="`/testimonials/${item.slug}`"
            class="group relative h-[20.5rem] w-[82vw] max-w-[22rem] shrink-0 snap-center overflow-hidden rounded-[1.6rem] border border-[#f0e4d8] bg-gray-950 shadow-lg shadow-orange-950/10"
          >
            <img v-if="item.coverImageUrl" :src="item.coverImageUrl" :alt="item.title" class="absolute inset-0 h-full w-full object-cover opacity-95 transition-transform duration-[1200ms] ease-out group-hover:scale-[1.03]" loading="lazy" />
            <div v-else class="absolute inset-0 bg-gradient-to-br from-[#fff7ed] to-[#f8e7dc]" />
            <div class="absolute inset-0 bg-[linear-gradient(180deg,rgba(12,10,8,0.10),rgba(12,10,8,0.20)_40%,rgba(12,10,8,0.86)),radial-gradient(circle_at_18%_16%,rgba(255,251,247,0.26),transparent_30%)]" />
            <div class="absolute left-3 top-3 rounded-full border border-white/20 bg-black/28 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#f0dca7] backdrop-blur">Case · {{ item.imageCount }} 张</div>
            <div class="absolute inset-x-0 bottom-0 p-4 text-white">
              <h3 class="text-2xl font-semibold leading-none tracking-[-0.055em]">{{ item.title }}</h3>
              <p v-if="item.summary" class="mt-2 line-clamp-2 text-xs leading-5 text-white/72">{{ item.summary }}</p>
              <span class="mt-4 inline-flex rounded-full bg-white px-3.5 py-2 text-xs font-medium text-gray-950 transition-all group-hover:-translate-y-0.5">查看案例详情</span>
            </div>
          </NuxtLink>
        </div>
      </div>

      <NuxtLink
        :key="activeCase.id"
        :to="`/testimonials/${activeCase.slug}`"
        class="group relative min-h-[20.5rem] overflow-hidden rounded-[1.75rem] border border-[#f0e4d8] bg-gray-950 shadow-lg shadow-orange-950/10 lg:min-h-[25rem]"
        :class="visibleCases.length > 1 ? 'hidden lg:block' : 'block'"
      >
        <img v-if="activeCase.coverImageUrl" :src="activeCase.coverImageUrl" :alt="activeCase.title" class="absolute inset-0 h-full w-full object-cover opacity-95 transition-transform duration-[1400ms] ease-out motion-safe:animate-[fade-in_0.55s_ease-out] group-hover:scale-[1.03]" loading="lazy" />
        <div v-else class="absolute inset-0 bg-gradient-to-br from-[#fff7ed] to-[#f8e7dc]" />
        <div class="absolute inset-0 bg-[linear-gradient(90deg,rgba(12,10,8,0.78),rgba(12,10,8,0.34)_58%,rgba(12,10,8,0.12)),radial-gradient(circle_at_20%_16%,rgba(255,251,247,0.28),transparent_28%)]" />
        <div class="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/82 via-black/34 to-transparent p-5 text-white sm:p-6">
          <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#d6c39a]">Authorized Case · {{ activeCase.imageCount }} 张图片</p>
          <h3 class="mt-3 max-w-2xl text-3xl font-semibold leading-none tracking-[-0.055em] lg:text-4xl">{{ activeCase.title }}</h3>
          <p v-if="activeCase.summary" class="mt-3 max-w-xl line-clamp-2 text-sm leading-7 text-white/72">{{ activeCase.summary }}</p>
          <span class="mt-5 inline-flex rounded-full bg-white px-4 py-2 text-sm font-medium text-gray-950 transition-all group-hover:-translate-y-0.5">查看案例详情</span>
        </div>
      </NuxtLink>

      <div v-if="visibleCases.length > 1" data-testid="desktop-testimonial-preview-panel" class="hidden flex-col justify-between gap-4 rounded-[1.75rem] border border-[#f0e4d8] bg-[#fffbf7]/92 p-3 shadow-inner shadow-white/70 lg:flex">
        <div v-if="previewCases.length" class="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
          <button
            v-for="entry in previewCases"
            :key="entry.item.id"
            type="button"
            class="group grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 rounded-[1.1rem] border bg-white p-2 text-left shadow-sm shadow-orange-950/5 transition-all hover:-translate-y-0.5 hover:border-[#d6c39a]"
            :class="entry.index === activeIndex ? 'border-[#d6c39a] ring-2 ring-[#d6c39a]/20' : 'border-[#f0e4d8]'"
            @click="goToSlide(entry.index)"
          >
            <div class="aspect-[4/3] overflow-hidden rounded-[0.85rem] bg-orange-50">
              <img v-if="entry.item.coverImageUrl" :src="entry.item.coverImageUrl" :alt="entry.item.title" class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" />
              <div v-else class="h-full bg-gradient-to-br from-[#fff7ed] to-[#f8e7dc]" />
            </div>
            <div class="min-w-0 py-1">
              <p class="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#bfa46a]">{{ entry.item.imageCount }} 张</p>
              <p class="mt-1 line-clamp-2 text-sm font-semibold leading-5 text-gray-950">{{ entry.item.title }}</p>
            </div>
          </button>
        </div>

        <div v-if="visibleCases.length > 1" class="flex items-center justify-between gap-3 px-1 pb-1">
          <div class="flex items-center gap-2">
            <button
              v-for="(_, index) in visibleCases"
              :key="index"
              type="button"
              class="h-1.5 rounded-full transition-all"
              :class="index === activeIndex ? 'w-8 bg-gray-950' : 'w-3 bg-gray-300 hover:bg-gray-500'"
              :aria-label="`切换到第 ${index + 1} 个真实案例`"
              :aria-current="index === activeIndex ? 'true' : undefined"
              @click="goToSlide(index)"
            />
          </div>
          <div class="flex gap-2">
            <button type="button" aria-label="上一个真实案例" class="flex h-9 w-9 items-center justify-center rounded-full border border-[#eadfd2] bg-white text-lg text-gray-950 transition-all hover:-translate-y-0.5 hover:border-[#d6c39a]" @click="prevSlide">‹</button>
            <button type="button" aria-label="下一个真实案例" class="flex h-9 w-9 items-center justify-center rounded-full border border-[#eadfd2] bg-white text-lg text-gray-950 transition-all hover:-translate-y-0.5 hover:border-[#d6c39a]" @click="nextSlide">›</button>
          </div>
        </div>
      </div>

      <div v-if="visibleCases.length > 1" class="mt-3 flex items-center justify-between gap-3 px-1 lg:hidden">
        <div class="flex items-center gap-2">
          <button
            v-for="(_, index) in visibleCases"
            :key="index"
            type="button"
            class="h-1.5 rounded-full transition-all"
            :class="index === activeIndex ? 'w-7 bg-gray-950' : 'w-2.5 bg-gray-300'"
            :aria-label="`切换到第 ${index + 1} 个真实案例`"
            :aria-current="index === activeIndex ? 'true' : undefined"
            @click="goToSlide(index)"
          />
        </div>
        <div class="flex gap-2">
          <button type="button" aria-label="上一个真实案例" class="flex h-9 w-9 items-center justify-center rounded-full border border-[#eadfd2] bg-[#fffbf7] text-lg text-gray-950 transition-all active:scale-95" @click="prevSlide">‹</button>
          <button type="button" aria-label="下一个真实案例" class="flex h-9 w-9 items-center justify-center rounded-full border border-[#eadfd2] bg-gray-950 text-lg text-[#d6c39a] shadow-sm shadow-gray-950/20 transition-all active:scale-95" @click="nextSlide">›</button>
        </div>
      </div>
    </div>
    <div v-else class="mt-5 rounded-[1.5rem] border border-orange-100 bg-[#fffbf7] px-5 py-10 text-center">
      <h3 class="text-lg font-semibold tracking-tight text-gray-950">真实案例整理中</h3>
      <p class="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500">我们正在整理已授权、已脱敏的用户反馈。你可以先浏览最新图库，或联系站长了解会员规则。</p>
      <NuxtLink to="/discover" class="mt-5 inline-flex rounded-full bg-gray-950 px-5 py-2.5 text-sm font-medium text-white transition-all hover:-translate-y-0.5 hover:bg-gray-800">浏览最新图库</NuxtLink>
    </div>
    </div>
  </section>
</template>
