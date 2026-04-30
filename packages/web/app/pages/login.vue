<script setup lang="ts">
const { login, isLoggedIn } = useAuth()
const route = useRoute()
const router = useRouter()

const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

if (isLoggedIn.value) {
  router.replace('/')
}

async function onSubmit() {
  error.value = ''
  if (!email.value || !password.value) {
    error.value = '请填写邮箱和密码'
    return
  }
  loading.value = true
  try {
    await login(email.value, password.value)
    navigateTo((route.query.redirect as string) || '/')
  } catch (e: any) {
    error.value = e?.data?.message || e?.message || '登录失败，请重试'
  } finally {
    loading.value = false
  }
}

useSeoMeta({ title: '登录 - MeiGallery', robots: 'noindex' })

definePageMeta({ layout: 'default' })
</script>

<template>
  <div class="-mt-14 min-h-screen flex items-center justify-center bg-gray-50 px-4">
    <div class="w-full max-w-sm bg-white rounded-2xl shadow-sm p-8">
      <!-- Logo & Slogan -->
      <h1 class="text-2xl font-bold text-center">MeiGallery</h1>
      <p class="text-sm text-gray-400 text-center mt-1 mb-8">发现优质写真 · 时尚 · 生活 · 艺术</p>

      <!-- Error -->
      <div v-if="error" class="text-red-500 text-sm text-center mb-4">{{ error }}</div>

      <form class="space-y-4" @submit.prevent="onSubmit">
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
          <label class="flex justify-between text-sm font-medium text-gray-700 mb-1">
            <span>密码</span>
            <a href="#" class="text-xs text-gray-400">忘记密码？</a>
          </label>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            class="border border-gray-200 rounded-lg px-4 py-2.5 w-full text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
            placeholder="输入密码"
          />
        </div>

        <!-- Turnstile 占位 -->
        <div class="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center gap-2 mb-4">
          <div class="w-5 h-5 border-2 border-gray-300 rounded" />
          <span class="text-sm text-gray-600">人机验证</span>
          <span class="ml-auto text-xs text-gray-400">Cloudflare Turnstile</span>
        </div>

        <!-- 登录按钮 -->
        <button
          type="submit"
          :disabled="loading"
          class="w-full bg-gray-900 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50"
        >
          {{ loading ? '登录中...' : '登录' }}
        </button>
      </form>

      <!-- 底部链接 -->
      <p class="text-center text-sm text-gray-500 mt-4">
        还没有账号？
        <NuxtLink to="/register" class="font-medium text-gray-900">注册</NuxtLink>
      </p>
    </div>
  </div>
</template>
