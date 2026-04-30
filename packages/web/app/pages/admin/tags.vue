<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const toast = useToast()

interface Tag {
  id: string; type: string; name: string; slug: string; created_at: string; gallery_count: number
}

const tags = ref<Tag[]>([])
const loading = ref(true)

async function fetchTags() {
  try {
    const res = await api<{ data: Tag[] }>('/api/admin/tags')
    tags.value = res.data ?? []
  } finally {
    loading.value = false
  }
}

onMounted(fetchTags)

const typeLabels: Record<string, string> = {
  region_scope: '地区范围', region_group: '地区组', city_country: '城市/国家',
  identity: '身份', personality: '性格', style: '风格', occupation: '职业',
  hair: '发型', clothing: '服饰', scene: '场景', content_type: '内容类型',
}

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
    toast.add({ title: '标签已创建', color: 'success' })
    fetchTags()
  } catch (e: any) {
    createError.value = e?.data?.message || '创建失败'
  }
}

// 编辑
const showEdit = ref(false)
const editForm = reactive({ id: '', name: '', slug: '' })
const editError = ref('')

function startEdit(tag: Tag) {
  editForm.id = tag.id
  editForm.name = tag.name
  editForm.slug = tag.slug
  editError.value = ''
  showEdit.value = true
}

async function saveEdit() {
  editError.value = ''
  if (!editForm.name || !editForm.slug) {
    editError.value = 'name 和 slug 为必填'
    return
  }
  try {
    await api(`/api/admin/tags/${editForm.id}`, { method: 'PUT', body: { name: editForm.name, slug: editForm.slug } })
    showEdit.value = false
    toast.add({ title: '标签已更新', color: 'success' })
    fetchTags()
  } catch (e: any) {
    editError.value = e?.data?.message || '更新失败'
  }
}

// 删除
const showDeleteConfirm = ref(false)
const deleteTargetId = ref('')

function confirmDelete(id: string) {
  deleteTargetId.value = id
  showDeleteConfirm.value = true
}

async function doDelete() {
  await api(`/api/admin/tags/${deleteTargetId.value}`, { method: 'DELETE' })
  showDeleteConfirm.value = false
  toast.add({ title: '标签已删除', color: 'success' })
  fetchTags()
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
          <option v-for="t in tagTypes" :key="t" :value="t">{{ typeLabels[t] || t }}</option>
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
            <td class="px-4 py-3 text-gray-500">{{ typeLabels[tag.type] || tag.type }}</td>
            <td class="px-4 py-3 font-medium">{{ tag.name }}</td>
            <td class="px-4 py-3 font-mono text-gray-500">{{ tag.slug }}</td>
            <td class="px-4 py-3">{{ tag.gallery_count }}</td>
            <td class="px-4 py-3 text-right space-x-2">
              <button class="text-xs text-blue-600 hover:underline" @click="startEdit(tag)">编辑</button>
              <button class="text-xs text-red-600 hover:underline" @click="confirmDelete(tag.id)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 编辑弹窗 -->
    <UModal v-model="showEdit">
      <div class="p-6">
        <h3 class="text-base font-semibold text-gray-900 mb-4">编辑标签</h3>
        <div class="space-y-3">
          <div>
            <label class="block text-sm text-gray-600 mb-1">名称</label>
            <input v-model="editForm.name" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </div>
          <div>
            <label class="block text-sm text-gray-600 mb-1">Slug</label>
            <input v-model="editForm.slug" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono" />
          </div>
          <p v-if="editError" class="text-sm text-red-600">{{ editError }}</p>
          <div class="flex gap-3 pt-2">
            <button class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700" @click="saveEdit">保存</button>
            <button class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50" @click="showEdit = false">取消</button>
          </div>
        </div>
      </div>
    </UModal>

    <!-- 删除确认弹窗 -->
    <UModal v-model="showDeleteConfirm">
      <div class="p-6">
        <h3 class="text-base font-semibold text-gray-900 mb-3">确认删除</h3>
        <p class="text-sm text-gray-600 mb-4">确认删除该标签？此操作不可撤销。</p>
        <div class="flex gap-3">
          <button class="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700" @click="doDelete">确认删除</button>
          <button class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50" @click="showDeleteConfirm = false">取消</button>
        </div>
      </div>
    </UModal>
  </div>
</template>
