<script setup lang="ts">
const { pending, requiresChoice, grant, deny } = useMarketingConsent()
const route = useRoute()
const errorMessage = ref('')

const outsideTrackingPage = computed(() => route.path !== '/marketing-tracking')
const showChoiceBanner = computed(() => outsideTrackingPage.value && requiresChoice.value)

async function choose(nextState: 'granted' | 'denied') {
  errorMessage.value = ''
  try {
    await (nextState === 'granted' ? grant() : deny())
  }
  catch {
    errorMessage.value = '保存失败，请稍后重试。'
  }
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

</template>
