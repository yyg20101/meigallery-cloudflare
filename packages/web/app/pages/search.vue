<script setup lang="ts">
const route = useRoute()
const router = useRouter()
const { api } = useApi()

interface GallerySummary {
  id: string; title: string; slug: string; summary: string | null
  coverUrl: string | null; requiredLevelRank: number; publishedAt: string | null
  tags: Array<{ id: string; type: string; name: string; slug: string }>
}
interface TagGroup {
  [type: string]: Array<{ id: string; name: string; slug: string }>
}

const keyword = ref((route.query.q as string) || '')
const selectedTags = ref<string[]>(
  (route.query.tag as string)?.split(',').filter(Boolean) || [],
)
const page = ref(parseInt((route.query.page as string) || '1', 10))
const sort = ref((route.query.sort as string) || 'relevance')

// 获取标签供筛选用
const { data: tagsData } = await useAsyncData('search-tags', () =>
  api<{ data: TagGroup }>('/api/tags'),
)

const { data: searchResult, refresh } = await useAsyncData(
  'search-results',
  () => api<{ data: GallerySummary[]; total: number; page: number; pageSize: number }>('/api/search', {
    query: {
      q: keyword.value || undefined,
      tag: selectedTags.value.length > 0 ? selectedTags.value.join(',') : undefined,
      page: String(page.value),
      pageSize: '24',
      sort: sort.value !== 'relevance' ? sort.value : undefined,
    },
  }),
  { watch: [keyword, selectedTags, page, sort] },
)

const galleries = computed(() => searchResult.value?.data ?? [])
const total = computed(() => searchResult.value?.total ?? 0)
const totalPages = computed(() => Math.ceil(total.value / 24))

// 相关标签推荐：根据搜索词匹配
const relatedTags = computed(() => {
  if (!tagsData.value?.data || !keyword.value) return []
  const allTags: Array<{ id: string; name: string; slug: string }> = []
  for (const group of Object.values(tagsData.value.data)) {
    for (const tag of group) {
      if (tag.name.includes(keyword.value) || tag.slug.includes(keyword.value.toLowerCase())) {
        allTags.push(tag)
      }
    }
  }
  return allTags.slice(0, 10)
})

// 热门标签（无结果时展示）
const popularTags = computed(() => {
  if (!tagsData.value?.data) return []
  const allTags: Array<{ id: string; name: string; slug: string }> = []
  for (const group of Object.values(tagsData.value.data)) {
    allTags.push(...group)
  }
  return allTags.slice(0, 12)
})

function toggleTag(slug: string) {
  const idx = selectedTags.value.indexOf(slug)
  if (idx >= 0) {
    selectedTags.value.splice(idx, 1)
  } else {
    selectedTags.value.push(slug)
  }
  page.value = 1
  updateUrl()
}

function clearTags() {
  selectedTags.value = []
  page.value = 1
  updateUrl()
}

function onSearch(val: string) {
  keyword.value = val
  page.value = 1
  updateUrl()
}

function updateUrl() {
  router.replace({
    query: {
      ...(keyword.value ? { q: keyword.value } : {}),
      ...(selectedTags.value.length > 0 ? { tag: selectedTags.value.join(',') } : {}),
      ...(page.value > 1 ? { page: String(page.value) } : {}),
      ...(sort.value !== 'relevance' ? { sort: sort.value } : {}),
    },
  })
}

function goToTag(slug: string) {
  navigateTo('/discover?tag=' + slug)
}

const searchQuery = computed(() => route.query.q as string || '')
useSeoMeta({
  title: () => searchQuery.value ? `搜索: ${searchQuery.value} - MeiGallery` : '搜索 - MeiGallery',
  robots: 'noindex',
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 pb-20 sm:pb-6">
    <!-- 搜索栏 -->
    <div class="mb-6 max-w-2xl mx-auto">
      <div class="relative">
        <input
          :value="keyword"
          type="text"
          class="w-full text-lg py-3 px-5 pr-12 border border-gray-200 rounded-xl focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
          placeholder="搜索写真、标签、关键词..."
          @input="keyword = ($event.target as HTMLInputElement).value"
          @keydown.enter="onSearch(keyword)"
        />
        <button
          class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
          @click="onSearch(keyword)"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 筛选栏 -->
    <div v-if="tagsData?.data" class="mb-6">
      <FilterBar :tags="tagsData.data" :selected-tags="selectedTags" @toggle="toggleTag" @clear="clearTags" />
    </div>

    <!-- 当前筛选条件 -->
    <div v-if="selectedTags.length > 0 || keyword" class="mb-4 flex flex-wrap items-center gap-2">
      <span class="text-sm text-gray-500">当前筛选：</span>
      <span v-if="keyword" class="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
        关键词: {{ keyword }}
      </span>
      <span v-for="slug in selectedTags" :key="slug" class="rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">
        {{ slug }}
        <button class="ml-1" @click="toggleTag(slug)">&times;</button>
      </span>
    </div>

    <!-- 相关标签推荐 -->
    <div v-if="relatedTags.length > 0" class="flex flex-wrap gap-2 mb-4">
      <span class="text-sm text-gray-500 mr-1">相关标签：</span>
      <button
        v-for="tag in relatedTags"
        :key="tag.id"
        class="bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-xs cursor-pointer hover:bg-blue-100 transition-colors"
        @click="goToTag(tag.slug)"
      >
        {{ tag.name }}
      </button>
    </div>

    <!-- 排序 + 结果统计 -->
    <div class="mb-4 flex items-center justify-between">
      <p class="text-sm text-gray-500">共 {{ total }} 个结果</p>
      <div class="flex items-center gap-2 text-sm">
        <span class="text-gray-500">排序：</span>
        <select
          v-model="sort"
          class="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-gray-900"
          @change="page = 1; updateUrl()"
        >
          <option value="relevance">综合</option>
          <option value="newest">最新</option>
          <option value="popular">最热</option>
        </select>
      </div>
    </div>

    <!-- 结果网格 -->
    <div v-if="galleries.length > 0" class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      <GalleryCard v-for="g in galleries" :key="g.id" :gallery="g" />
    </div>

    <!-- 无结果状态 -->
    <div v-if="galleries.length === 0" class="py-20 text-center">
      <svg class="w-16 h-16 mx-auto text-gray-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <p class="text-gray-500 text-lg mb-2">没有找到相关内容</p>
      <p class="text-gray-400 text-sm mb-6">试试其他关键词或浏览热门标签</p>
      <div class="flex flex-wrap justify-center gap-2">
        <button
          v-for="tag in popularTags"
          :key="tag.id"
          class="bg-blue-50 text-blue-700 px-3 py-1 rounded-full text-xs cursor-pointer hover:bg-blue-100 transition-colors"
          @click="goToTag(tag.slug)"
        >
          {{ tag.name }}
        </button>
      </div>
    </div>

    <!-- 分页 -->
    <div v-if="totalPages > 1" class="mt-8 flex justify-center gap-2">
      <button
        :disabled="page <= 1"
        class="rounded px-3 py-1 text-sm border disabled:opacity-50"
        @click="page--; updateUrl()"
      >上一页</button>
      <span class="px-3 py-1 text-sm text-gray-600">{{ page }} / {{ totalPages }}</span>
      <button
        :disabled="page >= totalPages"
        class="rounded px-3 py-1 text-sm border disabled:opacity-50"
        @click="page++; updateUrl()"
      >下一页</button>
    </div>
  </div>
</template>
