<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const router = useRouter()

const galleryId = route.params.id as string

const { data: gallery } = await useAsyncData(`admin-gallery-${galleryId}`, () =>
  api<{
    id: string; title: string; slug: string; summary: string | null; bodyMd: string | null
    status: string; requiredLevelRank: number; tags: Array<{ id: string; name: string }>
  }>(`/api/admin/galleries/${galleryId}`),
)

if (!gallery.value) {
  throw createError({ statusCode: 404, message: '图库不存在' })
}

const form = reactive({
  title: gallery.value.title,
  slug: gallery.value.slug,
  summary: gallery.value.summary || '',
  bodyMd: gallery.value.bodyMd || '',
  requiredLevelRank: gallery.value.requiredLevelRank,
  tagIds: gallery.value.tags.map(t => t.id),
})
const error = ref('')
const loading = ref(false)

const { data: tagsData } = await useAsyncData('admin-all-tags-edit', () =>
  api<{ data: Array<{ id: string; type: string; name: string; slug: string }> }>('/api/admin/tags'),
)

async function onSubmit() {
  error.value = ''
  loading.value = true
  try {
    await api(`/api/admin/galleries/${galleryId}`, {
      method: 'PATCH',
      body: {
        title: form.title,
        slug: form.slug,
        summary: form.summary || undefined,
        bodyMd: form.bodyMd || undefined,
        requiredLevelRank: form.requiredLevelRank,
        tagIds: form.tagIds,
      },
    })
    router.push('/admin/galleries')
  } catch (e: any) {
    error.value = e?.data?.message || '保存失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="max-w-3xl">
    <h1 class="text-xl font-bold text-gray-900 mb-6">编辑图库</h1>

    <form class="space-y-5" @submit.prevent="onSubmit">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">标题</label>
        <input v-model="form.title" type="text" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Slug</label>
        <input v-model="form.slug" type="text" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">摘要</label>
        <textarea v-model="form.summary" rows="2" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">正文 (Markdown)</label>
        <textarea v-model="form.bodyMd" rows="8" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">所需会员等级</label>
        <select v-model.number="form.requiredLevelRank" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option :value="0">免费 (0)</option>
          <option :value="10">VIP (10)</option>
          <option :value="20">SVIP (20)</option>
        </select>
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">标签</label>
        <div class="flex flex-wrap gap-2 max-h-48 overflow-y-auto p-2 border rounded-lg">
          <label v-for="tag in tagsData?.data" :key="tag.id" class="inline-flex items-center gap-1 text-xs">
            <input type="checkbox" :value="tag.id" v-model="form.tagIds" class="rounded" />
            {{ tag.name }}
          </label>
        </div>
      </div>

      <div v-if="error" class="rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ error }}</div>

      <div class="flex gap-3">
        <button type="submit" :disabled="loading" class="rounded-lg bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
          {{ loading ? '保存中...' : '保存' }}
        </button>
        <NuxtLink to="/admin/galleries" class="rounded-lg border px-6 py-2 text-sm text-gray-600 hover:bg-gray-50">取消</NuxtLink>
      </div>
    </form>
  </div>
</template>
