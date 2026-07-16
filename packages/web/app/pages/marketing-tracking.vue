<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { siteName } = useSiteSettings()
const { state, pending, decisionSource, requiresChoice, grant, deny } = useMarketingConsent()
const saved = ref(false)
const errorMessage = ref('')

const currentStatus = computed(() => {
  if (decisionSource.value === 'gpc') return '已按浏览器隐私偏好关闭可选分析'
  if (decisionSource.value === 'disabled') return '当前仅使用必要功能'
  if (state.value === 'granted') return '已允许效果分析'
  if (state.value === 'denied') return '仅使用必要功能'
  return '等待你的选择'
})

async function choose(nextState: 'granted' | 'denied') {
  saved.value = false
  errorMessage.value = ''
  try {
    await (nextState === 'granted' ? grant() : deny())
    saved.value = true
  }
  catch {
    errorMessage.value = '保存失败，请稍后重试。'
  }
}

useSeoMeta({
  title: () => `数据与隐私 - ${siteName.value}`,
  description: '了解本站如何保护你的隐私，并管理可选的数据分析设置。',
})
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
    <header class="border-b border-gray-200 pb-7">
      <p class="text-sm font-medium text-gray-500">隐私与选择</p>
      <h1 class="mt-2 text-3xl font-semibold text-gray-950">数据与隐私</h1>
      <p class="mt-4 text-sm leading-7 text-gray-600">{{ siteName }} 会使用必要信息保障网站正常运行。对于改善体验和衡量推广效果所需的可选信息，你可以自行决定是否允许。</p>
    </header>

    <section class="border-b border-gray-200 py-7">
      <h2 class="text-lg font-semibold text-gray-950">你的隐私偏好</h2>
      <p class="mt-2 text-sm text-gray-600">当前：{{ currentStatus }}</p>
      <p v-if="requiresChoice" class="mt-2 text-sm leading-6 text-gray-500">在你作出选择前，我们只使用网站正常运行所必需的信息。</p>
      <p v-if="saved" class="mt-2 text-sm text-green-700" role="status">设置已保存。</p>
      <p v-if="errorMessage" class="mt-2 text-sm text-red-600" role="alert">{{ errorMessage }}</p>
      <div class="mt-5 grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          data-privacy-choice="granted"
          :aria-pressed="state === 'granted'"
          :disabled="pending"
          class="rounded-md border px-4 py-3 text-left text-sm font-medium transition-colors disabled:opacity-60"
          :class="state === 'granted' ? 'border-gray-950 bg-gray-100 text-gray-950' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'"
          @click="choose('granted')"
        >允许效果分析</button>
        <button
          type="button"
          data-privacy-choice="denied"
          :aria-pressed="state === 'denied'"
          :disabled="pending"
          class="rounded-md border px-4 py-3 text-left text-sm font-medium transition-colors disabled:opacity-60"
          :class="state === 'denied' ? 'border-gray-950 bg-gray-100 text-gray-950' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'"
          @click="choose('denied')"
        >仅使用必要功能</button>
      </div>
    </section>

    <section class="border-b border-gray-200 py-7">
      <h2 class="text-lg font-semibold text-gray-950">信息用途</h2>
      <div class="mt-5 divide-y divide-gray-200 border-y border-gray-200">
        <div class="py-5">
          <div class="flex items-center justify-between gap-4">
            <h3 class="text-sm font-semibold text-gray-950">必要功能</h3>
            <span class="text-xs font-medium text-gray-500">始终启用</span>
          </div>
          <p class="mt-2 text-sm leading-7 text-gray-600">用于账户登录、安全防护、保存隐私偏好，以及提供你主动请求的浏览、注册和联系功能。这部分信息无法关闭。</p>
        </div>
        <div class="py-5">
          <div class="flex items-center justify-between gap-4">
            <h3 class="text-sm font-semibold text-gray-950">效果分析</h3>
            <span class="text-xs font-medium text-gray-500">由你决定</span>
          </div>
          <p class="mt-2 text-sm leading-7 text-gray-600">允许后，我们可能使用访问来源、浏览页面、设备与浏览器的基础信息，以及是否完成注册或发起联系，用于改善网站体验和衡量推广效果。</p>
        </div>
      </div>
    </section>

    <section class="border-b border-gray-200 py-7">
      <h2 class="text-lg font-semibold text-gray-950">我们如何保护信息</h2>
      <div class="mt-3 space-y-3 text-sm leading-7 text-gray-600">
        <p>我们不会读取聊天内容、密码、通讯录、联系人内容或受保护媒体内容，也不会出售你的个人信息。</p>
        <p>为完成效果统计，有限信息可能由受托的分析与推广服务提供方处理。信息只会提供给与你本次访问来源相关的服务方，不会同时提供给无关服务方。</p>
      </div>
    </section>

    <section class="py-7">
      <h2 class="text-lg font-semibold text-gray-950">管理你的选择</h2>
      <div class="mt-3 space-y-3 text-sm leading-7 text-gray-600">
        <p>你可以随时回到本页修改设置。选择“仅使用必要功能”后，我们会停止后续的可选效果分析。</p>
        <p>你的选择保存在当前浏览器中，最长保留 180 天；清除浏览器数据或更换浏览器后，可能需要重新选择。</p>
        <p>无论如何选择，都不会影响你浏览网站、注册账号或使用联系方式。浏览器表达的隐私偏好也会得到尊重。</p>
      </div>
    </section>
  </div>
</template>
