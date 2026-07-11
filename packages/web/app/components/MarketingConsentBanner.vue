<script setup lang="ts">
const { state, pending, grant, deny } = useMarketingConsent()
</script>

<template>
  <section
    v-if="state === 'limited'"
    class="fixed inset-x-0 bottom-0 z-[70] border-t border-gray-200 bg-white px-4 py-3 shadow-[0_-8px_24px_rgba(17,24,39,0.1)]"
    aria-label="营销追踪授权"
  >
    <div class="mx-auto flex max-w-7xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p class="text-sm text-gray-700">我们会在获得同意后使用营销追踪来衡量推广效果。</p>
      <div class="flex shrink-0 gap-2">
        <button type="button" :disabled="pending" class="rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60" @click="grant">同意营销追踪</button>
        <button type="button" :disabled="pending" class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60" @click="deny">仅必要功能</button>
      </div>
    </div>
  </section>
</template>
