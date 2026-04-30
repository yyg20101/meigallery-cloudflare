<script setup lang="ts">
const { sendCode, resetPassword } = useAuth()
const router = useRouter()
const config = useRuntimeConfig()

// 表单数据
const email = ref('')
const verificationCode = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const error = ref('')
const success = ref('')
const loading = ref(false)
const codeSending = ref(false)
const turnstileToken = ref('')
const turnstileExpired = ref(false)

// 步骤控制：1=输入邮箱 2=输入验证码+新密码 3=完成
const step = ref(1)

// 冷却倒计时
const cooldown = ref(0)
let cooldownTimer: ReturnType<typeof setInterval> | null = null

const turnstileSiteKey = computed(() => config.public.turnstileSiteKey as string)
const hasTurnstile = computed(() => !!turnstileSiteKey.value)

const canSubmit = computed(() => {
  if (!hasTurnstile.value) return true
  return !!turnstileToken.value && !turnstileExpired.value
})

onMounted(() => {
  if (!hasTurnstile.value) return

  ;(window as any).onTurnstileResetSuccess = (token: string) => {
    turnstileToken.value = token
    turnstileExpired.value = false
  }
  ;(window as any).onTurnstileResetExpired = () => {
    turnstileToken.value = ''
    turnstileExpired.value = true
  }
  ;(window as any).onTurnstileResetError = () => {
    turnstileToken.value = ''
    error.value = '人机验证加载失败，请刷新页面重试'
  }

  if (!document.querySelector('script[src*="challenges.cloudflare.com"]')) {
    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
    script.async = true
    document.head.appendChild(script)
  }
})

onUnmounted(() => {
  if (cooldownTimer) clearInterval(cooldownTimer)
})

function startCooldown(seconds: number) {
  cooldown.value = seconds
  if (cooldownTimer) clearInterval(cooldownTimer)
  cooldownTimer = setInterval(() => {
    cooldown.value--
    if (cooldown.value <= 0 && cooldownTimer) {
      clearInterval(cooldownTimer)
      cooldownTimer = null
    }
  }, 1000)
}

/** 第一步：发送验证码 */
async function onSendCode() {
  error.value = ''

  if (!email.value) {
    error.value = '请输入邮箱'
    return
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
    error.value = '邮箱格式无效'
    return
  }
  if (hasTurnstile.value && !turnstileToken.value) {
    error.value = '请完成人机验证'
    return
  }

  codeSending.value = true
  try {
    const result = await sendCode(
      email.value,
      'password_reset',
      hasTurnstile.value ? turnstileToken.value : undefined,
    )
    startCooldown(result.cooldown || 60)
    step.value = 2
  } catch (e: any) {
    const msg = e?.data ? (() => { try { return JSON.parse(e.data)?.message } catch { return null } })() : null
    error.value = msg || '发送失败，请重试'
  } finally {
    codeSending.value = false
  }
}

/** 重新发送验证码 */
async function onResendCode() {
  if (cooldown.value > 0) return
  error.value = ''
  codeSending.value = true
  try {
    const result = await sendCode(email.value, 'password_reset')
    startCooldown(result.cooldown || 60)
  } catch (e: any) {
    const msg = e?.data ? (() => { try { return JSON.parse(e.data)?.message } catch { return null } })() : null
    error.value = msg || '重新发送失败'
  } finally {
    codeSending.value = false
  }
}

/** 第二步：重置密码 */
async function onResetPassword() {
  error.value = ''

  if (!verificationCode.value || verificationCode.value.length !== 6) {
    error.value = '请输入 6 位验证码'
    return
  }
  if (!newPassword.value || newPassword.value.length < 8) {
    error.value = '新密码长度至少 8 位'
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致'
    return
  }

  loading.value = true
  try {
    await resetPassword(email.value, verificationCode.value, newPassword.value)
    step.value = 3
    success.value = '密码重置成功，请使用新密码登录'
  } catch (e: any) {
    const msg = e?.data ? (() => { try { return JSON.parse(e.data)?.message } catch { return null } })() : null
    error.value = msg || '重置失败，请重试'
  } finally {
    loading.value = false
  }
}

useSeoMeta({ title: '忘记密码 - MeiGallery', robots: 'noindex' })

definePageMeta({ layout: 'default' })
</script>

<template>
  <div class="-mt-14 min-h-screen flex items-center justify-center bg-gray-50 px-4">
    <div class="w-full max-w-sm bg-white rounded-2xl shadow-sm p-8">
      <!-- Logo -->
      <h1 class="text-2xl font-bold text-center">MeiGallery</h1>
      <p class="text-sm text-gray-400 text-center mt-1 mb-8">重置你的密码</p>

      <!-- Error / Success -->
      <div v-if="error" class="text-red-500 text-sm text-center mb-4">{{ error }}</div>
      <div v-if="success" class="text-green-600 text-sm text-center mb-4">{{ success }}</div>

      <!-- ========== 第一步：输入邮箱 ========== -->
      <form v-if="step === 1" class="space-y-4" @submit.prevent="onSendCode">
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

        <!-- Turnstile -->
        <div v-if="hasTurnstile" class="flex justify-center">
          <div
            id="turnstile-reset"
            class="cf-turnstile"
            :data-sitekey="turnstileSiteKey"
            data-callback="onTurnstileResetSuccess"
            data-expired-callback="onTurnstileResetExpired"
            data-error-callback="onTurnstileResetError"
            data-theme="light"
            data-language="zh-cn"
          />
        </div>
        <div v-else class="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center gap-2">
          <svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
          <span class="text-xs text-gray-400">开发模式 · 人机验证已跳过</span>
        </div>

        <p v-if="turnstileExpired" class="text-xs text-amber-600 text-center">
          验证已过期，请重新完成人机验证
        </p>

        <button
          type="submit"
          :disabled="codeSending || !canSubmit"
          class="w-full bg-gray-900 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ codeSending ? '发送中...' : '发送验证码' }}
        </button>
      </form>

      <!-- ========== 第二步：输入验证码和新密码 ========== -->
      <form v-else-if="step === 2" class="space-y-4" @submit.prevent="onResetPassword">
        <div class="bg-gray-50 rounded-lg p-3 text-sm text-gray-600 text-center">
          验证码已发送至 <span class="font-medium text-gray-900">{{ email }}</span>
        </div>

        <!-- 验证码 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">验证码</label>
          <input
            v-model="verificationCode"
            type="text"
            inputmode="numeric"
            maxlength="6"
            autocomplete="one-time-code"
            class="border border-gray-200 rounded-lg px-4 py-2.5 w-full text-sm text-center tracking-[0.5em] font-mono text-lg focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
            placeholder="000000"
          />
        </div>

        <!-- 重新发送 -->
        <div class="text-center">
          <button
            v-if="cooldown > 0"
            type="button"
            disabled
            class="text-sm text-gray-400 cursor-not-allowed"
          >
            {{ cooldown }} 秒后可重新发送
          </button>
          <button
            v-else
            type="button"
            :disabled="codeSending"
            class="text-sm text-blue-600 hover:underline"
            @click="onResendCode"
          >
            {{ codeSending ? '发送中...' : '重新发送验证码' }}
          </button>
        </div>

        <!-- 新密码 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">新密码</label>
          <input
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            class="border border-gray-200 rounded-lg px-4 py-2.5 w-full text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
            placeholder="至少 8 位"
          />
        </div>

        <!-- 确认新密码 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">确认新密码</label>
          <input
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            class="border border-gray-200 rounded-lg px-4 py-2.5 w-full text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
            placeholder="再次输入新密码"
          />
        </div>

        <button
          type="submit"
          :disabled="loading"
          class="w-full bg-gray-900 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ loading ? '重置中...' : '重置密码' }}
        </button>

        <button
          type="button"
          class="w-full text-sm text-gray-500 hover:text-gray-700"
          @click="step = 1; error = ''"
        >
          返回修改邮箱
        </button>
      </form>

      <!-- ========== 第三步：成功 ========== -->
      <div v-else class="text-center space-y-4">
        <div class="w-16 h-16 mx-auto bg-green-50 rounded-full flex items-center justify-center">
          <svg class="w-8 h-8 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
        </div>
        <p class="text-gray-700">密码重置成功</p>
        <button
          class="w-full bg-gray-900 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-gray-800"
          @click="router.push('/login')"
        >
          前往登录
        </button>
      </div>

      <!-- 底部链接 -->
      <p class="text-center text-sm text-gray-500 mt-4">
        想起密码了？
        <NuxtLink to="/login" class="font-medium text-gray-900">立即登录</NuxtLink>
      </p>
    </div>
  </div>
</template>
