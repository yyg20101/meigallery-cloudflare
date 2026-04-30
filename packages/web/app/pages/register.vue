<script setup lang="ts">
const { register, isLoggedIn } = useAuth()
const router = useRouter()

const nickname = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const loading = ref(false)

if (isLoggedIn.value) {
  router.replace('/')
}

async function onSubmit() {
  error.value = ''
  if (!email.value || !password.value || !confirmPassword.value) {
    error.value = '请填写所有必填项'
    return
  }
  if (password.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  if (password.value.length < 8) {
    error.value = '密码长度至少 8 位'
    return
  }
  loading.value = true
  try {
    await register(email.value, password.value, nickname.value || undefined)
    router.push('/')
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || '注册失败，请重试'
  } finally {
    loading.value = false
  }
}

useSeoMeta({ title: '注册 - MeiGallery', robots: 'noindex' })

definePageMeta({ layout: 'default' })
</script>

<template>
  <div class="-mt-14 min-h-screen flex items-center justify-center bg-gray-50 px-4">
    <div class="w-full max-w-sm bg-white rounded-2xl shadow-sm p-8">
      <!-- Logo & Slogan -->
      <h1 class="text-2xl font-bold text-center">MeiGallery</h1>
      <p class="text-sm text-gray-400 text-center mt-1 mb-8">创建账号，解锁更多内容</p>

      <!-- Error -->
      <div v-if="error" class="text-red-500 text-sm text-center mb-4">{{ error }}</div>

      <form class="space-y-4" @submit.prevent="onSubmit">
        <!-- 昵称 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">昵称</label>
          <input
            v-model="nickname"
            type="text"
            autocomplete="nickname"
            class="border border-gray-200 rounded-lg px-4 py-2.5 w-full text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
            placeholder="你的昵称（可选）"
          />
        </div>

        <!-- 邮箱 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
          <input
            v-model="email"
            type="email"
            autocomplete="email"
            class="border border-gray-200 rounded-lg px-4 py-2.5 w-full text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
            placeholder="your@email.com"
          />
        </div>

        <!-- 密码 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">密码</label>
          <input
            v-model="password"
            type="password"
            autocomplete="new-password"
            class="border border-gray-200 rounded-lg px-4 py-2.5 w-full text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
            placeholder="至少 8 位"
          />
        </div>

        <!-- 确认密码 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">确认密码</label>
          <input
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            class="border border-gray-200 rounded-lg px-4 py-2.5 w-full text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
            placeholder="再次输入密码"
          />
        </div>

        <!-- Turnstile 占位 -->
        <div class="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center gap-2 mb-4">
          <div class="w-5 h-5 border-2 border-gray-300 rounded" />
          <span class="text-sm text-gray-600">人机验证</span>
          <span class="ml-auto text-xs text-gray-400">Cloudflare Turnstile</span>
        </div>

        <!-- 注册按钮 -->
        <button
          type="submit"
          :disabled="loading"
          class="w-full bg-gray-900 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50"
        >
          {{ loading ? '注册中...' : '注册' }}
        </button>
      </form>

      <!-- 底部链接 -->
      <p class="text-center text-sm text-gray-500 mt-4">
        已有账号？
        <NuxtLink to="/login" class="font-medium text-gray-900">立即登录</NuxtLink>
      </p>
    </div>
  </div>
</template>
