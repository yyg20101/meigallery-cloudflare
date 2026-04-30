<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const userId = route.params.id as string

const { data: userData, refresh } = await useAsyncData(`admin-user-${userId}`, () =>
  api<{
    id: string; email: string; nickname: string | null; role: string; status: string
    created_at: string
    memberships: Array<{ id: string; level_name: string; rank: number; starts_at: string; expires_at: string; note: string | null }>
  }>(`/api/admin/users/${userId}`),
)

// 发放会员表单
const grantForm = reactive({
  levelId: 'ml_vip',
  expiresAt: '',
  note: '',
})
const grantError = ref('')

async function grantMembership() {
  grantError.value = ''
  if (!grantForm.expiresAt) {
    grantError.value = '请设置到期时间'
    return
  }
  try {
    await api(`/api/admin/users/${userId}/memberships`, {
      method: 'POST',
      body: {
        levelId: grantForm.levelId,
        expiresAt: new Date(grantForm.expiresAt).toISOString(),
        note: grantForm.note || undefined,
      },
    })
    grantForm.note = ''
    grantForm.expiresAt = ''
    refresh()
  } catch (e: any) {
    grantError.value = e?.data?.message || '发放失败'
  }
}
</script>

<template>
  <div v-if="userData" class="max-w-3xl">
    <h1 class="text-xl font-bold text-gray-900 mb-6">用户详情</h1>

    <!-- 基本信息 -->
    <div class="rounded-lg bg-white p-4 border border-gray-200 mb-6">
      <dl class="grid grid-cols-2 gap-3 text-sm">
        <div><dt class="text-gray-500">邮箱</dt><dd>{{ userData.email }}</dd></div>
        <div><dt class="text-gray-500">昵称</dt><dd>{{ userData.nickname || '-' }}</dd></div>
        <div><dt class="text-gray-500">角色</dt><dd>{{ userData.role }}</dd></div>
        <div><dt class="text-gray-500">状态</dt><dd>{{ userData.status }}</dd></div>
        <div><dt class="text-gray-500">注册时间</dt><dd>{{ userData.created_at?.split('T')[0] }}</dd></div>
      </dl>
    </div>

    <!-- 发放会员 -->
    <div class="rounded-lg bg-white p-4 border border-gray-200 mb-6">
      <h2 class="text-base font-semibold text-gray-900 mb-4">发放会员</h2>
      <div class="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <select v-model="grantForm.levelId" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="ml_vip">VIP</option>
          <option value="ml_svip">SVIP</option>
        </select>
        <input v-model="grantForm.expiresAt" type="date" class="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input v-model="grantForm.note" placeholder="备注" class="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <button class="rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700" @click="grantMembership">发放</button>
      </div>
      <p v-if="grantError" class="mt-2 text-sm text-red-600">{{ grantError }}</p>
    </div>

    <!-- 会员历史 -->
    <div class="rounded-lg bg-white p-4 border border-gray-200">
      <h2 class="text-base font-semibold text-gray-900 mb-4">会员历史</h2>
      <table v-if="userData.memberships.length > 0" class="w-full text-sm">
        <thead class="border-b">
          <tr>
            <th class="py-2 text-left text-gray-600">等级</th>
            <th class="py-2 text-left text-gray-600">开始</th>
            <th class="py-2 text-left text-gray-600">到期</th>
            <th class="py-2 text-left text-gray-600">备注</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="m in userData.memberships" :key="m.id">
            <td class="py-2">{{ m.level_name }} ({{ m.rank }})</td>
            <td class="py-2 text-gray-500">{{ m.starts_at?.split('T')[0] }}</td>
            <td class="py-2 text-gray-500">{{ m.expires_at?.split('T')[0] }}</td>
            <td class="py-2 text-gray-500">{{ m.note || '-' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="text-sm text-gray-400">暂无会员记录</p>
    </div>
  </div>
</template>
