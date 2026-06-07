<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { normalizeHomeAdImageUrl, normalizeHomeAdUrl, safeHomeAdText } from '~/utils/siteSettingsSecurity'

interface HomeAdItem {
  id?: string
  eyebrow?: string
  title?: string
  summary?: string
  ctaLabel?: string
  url?: string
  targetUrl?: string
  sponsor?: string
  imageUrl?: string
}

const props = defineProps<{
  enabled: boolean
  ads?: HomeAdItem[]
  eyebrow?: string
  title?: string
  summary?: string
  ctaLabel?: string
  url?: string
  sponsor?: string
  imageUrl?: string
  preview?: boolean
}>()

const externalNoteId = `${useId()}-home-ad-external-note`
const internalNoteId = `${useId()}-home-ad-internal-note`
const activeIndex = ref(0)
const sectionRef = ref<HTMLElement | null>(null)
const adVisible = ref(false)
const analytics = useAnalytics()
let carouselTimer: ReturnType<typeof setInterval> | null = null
let impressionTimer: ReturnType<typeof setTimeout> | null = null
let impressionObserver: IntersectionObserver | null = null
const impressedAdKeys = new Set<string>()

const adItems = computed(() => {
  const source = Array.isArray(props.ads) && props.ads.length > 0
    ? props.ads
    : [{
        id: 'legacy-home-ad',
        eyebrow: props.eyebrow,
        title: props.title,
        summary: props.summary,
        ctaLabel: props.ctaLabel,
        url: props.url,
        sponsor: props.sponsor,
        imageUrl: props.imageUrl,
      }]

  return source.map(normalizeAdItem).filter((item): item is ReturnType<typeof normalizeAdItem> & { title: string } => Boolean(item))
})

const enabled = computed(() => props.enabled && adItems.value.length > 0)
const hasMultipleAds = computed(() => adItems.value.length > 1)
const currentAd = computed(() => adItems.value[activeIndex.value] ?? adItems.value[0])
const safeUrl = computed(() => currentAd.value?.url ?? '/discover?sort=hot')
const isExternalUrl = computed(() => safeUrl.value.startsWith('https://'))
const externalHostname = computed(() => {
  if (!isExternalUrl.value) return ''

  try {
    return new URL(safeUrl.value).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return ''
  }
})
const ctaSecurityLabel = computed(() => isExternalUrl.value ? '外部链接' : '站内推荐')
const internalPathLabel = computed(() => isExternalUrl.value ? '' : safeUrl.value)
const internalDestinationLabel = computed(() => {
  if (isExternalUrl.value) return ''
  return resolveInternalDestinationLabel(safeUrl.value)
})
const noteId = computed(() => isExternalUrl.value ? externalNoteId : internalNoteId)
const ctaAriaLabel = computed(() => {
  if (!currentAd.value) return '查看详情'
  if (isExternalUrl.value) {
    return `${currentAd.value.ctaLabel}，外部链接${externalHostname.value ? `，目标域名 ${externalHostname.value}` : ''}`
  }
  return `${currentAd.value.ctaLabel}，站内推荐，目标页面 ${internalDestinationLabel.value}，路径 ${internalPathLabel.value}`
})

watch(() => adItems.value.length, () => {
  activeIndex.value = 0
  restartCarousel()
  scheduleAdImpression()
})

watch([currentAd, adVisible], () => {
  scheduleAdImpression()
})

onMounted(() => {
  restartCarousel()
  setupImpressionObserver()
})

onUnmounted(() => {
  stopCarousel()
  stopImpressionTracking()
})

function normalizeAdItem(ad: HomeAdItem, index: number) {
  const title = safeHomeAdText('home_ad_title', ad.title) || (index === 0 ? '会员季精选内容' : '')
  const url = normalizeHomeAdUrl(ad.url ?? ad.targetUrl) || '/discover?sort=hot'
  if (!title || !url) return null

  return {
    id: ad.id || `home-ad-${index}`,
    eyebrow: safeHomeAdText('home_ad_eyebrow', ad.eyebrow) || '本周推荐',
    title,
    summary: safeHomeAdText('home_ad_summary', ad.summary) || '探索本周精选图库、真实案例和会员可访问内容。',
    ctaLabel: safeHomeAdText('home_ad_cta_label', ad.ctaLabel) || '查看详情',
    sponsor: safeHomeAdText('home_ad_sponsor', ad.sponsor),
    imageUrl: normalizePreviewableHomeAdImageUrl(ad.imageUrl),
    url,
  }
}

function normalizePreviewableHomeAdImageUrl(value: unknown) {
  const raw = String(value ?? '').trim()
  if (props.preview && raw.startsWith('blob:')) return raw
  return normalizeHomeAdImageUrl(raw)
}

function stopCarousel() {
  if (!carouselTimer) return
  clearInterval(carouselTimer)
  carouselTimer = null
}

function restartCarousel() {
  stopCarousel()
  if (!hasMultipleAds.value || props.preview) return
  carouselTimer = setInterval(() => {
    goToAd((activeIndex.value + 1) % adItems.value.length)
  }, 6200)
}

function goToAd(index: number) {
  const count = adItems.value.length
  if (count <= 0) return
  activeIndex.value = (index + count) % count
}

function setupImpressionObserver() {
  if (props.preview || typeof IntersectionObserver === 'undefined') return
  const el = sectionRef.value
  if (!el) return

  impressionObserver = new IntersectionObserver((entries) => {
    const entry = entries[0]
    adVisible.value = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.5)
    scheduleAdImpression()
  }, { threshold: [0, 0.5, 1] })
  impressionObserver.observe(el)
}

function stopImpressionTracking() {
  impressionObserver?.disconnect()
  impressionObserver = null
  clearImpressionTimer()
}

function clearImpressionTimer() {
  if (!impressionTimer) return
  clearTimeout(impressionTimer)
  impressionTimer = null
}

function scheduleAdImpression() {
  clearImpressionTimer()
  if (props.preview || !adVisible.value || !currentAd.value) return
  const key = `${currentAd.value.id}:${activeIndex.value}`
  if (impressedAdKeys.has(key)) return

  impressionTimer = setTimeout(() => {
    if (!adVisible.value || !currentAd.value || impressedAdKeys.has(key)) return
    impressedAdKeys.add(key)
    analytics.track('home_ad_impression', {
      entityType: 'ad',
      entityId: currentAd.value.id,
      props: {
        ad_id: currentAd.value.id,
        position: activeIndex.value + 1,
        creative_type: currentAd.value.imageUrl ? 'image' : 'text',
      },
    })
  }, 1000)
}

function trackAdClick() {
  if (!currentAd.value) return
  analytics.track('home_ad_click', {
    entityType: 'ad',
    entityId: currentAd.value.id,
    props: {
      ad_id: currentAd.value.id,
      target_type: isExternalUrl.value ? 'external' : 'internal',
      target_path_or_host: isExternalUrl.value ? externalHostname.value : safeUrl.value,
    },
  })
}

function resolveInternalDestinationLabel(url: string) {
  const pathname = new URL(url, 'https://meigallery.local').pathname
  if (pathname === '/') return '首页'
  if (pathname === '/discover') return '探索页'
  if (pathname === '/search') return '搜索页'
  if (pathname === '/gallery' || pathname.startsWith('/gallery/')) return '图库页'
  if (pathname === '/cases' || pathname.startsWith('/cases/')) return '真实案例页'
  if (pathname === '/tags' || pathname.startsWith('/tags/')) return '标签页'
  if (pathname === '/rules') return '规则页'
  if (pathname === '/login') return '登录页'
  if (pathname === '/register') return '注册页'
  if (pathname === '/user') return '个人中心'
  if (pathname === '/settings') return '个人设置'
  if (pathname === '/forgot-password') return '找回密码'
  return '站内页面'
}
</script>

<template>
  <section
    v-if="enabled && currentAd"
    ref="sectionRef"
    aria-label="首页广告推荐"
    class="relative overflow-hidden rounded-[1.5rem] border border-[#eadfd2] bg-[#111111] shadow-[0_24px_70px_rgba(17,24,39,0.18)]"
  >
    <div class="grid min-h-[18rem] lg:grid-cols-[minmax(0,1fr)_minmax(21rem,0.82fr)]">
      <div class="relative z-10 flex min-w-0 flex-col justify-between px-5 py-5 text-white sm:px-7 lg:px-8 lg:py-7">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span class="rounded-full bg-white px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-gray-950">
              推广
            </span>
            <span class="rounded-full border border-[#d6c39a]/55 bg-[#d6c39a]/15 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#f8e7bc]">
              {{ currentAd.eyebrow }}
            </span>
            <span v-if="currentAd.sponsor" class="min-w-0 break-words text-xs text-white/58">{{ currentAd.sponsor }}</span>
          </div>

          <h2 class="mt-5 max-w-3xl break-words text-2xl font-semibold leading-tight tracking-normal text-white sm:text-3xl lg:text-4xl">
            {{ currentAd.title }}
          </h2>
          <p class="mt-3 max-w-2xl break-words text-sm leading-6 text-white/72 line-clamp-3 lg:text-base lg:leading-7">
            {{ currentAd.summary }}
          </p>
        </div>

        <div class="mt-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-for="(ad, index) in adItems"
              :key="ad.id"
              type="button"
              class="h-2.5 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-[#d6c39a] focus:ring-offset-2 focus:ring-offset-gray-950"
              :class="index === activeIndex ? 'w-8 bg-[#d6c39a]' : 'w-2.5 bg-white/35 hover:bg-white/65'"
              :aria-label="`切换到广告：${ad.title}`"
              :aria-current="index === activeIndex ? 'true' : undefined"
              @click="goToAd(index)"
            />
          </div>

          <span
            v-if="preview"
            aria-disabled="true"
            :aria-describedby="noteId"
            :aria-label="ctaAriaLabel"
            class="inline-flex min-h-11 max-w-full shrink-0 cursor-default items-center justify-center gap-2 rounded-full bg-white px-5 py-2.5 text-center text-sm font-semibold leading-tight whitespace-normal break-words text-gray-950 shadow-sm shadow-black/20"
          >
            <span>{{ currentAd.ctaLabel }}</span>
          </span>
          <a
            v-else-if="isExternalUrl"
            :href="safeUrl"
            target="_blank"
            rel="noopener noreferrer nofollow sponsored"
            referrerpolicy="no-referrer"
            :aria-describedby="externalNoteId"
            :aria-label="ctaAriaLabel"
            class="group/cta inline-flex min-h-11 max-w-full shrink-0 items-center justify-center gap-2 rounded-full bg-white px-5 py-2.5 text-center text-sm font-semibold leading-tight whitespace-normal break-words text-gray-950 shadow-sm shadow-black/20 transition-all hover:-translate-y-0.5 hover:bg-[#fff7ed]"
            @click="trackAdClick"
          >
            <span>{{ currentAd.ctaLabel }}</span>
            <svg aria-hidden="true" class="h-3.5 w-3.5 shrink-0 transition-transform group-hover/cta:-translate-y-0.5 group-hover/cta:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M7 17 17 7" />
              <path d="M9 7h8v8" />
            </svg>
          </a>
          <NuxtLink
            v-else
            :to="safeUrl"
            :aria-describedby="internalNoteId"
            :aria-label="ctaAriaLabel"
            class="inline-flex min-h-11 max-w-full shrink-0 items-center justify-center rounded-full bg-white px-5 py-2.5 text-center text-sm font-semibold leading-tight whitespace-normal break-words text-gray-950 shadow-sm shadow-black/20 transition-all hover:-translate-y-0.5 hover:bg-[#fff7ed]"
            @click="trackAdClick"
          >
            {{ currentAd.ctaLabel }}
          </NuxtLink>
        </div>
      </div>

      <div class="relative min-h-[15rem] overflow-hidden border-t border-white/10 lg:border-l lg:border-t-0">
        <img
          v-if="currentAd.imageUrl"
          :src="currentAd.imageUrl"
          :alt="currentAd.title"
          class="h-full min-h-[15rem] w-full object-cover"
          loading="lazy"
          decoding="async"
          referrerpolicy="no-referrer"
        />
        <div v-else class="flex h-full min-h-[15rem] items-center justify-center bg-[linear-gradient(135deg,#2a211a,#111111_52%,#3b3226)] px-8 text-center">
          <div class="max-w-xs">
            <p class="text-xs font-semibold uppercase tracking-[0.28em] text-[#d6c39a]">MeiGallery</p>
            <p class="mt-3 text-2xl font-semibold leading-tight text-white">{{ currentAd.eyebrow }}</p>
            <p class="mt-3 text-xs leading-5 text-white/55">上传广告大图后，这里会展示更强的首页视觉。</p>
          </div>
        </div>
        <div class="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(17,17,17,0.58),transparent_38%,rgba(17,17,17,0.08))]" />
      </div>
    </div>

    <p :id="isExternalUrl ? externalNoteId : internalNoteId" class="relative border-t border-white/10 bg-white/[0.06] px-5 py-2 text-[11px] font-medium break-words text-white/56 lg:px-8">
      {{ ctaSecurityLabel }}
      <span v-if="!isExternalUrl" class="mx-1 text-white/25">/</span>
      <span v-if="!isExternalUrl">目标页面 {{ internalDestinationLabel }}</span>
      <span v-if="isExternalUrl" class="mx-1 text-white/25">/</span>
      <span v-if="isExternalUrl && externalHostname">目标域名 {{ externalHostname }}</span>
      <span v-if="isExternalUrl && externalHostname" class="mx-1 text-white/25">/</span>
      <span v-if="isExternalUrl">不发送来源页信息</span>
    </p>
  </section>
</template>
