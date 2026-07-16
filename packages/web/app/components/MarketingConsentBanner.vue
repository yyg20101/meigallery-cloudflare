<script setup lang="ts">
const { state, pending, grant, deny } = useMarketingConsent()
const route = useRoute()
const settingsOpen = ref(false)
const errorMessage = ref('')
const showBanner = computed(() => state.value === 'limited' && route.path !== '/marketing-tracking')

async function choose(nextState: 'granted' | 'denied') {
  errorMessage.value = ''
  try {
    await (nextState === 'granted' ? grant() : deny())
    settingsOpen.value = false
  }
  catch {
    errorMessage.value = '保存失败，请稍后重试。'
  }
}
</script>

<template>
  <section
    v-if="showBanner"
    class="fixed inset-x-0 bottom-0 z-[70] border-t border-gray-200 bg-white px-4 py-3 shadow-[0_-8px_24px_rgba(17,24,39,0.1)]"
    aria-label="营销追踪授权"
  >
    <div class="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p class="text-sm leading-6 text-gray-700">
          允许营销追踪，用于衡量并优化广告效果。可随时更改。
          <NuxtLink to="/marketing-tracking" class="whitespace-nowrap font-medium text-gray-950 underline decoration-gray-300 underline-offset-4 hover:decoration-gray-700">了解详情</NuxtLink>
        </p>
        <p v-if="errorMessage" class="mt-1 text-sm text-red-600" role="alert">{{ errorMessage }}</p>
      </div>
      <div class="flex shrink-0 gap-2">
        <button type="button" :disabled="pending" class="rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60" @click="choose('granted')">同意</button>
        <button type="button" :disabled="pending" class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60" @click="choose('denied')">仅必要功能</button>
      </div>
    </div>
  </section>

  <button
    v-else-if="state !== 'limited'"
    type="button"
    class="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] left-4 z-[45] flex h-10 w-10 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600 shadow-md transition-colors hover:border-gray-300 hover:text-gray-950 lg:bottom-5"
    aria-label="打开营销追踪设置"
    title="营销追踪设置"
    @click="settingsOpen = true"
  >
    <UIcon name="i-lucide-shield-check" class="h-5 w-5" />
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
        <h2 id="marketing-consent-title" class="text-base font-semibold text-gray-950">营销追踪设置</h2>
        <button type="button" class="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-950" aria-label="关闭营销追踪设置" @click="settingsOpen = false">
          <UIcon name="i-lucide-x" class="h-4 w-4" />
        </button>
      </div>
      <p class="mt-3 text-sm leading-6 text-gray-600">当前状态：{{ state === 'granted' ? '已允许营销追踪' : '仅使用必要功能' }}</p>
      <p v-if="errorMessage" class="mt-2 text-sm text-red-600" role="alert">{{ errorMessage }}</p>
      <div class="mt-5 flex flex-col gap-2 sm:flex-row">
        <button type="button" :disabled="pending" class="rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60" @click="choose('granted')">允许营销追踪</button>
        <button type="button" :disabled="pending" class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60" @click="choose('denied')">仅必要功能</button>
      </div>
      <NuxtLink to="/marketing-tracking" class="mt-4 inline-block text-sm font-medium text-gray-700 underline decoration-gray-300 underline-offset-4 hover:text-gray-950" @click="settingsOpen = false">查看营销追踪说明</NuxtLink>
    </section>
  </div>
</template>
