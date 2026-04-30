<script setup lang="ts">
const { login, isLoggedIn } = useAuth()
const router = useRouter()

const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

// 已登录直接跳转
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
    router.push('/')
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
  <div class="flex min-h-[60vh] items-center justify-center px-4 pb-20 sm:pb-0">
    <div class="w-full max-w-sm">
      <h1 class="text-2xl font-bold text-gray-900 text-center mb-6">登录</h1>

      <form class="space-y-4" @submit.prevent="onSubmit">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
          <input
            v-model="email"
            type="email"
            autocomplete="email"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="your@email.com"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">密码</label>
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="输入密码"
          />
        </div>

        <div v-if="error" class="rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ error }}</div>

        <button
          type="submit"
          :disabled="loading"
          class="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {{ loading ? '登录中...' : '登录' }}
        </button>
      </form>

      <p class="mt-4 text-center text-sm text-gray-500">
        还没有账号？
        <NuxtLink to="/register" class="text-blue-600 hover:underline">注册</NuxtLink>
      </p>
    </div>
  </div>
</template>
