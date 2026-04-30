<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()

// 筛选
const sources = ref<any[]>([])
const filter = reactive({
  sourceId: '',
  status: '',
  reviewStatus: '',
  page: 1,
  pageSize: 20,
})

// 数据
const items = ref<any[]>([])
const total = ref(0)
const loading = ref(false)

async function fetchSources() {
  const res = await api<{ data: any[] }>('/api/admin/legacy-import/sources')
  sources.value = res.data ?? []
}

async function fetchItems() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (filter.sourceId) params.set('sourceId', filter.sourceId)
    if (filter.status) params.set('status', filter.status)
    if (filter.reviewStatus) params.set('reviewStatus', filter.reviewStatus)
    params.set('page', String(filter.page))
    params.set('pageSize', String(filter.pageSize))

    const res = await api<{ data: any[]; total: number }>(`/api/admin/legacy-import/items?${params}`)
    items.value = res.data ?? []
    total.value = res.total ?? 0
  } finally {
    loading.value = false
  }
}

async function review(itemId: string, reviewStatus: 'approved' | 'rejected') {
  await api(`/api/admin/legacy-import/items/${itemId}/review`, {
    method: 'PATCH',
    body: { reviewStatus },
  })
  await fetchItems()
}

function applyFilter() {
  filter.page = 1
  fetchItems()
}

const totalPages = computed(() => Math.ceil(total.value / filter.pageSize) || 1)

const statusOptions = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '等待中' },
  { value: 'imported', label: '已导入' },
  { value: 'failed', label: '失败' },
]

const reviewOptions = [
  { value: '', label: '全部审核' },
  { value: 'pending', label: '待审核' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已拒绝' },
]

const statusColor: Record<string, string> = {
  pending: 'gray',
  imported: 'green',
  failed: 'red',
}

const reviewColor: Record<string, string> = {
  pending: 'yellow',
  approved: 'green',
  rejected: 'red',
}

const statusLabel: Record<string, string> = {
  pending: '等待中',
  imported: '已导入',
  failed: '失败',
}

const reviewLabel: Record<string, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '已拒绝',
}

onMounted(() => {
  fetchSources()
  fetchItems()
})
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-xl font-bold text-gray-900">迁移条目审核</h1>
      <NuxtLink to="/admin/legacy-import" class="text-sm text-blue-600 hover:underline">返回迁移管理</NuxtLink>
    </div>

    <!-- 筛选栏 -->
    <div class="mb-6 flex flex-wrap items-end gap-4 rounded-lg border border-gray-200 bg-white p-4">
      <div>
        <label class="mb-1 block text-sm text-gray-600">来源</label>
        <select v-model="filter.sourceId" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="">全部来源</option>
          <option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option>
        </select>
      </div>
      <div>
        <label class="mb-1 block text-sm text-gray-600">导入状态</label>
        <select v-model="filter.status" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </div>
      <div>
        <label class="mb-1 block text-sm text-gray-600">审核状态</label>
        <select v-model="filter.reviewStatus" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option v-for="opt in reviewOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </div>
      <button class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700" @click="applyFilter">筛选</button>
    </div>

    <!-- 表格 -->
    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table class="w-full text-sm">
        <thead class="border-b bg-gray-50">
          <tr>
            <th class="px-4 py-3 text-left font-medium text-gray-600">标题</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">原始链接</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">导入状态</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">审核状态</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">图库 ID</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-if="loading">
            <td colspan="6" class="px-4 py-8 text-center text-gray-500">加载中...</td>
          </tr>
          <tr v-else-if="items.length === 0">
            <td colspan="6" class="px-4 py-8 text-center text-gray-500">暂无数据</td>
          </tr>
          <tr v-for="item in items" :key="item.id" class="hover:bg-gray-50">
            <td class="px-4 py-3 max-w-[200px] truncate">{{ item.legacyTitle }}</td>
            <td class="px-4 py-3 max-w-[200px] truncate">
              <a :href="item.legacyUrl" target="_blank" class="text-blue-600 hover:underline">{{ item.legacyUrl }}</a>
            </td>
            <td class="px-4 py-3">
              <span :class="`rounded-full px-2 py-0.5 text-xs font-medium bg-${statusColor[item.status] ?? 'gray'}-100 text-${statusColor[item.status] ?? 'gray'}-800`">
                {{ statusLabel[item.status] ?? item.status }}
              </span>
            </td>
            <td class="px-4 py-3">
              <span :class="`rounded-full px-2 py-0.5 text-xs font-medium bg-${reviewColor[item.reviewStatus] ?? 'gray'}-100 text-${reviewColor[item.reviewStatus] ?? 'gray'}-800`">
                {{ reviewLabel[item.reviewStatus] ?? item.reviewStatus }}
              </span>
            </td>
            <td class="px-4 py-3 font-mono text-xs">{{ item.galleryId ?? '-' }}</td>
            <td class="px-4 py-3">
              <div class="flex gap-2">
                <button
                  v-if="item.reviewStatus !== 'approved'"
                  class="rounded-lg bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700"
                  @click="review(item.id, 'approved')"
                >
                  通过
                </button>
                <button
                  v-if="item.reviewStatus !== 'rejected'"
                  class="rounded-lg bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
                  @click="review(item.id, 'rejected')"
                >
                  拒绝
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 分页 -->
    <div class="mt-4 flex items-center justify-between text-sm text-gray-600">
      <span>共 {{ total }} 条，第 {{ filter.page }}/{{ totalPages }} 页</span>
      <div class="flex gap-2">
        <button :disabled="filter.page <= 1" class="rounded-lg border border-gray-300 px-3 py-1 hover:bg-gray-50 disabled:opacity-50" @click="filter.page--; fetchItems()">上一页</button>
        <button :disabled="filter.page >= totalPages" class="rounded-lg border border-gray-300 px-3 py-1 hover:bg-gray-50 disabled:opacity-50" @click="filter.page++; fetchItems()">下一页</button>
      </div>
    </div>
  </div>
</template>
