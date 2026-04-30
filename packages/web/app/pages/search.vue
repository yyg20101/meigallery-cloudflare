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
    },
  }),
  { watch: [keyword, selectedTags, page] },
)

const galleries = computed(() => searchResult.value?.data ?? [])
const total = computed(() => searchResult.value?.total ?? 0)
const totalPages = computed(() => Math.ceil(total.value / 24))

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
    },
  })
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
    <div class="mb-6 max-w-lg">
      <SearchInput v-model="keyword" @search="onSearch" />
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

    <!-- 结果统计 -->
    <p class="mb-4 text-sm text-gray-500">共 {{ total }} 个结果</p>

    <!-- 结果网格 -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      <GalleryCard v-for="g in galleries" :key="g.id" :gallery="g" />
    </div>

    <div v-if="galleries.length === 0" class="py-20 text-center text-gray-400">
      没有找到匹配的图库
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
