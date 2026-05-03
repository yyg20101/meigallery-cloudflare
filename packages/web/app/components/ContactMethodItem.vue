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

function copyValue() {
  navigator.clipboard?.writeText(props.method.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
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
      class="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors hover:bg-gray-50 cursor-pointer group"
      @mouseenter="hasQr ? (isHovering = true) : undefined"
      @mouseleave="hasQr ? (isHovering = false) : undefined"
      @click="hasQr ? toggleQr() : (!hasLink ? copyValue() : undefined)"
    >
      <!-- 平台图标 -->
      <PlatformIcon :platform="method.platform" :size="18" class="text-gray-500" />

      <!-- 标签和值 -->
      <div class="flex-1 min-w-0">
        <span class="text-sm text-gray-600">{{ method.label }}</span>
      </div>

      <!-- 右侧操作区 -->
      <div class="flex items-center gap-1 text-xs text-gray-400">
        <span v-if="!hasLink && !hasQr" class="truncate max-w-[120px]">{{ method.value }}</span>
        <span v-if="copied" class="text-green-500">已复制</span>
        <!-- 外链指示 -->
        <svg v-if="hasLink && !hasQr" class="w-3.5 h-3.5 opacity-0 group-hover:opacity-100 transition-opacity" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />
        </svg>
        <!-- 二维码指示 -->
        <svg v-if="hasQr" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
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
        class="mt-2 flex flex-col items-center rounded-xl border border-gray-100 bg-white p-3 shadow-lg"
        @mouseenter="isHovering = true"
        @mouseleave="isHovering = false"
      >
        <img
          :src="method.qrCodeUrl!"
          :alt="`${method.label} 二维码`"
          class="w-40 h-40 rounded-lg object-cover"
        />
        <p class="text-xs text-gray-500 mt-2">扫码添加</p>
        <a
          v-if="hasLink"
          :href="method.linkUrl!"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-1 text-xs text-blue-500 hover:text-blue-600"
        >
          点击跳转 →
        </a>
      </div>
    </Transition>
  </div>
</template>
