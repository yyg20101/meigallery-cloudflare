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
const currentPage = ref(1)

// 从 URL 初始化状态
function syncFromRoute() {
  const q = route.query
  selectedSlugs.value = q.tag ? String(q.tag).split(',').filter(Boolean) : []
  sortBy.value = (['latest', 'hot', 'random'].includes(String(q.sort)) ? String(q.sort) : 'latest') as typeof sortBy.value
  currentPage.value = Number(q.page) || 1
}
syncFromRoute()

// 监听路由变化（浏览器前进后退）
watch(() => route.query, syncFromRoute)

// 同步状态到 URL
function updateQuery() {
  const query: Record<string, string> = {}
  if (selectedSlugs.value.length) query.tag = selectedSlugs.value.join(',')
  if (sortBy.value !== 'latest') query.sort = sortBy.value
  if (currentPage.value > 1) query.page = String(currentPage.value)
  router.push({ path: '/discover', query })
}

function toggleTag(slug: string) {
  const idx = selectedSlugs.value.indexOf(slug)
  if (idx >= 0) {
    selectedSlugs.value.splice(idx, 1)
  } else {
    selectedSlugs.value.push(slug)
  }
  currentPage.value = 1
  updateQuery()
}

function clearTags() {
  selectedSlugs.value = []
  currentPage.value = 1
  updateQuery()
}

function setSort(val: 'latest' | 'hot' | 'random') {
  sortBy.value = val
  currentPage.value = 1
  updateQuery()
}

function goToPage(page: number) {
  currentPage.value = page
  updateQuery()
}

// 数据获取
const { api } = useApi()

const { data: tagsData } = await useAsyncData('discover-tags', () =>
  api<{ data: Record<string, TagInfo[]> }>('/api/tags'),
)

const tags = computed(() => tagsData.value?.data ?? {})

const { data: galleriesData, status } = await useAsyncData(
  'discover-galleries',
  () =>
    api<{ data: GallerySummary[]; total: number }>('/api/galleries', {
      query: {
        pageSize: PAGE_SIZE,
        page: currentPage.value,
        tag: selectedSlugs.value.length ? selectedSlugs.value.join(',') : undefined,
        sort: sortBy.value,
      },
    }),
  { watch: [selectedSlugs, currentPage, sortBy] },
)

const galleries = computed(() => galleriesData.value?.data ?? [])
const total = computed(() => galleriesData.value?.total ?? 0)
const totalPages = computed(() => Math.ceil(total.value / PAGE_SIZE))

// 分页页码列表
const pageNumbers = computed(() => {
  const pages: (number | '...')[] = []
  const tp = totalPages.value
  const cp = currentPage.value
  if (tp <= 7) {
    for (let i = 1; i <= tp; i++) pages.push(i)
  } else {
    pages.push(1)
    if (cp > 3) pages.push('...')
    const start = Math.max(2, cp - 1)
    const end = Math.min(tp - 1, cp + 1)
    for (let i = start; i <= end; i++) pages.push(i)
    if (cp < tp - 2) pages.push('...')
    pages.push(tp)
  }
  return pages
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

    <!-- 加载中 -->
    <div v-if="status === 'pending'" class="py-20 text-center text-gray-400">
      加载中...
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

    <!-- 图库网格 -->
    <template v-else>
      <GalleryGrid :galleries="galleries" />

      <!-- 分页 -->
      <nav v-if="totalPages > 1" class="flex items-center justify-center gap-1 mt-8">
        <button
          v-for="p in pageNumbers"
          :key="p"
          :disabled="p === '...'"
          class="min-w-[36px] h-9 px-2 text-sm rounded-md transition-colors"
          :class="
            p === '...'
              ? 'cursor-default text-gray-400'
              : p === currentPage
                ? 'bg-gray-900 text-white font-medium'
                : 'text-gray-700 hover:bg-gray-100'
          "
          @click="p !== '...' && goToPage(p)"
        >
          {{ p }}
        </button>
        <button
          v-if="currentPage < totalPages"
          class="min-w-[36px] h-9 px-2 text-sm rounded-md text-gray-700 hover:bg-gray-100"
          @click="goToPage(currentPage + 1)"
        >
          →
        </button>
      </nav>
    </template>
  </div>
</template>
