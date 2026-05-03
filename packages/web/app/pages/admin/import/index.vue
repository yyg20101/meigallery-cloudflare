<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()

interface ImportJob {
  id: string; type: string; status: string; total_count: number
  success_count: number; failure_count: number
  creator_email: string; created_at: string; completed_at: string | null
}

const { data, refresh } = await useAsyncData('admin-imports', () =>
  api<{ data: ImportJob[]; total: number }>('/api/admin/import-jobs'),
)

const jobs = computed(() => data.value?.data ?? [])

// 创建新任务
const creating = ref(false)
async function createJob() {
  creating.value = true
  try {
    const result = await api<{ id: string }>('/api/admin/import-jobs', {
      method: 'POST',
      body: { totalCount: 0, sourceDescription: '手动创建' },
    })
    navigateTo(`/admin/import/${result.id}`)
  } catch (e: any) {
    useToast().add({ title: e?.data?.message || '创建失败', color: 'error' })
  } finally {
    creating.value = false
  }
}

const statusColors: Record<string, string> = {
  queued: 'bg-yellow-100 text-yellow-800',
  processing: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-xl font-bold text-gray-900">批量导入</h1>
      <button
        :disabled="creating"
        class="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
        @click="createJob"
      >
        创建导入任务
      </button>
    </div>

    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b">
          <tr>
            <th class="px-4 py-3 text-left font-medium text-gray-600">ID</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">状态</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">总数</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">成功</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">失败</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">创建者</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">时间</th>
            <th class="px-4 py-3 text-right font-medium text-gray-600">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="job in jobs" :key="job.id" class="hover:bg-gray-50">
            <td class="px-4 py-3 font-mono text-xs">{{ job.id.slice(0, 12) }}</td>
            <td class="px-4 py-3">
              <span :class="['rounded-full px-2 py-0.5 text-xs font-medium', statusColors[job.status] || '']">
                {{ job.status }}
              </span>
            </td>
            <td class="px-4 py-3">{{ job.total_count }}</td>
            <td class="px-4 py-3 text-green-600">{{ job.success_count }}</td>
            <td class="px-4 py-3 text-red-600">{{ job.failure_count }}</td>
            <td class="px-4 py-3">{{ job.creator_email }}</td>
            <td class="px-4 py-3 text-gray-500">{{ job.created_at?.split('T')[0] }}</td>
            <td class="px-4 py-3 text-right">
              <NuxtLink :to="`/admin/import/${job.id}`" class="text-xs text-blue-600 hover:underline">详情</NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
