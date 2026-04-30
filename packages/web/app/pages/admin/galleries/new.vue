<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const router = useRouter()
const { isOwner } = useAuth()

const form = reactive({
  title: '',
  slug: '',
  summary: '',
  bodyMd: '',
  requiredLevelRank: 0,
  tagIds: [] as string[],
  status: 'draft',
})
const error = ref('')
const loading = ref(false)

// 获取标签供选择
const { data: tagsData } = await useAsyncData('admin-all-tags', () =>
  api<{ data: Array<{ id: string; type: string; name: string; slug: string; gallery_count: number }> }>('/api/admin/tags'),
)

// 自动生成 slug
watch(() => form.title, (val) => {
  if (!form.slug || form.slug === slugify(form.title)) {
    form.slug = slugify(val)
  }
})

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '').slice(0, 100)
}

async function onSubmit() {
  error.value = ''
  if (!form.title || !form.slug) {
    error.value = '标题和 slug 为必填'
    return
  }
  loading.value = true
  try {
    const result = await api<{ id: string }>('/api/admin/galleries', {
      method: 'POST',
      body: {
        title: form.title,
        slug: form.slug,
        summary: form.summary || undefined,
        bodyMd: form.bodyMd || undefined,
        requiredLevelRank: form.requiredLevelRank,
        tagIds: form.tagIds.length > 0 ? form.tagIds : undefined,
        status: isOwner.value ? form.status : 'draft',
      },
    })
    router.push(`/admin/galleries/${result.id}`)
  } catch (e: any) {
    error.value = e?.data?.message || '创建失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="max-w-3xl">
    <h1 class="text-xl font-bold text-gray-900 mb-6">创建图库</h1>

    <form class="space-y-5" @submit.prevent="onSubmit">
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">标题 *</label>
        <input v-model="form.title" type="text" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </div>
      <div>
        <label class="block text-sm font-medium text-gray-700 mb-1">Slug *</label>
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
        <label class="block text-sm font-medium text-gray-700 mb-1">所需会员等级 (rank)</label>
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
      <div v-if="isOwner">
        <label class="block text-sm font-medium text-gray-700 mb-1">状态</label>
        <select v-model="form.status" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="draft">草稿</option>
          <option value="published">直接发布</option>
        </select>
      </div>

      <div v-if="error" class="rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ error }}</div>

      <button type="submit" :disabled="loading" class="rounded-lg bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50">
        {{ loading ? '创建中...' : '创建图库' }}
      </button>
    </form>
  </div>
</template>
