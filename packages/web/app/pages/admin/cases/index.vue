<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { data } = await useAsyncData('admin-cases', () =>
  api<{ data: Array<{ id: string; title: string; slug: string; status: string; featured: boolean; sortOrder: number; imageCount: number; updatedAt: string }> }>('/api/admin/cases'),
)
</script>

<template>
  <div>
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-xl font-bold text-gray-900">真实案例</h1>
      <NuxtLink to="/admin/cases/new" class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">新建案例</NuxtLink>
    </div>

    <div class="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div v-if="!data?.data.length" class="px-6 py-12 text-center">
        <h2 class="text-base font-semibold text-gray-900">还没有真实案例</h2>
        <p class="mt-2 text-sm text-gray-500">发布前需上传 2-9 张已授权、已脱敏图片。</p>
        <NuxtLink to="/admin/cases/new" class="mt-5 inline-flex rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">新建案例</NuxtLink>
      </div>
      <table v-else class="min-w-full divide-y divide-gray-200 text-sm">
        <thead class="bg-gray-50 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
          <tr><th class="px-4 py-3">标题</th><th class="px-4 py-3">状态</th><th class="px-4 py-3">图片</th><th class="px-4 py-3">排序</th><th class="px-4 py-3">操作</th></tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="item in data?.data || []" :key="item.id">
            <td class="px-4 py-3"><div class="font-medium text-gray-900">{{ item.title }}</div><div class="text-xs text-gray-400">/{{ item.slug }}</div></td>
            <td class="px-4 py-3"><span class="rounded-full px-2 py-1 text-xs" :class="item.status === 'published' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'">{{ item.status === 'published' ? '已发布' : '草稿' }}</span></td>
            <td class="px-4 py-3" :class="item.imageCount < 2 || item.imageCount > 9 ? 'text-amber-600' : 'text-gray-700'">{{ item.imageCount }} 张</td>
            <td class="px-4 py-3">{{ item.sortOrder }}</td>
            <td class="px-4 py-3"><NuxtLink :to="`/admin/cases/${item.id}`" class="text-blue-600 hover:underline">编辑</NuxtLink></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
