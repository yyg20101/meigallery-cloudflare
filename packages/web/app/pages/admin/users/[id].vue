<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const route = useRoute()
const { api } = useApi()
const userId = route.params.id as string

interface UserDetail {
  id: number; email: string; username: string | null; nickname: string | null
  avatarKey: string | null; role: string; status: string
  emailVerified: boolean; notificationEnabled: boolean
  created_at: string; updated_at: string
  memberships: Array<{
    id: string; level_name: string; rank: number
    starts_at: string; expires_at: string; note: string | null
  }>
}

interface ActivityData {
  auditLogs: Array<{
    id: string; adminId: string; action: string; targetType: string
    beforeValue: any; afterValue: any; createdAt: string
  }>
  recentSessions: Array<{ id: string; createdAt: string }>
}

const { data: userData, refresh } = await useAsyncData(`admin-user-${userId}`, () =>
  api<UserDetail>(`/api/admin/users/${userId}`),
)

// 活动日志
const { data: activityData } = await useAsyncData(`admin-user-activity-${userId}`, () =>
  api<ActivityData>(`/api/admin/users/${userId}/activity`),
)

// ============ 编辑用户信息 ============
const editForm = reactive({ username: '', email: '' })
const editError = ref('')
const editLoading = ref(false)
const editSuccess = ref(false)

watch(userData, (val) => {
  if (val) {
    editForm.username = val.username || ''
    editForm.email = val.email || ''
  }
}, { immediate: true })

async function saveUserInfo() {
  editError.value = ''
  editSuccess.value = false
  editLoading.value = true
  try {
    const changes: Record<string, string> = {}
    if (editForm.username !== (userData.value?.username || '')) {
      changes.username = editForm.username
    }
    if (editForm.email !== userData.value?.email) {
      changes.email = editForm.email
    }
    if (Object.keys(changes).length === 0) {
      editError.value = '没有修改'
      return
    }
    await api(`/api/admin/users/${userId}`, { method: 'PATCH', body: changes })
    editSuccess.value = true
    refresh()
    setTimeout(() => { editSuccess.value = false }, 3000)
  } catch (e: any) {
    editError.value = e?.data?.message || '保存失败'
  } finally {
    editLoading.value = false
  }
}

// ============ 重置密码 ============
const resetForm = reactive({ newPassword: '', confirmPassword: '' })
const resetError = ref('')
const resetLoading = ref(false)
const resetSuccess = ref(false)

async function resetPassword() {
  resetError.value = ''
  resetSuccess.value = false
  if (!resetForm.newPassword || resetForm.newPassword.length < 8) {
    resetError.value = '密码长度至少 8 位'
    return
  }
  if (resetForm.newPassword !== resetForm.confirmPassword) {
    resetError.value = '两次输入的密码不一致'
    return
  }
  resetLoading.value = true
  try {
    await api(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: { newPassword: resetForm.newPassword },
    })
    resetSuccess.value = true
    resetForm.newPassword = ''
    resetForm.confirmPassword = ''
    setTimeout(() => { resetSuccess.value = false }, 3000)
  } catch (e: any) {
    resetError.value = e?.data?.message || '重置失败'
  } finally {
    resetLoading.value = false
  }
}

// ============ 角色/状态修改 ============
const roleLoading = ref(false)
const statusLoading = ref(false)

const toast = useToast()

// 确认弹窗状态
const showConfirmModal = ref(false)
const confirmMessage = ref('')
const confirmCallback = ref<(() => Promise<void>) | null>(null)

function requestConfirm(msg: string, cb: () => Promise<void>) {
  confirmMessage.value = msg
  confirmCallback.value = cb
  showConfirmModal.value = true
}

async function doConfirm() {
  showConfirmModal.value = false
  if (confirmCallback.value) await confirmCallback.value()
}

async function changeRole(newRole: string) {
  requestConfirm(`确认将角色修改为「${newRole === 'admin' ? '管理员' : '用户'}」？`, async () => {
    roleLoading.value = true
    try {
      await api(`/api/admin/users/${userId}/role`, { method: 'PATCH', body: { role: newRole } })
      refresh()
    } catch (e: any) {
      toast.add({ title: e?.data?.message || '操作失败', color: 'error' })
    } finally {
      roleLoading.value = false
    }
  })
}

async function toggleStatus() {
  const newStatus = userData.value?.status === 'active' ? 'banned' : 'active'
  const label = newStatus === 'banned' ? '封禁' : '解封'
  const extra = newStatus === 'banned' ? '用户所有会话将被清除。' : ''
  requestConfirm(`确认${label}该用户？${extra}`, async () => {
    statusLoading.value = true
    try {
      await api(`/api/admin/users/${userId}/status`, { method: 'PATCH', body: { status: newStatus } })
      refresh()
    } catch (e: any) {
      toast.add({ title: e?.data?.message || '操作失败', color: 'error' })
    } finally {
      statusLoading.value = false
    }
  })
}

// ============ 发放会员 ============
const grantForm = reactive({ levelId: 'ml_vip', expiresAt: '', note: '' })
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

// ============ 辅助函数 ============
function actionLabel(action: string): string {
  const map: Record<string, string> = {
    grant_membership: '发放会员',
    change_role: '修改角色',
    change_status: '修改状态',
    edit_user: '编辑信息',
    reset_password: '重置密码',
    settings_change: '修改设置',
  }
  return map[action] || action
}

function roleLabel(role: string): string {
  const map: Record<string, string> = { owner: '站长', admin: '管理员', user: '用户' }
  return map[role] || role
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '-'
  return dateStr.replace('T', ' ').substring(0, 19)
}
</script>

<template>
  <div v-if="userData" class="max-w-4xl space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-xl font-bold text-gray-900">用户详情</h1>
      <NuxtLink to="/admin/users" class="text-sm text-gray-500 hover:text-gray-700">返回列表</NuxtLink>
    </div>

    <!-- ========== 基本信息 + 编辑 ========== -->
    <div class="rounded-lg bg-white p-5 border border-gray-200">
      <h2 class="text-base font-semibold text-gray-900 mb-4">基本信息</h2>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <dl class="text-sm space-y-2">
          <div><dt class="text-gray-500">ID</dt><dd class="font-mono text-xs">{{ userData.id }}</dd></div>
          <div><dt class="text-gray-500">角色</dt>
            <dd>
              <span
                class="rounded-full px-2 py-0.5 text-xs font-medium"
                :class="{
                  'bg-red-100 text-red-800': userData.role === 'owner',
                  'bg-blue-100 text-blue-800': userData.role === 'admin',
                  'bg-gray-100 text-gray-600': userData.role === 'user',
                }"
              >{{ roleLabel(userData.role) }}</span>
            </dd>
          </div>
          <div><dt class="text-gray-500">状态</dt>
            <dd :class="userData.status === 'active' ? 'text-green-600' : 'text-red-600'">
              {{ userData.status === 'active' ? '正常' : '已封禁' }}
            </dd>
          </div>
          <div><dt class="text-gray-500">邮箱验证</dt>
            <dd>{{ userData.emailVerified ? '已验证' : '未验证' }}</dd>
          </div>
          <div><dt class="text-gray-500">注册时间</dt><dd>{{ formatDate(userData.created_at) }}</dd></div>
        </dl>

        <!-- 可编辑字段 -->
        <div class="space-y-3">
          <div>
            <label class="block text-xs text-gray-500 mb-1">用户名</label>
            <input v-model="editForm.username" class="rounded-lg border border-gray-300 px-3 py-2 text-sm w-full" />
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1">邮箱</label>
            <input v-model="editForm.email" type="email" class="rounded-lg border border-gray-300 px-3 py-2 text-sm w-full" />
          </div>
          <div class="flex items-center gap-2">
            <button
              :disabled="editLoading"
              class="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
              @click="saveUserInfo"
            >{{ editLoading ? '保存中...' : '保存修改' }}</button>
            <span v-if="editSuccess" class="text-sm text-green-600">已保存</span>
            <span v-if="editError" class="text-sm text-red-600">{{ editError }}</span>
          </div>
        </div>
      </div>

      <!-- 角色/状态操作 -->
      <div v-if="userData.role !== 'owner'" class="flex gap-3 pt-3 border-t border-gray-100">
        <button
          v-if="userData.role === 'user'"
          :disabled="roleLoading"
          class="rounded-lg border border-blue-300 text-blue-700 px-3 py-1.5 text-xs hover:bg-blue-50 disabled:opacity-50"
          @click="changeRole('admin')"
        >设为管理员</button>
        <button
          v-if="userData.role === 'admin'"
          :disabled="roleLoading"
          class="rounded-lg border border-gray-300 text-gray-700 px-3 py-1.5 text-xs hover:bg-gray-50 disabled:opacity-50"
          @click="changeRole('user')"
        >降为用户</button>
        <button
          :disabled="statusLoading"
          class="rounded-lg border px-3 py-1.5 text-xs disabled:opacity-50"
          :class="userData.status === 'active' ? 'border-red-300 text-red-700 hover:bg-red-50' : 'border-green-300 text-green-700 hover:bg-green-50'"
          @click="toggleStatus"
        >{{ userData.status === 'active' ? '封禁' : '解封' }}</button>
      </div>
    </div>

    <!-- ========== 重置密码 ========== -->
    <div class="rounded-lg bg-white p-5 border border-gray-200">
      <h2 class="text-base font-semibold text-gray-900 mb-4">重置密码</h2>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <input
          v-model="resetForm.newPassword"
          type="password"
          placeholder="新密码（至少 8 位）"
          class="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          v-model="resetForm.confirmPassword"
          type="password"
          placeholder="确认新密码"
          class="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <button
          :disabled="resetLoading"
          class="rounded-lg bg-amber-600 px-4 py-2 text-sm text-white hover:bg-amber-700 disabled:opacity-50"
          @click="resetPassword"
        >{{ resetLoading ? '重置中...' : '重置密码' }}</button>
      </div>
      <p v-if="resetError" class="mt-2 text-sm text-red-600">{{ resetError }}</p>
      <p v-if="resetSuccess" class="mt-2 text-sm text-green-600">密码已重置，用户所有会话已清除</p>
    </div>

    <!-- ========== 发放会员 ========== -->
    <div class="rounded-lg bg-white p-5 border border-gray-200">
      <h2 class="text-base font-semibold text-gray-900 mb-4">发放会员</h2>
      <div class="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <select v-model="grantForm.levelId" class="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="ml_vip">VIP</option>
          <option value="ml_svip">SVIP</option>
        </select>
        <input v-model="grantForm.expiresAt" type="date" class="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <input v-model="grantForm.note" placeholder="备注（可选）" class="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
        <button class="rounded-lg bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700" @click="grantMembership">发放</button>
      </div>
      <p v-if="grantError" class="mt-2 text-sm text-red-600">{{ grantError }}</p>
    </div>

    <!-- ========== 会员历史 ========== -->
    <div class="rounded-lg bg-white p-5 border border-gray-200">
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

    <!-- ========== 活动日志 ========== -->
    <div class="rounded-lg bg-white p-5 border border-gray-200">
      <h2 class="text-base font-semibold text-gray-900 mb-4">活动日志</h2>

      <!-- 管理操作记录 -->
      <div v-if="activityData?.auditLogs?.length" class="mb-6">
        <h3 class="text-sm font-medium text-gray-700 mb-2">管理操作</h3>
        <div class="space-y-2">
          <div
            v-for="log in activityData.auditLogs"
            :key="log.id"
            class="flex items-start gap-3 text-sm border-l-2 border-gray-200 pl-3 py-1"
          >
            <span class="text-xs text-gray-400 whitespace-nowrap">{{ formatDate(log.createdAt) }}</span>
            <span class="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium">{{ actionLabel(log.action) }}</span>
            <span v-if="log.beforeValue || log.afterValue" class="text-gray-500 text-xs">
              <template v-if="log.beforeValue">{{ JSON.stringify(log.beforeValue) }}</template>
              <template v-if="log.beforeValue && log.afterValue"> → </template>
              <template v-if="log.afterValue">{{ JSON.stringify(log.afterValue) }}</template>
            </span>
          </div>
        </div>
      </div>
      <p v-else class="text-sm text-gray-400 mb-4">暂无管理操作记录</p>

      <!-- 最近登录 -->
      <div>
        <h3 class="text-sm font-medium text-gray-700 mb-2">最近登录</h3>
        <div v-if="activityData?.recentSessions?.length" class="space-y-1">
          <div
            v-for="s in activityData.recentSessions"
            :key="s.id"
            class="text-sm text-gray-500"
          >
            {{ formatDate(s.createdAt) }}
          </div>
        </div>
        <p v-else class="text-sm text-gray-400">暂无登录记录</p>
      </div>
    </div>
  </div>

  <!-- 确认弹窗 -->
  <UModal v-model:open="showConfirmModal">
    <template #content>
      <div class="p-6">
        <h3 class="text-base font-semibold text-gray-900 mb-3">确认操作</h3>
        <p class="text-sm text-gray-600 mb-4">{{ confirmMessage }}</p>
        <div class="flex gap-3">
          <button class="rounded-lg bg-red-600 px-4 py-2 text-sm text-white hover:bg-red-700" @click="doConfirm">确认</button>
          <button class="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50" @click="showConfirmModal = false">取消</button>
        </div>
      </div>
    </template>
  </UModal>
</template>
