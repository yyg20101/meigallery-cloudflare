<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const { api } = useApi()

const page = ref(1)
const keyword = ref('')
const filterRole = ref('')
const filterStatus = ref('')

interface AdminUser {
  id: string; email: string; username: string | null; nickname: string | null
  role: string; status: string; createdAt: string
  membershipRank: number; membershipExpiry: string | null
}

const { data, refresh } = await useAsyncData('admin-users', () =>
  api<{ data: AdminUser[]; total: number }>('/api/admin/users', {
    query: {
      page: String(page.value),
      pageSize: '20',
      q: keyword.value || undefined,
      role: filterRole.value || undefined,
      status: filterStatus.value || undefined,
    },
  }),
  { watch: [page, keyword, filterRole, filterStatus] },
)

const users = computed(() => data.value?.data ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.ceil(total.value / 20))

function membershipLabel(rank: number): string {
  if (rank >= 20) return 'SVIP'
  if (rank >= 10) return 'VIP'
  return '免费'
}

function membershipClass(rank: number): string {
  if (rank >= 20) return 'bg-purple-100 text-purple-800'
  if (rank >= 10) return 'bg-amber-100 text-amber-800'
  return 'text-gray-400'
}

function roleLabel(role: string): string {
  const map: Record<string, string> = { owner: '站长', admin: '管理员', user: '用户' }
  return map[role] || role
}

function statusLabel(status: string): string {
  return status === 'active' ? '正常' : '已封禁'
}
</script>

<template>
  <div>
    <h1 class="text-xl font-bold text-gray-900 mb-6">用户管理</h1>

    <!-- 搜索和筛选 -->
    <div class="mb-4 flex flex-wrap gap-3">
      <input
        v-model="keyword"
        placeholder="搜索用户名、邮箱或昵称..."
        class="rounded-lg border border-gray-300 px-3 py-2 text-sm w-64"
      />
      <select v-model="filterRole" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
        <option value="">全部角色</option>
        <option value="owner">站长</option>
        <option value="admin">管理员</option>
        <option value="user">用户</option>
      </select>
      <select v-model="filterStatus" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
        <option value="">全部状态</option>
        <option value="active">正常</option>
        <option value="banned">已封禁</option>
      </select>
      <span class="text-sm text-gray-500 self-center">共 {{ total }} 个用户</span>
    </div>

    <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b">
          <tr>
            <th class="px-4 py-3 text-left font-medium text-gray-600">用户名</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">邮箱</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">角色</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">会员</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">状态</th>
            <th class="px-4 py-3 text-left font-medium text-gray-600">注册时间</th>
            <th class="px-4 py-3 text-right font-medium text-gray-600">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="u in users" :key="u.id" class="hover:bg-gray-50">
            <td class="px-4 py-3 font-mono text-sm">{{ u.username || '-' }}</td>
            <td class="px-4 py-3">{{ u.email }}</td>
            <td class="px-4 py-3">
              <span
                class="rounded-full px-2 py-0.5 text-xs font-medium"
                :class="{
                  'bg-red-100 text-red-800': u.role === 'owner',
                  'bg-blue-100 text-blue-800': u.role === 'admin',
                  'bg-gray-100 text-gray-600': u.role === 'user',
                }"
              >{{ roleLabel(u.role) }}</span>
            </td>
            <td class="px-4 py-3">
              <span
                class="rounded-full px-2 py-0.5 text-xs font-medium"
                :class="membershipClass(u.membershipRank)"
              >{{ membershipLabel(u.membershipRank) }}</span>
            </td>
            <td class="px-4 py-3">
              <span :class="u.status === 'active' ? 'text-green-600' : 'text-red-600'">
                {{ statusLabel(u.status) }}
              </span>
            </td>
            <td class="px-4 py-3 text-gray-500">{{ u.createdAt?.split('T')[0] }}</td>
            <td class="px-4 py-3 text-right">
              <NuxtLink :to="`/admin/users/${u.id}`" class="text-xs text-blue-600 hover:underline">管理</NuxtLink>
            </td>
          </tr>
          <tr v-if="users.length === 0">
            <td colspan="7" class="px-4 py-8 text-center text-gray-400">暂无用户数据</td>
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
