<script setup lang="ts">
import type { ContactMethod } from '@meigallery/shared'

const props = defineProps<{
  method: ContactMethod
}>()

const showQr = ref(false)
const isHovering = ref(false)
const copied = ref(false)

// 显示二维码：桌面悬浮或移动端点击
const showQrCode = computed(() => isHovering.value || showQr.value)

const hasLink = computed(() => !!props.method.linkUrl)
const hasQr = computed(() => !!props.method.qrCodeUrl)

function toggleQr() {
  showQr.value = !showQr.value
}

async function copyValue() {
  if (!navigator.clipboard) return
  try {
    await navigator.clipboard.writeText(props.method.value)
  } catch {
    return
  }
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

function activate() {
  if (hasQr.value) {
    toggleQr()
    return
  }
  if (!hasLink.value) copyValue()
}
</script>

<template>
  <div class="relative">
    <!-- 主行 -->
    <component
      :is="hasLink && !hasQr ? 'a' : 'div'"
      :href="hasLink && !hasQr ? method.linkUrl : undefined"
      :target="hasLink && !hasQr ? '_blank' : undefined"
      :rel="hasLink && !hasQr ? 'noopener noreferrer' : undefined"
      :role="hasLink && !hasQr ? undefined : 'button'"
      :tabindex="hasLink && !hasQr ? undefined : 0"
      class="group flex cursor-pointer items-center gap-3 rounded-2xl border border-transparent bg-white/70 px-3 py-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-[#f8e7dc] hover:bg-[#fffbf7] hover:shadow-sm"
      @mouseenter="hasQr ? (isHovering = true) : undefined"
      @mouseleave="hasQr ? (isHovering = false) : undefined"
      @click="activate"
      @keydown.enter.prevent="activate"
      @keydown.space.prevent="activate"
    >
      <!-- 平台图标 -->
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#fff7ed] to-gray-100 text-gray-600 ring-1 ring-white">
        <PlatformIcon :platform="method.platform" :size="18" />
      </span>

      <!-- 标签和值 -->
      <div class="flex-1 min-w-0">
        <span class="block text-sm font-medium text-gray-800">{{ method.label }}</span>
        <span class="mt-0.5 block truncate text-xs text-gray-400">{{ method.value }}</span>
      </div>

      <!-- 右侧操作区 -->
      <div class="flex items-center gap-1 text-xs text-gray-400">
        <span v-if="copied" class="rounded-full bg-green-50 px-2 py-1 text-green-600">已复制</span>
        <!-- 外链指示 -->
        <svg v-if="hasLink && !hasQr" class="h-3.5 w-3.5 opacity-50 transition-opacity group-hover:opacity-100" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />
        </svg>
        <!-- 二维码指示 -->
        <svg v-if="hasQr" class="h-3.5 w-3.5 text-[#bfa46a]" viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm13-2h3v3h-3v-3zm-5 0h3v3h-3v-3zm5 5h3v3h-3v-3zm-5 0h3v3h-3v-3zm2.5-2.5h3v3h-3v-3z" />
        </svg>
      </div>
    </component>

    <!-- 二维码弹出层 -->
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 scale-95"
      enter-to-class="opacity-100 scale-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="hasQr && showQrCode"
        class="mt-2 flex flex-col items-center rounded-2xl border border-[#f8e7dc] bg-[#fffbf7] p-3 shadow-lg shadow-orange-950/5"
        @mouseenter="isHovering = true"
        @mouseleave="isHovering = false"
      >
        <img
          :src="method.qrCodeUrl!"
          :alt="`${method.label} 二维码`"
          class="h-40 w-40 rounded-xl object-cover ring-1 ring-white"
        />
        <p class="mt-2 text-xs text-gray-500">扫码添加</p>
        <a
          v-if="hasLink"
          :href="method.linkUrl!"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-1 text-xs text-gray-800 underline decoration-[#d6c39a] underline-offset-4 hover:text-black"
        >
          点击跳转 →
        </a>
      </div>
    </Transition>
  </div>
</template>
