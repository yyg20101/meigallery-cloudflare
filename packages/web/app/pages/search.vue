<script setup lang="ts">
const route = useRoute()
const router = useRouter()
const { api } = useApi()
const analytics = useAnalytics()
const { trackSearch, trackFilterSelected } = useFacebookPixel()
const { siteName } = useSiteSettings()

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

const { data: searchResult } = await useAsyncData(
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
const lastTrackedSearchKey = ref('')

function findTagType(slug: string) {
  const groups = tagsData.value?.data || {}
  for (const [type, items] of Object.entries(groups)) {
    if (items.some(tag => tag.slug === slug)) return type
  }
  return 'unknown'
}

function getSearchTrackingKey() {
  return [keyword.value.trim(), selectedTags.value.slice().sort().join(','), sort.value].join('|')
}

watch(searchResult, (result) => {
  if (!result || (!keyword.value.trim() && selectedTags.value.length === 0)) return
  const key = getSearchTrackingKey()
  if (lastTrackedSearchKey.value === key) return
  lastTrackedSearchKey.value = key
  trackSearch({
    searchString: `has_query=${keyword.value.trim() ? 'true' : 'false'} tag_count=${selectedTags.value.length} sort=${sort.value}`,
    resultCount: result.total,
  })
  analytics.track(result.total > 0 ? 'search_results_view' : 'search_no_results', {
    entityType: 'page',
    props: result.total > 0
      ? { result_count: result.total, page: result.page, sort: sort.value }
      : { query_length: keyword.value.trim().length, tag_count: selectedTags.value.length },
  })
}, { immediate: true })

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
  const selected = idx < 0
  if (idx >= 0) {
    selectedTags.value.splice(idx, 1)
  } else {
    selectedTags.value.push(slug)
  }
  page.value = 1
  updateUrl()
  trackFilterSelected({ tagSlug: slug, tagType: findTagType(slug), location: 'search_filter' })
  analytics.track(selected ? 'filter_selected' : 'filter_removed', {
    entityType: 'tag',
    entityId: slug,
    props: {
      tag_slug: slug,
      tag_type: findTagType(slug),
      location: 'search_filter',
    },
  })
}

function clearTags() {
  selectedTags.value = []
  page.value = 1
  updateUrl()
}

function onSearch(val: string) {
  keyword.value = val
  page.value = 1
  analytics.track('search_submit', {
    entityType: 'page',
    props: {
      has_query: Boolean(keyword.value.trim()),
      query_length: keyword.value.trim().length,
      tag_count: selectedTags.value.length,
      sort: sort.value,
    },
  })
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
  trackFilterSelected({ tagSlug: slug, tagType: findTagType(slug), location: 'search_related_tag' })
  analytics.track('filter_selected', {
    entityType: 'tag',
    entityId: slug,
    props: {
      tag_slug: slug,
      tag_type: findTagType(slug),
      location: 'search_related_tag',
    },
  })
  navigateTo({ path: '/discover', query: { tag: slug } })
}

function onSortChanged() {
  const oldSort = String(route.query.sort || 'relevance')
  page.value = 1
  analytics.track('sort_changed', {
    props: {
      old_sort: oldSort,
      new_sort: sort.value,
      location: 'search_results',
    },
  })
  updateUrl()
}

const searchQuery = computed(() => route.query.q as string || '')
useSeoMeta({
  title: () => searchQuery.value ? `搜索: ${searchQuery.value} - ${siteName.value}` : `搜索 - ${siteName.value}`,
  robots: 'noindex',
})
</script>

<template>
  <div class="mx-auto max-w-7xl px-4 py-5 pb-24 sm:px-6 lg:px-8 lg:py-8">
    <section class="mb-6 rounded-[2rem] border border-white/80 bg-[#fffbf7] px-5 py-7 shadow-xl shadow-orange-950/6 lg:px-8">
      <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">Search</p>
      <h1 class="mt-3 text-3xl font-semibold tracking-[-0.05em] text-gray-950 lg:text-5xl">搜索写真、地区和标签</h1>
      <div class="relative mt-6 max-w-3xl">
        <input :value="keyword" type="text" class="w-full rounded-full border border-[#eadfd2] bg-white px-5 py-4 pr-14 text-base text-gray-900 shadow-sm outline-none transition-all placeholder:text-gray-400 focus:border-[#d6c39a] focus:ring-4 focus:ring-[#f8e7dc]/70" placeholder="输入地区、风格、标题关键词..." @input="keyword = ($event.target as HTMLInputElement).value" @keydown.enter="onSearch(keyword)" />
        <button aria-label="搜索" class="absolute right-2 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-gray-950 text-[#d6c39a] transition-all hover:-translate-y-[52%] hover:bg-black" @click="onSearch(keyword)">
          <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
        </button>
      </div>
    </section>

    <div v-if="tagsData?.data" class="mb-6">
      <FilterBar :tags="tagsData.data" :selected-tags="selectedTags" @toggle="toggleTag" @clear="clearTags" />
    </div>

    <div v-if="selectedTags.length > 0 || keyword" class="mb-4 flex flex-wrap items-center gap-2">
      <span class="text-sm text-gray-500">当前筛选：</span>
      <span v-if="keyword" class="rounded-full border border-[#eadfd2] bg-white px-3 py-1 text-xs text-gray-800">关键词：{{ keyword }}</span>
      <span v-for="slug in selectedTags" :key="slug" class="rounded-full border border-[#eadfd2] bg-white px-3 py-1 text-xs text-gray-800">
        {{ slug }}
        <button class="ml-1 text-gray-400 hover:text-gray-700" @click="toggleTag(slug)">&times;</button>
      </span>
    </div>

    <div v-if="relatedTags.length > 0" class="mb-5 flex flex-wrap items-center gap-2">
      <span class="mr-1 text-sm text-gray-500">相关标签：</span>
      <button v-for="tag in relatedTags" :key="tag.id" class="rounded-full border border-transparent bg-[#f8e7dc]/55 px-3 py-1 text-xs text-gray-700 transition-all hover:border-[#e8d5c5] hover:bg-[#fff7ed] hover:text-gray-950" @click="goToTag(tag.slug)">
        {{ tag.name }}
      </button>
    </div>

    <div class="mb-5 flex items-center justify-between gap-3">
      <p class="text-sm text-gray-500">共 {{ total }} 个结果</p>
      <select v-model="sort" class="rounded-full border border-[#eadfd2] bg-white px-3 py-2 text-sm outline-none focus:border-[#d6c39a] focus:ring-4 focus:ring-[#f8e7dc]/70" @change="onSortChanged">
        <option value="relevance">综合</option>
        <option value="newest">最新</option>
        <option value="hot">最热</option>
      </select>
    </div>

    <div v-if="galleries.length > 0" class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 lg:gap-4">
      <GalleryCard v-for="(g, index) in galleries" :key="g.id" :gallery="g" list-type="search_results" :position="index + 1" />
    </div>

    <div v-if="galleries.length === 0" class="rounded-[1.5rem] border border-[#f0e4d8] bg-white/86 py-20 text-center shadow-sm shadow-orange-950/5">
      <svg class="mx-auto mb-4 h-16 w-16 text-[#e8d5c5]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
      <p class="mb-2 text-lg text-gray-600">没有找到相关内容</p>
      <p class="mb-6 text-sm text-gray-400">试试其他关键词或浏览热门标签</p>
      <div class="flex flex-wrap justify-center gap-2">
        <button v-for="tag in popularTags" :key="tag.id" class="rounded-full border border-transparent bg-[#f8e7dc]/55 px-3 py-1 text-xs text-gray-700 transition-all hover:border-[#e8d5c5] hover:bg-[#fff7ed] hover:text-gray-950" @click="goToTag(tag.slug)">
          {{ tag.name }}
        </button>
      </div>
    </div>

    <div v-if="totalPages > 1" class="mt-8 flex justify-center gap-2">
      <button :disabled="page <= 1" class="rounded-full border border-[#eadfd2] bg-white px-4 py-2 text-sm disabled:opacity-50" @click="page--; updateUrl()">上一页</button>
      <span class="px-3 py-2 text-sm text-gray-600">{{ page }} / {{ totalPages }}</span>
      <button :disabled="page >= totalPages" class="rounded-full border border-[#eadfd2] bg-white px-4 py-2 text-sm disabled:opacity-50" @click="page++; updateUrl()">下一页</button>
    </div>
  </div>
</template>
