<script setup lang="ts">
const { login, isLoggedIn } = useAuth()
const route = useRoute()
const router = useRouter()
const config = useRuntimeConfig()

const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)
const turnstileToken = ref('')

const turnstileSiteKey = computed(() => config.public.turnstileSiteKey as string)
const hasTurnstile = computed(() => !!turnstileSiteKey.value)

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
    await login(email.value, password.value, hasTurnstile.value ? turnstileToken.value : undefined)
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

        <!-- Turnstile 人机验证 -->
        <div v-if="hasTurnstile" class="mb-4">
          <!-- 真实 Turnstile widget 挂载点 -->
          <div id="turnstile-login" class="cf-turnstile" :data-sitekey="turnstileSiteKey" data-callback="onTurnstileLogin" />
        </div>
        <div v-else class="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center gap-2 mb-4">
          <svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
          <span class="text-xs text-gray-400">开发模式 · 人机验证已跳过</span>
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
