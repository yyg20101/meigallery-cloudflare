<script setup lang="ts">
const { register, isLoggedIn } = useAuth()
const router = useRouter()
const config = useRuntimeConfig()

const nickname = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const error = ref('')
const loading = ref(false)
const turnstileToken = ref('')

const turnstileSiteKey = computed(() => config.public.turnstileSiteKey as string)
const hasTurnstile = computed(() => !!turnstileSiteKey.value)

// Turnstile 回调：挂载到 window 以供 Turnstile widget 调用
if (import.meta.client && hasTurnstile.value) {
  useHead({
    script: [{ src: 'https://challenges.cloudflare.com/turnstile/v0/api.js', async: true }],
  })
  ;(window as any).onTurnstileRegister = (token: string) => {
    turnstileToken.value = token
  }
}

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
    await register(email.value, password.value, nickname.value || undefined, hasTurnstile.value ? turnstileToken.value : undefined)
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

        <!-- Turnstile 人机验证 -->
        <div v-if="hasTurnstile" class="mb-4">
          <div id="turnstile-register" class="cf-turnstile" :data-sitekey="turnstileSiteKey" data-callback="onTurnstileRegister" />
        </div>
        <div v-else class="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center gap-2 mb-4">
          <svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
          <span class="text-xs text-gray-400">开发模式 · 人机验证已跳过</span>
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
