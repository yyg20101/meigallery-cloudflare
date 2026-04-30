<script setup lang="ts">
import type { GallerySummary } from '@meigallery/shared'

interface TagInfo {
  slug: string
  name: string
  count: number
}

useSeoMeta({
  title: '发现图库 - MeiGallery',
  description: '浏览和筛选精选图库内容',
})

const route = useRoute()
const router = useRouter()

const PAGE_SIZE = 24

// 响应式状态
const selectedSlugs = ref<string[]>([])
const sortBy = ref<'latest' | 'hot' | 'random'>('latest')

// 从 URL 初始化状态
function syncFromRoute() {
  const q = route.query
  selectedSlugs.value = q.tag ? String(q.tag).split(',').filter(Boolean) : []
  sortBy.value = (['latest', 'hot', 'random'].includes(String(q.sort)) ? String(q.sort) : 'latest') as typeof sortBy.value
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
}

function clearTags() {
  selectedSlugs.value = []
  updateQuery()
}

function setSort(val: 'latest' | 'hot' | 'random') {
  sortBy.value = val
  updateQuery()
}

// 数据获取
const { api } = useApi()

const { data: tagsData } = await useAsyncData('discover-tags', () =>
  api<{ data: Record<string, TagInfo[]> }>('/api/tags'),
)

const tags = computed(() => tagsData.value?.data ?? {})

// 无限滚动状态
const galleries = ref<GallerySummary[]>([])
const total = ref(0)
const currentPage = ref(1)
const isLoading = ref(false)
const isInitialLoading = ref(true)
const hasMore = computed(() => galleries.value.length < total.value)

// 首次加载（SSR 兼容）
const { data: initialData } = await useAsyncData(
  'discover-galleries',
  () =>
    api<{ data: GallerySummary[]; total: number }>('/api/galleries', {
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
    currentPage.value = 1
    isInitialLoading.value = false
  }
}, { immediate: true })

// 重置并重新加载
function resetAndFetch() {
  currentPage.value = 1
  galleries.value = []
  isInitialLoading.value = true
}

// 加载更多
async function loadMore() {
  if (isLoading.value || !hasMore.value) return
  isLoading.value = true
  try {
    const nextPage = currentPage.value + 1
    const data = await api<{ data: GallerySummary[]; total: number }>('/api/galleries', {
      query: {
        pageSize: PAGE_SIZE,
        page: nextPage,
        tag: selectedSlugs.value.length ? selectedSlugs.value.join(',') : undefined,
        sort: sortBy.value,
      },
    })
    galleries.value.push(...data.data)
    total.value = data.total
    currentPage.value = nextPage
  } finally {
    isLoading.value = false
  }
}

// IntersectionObserver 哨兵
const sentinel = ref<HTMLElement | null>(null)

onMounted(() => {
  if (!sentinel.value) return
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && hasMore.value && !isLoading.value) {
        loadMore()
      }
    },
    { rootMargin: '200px' },
  )
  observer.observe(sentinel.value)
  onUnmounted(() => observer.disconnect())
})

const sortOptions = [
  { value: 'latest' as const, label: '最新' },
  { value: 'hot' as const, label: '最热' },
  { value: 'random' as const, label: '随机' },
]
</script>

<template>
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-20 sm:pb-6">
    <!-- 标签筛选 -->
    <div class="sticky top-0 z-10 bg-white border-b border-gray-200 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 py-4">
      <TagFilterTabs
        :tags="tags"
        :selected-slugs="selectedSlugs"
        @toggle="toggleTag"
        @clear="clearTags"
      />
    </div>

    <!-- 结果统计 + 排序 -->
    <div class="flex items-center justify-between py-4">
      <span class="text-sm text-gray-600">共 {{ total }} 个图库</span>
      <div class="flex items-center gap-1 rounded-lg bg-gray-100 p-1">
        <button
          v-for="opt in sortOptions"
          :key="opt.value"
          class="px-3 py-1 text-sm rounded-md transition-colors"
          :class="sortBy === opt.value ? 'bg-white text-gray-900 shadow-sm font-medium' : 'text-gray-600 hover:text-gray-900'"
          @click="setSort(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <!-- 初始加载中 -->
    <div v-if="isInitialLoading" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 lg:gap-3">
      <div v-for="i in 12" :key="i">
        <div class="aspect-[3/4] bg-gray-200 animate-pulse rounded-md" />
        <div class="mt-2 h-4 w-3/4 bg-gray-200 animate-pulse rounded" />
        <div class="mt-1 flex gap-1">
          <div class="h-4 w-10 bg-gray-200 animate-pulse rounded-full" />
          <div class="h-4 w-10 bg-gray-200 animate-pulse rounded-full" />
        </div>
      </div>
    </div>

    <!-- 空结果 -->
    <div v-else-if="galleries.length === 0" class="py-20 text-center">
      <p class="text-gray-500 mb-4">没有找到符合条件的图库</p>
      <button
        v-if="selectedSlugs.length"
        class="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors"
        @click="clearTags"
      >
        清除筛选
      </button>
    </div>

    <!-- 图库网格 + 无限滚动 -->
    <template v-else>
      <GalleryGrid :galleries="galleries" />

      <!-- 加载更多指示 -->
      <div v-if="isLoading" class="py-8 text-center text-gray-400">
        加载中...
      </div>

      <!-- 无限滚动哨兵 -->
      <div v-if="hasMore" ref="sentinel" class="h-px" />

      <!-- 全部加载完毕 -->
      <div v-if="!hasMore && galleries.length > 0" class="py-8 text-center text-sm text-gray-400">
        已加载全部 {{ total }} 个图库
      </div>
    </template>
  </div>
</template>
