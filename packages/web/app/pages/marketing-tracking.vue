<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { siteName } = useSiteSettings()
const { state, pending, policyMode, decisionSource, requiresChoice, grant, deny } = useMarketingConsent()
const saved = ref(false)
const errorMessage = ref('')

const currentStatus = computed(() => {
  if (decisionSource.value === 'gpc') return '浏览器隐私偏好已关闭效果分析'
  if (decisionSource.value === 'disabled') return '站点当前已关闭效果分析'
  if (state.value === 'granted') return '效果分析已启用'
  if (state.value === 'denied') return '仅使用必要功能'
  return '需要你先选择'
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
  title: () => `广告效果分析 - ${siteName.value}`,
  description: '了解本站如何根据地区规则使用广告平台 Pixel 和 Server API 衡量推广效果，以及如何随时关闭。',
})
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
    <header class="border-b border-gray-200 pb-7">
      <p class="text-sm font-medium text-gray-500">隐私与选择</p>
      <h1 class="mt-2 text-3xl font-semibold text-gray-950">广告效果分析</h1>
      <p class="mt-4 text-sm leading-7 text-gray-600">我们用效果分析判断推广是否带来有效联系或完成注册，从而减少无关推广。不会读取聊天内容、密码、联系人内容或受保护媒体内容。</p>
    </header>

    <section class="border-b border-gray-200 py-7">
      <h2 class="text-lg font-semibold text-gray-950">当前设置</h2>
      <p class="mt-2 text-sm text-gray-600">{{ currentStatus }}</p>
      <p v-if="policyMode === 'notice_opt_out' && state === 'granted'" class="mt-2 text-sm leading-6 text-gray-500">你所在地区适用“明确告知并可退出”的方式，效果分析当前正常工作。</p>
      <p v-else-if="requiresChoice" class="mt-2 text-sm leading-6 text-gray-500">你所在地区需要先选择，选择前不会加载广告平台 Pixel 或发送 Server API 事件。</p>
      <p v-if="saved" class="mt-2 text-sm text-green-700" role="status">设置已保存。</p>
      <p v-if="errorMessage" class="mt-2 text-sm text-red-600" role="alert">{{ errorMessage }}</p>
      <div class="mt-5 flex flex-col gap-2 sm:flex-row">
        <button type="button" :disabled="pending" class="rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60" @click="choose('granted')">启用效果分析</button>
        <button type="button" :disabled="pending" class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60" @click="choose('denied')">关闭效果分析</button>
      </div>
    </section>

    <section class="border-b border-gray-200 py-7">
      <h2 class="text-lg font-semibold text-gray-950">发送哪些事件</h2>
      <div class="mt-3 space-y-3 text-sm leading-7 text-gray-600">
        <p>系统会根据本次广告来源，只启用 Meta、TikTok 或 Google 中对应的一个平台，并发送 PageView、Contact、CompleteRegistration 等标准事件。</p>
        <p>不同平台严格隔离。来自 Meta 的访问不会发送到 TikTok，来自 TikTok 的访问也不会发送到 Meta 或 Google。</p>
        <p>浏览器 Pixel 与 Server API 使用同一事件编号去重。未允许营销衡量时，站内有效联系事实仍会记录，但不会投递给广告平台。</p>
      </div>
    </section>

    <section class="py-7">
      <h2 class="text-lg font-semibold text-gray-950">地区规则与撤回</h2>
      <div class="mt-3 space-y-3 text-sm leading-7 text-gray-600">
        <p>严格地区在你选择前不会启用广告平台追踪；其他地区会在明确告知并提供退出入口后启用。无法识别地区时按严格方式处理。</p>
        <p>你的明确选择最多保存 180 天，并始终优先于地区默认值。浏览器发送 GPC 隐私信号时，系统会关闭效果分析。</p>
        <p>关闭后，当前广告归因上下文会立即清除，网站浏览、注册和联系方式仍可正常使用。</p>
      </div>
    </section>
  </div>
</template>
