<script setup lang="ts">
import type { GallerySummary, TagInfo as SharedTagInfo } from '@meigallery/shared'
import { collectRegionGuideItems } from '~/utils/galleryPresentation'

interface GalleryListResponse {
  data: GallerySummary[]
  total: number
  hasMore?: boolean
}

const { siteName } = useSiteSettings()

useSeoMeta({
  title: () => `发现图库 - ${siteName.value}`,
  description: '浏览和筛选精选图库内容',
})

const route = useRoute()
const router = useRouter()
const { trackFilterSelected } = useFacebookPixel()

const PAGE_SIZE = 24

// 响应式状态
const selectedSlugs = ref<string[]>([])
const sortBy = ref<'latest' | 'hot'>('latest')

// 从 URL 初始化状态
function syncFromRoute() {
  const q = route.query
  selectedSlugs.value = q.tag ? String(q.tag).split(',').filter(Boolean) : []
  sortBy.value = (['latest', 'hot'].includes(String(q.sort)) ? String(q.sort) : 'latest') as typeof sortBy.value
}
syncFromRoute()

// 监听路由变化（浏览器前进后退）
watch(() => route.query, () => {
  syncFromRoute()
  resetAndFetch()
})

// 同步状态到 URL（不带 page）
function updateQuery() {
  const query: Record<string, string> = {}
  if (selectedSlugs.value.length) query.tag = selectedSlugs.value.join(',')
  if (sortBy.value !== 'latest') query.sort = sortBy.value
  router.push({ path: '/discover', query })
}

function toggleTag(slug: string) {
  const idx = selectedSlugs.value.indexOf(slug)
  if (idx >= 0) {
    selectedSlugs.value.splice(idx, 1)
  } else {
    selectedSlugs.value.push(slug)
  }
  updateQuery()
  trackFilterSelected({ tagSlug: slug, tagType: findTagType(slug), location: 'discover_filter' })
}

function clearTags() {
  selectedSlugs.value = []
  updateQuery()
}

function setSort(val: 'latest' | 'hot') {
  sortBy.value = val
  updateQuery()
}

// 数据获取
const { api } = useApi()

const { data: tagsData } = await useAsyncData('discover-tags', () =>
  api<{ data: Record<string, SharedTagInfo[]> }>('/api/tags'),
)

const tags = computed(() => tagsData.value?.data ?? {})
const regionGuideItems = computed(() => collectRegionGuideItems(tags.value, [], 4))

function findTagType(slug: string) {
  for (const [type, items] of Object.entries(tags.value)) {
    if (items.some(tag => tag.slug === slug)) return type
  }
  return 'unknown'
}

// 无限滚动状态
const galleries = ref<GallerySummary[]>([])
const total = ref(0)
const currentPage = ref(1)
const isLoading = ref(false)
const isInitialLoading = ref(true)
const hasMoreFromApi = ref<boolean | null>(null)
const hasMore = computed(() => hasMoreFromApi.value ?? galleries.value.length < total.value)

// 首次加载（SSR 兼容）
const { data: initialData } = await useAsyncData(
  'discover-galleries',
  () =>
    api<GalleryListResponse>('/api/galleries', {
      query: {
        pageSize: PAGE_SIZE,
        page: 1,
        tag: selectedSlugs.value.length ? selectedSlugs.value.join(',') : undefined,
        sort: sortBy.value,
      },
    }),
  { watch: [selectedSlugs, sortBy] },
)

watch(initialData, (val) => {
  if (val) {
    galleries.value = val.data
    total.value = val.total
    hasMoreFromApi.value = val.hasMore ?? null
    currentPage.value = 1
    isInitialLoading.value = false
  }
}, { immediate: true })

// 重置并重新加载
function resetAndFetch() {
  currentPage.value = 1
  galleries.value = []
  hasMoreFromApi.value = null
  isInitialLoading.value = true
}

// 加载更多
async function loadMore() {
  if (isLoading.value || !hasMore.value) return
  isLoading.value = true
  try {
    const nextPage = currentPage.value + 1
    const data = await api<GalleryListResponse>('/api/galleries', {
      query: {
        pageSize: PAGE_SIZE,
        page: nextPage,
        tag: selectedSlugs.value.length ? selectedSlugs.value.join(',') : undefined,
        sort: sortBy.value,
      },
    })
    galleries.value.push(...data.data)
    total.value = data.total
    hasMoreFromApi.value = data.hasMore ?? null
    currentPage.value = nextPage
  } finally {
    isLoading.value = false
  }
}

// IntersectionObserver 哨兵
const sentinel = ref<HTMLElement | null>(null)
let observer: IntersectionObserver | null = null

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0]
      if (entry?.isIntersecting && hasMore.value && !isLoading.value) {
        loadMore()
      }
    },
    { rootMargin: '200px' },
  )

  watch(sentinel, (el, oldEl) => {
    if (oldEl) observer?.unobserve(oldEl)
    if (el) observer?.observe(el)
  }, { immediate: true, flush: 'post' })
})

onUnmounted(() => observer?.disconnect())

const sortOptions = [
  { value: 'latest' as const, label: '最新' },
  { value: 'hot' as const, label: '最热' },
]
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-5 pb-24 sm:px-6 lg:px-8 lg:py-8">
    <section class="mb-6 rounded-[2rem] border border-white/80 bg-[#fffbf7] px-5 py-7 shadow-xl shadow-orange-950/6 lg:px-8">
      <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Discover</p>
      <h1 class="mt-3 text-3xl font-semibold tracking-[-0.05em] text-gray-950 lg:text-5xl">按地区和风格发现图库</h1>
      <p class="mt-3 max-w-2xl text-sm leading-7 text-gray-600">地区是浏览主线，标签用于细化人物气质、场景和内容类型。</p>
    </section>

    <section v-if="regionGuideItems.length" class="mb-6">
      <RegionGuide :regions="regionGuideItems" compact />
    </section>

    <div class="sticky top-14 z-10 -mx-4 border-y border-white/70 bg-[#fffbf7]/88 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:top-20 lg:-mx-8 lg:px-8">
      <TagFilterTabs :tags="tags" :selected-slugs="selectedSlugs" @toggle="toggleTag" @clear="clearTags" />
    </div>

    <div class="my-5 flex items-center justify-between gap-3">
      <span class="text-sm text-gray-600">共 {{ total }} 个图库</span>
      <div class="flex items-center gap-1 rounded-full border border-[#f0e4d8] bg-white p-1 shadow-sm">
        <button
          v-for="opt in sortOptions"
          :key="opt.value"
          class="rounded-full px-3 py-1.5 text-sm transition-all"
          :class="sortBy === opt.value ? 'bg-gray-950 text-white shadow-sm' : 'text-gray-600 hover:bg-orange-50 hover:text-gray-950'"
          @click="setSort(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <div v-if="isInitialLoading" class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 lg:gap-4">
      <div v-for="i in 12" :key="i">
        <div class="aspect-[3/4] animate-pulse rounded-[1.25rem] bg-orange-50" />
        <div class="mt-2 h-4 w-3/4 animate-pulse rounded bg-orange-50" />
        <div class="mt-1 flex gap-1">
          <div class="h-4 w-10 animate-pulse rounded-full bg-orange-50" />
          <div class="h-4 w-10 animate-pulse rounded-full bg-orange-50" />
        </div>
      </div>
    </div>

    <div v-else-if="galleries.length === 0" class="rounded-[1.5rem] border border-[#f0e4d8] bg-white/86 py-20 text-center shadow-sm shadow-orange-950/5">
      <p class="mb-4 text-gray-500">没有找到符合条件的图库</p>
      <button
        v-if="selectedSlugs.length"
        class="rounded-full bg-gray-950 px-4 py-2 text-sm text-[#d6c39a] transition-all hover:-translate-y-0.5 hover:bg-black"
        @click="clearTags"
      >
        清除筛选
      </button>
    </div>

    <template v-else>
      <GalleryGrid :galleries="galleries" variant="magazine" />

      <div v-if="isLoading" class="py-8 text-center text-gray-400">
        加载中...
      </div>

      <div v-if="hasMore" ref="sentinel" class="h-px" />

      <div v-if="!hasMore && galleries.length > 0" class="py-8 text-center text-sm text-gray-400">
        已加载全部 {{ total }} 个图库
      </div>
    </template>
  </div>
</template>
