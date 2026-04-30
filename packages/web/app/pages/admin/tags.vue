<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()

interface Tag {
  id: string; type: string; name: string; slug: string; created_at: string; gallery_count: number
}

const { data, refresh } = await useAsyncData('admin-tags', () =>
  api<{ data: Tag[] }>('/api/admin/tags'),
)
const tags = computed(() => data.value?.data ?? [])

// 创建表单
const showCreate = ref(false)
const createForm = reactive({ type: 'personality', name: '', slug: '' })
const createError = ref('')

async function createTag() {
  createError.value = ''
  if (!createForm.name || !createForm.slug) {
    createError.value = 'name 和 slug 为必填'
    return
  }
  try {
    await api('/api/admin/tags', { method: 'POST', body: { ...createForm } })
    showCreate.value = false
    createForm.name = ''
    createForm.slug = ''
    refresh()
  } catch (e: any) {
    createError.value = e?.data?.message || '创建失败'
  }
}

async function deleteTag(id: string) {
  if (!confirm('确认删除该标签？')) return
  await api(`/api/admin/tags/${id}`, { method: 'DELETE' })
  refresh()
}

const tagTypes = [
  'region_scope', 'region_group', 'city_country', 'identity',
  'personality', 'style', 'occupation', 'hair', 'clothing', 'scene', 'content_type',
]
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-xl font-bold text-gray-900">标签管理</h1>
      <button class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700" @click="showCreate = !showCreate">
        {{ showCreate ? '取消' : '创建标签' }}
      </button>
    </div>

    <!-- 创建表单 -->
    <div v-if="showCreate" class="mb-6 rounded-lg border border-gray-200 bg-white p-4">
      <div class="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <select v-model="createForm.type" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option v-for="t in tagTypes" :key="t" :value="t">{{ t }}</option>
        </select>
        <input v-model="createForm.name" placeholder="标签名称" class="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input v-model="createForm.slug" placeholder="slug" class="rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
        <button class="rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700" @click="createTag">创建</button>
      </div>
      <p v-if="createError" class="mt-2 text-sm text-red-600">{{ createError }}</p>
    </div>

    <!-- 表格 -->
    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b">
          <tr>
            <th class="px-4 py-3 text-left font-medium text-gray-600">类型</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">名称</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">Slug</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">关联图库</th>
            <th class="px-4 py-3 text-right font-medium text-gray-600">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="tag in tags" :key="tag.id" class="hover:bg-gray-50">
            <td class="px-4 py-3 text-gray-500">{{ tag.type }}</td>
            <td class="px-4 py-3 font-medium">{{ tag.name }}</td>
            <td class="px-4 py-3 font-mono text-gray-500">{{ tag.slug }}</td>
            <td class="px-4 py-3">{{ tag.gallery_count }}</td>
            <td class="px-4 py-3 text-right">
              <button class="text-xs text-red-600 hover:underline" @click="deleteTag(tag.id)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
