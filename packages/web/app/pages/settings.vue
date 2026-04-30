<script setup lang="ts">
import { validateUsername } from '@meigallery/shared/utils'

definePageMeta({ layout: 'default', middleware: 'auth' })

const { user, fetchUser, checkUsername } = useAuth()
const { api } = useApi()

// ============ 用户名修改 ============
const usernameEdit = ref(false)
const newUsername = ref('')
const usernameError = ref('')
const usernameLoading = ref(false)
const usernameSuccess = ref(false)
const usernameChecking = ref(false)
let usernameDebounce: ReturnType<typeof setTimeout> | null = null

function startEditUsername() {
  newUsername.value = user.value?.username || ''
  usernameEdit.value = true
  usernameError.value = ''
  usernameSuccess.value = false
}

watch(newUsername, (val) => {
  usernameError.value = ''
  if (usernameDebounce) clearTimeout(usernameDebounce)
  if (!val || val === user.value?.username) return

  const result = validateUsername(val)
  if (!result.valid) {
    usernameError.value = result.error
    return
  }

  usernameDebounce = setTimeout(async () => {
    usernameChecking.value = true
    try {
      const res = await checkUsername(val)
      if (!res.available) {
        usernameError.value = res.error || '该用户名已被使用'
      }
    } catch { /* 忽略 */ } finally {
      usernameChecking.value = false
    }
  }, 500)
})

async function saveUsername() {
  usernameError.value = ''
  usernameSuccess.value = false
  if (!newUsername.value || newUsername.value === user.value?.username) {
    usernameEdit.value = false
    return
  }
  const result = validateUsername(newUsername.value)
  if (!result.valid) {
    usernameError.value = result.error
    return
  }
  usernameLoading.value = true
  try {
    await api('/api/me/profile', { method: 'PATCH', body: { username: newUsername.value } })
    usernameSuccess.value = true
    usernameEdit.value = false
    await fetchUser()
    setTimeout(() => { usernameSuccess.value = false }, 3000)
  } catch (e: any) {
    usernameError.value = e?.data?.message || '保存失败'
  } finally {
    usernameLoading.value = false
  }
}

// ============ 密码修改 ============
const passwordExpand = ref(false)
const passwordForm = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' })
const passwordError = ref('')
const passwordLoading = ref(false)
const passwordSuccess = ref(false)

async function changePassword() {
  passwordError.value = ''
  passwordSuccess.value = false
  if (!passwordForm.oldPassword) {
    passwordError.value = '请输入旧密码'
    return
  }
  if (passwordForm.newPassword.length < 8) {
    passwordError.value = '新密码长度至少 8 位'
    return
  }
  if (passwordForm.newPassword !== passwordForm.confirmPassword) {
    passwordError.value = '两次输入的新密码不一致'
    return
  }
  passwordLoading.value = true
  try {
    await api('/api/me/password', {
      method: 'PATCH',
      body: { oldPassword: passwordForm.oldPassword, newPassword: passwordForm.newPassword },
    })
    passwordSuccess.value = true
    passwordExpand.value = false
    passwordForm.oldPassword = ''
    passwordForm.newPassword = ''
    passwordForm.confirmPassword = ''
    setTimeout(() => { passwordSuccess.value = false }, 3000)
  } catch (e: any) {
    passwordError.value = e?.data?.message || '修改失败'
  } finally {
    passwordLoading.value = false
  }
}

// ============ 头像上传 ============
const avatarLoading = ref(false)
const avatarError = ref('')

async function onAvatarChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  avatarError.value = ''

  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
    avatarError.value = '仅支持 JPG、PNG、WebP 格式'
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    avatarError.value = '图片大小不能超过 2MB'
    return
  }

  avatarLoading.value = true
  try {
    const formData = new FormData()
    formData.append('avatar', file)
    await api('/api/me/avatar', { method: 'POST', body: formData })
    await fetchUser()
  } catch (e: any) {
    avatarError.value = e?.data?.message || '上传失败'
  } finally {
    avatarLoading.value = false
    input.value = '' // 重置 input
  }
}

// ============ 通知设置 ============
const notifLoading = ref(false)

async function toggleNotification() {
  notifLoading.value = true
  try {
    const enabled = !user.value?.notificationEnabled
    await api('/api/me/notifications', { method: 'PATCH', body: { enabled } })
    await fetchUser()
  } catch { /* 忽略 */ } finally {
    notifLoading.value = false
  }
}

// ============ 邮箱修改 ============
const emailEdit = ref(false)
const emailForm = reactive({ newEmail: '', password: '' })
const emailError = ref('')
const emailLoading = ref(false)
const emailSuccess = ref(false)

async function changeEmail() {
  emailError.value = ''
  emailSuccess.value = false
  if (!emailForm.newEmail || !emailForm.password) {
    emailError.value = '请填写新邮箱和密码'
    return
  }
  emailLoading.value = true
  try {
    await api('/api/me/email', {
      method: 'PATCH',
      body: { newEmail: emailForm.newEmail, password: emailForm.password },
    })
    emailSuccess.value = true
    emailEdit.value = false
    emailForm.newEmail = ''
    emailForm.password = ''
    await fetchUser()
    setTimeout(() => { emailSuccess.value = false }, 3000)
  } catch (e: any) {
    emailError.value = e?.data?.message || '修改失败'
  } finally {
    emailLoading.value = false
  }
}

// ============ 辅助 ============
function membershipLabel(rank: number): string {
  if (rank >= 20) return 'SVIP'
  if (rank >= 10) return 'VIP'
  return '免费用户'
}

const config = useRuntimeConfig()

// 头像 URL（R2 公开访问 或 通过媒体 API）
const avatarUrl = computed(() => {
  if (!user.value?.avatarKey) return null
  const apiBase = config.public.apiBaseUrl as string
  return `${apiBase}/api/media/public/${user.value.avatarKey}`
})

onUnmounted(() => {
  if (usernameDebounce) clearTimeout(usernameDebounce)
})

useSeoMeta({ title: '个人设置 - MeiGallery', robots: 'noindex' })
</script>

<template>
  <div class="min-h-screen bg-gray-50 py-8 px-4">
    <div v-if="user" class="max-w-2xl mx-auto space-y-6">
      <h1 class="text-xl font-bold text-gray-900">个人设置</h1>

      <!-- ========== 个人信息概览 ========== -->
      <div class="rounded-lg bg-white p-6 border border-gray-200">
        <div class="flex items-center gap-5">
          <!-- 头像 -->
          <div class="relative group">
            <div
              class="w-20 h-20 rounded-full bg-gray-200 flex items-center justify-center overflow-hidden cursor-pointer"
              @click="($refs.avatarInput as HTMLInputElement)?.click()"
            >
              <img v-if="avatarUrl" :src="avatarUrl" class="w-full h-full object-cover" alt="头像" />
              <span v-else class="text-3xl text-gray-400">{{ (user.username || user.email)?.[0]?.toUpperCase() }}</span>
              <div class="absolute inset-0 bg-black/40 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <span class="text-white text-xs">{{ avatarLoading ? '上传中...' : '更换' }}</span>
              </div>
            </div>
            <input
              ref="avatarInput"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              class="hidden"
              @change="onAvatarChange"
            />
          </div>
          <div>
            <p class="text-lg font-semibold">{{ user.username || user.email }}</p>
            <p class="text-sm text-gray-500">{{ user.email }}</p>
            <p class="text-xs text-gray-400 mt-1">注册于 {{ user.createdAt?.split('T')[0] }}</p>
          </div>
        </div>
        <p v-if="avatarError" class="text-xs text-red-500 mt-2">{{ avatarError }}</p>
      </div>

      <!-- ========== 用户名 ========== -->
      <div class="rounded-lg bg-white p-5 border border-gray-200">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-base font-semibold text-gray-900">用户名</h2>
          <button
            v-if="!usernameEdit"
            class="text-sm text-blue-600 hover:underline"
            @click="startEditUsername"
          >修改</button>
        </div>
        <div v-if="!usernameEdit">
          <p class="text-sm font-mono">{{ user.username || '未设置' }}</p>
          <p v-if="usernameSuccess" class="text-xs text-green-600 mt-1">已保存</p>
        </div>
        <div v-else class="space-y-2">
          <div class="relative">
            <input
              v-model="newUsername"
              class="rounded-lg border border-gray-300 px-3 py-2 text-sm w-full font-mono"
              placeholder="英文字母和数字，3-20 位"
            />
            <span v-if="usernameChecking" class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">检查中...</span>
          </div>
          <p v-if="usernameError" class="text-xs text-red-500">{{ usernameError }}</p>
          <div class="flex gap-2">
            <button
              :disabled="usernameLoading || !!usernameError || usernameChecking"
              class="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
              @click="saveUsername"
            >{{ usernameLoading ? '保存中...' : '保存' }}</button>
            <button class="text-sm text-gray-500" @click="usernameEdit = false">取消</button>
          </div>
        </div>
      </div>

      <!-- ========== 邮箱 ========== -->
      <div class="rounded-lg bg-white p-5 border border-gray-200">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-base font-semibold text-gray-900">邮箱</h2>
          <button
            v-if="!emailEdit"
            class="text-sm text-blue-600 hover:underline"
            @click="emailEdit = true; emailError = ''; emailSuccess = false"
          >修改</button>
        </div>
        <div v-if="!emailEdit">
          <p class="text-sm">{{ user.email }}</p>
          <p v-if="emailSuccess" class="text-xs text-green-600 mt-1">邮箱已更新</p>
        </div>
        <div v-else class="space-y-3">
          <input
            v-model="emailForm.newEmail"
            type="email"
            class="rounded-lg border border-gray-300 px-3 py-2 text-sm w-full"
            placeholder="新邮箱地址"
          />
          <input
            v-model="emailForm.password"
            type="password"
            class="rounded-lg border border-gray-300 px-3 py-2 text-sm w-full"
            placeholder="输入当前密码确认身份"
          />
          <p v-if="emailError" class="text-xs text-red-500">{{ emailError }}</p>
          <div class="flex gap-2">
            <button
              :disabled="emailLoading"
              class="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
              @click="changeEmail"
            >{{ emailLoading ? '保存中...' : '保存' }}</button>
            <button class="text-sm text-gray-500" @click="emailEdit = false">取消</button>
          </div>
        </div>
      </div>

      <!-- ========== 安全设置 ========== -->
      <div class="rounded-lg bg-white p-5 border border-gray-200">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-base font-semibold text-gray-900">修改密码</h2>
          <button
            v-if="!passwordExpand"
            class="text-sm text-blue-600 hover:underline"
            @click="passwordExpand = true; passwordError = ''; passwordSuccess = false"
          >修改</button>
        </div>
        <p v-if="passwordSuccess" class="text-xs text-green-600 mb-2">密码已修改，其他设备已登出</p>
        <div v-if="passwordExpand" class="space-y-3">
          <input
            v-model="passwordForm.oldPassword"
            type="password"
            class="rounded-lg border border-gray-300 px-3 py-2 text-sm w-full"
            placeholder="旧密码"
          />
          <input
            v-model="passwordForm.newPassword"
            type="password"
            class="rounded-lg border border-gray-300 px-3 py-2 text-sm w-full"
            placeholder="新密码（至少 8 位）"
          />
          <input
            v-model="passwordForm.confirmPassword"
            type="password"
            class="rounded-lg border border-gray-300 px-3 py-2 text-sm w-full"
            placeholder="确认新密码"
          />
          <p v-if="passwordError" class="text-xs text-red-500">{{ passwordError }}</p>
          <div class="flex gap-2">
            <button
              :disabled="passwordLoading"
              class="rounded-lg bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
              @click="changePassword"
            >{{ passwordLoading ? '保存中...' : '修改密码' }}</button>
            <button class="text-sm text-gray-500" @click="passwordExpand = false">取消</button>
          </div>
        </div>
        <p v-if="!passwordExpand && !passwordSuccess" class="text-sm text-gray-500">定期修改密码可以提高账号安全性</p>
      </div>

      <!-- ========== 通知设置 ========== -->
      <div class="rounded-lg bg-white p-5 border border-gray-200">
        <h2 class="text-base font-semibold text-gray-900 mb-3">通知设置</h2>
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm">新图库发布通知</p>
            <p class="text-xs text-gray-400">接收新图库上线的邮件通知</p>
          </div>
          <button
            :disabled="notifLoading"
            class="relative w-11 h-6 rounded-full transition-colors duration-200"
            :class="user.notificationEnabled ? 'bg-green-500' : 'bg-gray-300'"
            @click="toggleNotification"
          >
            <span
              class="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform duration-200"
              :class="user.notificationEnabled ? 'translate-x-5' : 'translate-x-0'"
            />
          </button>
        </div>
      </div>

      <!-- ========== 会员信息 ========== -->
      <div class="rounded-lg bg-white p-5 border border-gray-200">
        <h2 class="text-base font-semibold text-gray-900 mb-3">会员信息</h2>
        <div class="flex items-center gap-3">
          <span
            class="rounded-full px-3 py-1 text-sm font-medium"
            :class="{
              'bg-purple-100 text-purple-800': user.membershipRank >= 20,
              'bg-amber-100 text-amber-800': user.membershipRank >= 10 && user.membershipRank < 20,
              'bg-gray-100 text-gray-600': user.membershipRank < 10,
            }"
          >{{ membershipLabel(user.membershipRank) }}</span>
          <span v-if="user.membershipExpiry" class="text-sm text-gray-500">
            到期时间：{{ user.membershipExpiry.split('T')[0] }}
          </span>
        </div>
        <p class="text-xs text-gray-400 mt-3">如需续费或升级会员，请联系站长</p>
      </div>
    </div>
  </div>
</template>
