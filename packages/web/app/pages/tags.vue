<script setup lang="ts">
const { api } = useApi()

interface TagGroup {
  [type: string]: Array<{ id: string; name: string; slug: string }>
}

const { data: tagsData } = await useAsyncData('all-tags', () =>
  api<{ data: TagGroup }>('/api/tags'),
)

const tagTypeLabels: Record<string, string> = {
  region_scope: '地区范围',
  region_group: '地区组',
  city_country: '城市/国家',
  identity: '身份',
  personality: '性格',
  style: '风格',
  occupation: '职业',
  hair: '发型',
  clothing: '服饰',
  scene: '场景',
  content_type: '内容类型',
}

useSeoMeta({
  title: '标签浏览 - MeiGallery',
  description: '按地区、风格、场景等分类浏览精选图库内容',
})
</script>

<template>
  <div class="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8 pb-20 sm:pb-6">
    <h1 class="text-2xl font-bold text-gray-900 mb-6">标签浏览</h1>

    <div v-if="tagsData?.data" class="space-y-8">
      <section v-for="(items, type) in tagsData.data" :key="type">
        <h2 class="text-base font-semibold text-gray-800 mb-3">{{ tagTypeLabels[type as string] || type }}</h2>
        <div class="flex flex-wrap gap-2">
          <NuxtLink
            v-for="tag in items"
            :key="tag.slug"
            :to="`/search?tag=${tag.slug}`"
            class="rounded-full bg-gray-100 px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 transition-colors"
          >
            {{ tag.name }}
          </NuxtLink>
        </div>
      </section>
    </div>

    <div v-else class="py-20 text-center text-gray-400">加载中...</div>
  </div>
</template>
