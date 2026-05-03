<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()

interface DashboardStats {
  totalGalleries: number
  publishedGalleries: number
  totalUsers: number
  activeVipUsers: number
  processingImports: number
  draftGalleries?: number
  failedImports?: number
}

interface GalleryItem {
  id: string
  title: string
  slug: string
  status: string
  cover_key: string | null
  created_at: string
}

const stats = ref<DashboardStats | null>(null)
const recentGalleries = ref<GalleryItem[]>([])
const loading = ref(true)

onMounted(async () => {
  try {
    const [dashData, galData] = await Promise.all([
      api<DashboardStats>('/api/admin/dashboard'),
      api<{ data: GalleryItem[] }>('/api/admin/galleries', { query: { pageSize: '5', sort: 'newest' } }),
    ])
    stats.value = dashData
    recentGalleries.value = galData.data ?? []
  } catch {
    // ignore
  } finally {
    loading.value = false
  }
})

const statCards = computed(() => {
  if (!stats.value) return []
  return [
    { label: '图库总数', value: stats.value.totalGalleries, color: 'text-blue-600' },
    { label: '已发布', value: stats.value.publishedGalleries, color: 'text-green-600' },
    { label: '注册用户', value: stats.value.totalUsers, color: 'text-purple-600' },
    { label: 'VIP 会员', value: stats.value.activeVipUsers, color: 'text-amber-600' },
    { label: '进行中导入', value: stats.value.processingImports, color: 'text-red-600' },
  ]
})

const draftCount = computed(() => {
  if (!stats.value) return 0
  if (stats.value.draftGalleries !== undefined) return stats.value.draftGalleries
  return stats.value.totalGalleries - stats.value.publishedGalleries
})

const failedImportCount = computed(() => stats.value?.failedImports ?? 0)

const hasPending = computed(() => draftCount.value > 0 || failedImportCount.value > 0)

function formatDate(d: string) {
  return d?.replace('T', ' ').substring(0, 16) ?? '-'
}

const statusLabels: Record<string, { text: string; cls: string }> = {
  published: { text: '已发布', cls: 'bg-green-100 text-green-800' },
  draft: { text: '草稿', cls: 'bg-yellow-100 text-yellow-800' },
  archived: { text: '已归档', cls: 'bg-gray-100 text-gray-600' },
}
</script>

<template>
  <div>
    <h1 class="text-xl font-bold text-gray-900 mb-6">数据概览</h1>

    <div v-if="loading" class="text-sm text-gray-500">加载中...</div>

    <template v-else>
      <!-- 统计卡片 -->
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <div v-for="stat in statCards" :key="stat.label" class="rounded-lg bg-white p-4 shadow-sm border border-gray-200">
          <p class="text-sm text-gray-500">{{ stat.label }}</p>
          <p :class="['text-2xl font-bold mt-1', stat.color]">{{ stat.value }}</p>
        </div>
      </div>

      <!-- 待处理事项 -->
      <div class="mt-6 rounded-lg bg-white p-5 border border-gray-200">
        <h2 class="text-base font-semibold text-gray-900 mb-3">待处理事项</h2>
        <div v-if="hasPending" class="space-y-2">
          <NuxtLink v-if="draftCount > 0" to="/admin/galleries?status=draft" class="block text-sm text-amber-700 hover:underline">
            有 {{ draftCount }} 个草稿待发布
          </NuxtLink>
          <NuxtLink v-if="failedImportCount > 0" to="/admin/import" class="block text-sm text-red-700 hover:underline">
            有 {{ failedImportCount }} 个导入任务失败
          </NuxtLink>
        </div>
        <p v-else class="text-sm text-gray-400">暂无待处理事项</p>
      </div>

      <!-- 最近图库 -->
      <div class="mt-6 rounded-lg bg-white border border-gray-200 overflow-hidden">
        <div class="px-5 py-3 border-b border-gray-100">
          <h2 class="text-base font-semibold text-gray-900">最近图库</h2>
        </div>
        <table v-if="recentGalleries.length > 0" class="w-full text-sm">
          <thead class="bg-gray-50 border-b">
            <tr>
              <th class="px-4 py-2 text-left font-medium text-gray-600">封面</th>
              <th class="px-4 py-2 text-left font-medium text-gray-600">标题</th>
              <th class="px-4 py-2 text-left font-medium text-gray-600">状态</th>
              <th class="px-4 py-2 text-left font-medium text-gray-600">创建时间</th>
              <th class="px-4 py-2 text-right font-medium text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr v-for="g in recentGalleries" :key="g.id" class="hover:bg-gray-50">
              <td class="px-4 py-2">
                <div class="w-10 h-10 rounded bg-gray-200 overflow-hidden">
                  <img v-if="g.cover_key" :src="`/api/media/cover/${g.id}`" class="w-full h-full object-cover" />
                </div>
              </td>
              <td class="px-4 py-2 font-medium">{{ g.title }}</td>
              <td class="px-4 py-2">
                <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusLabels[g.status]?.cls || 'bg-gray-100 text-gray-600']">
                  {{ statusLabels[g.status]?.text || g.status }}
                </span>
              </td>
              <td class="px-4 py-2 text-gray-500">{{ formatDate(g.created_at) }}</td>
              <td class="px-4 py-2 text-right">
                <NuxtLink :to="`/admin/galleries/${g.id}`" class="text-xs text-blue-600 hover:underline">编辑</NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="px-5 py-4 text-sm text-gray-400">暂无图库</p>
      </div>
    </template>
  </div>
</template>
