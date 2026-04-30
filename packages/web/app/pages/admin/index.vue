<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()

const { data: stats } = await useAsyncData('admin-dashboard', () =>
  api<{
    totalGalleries: number
    publishedGalleries: number
    totalUsers: number
    activeVipUsers: number
    processingImports: number
  }>('/api/admin/dashboard'),
)

const statCards = computed(() => [
  { label: '图库总数', value: stats.value?.totalGalleries ?? 0, color: 'text-blue-600' },
  { label: '已发布', value: stats.value?.publishedGalleries ?? 0, color: 'text-green-600' },
  { label: '注册用户', value: stats.value?.totalUsers ?? 0, color: 'text-purple-600' },
  { label: 'VIP 会员', value: stats.value?.activeVipUsers ?? 0, color: 'text-amber-600' },
  { label: '进行中导入', value: stats.value?.processingImports ?? 0, color: 'text-red-600' },
])
</script>

<template>
  <div>
    <h1 class="text-xl font-bold text-gray-900 mb-6">数据概览</h1>
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
      <div v-for="stat in statCards" :key="stat.label" class="rounded-lg bg-white p-4 shadow-sm border border-gray-200">
        <p class="text-sm text-gray-500">{{ stat.label }}</p>
        <p :class="['text-2xl font-bold mt-1', stat.color]">{{ stat.value }}</p>
      </div>
    </div>
  </div>
</template>
