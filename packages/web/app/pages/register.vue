<script setup lang="ts">
import { validateUsername } from '@meigallery/shared/utils'

const { register, sendCode, checkUsername, isLoggedIn } = useAuth()
const { api } = useApi()
const router = useRouter()
const config = useRuntimeConfig()

// 表单数据
const username = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const verificationCode = ref('')
const error = ref('')
const loading = ref(false)
const codeSending = ref(false)
const turnstileToken = ref('')
const turnstileExpired = ref(false)

// 用户名实时校验
const usernameError = ref('')
const usernameChecking = ref(false)
let usernameDebounce: ReturnType<typeof setTimeout> | null = null

// 邮箱验证开关（从公共设置获取）
const emailVerificationEnabled = ref(false)

// 步骤控制：1=填写信息 2=输入验证码（仅验证开启时使用）
const step = ref(1)

// 验证码冷却倒计时
const cooldown = ref(0)
let cooldownTimer: ReturnType<typeof setInterval> | null = null

const turnstileSiteKey = computed(() => config.public.turnstileSiteKey as string)
const hasTurnstile = computed(() => !!turnstileSiteKey.value)

// Turnstile 验证通过前禁止提交
const canSubmit = computed(() => {
  if (!hasTurnstile.value) return true
  return !!turnstileToken.value && !turnstileExpired.value
})

if (isLoggedIn.value) {
  router.replace('/')
}

// 获取邮箱验证开关
onMounted(async () => {
  try {
    const settings = await api<Record<string, any>>('/api/settings/public')
    emailVerificationEnabled.value = settings.email_verification_enabled === true || settings.email_verification_enabled === 'true'
  } catch {
    // 默认关闭
  }
})

// Turnstile 回调
onMounted(() => {
  if (!hasTurnstile.value) return

  ;(window as any).onTurnstileRegisterSuccess = (token: string) => {
    turnstileToken.value = token
    turnstileExpired.value = false
  }
  ;(window as any).onTurnstileRegisterExpired = () => {
    turnstileToken.value = ''
    turnstileExpired.value = true
  }
  ;(window as any).onTurnstileRegisterError = () => {
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
  if (usernameDebounce) clearTimeout(usernameDebounce)
})

// 用户名输入实时校验（防抖 500ms）
watch(username, (val) => {
  usernameError.value = ''
  if (usernameDebounce) clearTimeout(usernameDebounce)
  if (!val) return

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
    } catch {
      // 网络错误忽略，提交时会再校验
    } finally {
      usernameChecking.value = false
    }
  }, 500)
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

function resetTurnstile() {
  if (hasTurnstile.value && typeof (window as any).turnstile?.reset === 'function') {
    ;(window as any).turnstile.reset('#turnstile-register')
    turnstileToken.value = ''
  }
}

/** 基础表单校验 */
function validateForm(): boolean {
  error.value = ''

  if (!username.value || !email.value || !password.value || !confirmPassword.value) {
    error.value = '请填写所有必填项'
    return false
  }

  const usernameResult = validateUsername(username.value)
  if (!usernameResult.valid) {
    error.value = usernameResult.error
    return false
  }
  if (usernameError.value) {
    error.value = usernameError.value
    return false
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) {
    error.value = '邮箱格式无效'
    return false
  }
  if (password.value !== confirmPassword.value) {
    error.value = '两次输入的密码不一致'
    return false
  }
  if (password.value.length < 8) {
    error.value = '密码长度至少 8 位'
    return false
  }
  if (hasTurnstile.value && !turnstileToken.value) {
    error.value = '请完成人机验证'
    return false
  }

  return true
}

/** 邮箱验证开启时：第一步发送验证码 */
async function onSendCode() {
  if (!validateForm()) return

  codeSending.value = true
  try {
    const result = await sendCode(
      email.value,
      'register',
      hasTurnstile.value ? turnstileToken.value : undefined,
    )
    startCooldown(result.cooldown || 60)
    step.value = 2
  } catch (e: any) {
    const msg = e?.data ? (() => { try { return JSON.parse(e.data)?.message } catch { return null } })() : null
    error.value = msg || e?.message || '发送验证码失败，请重试'
    resetTurnstile()
  } finally {
    codeSending.value = false
  }
}

/** 邮箱验证关闭时：直接注册 */
async function onDirectRegister() {
  if (!validateForm()) return

  loading.value = true
  try {
    await register({
      email: email.value,
      password: password.value,
      username: username.value,
      turnstileToken: hasTurnstile.value ? turnstileToken.value : undefined,
    })
    router.push('/')
  } catch (e: any) {
    const msg = e?.data ? (() => { try { return JSON.parse(e.data)?.message } catch { return null } })() : null
    error.value = msg || e?.message || '注册失败，请重试'
    resetTurnstile()
  } finally {
    loading.value = false
  }
}

/** 重新发送验证码（在第二步） */
async function onResendCode() {
  if (cooldown.value > 0) return
  error.value = ''
  codeSending.value = true
  try {
    resetTurnstile()
    const result = await sendCode(email.value, 'register')
    startCooldown(result.cooldown || 60)
  } catch (e: any) {
    const msg = e?.data ? (() => { try { return JSON.parse(e.data)?.message } catch { return null } })() : null
    error.value = msg || '重新发送失败'
  } finally {
    codeSending.value = false
  }
}

/** 邮箱验证开启时：第二步提交验证码完成注册 */
async function onSubmitWithCode() {
  error.value = ''

  if (!verificationCode.value || verificationCode.value.length !== 6) {
    error.value = '请输入 6 位验证码'
    return
  }

  loading.value = true
  try {
    await register({
      email: email.value,
      password: password.value,
      username: username.value,
      code: verificationCode.value,
      turnstileToken: hasTurnstile.value ? turnstileToken.value : undefined,
    })
    router.push('/')
  } catch (e: any) {
    const msg = e?.data ? (() => { try { return JSON.parse(e.data)?.message } catch { return null } })() : null
    error.value = msg || e?.message || '注册失败，请重试'
  } finally {
    loading.value = false
  }
}

/** 返回第一步 */
function backToStep1() {
  step.value = 1
  verificationCode.value = ''
  error.value = ''
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

      <!-- ========== 第一步：填写信息 ========== -->
      <form
        v-if="step === 1"
        class="space-y-4"
        @submit.prevent="emailVerificationEnabled ? onSendCode() : onDirectRegister()"
      >
        <!-- 用户名 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">用户名 <span class="text-red-400">*</span></label>
          <div class="relative">
            <input
              v-model="username"
              type="text"
              autocomplete="username"
              class="border rounded-lg px-4 py-2.5 w-full text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
              :class="usernameError ? 'border-red-300' : 'border-gray-200'"
              placeholder="英文字母和数字，3-20 位"
            />
            <span
              v-if="usernameChecking"
              class="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400"
            >检查中...</span>
          </div>
          <p v-if="usernameError" class="text-xs text-red-500 mt-1">{{ usernameError }}</p>
        </div>

        <!-- 邮箱 -->
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">邮箱 <span class="text-red-400">*</span></label>
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
          <label class="block text-sm font-medium text-gray-700 mb-1">密码 <span class="text-red-400">*</span></label>
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
          <label class="block text-sm font-medium text-gray-700 mb-1">确认密码 <span class="text-red-400">*</span></label>
          <input
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            class="border border-gray-200 rounded-lg px-4 py-2.5 w-full text-sm focus:ring-2 focus:ring-gray-900 focus:border-transparent outline-none"
            placeholder="再次输入密码"
          />
        </div>

        <!-- Turnstile 人机验证 -->
        <div v-if="hasTurnstile" class="flex justify-center">
          <div
            id="turnstile-register"
            class="cf-turnstile"
            :data-sitekey="turnstileSiteKey"
            data-callback="onTurnstileRegisterSuccess"
            data-expired-callback="onTurnstileRegisterExpired"
            data-error-callback="onTurnstileRegisterError"
            data-theme="light"
            data-language="zh-cn"
          />
        </div>
        <div v-else class="bg-gray-50 border border-gray-200 rounded-lg p-3 flex items-center gap-2">
          <svg class="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" /></svg>
          <span class="text-xs text-gray-400">开发模式 · 人机验证已跳过</span>
        </div>

        <!-- 过期提示 -->
        <p v-if="turnstileExpired" class="text-xs text-amber-600 text-center">
          验证已过期，请重新完成人机验证
        </p>

        <!-- 提交按钮 -->
        <button
          type="submit"
          :disabled="codeSending || loading || !canSubmit || !!usernameError || usernameChecking"
          class="w-full bg-gray-900 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <template v-if="emailVerificationEnabled">
            {{ codeSending ? '发送中...' : '发送验证码' }}
          </template>
          <template v-else>
            {{ loading ? '注册中...' : '注册' }}
          </template>
        </button>
      </form>

      <!-- ========== 第二步：输入验证码（仅验证开启时） ========== -->
      <form v-else class="space-y-4" @submit.prevent="onSubmitWithCode">
        <div class="bg-gray-50 rounded-lg p-3 text-sm text-gray-600 text-center">
          验证码已发送至 <span class="font-medium text-gray-900">{{ email }}</span>
        </div>

        <!-- 验证码输入 -->
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

        <!-- 注册按钮 -->
        <button
          type="submit"
          :disabled="loading || verificationCode.length !== 6"
          class="w-full bg-gray-900 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ loading ? '注册中...' : '完成注册' }}
        </button>

        <!-- 返回上一步 -->
        <button
          type="button"
          class="w-full text-sm text-gray-500 hover:text-gray-700"
          @click="backToStep1"
        >
          返回修改信息
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
