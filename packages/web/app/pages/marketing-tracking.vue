<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { siteName } = useSiteSettings()
const { state, pending, grant, deny } = useMarketingConsent()
const saved = ref(false)
const errorMessage = ref('')

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
  title: () => `营销追踪说明 - ${siteName.value}`,
  description: '了解本站如何在获得同意后使用广告平台 Pixel 和 Server API 衡量推广效果。',
})
</script>

<template>
  <div class="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
    <header class="border-b border-gray-200 pb-7">
      <p class="text-sm font-medium text-gray-500">隐私与选择</p>
      <h1 class="mt-2 text-3xl font-semibold text-gray-950">营销追踪说明</h1>
      <p class="mt-4 text-sm leading-7 text-gray-600">本站仅在你明确同意后启用广告平台追踪，用于判断推广是否带来有效联系或完成注册，并优化广告投放效果。</p>
    </header>

    <section class="border-b border-gray-200 py-7">
      <h2 class="text-lg font-semibold text-gray-950">当前选择</h2>
      <p class="mt-2 text-sm text-gray-600">{{ state === 'granted' ? '已允许营销追踪' : state === 'denied' ? '仅使用必要功能' : '尚未选择' }}</p>
      <p v-if="saved" class="mt-2 text-sm text-green-700" role="status">设置已保存。</p>
      <p v-if="errorMessage" class="mt-2 text-sm text-red-600" role="alert">{{ errorMessage }}</p>
      <div class="mt-5 flex flex-col gap-2 sm:flex-row">
        <button type="button" :disabled="pending" class="rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60" @click="choose('granted')">允许营销追踪</button>
        <button type="button" :disabled="pending" class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60" @click="choose('denied')">仅必要功能</button>
      </div>
    </section>

    <section class="border-b border-gray-200 py-7">
      <h2 class="text-lg font-semibold text-gray-950">启用范围</h2>
      <div class="mt-3 space-y-3 text-sm leading-7 text-gray-600">
        <p>获得同意后，系统可能根据本次广告来源启用 Meta、TikTok 或 Google 中对应的一个平台，并发送 PageView、Contact、CompleteRegistration 等标准事件。</p>
        <p>不同平台严格隔离。来自 Meta 的访问不会发送到 TikTok，来自 TikTok 的访问也不会发送到 Meta 或 Google。</p>
        <p>浏览器 Pixel 与 Server API 使用同一事件编号去重；不会发送密码、聊天内容或受保护媒体内容。</p>
      </div>
    </section>

    <section class="py-7">
      <h2 class="text-lg font-semibold text-gray-950">拒绝与撤回</h2>
      <div class="mt-3 space-y-3 text-sm leading-7 text-gray-600">
        <p>未选择或选择“仅必要功能”时，系统不会加载广告平台 Pixel，也不会向广告平台发送 Server API 转化事件，站点必要功能不受影响。</p>
        <p>你的选择最多保存 180 天，可随时通过页面左下角的盾牌按钮或本页重新设置。撤回后，当前广告归因上下文会立即清除。</p>
      </div>
    </section>
  </div>
</template>
