<script setup lang="ts">
import { normalizeLoginRedirect } from '~/utils/loginRedirectSecurity'

const { login, isLoggedIn } = useAuth()
const route = useRoute()
const router = useRouter()
const { trackLoginCompleted } = useFacebookPixel()
const { siteName } = useSiteSettings()

const identifier = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

const {
  turnstileToken,
  turnstileExpired,
  hasTurnstile,
  canSubmit,
  mountTurnstile,
  resetTurnstile,
  cleanupTurnstile,
} = useTurnstile({
  containerId: 'turnstile-login',
  onError: (message) => {
    error.value = message
  },
})

if (isLoggedIn.value) {
  router.replace('/')
}

onMounted(() => {
  void mountTurnstile()
})

onUnmounted(() => {
  cleanupTurnstile()
})

async function onSubmit() {
  error.value = ''
  if (!identifier.value || !password.value) {
    error.value = '请填写用户名/邮箱和密码'
    return
  }
  if (hasTurnstile.value && !turnstileToken.value) {
    error.value = '请完成人机验证'
    return
  }
  loading.value = true
  try {
    await login(identifier.value, password.value, hasTurnstile.value ? turnstileToken.value : undefined)
    trackLoginCompleted()
    navigateTo(normalizeLoginRedirect(route.query.redirect))
  } catch (e: any) {
    error.value = resolveApiErrorMessage(e, '登录失败，请重试')
    resetTurnstile()
  } finally {
    loading.value = false
  }
}

useSeoMeta({ title: () => `登录 - ${siteName.value}`, robots: 'noindex' })

definePageMeta({ layout: 'default' })
</script>

<template>
  <div class="mx-auto flex min-h-[calc(100vh-8rem)] max-w-md items-center px-4 py-10">
    <div class="w-full overflow-hidden rounded-[2rem] border border-white/80 bg-white/90 p-6 shadow-2xl shadow-orange-950/8 ring-1 ring-[#f8e7dc]/70">
      <!-- Logo & Slogan -->
      <p class="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#bfa46a]">{{ siteName }}</p>
      <h1 class="mt-3 text-2xl font-semibold tracking-tight text-gray-950">登录 {{ siteName }}</h1>
      <p class="mb-8 mt-2 text-sm text-gray-500">登录后查看会员状态和受保护内容。</p>

      <!-- Error -->
      <div v-if="error" class="text-red-500 text-sm text-center mb-4">{{ error }}</div>

      <form class="space-y-4" @submit.prevent="onSubmit">
        <!-- 用户名 / 邮箱 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">用户名 / 邮箱</label>
          <input
            v-model="identifier"
            type="text"
            autocomplete="username"
            class="border border-gray-200 rounded-lg px-4 py-2.5 w-full text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
            placeholder="输入用户名或邮箱"
          />
        </div>

        <!-- 密码 -->
        <div>
          <label class="flex justify-between text-sm font-medium text-gray-700 mb-1">
            <span>密码</span>
            <NuxtLink to="/forgot-password" class="text-xs text-gray-400 hover:text-gray-600">忘记密码？</NuxtLink>
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
        <div v-if="hasTurnstile" class="flex justify-center">
          <div id="turnstile-login" />
        </div>
        <div v-else class="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center gap-2">
          <svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
          <span class="text-xs text-gray-400">开发模式 · 人机验证已跳过</span>
        </div>

        <!-- 过期提示 -->
        <p v-if="turnstileExpired" class="text-xs text-amber-600 text-center">
          验证已过期，请重新完成人机验证
        </p>

        <!-- 登录按钮 -->
        <button
          type="submit"
          :disabled="loading || !canSubmit"
          class="w-full rounded-full bg-gray-950 py-2.5 text-sm font-medium text-[#d6c39a] transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
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
