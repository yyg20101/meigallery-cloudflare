<script setup lang="ts">
const { register, isLoggedIn } = useAuth()
const router = useRouter()

const email = ref('')
const password = ref('')
const nickname = ref('')
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
</script>

<template>
  <div class="flex min-h-[60vh] items-center justify-center px-4 pb-20 sm:pb-0">
    <div class="w-full max-w-sm">
      <h1 class="text-2xl font-bold text-gray-900 text-center mb-6">注册</h1>

      <form class="space-y-4" @submit.prevent="onSubmit">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
          <input v-model="email" type="email" autocomplete="email" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" placeholder="your@email.com" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">昵称 (可选)</label>
          <input v-model="nickname" type="text" autocomplete="nickname" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" placeholder="你的昵称" />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">密码</label>
          <input v-model="password" type="password" autocomplete="new-password" class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" placeholder="至少 8 位" />
        </div>

        <div v-if="error" class="rounded-lg bg-red-50 p-3 text-sm text-red-700">{{ error }}</div>

        <button type="submit" :disabled="loading" class="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {{ loading ? '注册中...' : '注册' }}
        </button>
      </form>

      <p class="mt-4 text-center text-sm text-gray-500">
        已有账号？
        <NuxtLink to="/login" class="text-blue-600 hover:underline">登录</NuxtLink>
      </p>
    </div>
  </div>
</template>
