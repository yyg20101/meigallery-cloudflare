<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()

const page = ref(1)
const keyword = ref('')

interface AdminUser {
  id: string; email: string; nickname: string | null; role: string; status: string
  createdAt: string; membershipRank: number; membershipExpiry: string | null
}

const { data } = await useAsyncData('admin-users', () =>
  api<{ data: AdminUser[]; total: number }>('/api/admin/users', {
    query: { page: String(page.value), pageSize: '20', q: keyword.value || undefined },
  }),
  { watch: [page, keyword] },
)

const users = computed(() => data.value?.data ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.ceil(total.value / 20))
</script>

<template>
  <div>
    <h1 class="text-xl font-bold text-gray-900 mb-6">用户管理</h1>

    <div class="mb-4">
      <input v-model="keyword" placeholder="搜索邮箱或昵称..." class="rounded-lg border border-gray-300 px-3 py-2 text-sm w-64" />
    </div>

    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b">
          <tr>
            <th class="px-4 py-3 text-left font-medium text-gray-600">邮箱</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">昵称</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">角色</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">会员</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">状态</th>
            <th class="px-4 py-3 text-right font-medium text-gray-600">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="u in users" :key="u.id" class="hover:bg-gray-50">
            <td class="px-4 py-3">{{ u.email }}</td>
            <td class="px-4 py-3">{{ u.nickname || '-' }}</td>
            <td class="px-4 py-3">{{ u.role }}</td>
            <td class="px-4 py-3">
              <span v-if="u.membershipRank > 0" class="rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-xs font-medium">
                Rank {{ u.membershipRank }}
              </span>
              <span v-else class="text-gray-400">免费</span>
            </td>
            <td class="px-4 py-3">
              <span :class="u.status === 'active' ? 'text-green-600' : 'text-red-600'">{{ u.status }}</span>
            </td>
            <td class="px-4 py-3 text-right">
              <NuxtLink :to="`/admin/users/${u.id}`" class="text-xs text-blue-600 hover:underline">管理</NuxtLink>
            </td>
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
