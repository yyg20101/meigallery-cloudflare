<script setup lang="ts">
const { state, pending, decisionSource, requiresChoice, grant, deny } = useMarketingConsent()
const route = useRoute()
const settingsOpen = ref(false)
const errorMessage = ref('')
const noticeDismissed = ref(false)
const NOTICE_DISMISSED_KEY = 'mei_marketing_notice_dismissed_v1'

const outsideTrackingPage = computed(() => route.path !== '/marketing-tracking')
const showChoiceBanner = computed(() => outsideTrackingPage.value && requiresChoice.value)
const showNoticeBanner = computed(() => outsideTrackingPage.value
  && state.value === 'granted'
  && decisionSource.value === 'regional_default'
  && !noticeDismissed.value)
const showSettingsButton = computed(() => outsideTrackingPage.value
  && !showChoiceBanner.value
  && !showNoticeBanner.value
  && state.value !== 'limited')
const statusText = computed(() => {
  if (decisionSource.value === 'gpc') return '浏览器隐私偏好已关闭效果分析'
  if (decisionSource.value === 'disabled') return '效果分析已由站点关闭'
  if (state.value === 'granted') return '效果分析已启用'
  if (state.value === 'denied') return '仅使用必要功能'
  return '等待你的选择'
})

onMounted(() => {
  noticeDismissed.value = window.localStorage.getItem(NOTICE_DISMISSED_KEY) === '1'
})

async function choose(nextState: 'granted' | 'denied') {
  errorMessage.value = ''
  try {
    await (nextState === 'granted' ? grant() : deny())
    settingsOpen.value = false
    dismissNotice()
  }
  catch {
    errorMessage.value = '保存失败，请稍后重试。'
  }
}

function dismissNotice() {
  noticeDismissed.value = true
  window.localStorage.setItem(NOTICE_DISMISSED_KEY, '1')
}
</script>

<template>
  <section
    v-if="showChoiceBanner"
    class="fixed inset-x-0 bottom-0 z-[70] border-t border-gray-200 bg-white px-4 py-3 shadow-[0_-8px_24px_rgba(17,24,39,0.1)]"
    aria-label="营销效果分析选择"
  >
    <div class="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="max-w-3xl">
        <p class="text-sm font-medium text-gray-950">帮助我们减少无关推广</p>
        <p class="mt-1 text-sm leading-6 text-gray-600">
          允许衡量访问是否带来有效联系或完成注册。不会读取聊天内容、密码或联系人内容，可随时关闭。
          <NuxtLink to="/marketing-tracking" class="whitespace-nowrap font-medium text-gray-950 underline decoration-gray-300 underline-offset-4 hover:decoration-gray-700">了解详情</NuxtLink>
        </p>
        <p v-if="errorMessage" class="mt-1 text-sm text-red-600" role="alert">{{ errorMessage }}</p>
      </div>
      <div class="flex shrink-0 gap-2">
        <button type="button" data-consent-choice="granted" :disabled="pending" class="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60" @click="choose('granted')">允许效果分析</button>
        <button type="button" data-consent-choice="denied" :disabled="pending" class="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60" @click="choose('denied')">仅使用必要功能</button>
      </div>
    </div>
  </section>

  <section
    v-else-if="showNoticeBanner"
    class="fixed inset-x-0 bottom-0 z-[70] border-t border-gray-200 bg-white px-4 py-3 shadow-[0_-8px_24px_rgba(17,24,39,0.1)]"
    aria-label="营销效果分析说明"
  >
    <div class="mx-auto flex max-w-7xl items-start justify-between gap-4 sm:items-center">
      <p class="max-w-4xl text-sm leading-6 text-gray-600">
        我们使用广告效果分析判断推广是否带来有效联系，从而减少无关推广；不会读取聊天内容或密码。
        <NuxtLink to="/marketing-tracking" class="whitespace-nowrap font-medium text-gray-950 underline decoration-gray-300 underline-offset-4">管理设置</NuxtLink>
      </p>
      <button type="button" class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-950" aria-label="关闭效果分析说明" title="关闭说明" @click="dismissNotice">
        <UIcon name="i-lucide-x" class="h-4 w-4" />
      </button>
    </div>
  </section>

  <button
    v-else-if="showSettingsButton"
    type="button"
    class="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-4 z-[45] flex h-10 w-10 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600 shadow-md transition-colors hover:border-gray-300 hover:text-gray-950 lg:bottom-5"
    aria-label="打开效果分析设置"
    title="效果分析设置"
    @click="settingsOpen = true"
  >
    <UIcon :name="state === 'granted' ? 'i-lucide-shield-check' : 'i-lucide-shield-off'" class="h-5 w-5" />
  </button>

  <div
    v-if="settingsOpen"
    class="fixed inset-0 z-[80] flex items-end justify-center bg-black/30 p-4 sm:items-center"
    role="dialog"
    aria-modal="true"
    aria-labelledby="marketing-consent-title"
    @click.self="settingsOpen = false"
  >
    <section class="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
      <div class="flex items-center justify-between gap-4">
        <h2 id="marketing-consent-title" class="text-base font-semibold text-gray-950">效果分析设置</h2>
        <button type="button" class="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-950" aria-label="关闭效果分析设置" @click="settingsOpen = false">
          <UIcon name="i-lucide-x" class="h-4 w-4" />
        </button>
      </div>
      <p class="mt-3 text-sm leading-6 text-gray-600">当前状态：{{ statusText }}</p>
      <p class="mt-2 text-sm leading-6 text-gray-500">用于衡量有效联系和完成注册，不读取聊天内容、密码或联系人内容。</p>
      <p v-if="errorMessage" class="mt-2 text-sm text-red-600" role="alert">{{ errorMessage }}</p>
      <div class="mt-5 flex flex-col gap-2 sm:flex-row">
        <button type="button" data-consent-choice="granted" :aria-pressed="state === 'granted'" :disabled="pending" class="rounded-md border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60" :class="state === 'granted' ? 'border-gray-950 bg-gray-100 text-gray-950' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'" @click="choose('granted')">允许效果分析</button>
        <button type="button" data-consent-choice="denied" :aria-pressed="state === 'denied'" :disabled="pending" class="rounded-md border px-4 py-2 text-sm font-medium transition-colors disabled:opacity-60" :class="state === 'denied' ? 'border-gray-950 bg-gray-100 text-gray-950' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50'" @click="choose('denied')">仅使用必要功能</button>
      </div>
      <NuxtLink to="/marketing-tracking" class="mt-4 inline-block text-sm font-medium text-gray-700 underline decoration-gray-300 underline-offset-4 hover:text-gray-950" @click="settingsOpen = false">查看完整说明</NuxtLink>
    </section>
  </div>
</template>
