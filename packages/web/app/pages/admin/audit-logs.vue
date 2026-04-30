<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()
const page = ref(1)

const { data } = await useAsyncData('admin-audit-logs', () =>
  api<{ data: Array<{
    id: string; admin_email: string; action: string; target_type: string
    target_id: string; created_at: string
  }>; total: number }>('/api/admin/audit-logs', {
    query: { page: String(page.value), pageSize: '30' },
  }),
  { watch: [page] },
)

const logs = computed(() => data.value?.data ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.ceil(total.value / 30))
</script>

<template>
  <div>
    <h1 class="text-xl font-bold text-gray-900 mb-6">审计日志</h1>

    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b">
          <tr>
            <th class="px-4 py-3 text-left font-medium text-gray-600">时间</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">管理员</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">操作</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">目标类型</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">目标 ID</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="log in logs" :key="log.id" class="hover:bg-gray-50">
            <td class="px-4 py-3 text-gray-500">{{ log.created_at?.split('T')[0] }}</td>
            <td class="px-4 py-3">{{ log.admin_email }}</td>
            <td class="px-4 py-3">{{ log.action }}</td>
            <td class="px-4 py-3">{{ log.target_type }}</td>
            <td class="px-4 py-3 font-mono text-xs text-gray-500">{{ log.target_id || '-' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="totalPages > 1" class="mt-4 flex justify-center gap-2">
      <button :disabled="page <= 1" class="rounded px-3 py-1 text-sm border disabled:opacity-50" @click="page--">上一页</button>
      <span class="px-3 py-1 text-sm text-gray-600">{{ page }} / {{ totalPages }}</span>
      <button :disabled="page >= totalPages" class="rounded px-3 py-1 text-sm border disabled:opacity-50" @click="page++">下一页</button>
    </div>
  </div>
</template>
