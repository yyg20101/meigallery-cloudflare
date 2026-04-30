<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const route = useRoute()

const page = ref(parseInt((route.query.page as string) || '1', 10))
const status = ref((route.query.status as string) || '')

interface AdminGallery {
  id: string; title: string; slug: string; status: string
  requiredLevelRank: number; publishedAt: string | null; createdAt: string; updatedAt: string
}

const { data, refresh } = await useAsyncData('admin-galleries', () =>
  api<{ data: AdminGallery[]; total: number; page: number; pageSize: number }>('/api/admin/galleries', {
    query: { page: String(page.value), pageSize: '20', status: status.value || undefined },
  }),
  { watch: [page, status] },
)

const galleries = computed(() => data.value?.data ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.ceil(total.value / 20))

const statusOptions = [
  { label: '全部', value: '' },
  { label: '草稿', value: 'draft' },
  { label: '已发布', value: 'published' },
  { label: '已归档', value: 'archived' },
]

const statusColors: Record<string, string> = {
  draft: 'bg-yellow-100 text-yellow-800',
  published: 'bg-green-100 text-green-800',
  archived: 'bg-gray-100 text-gray-600',
}

async function publishGallery(id: string) {
  await api(`/api/admin/galleries/${id}/publish`, { method: 'POST' })
  refresh()
}

async function unpublishGallery(id: string) {
  await api(`/api/admin/galleries/${id}/unpublish`, { method: 'POST' })
  refresh()
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-xl font-bold text-gray-900">图库管理</h1>
      <NuxtLink to="/admin/galleries/new" class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
        创建图库
      </NuxtLink>
    </div>

    <!-- 筛选 -->
    <div class="mb-4 flex items-center gap-3">
      <select v-model="status" class="rounded-lg border border-gray-300 px-3 py-1.5 text-sm">
        <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
      </select>
    </div>

    <!-- 表格 -->
    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b">
          <tr>
            <th class="px-4 py-3 text-left font-medium text-gray-600">标题</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">状态</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">等级</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">更新时间</th>
            <th class="px-4 py-3 text-right font-medium text-gray-600">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="g in galleries" :key="g.id" class="hover:bg-gray-50">
            <td class="px-4 py-3">
              <NuxtLink :to="`/admin/galleries/${g.id}`" class="text-blue-600 hover:underline">{{ g.title }}</NuxtLink>
            </td>
            <td class="px-4 py-3">
              <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusColors[g.status] || '']">
                {{ g.status }}
              </span>
            </td>
            <td class="px-4 py-3">{{ g.requiredLevelRank }}</td>
            <td class="px-4 py-3 text-gray-500">{{ g.updatedAt?.split('T')[0] }}</td>
            <td class="px-4 py-3 text-right space-x-2">
              <NuxtLink :to="`/admin/galleries/${g.id}`" class="text-xs text-blue-600 hover:underline">编辑</NuxtLink>
              <button v-if="g.status === 'draft'" class="text-xs text-green-600 hover:underline" @click="publishGallery(g.id)">发布</button>
              <button v-if="g.status === 'published'" class="text-xs text-orange-600 hover:underline" @click="unpublishGallery(g.id)">下架</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页 -->
    <div v-if="totalPages > 1" class="mt-4 flex justify-center gap-2">
      <button :disabled="page <= 1" class="rounded px-3 py-1 text-sm border disabled:opacity-50" @click="page--">上一页</button>
      <span class="px-3 py-1 text-sm text-gray-600">{{ page }} / {{ totalPages }}</span>
      <button :disabled="page >= totalPages" class="rounded px-3 py-1 text-sm border disabled:opacity-50" @click="page++">下一页</button>
    </div>
  </div>
</template>
