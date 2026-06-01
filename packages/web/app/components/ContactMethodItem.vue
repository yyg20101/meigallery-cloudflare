<script setup lang="ts">
import type { ContactMethod } from '@meigallery/shared'
import { generateContactLink } from '@meigallery/shared/constants'
import { normalizeContactActionUrl, normalizeContactQrCodeUrl } from '~/utils/contactUrlSecurity'

const props = defineProps<{
  method: ContactMethod
}>()
const emit = defineEmits<{ activate: [methodType: string] }>()

const showQr = ref(false)
const isHovering = ref(false)
const copied = ref(false)
const copyFailed = ref(false)

// 显示二维码：桌面悬浮或移动端点击
const showQrCode = computed(() => isHovering.value || showQr.value)

const actionHref = computed(() => props.method.linkUrl || generateContactLink(props.method.platform, props.method.value))
const safeActionHref = computed(() => normalizeContactActionUrl(actionHref.value))
const hasLink = computed(() => !!safeActionHref.value)
const safeQrCodeUrl = computed(() => normalizeContactQrCodeUrl(props.method.qrCodeUrl))
const hasQr = computed(() => !!safeQrCodeUrl.value)

function toggleQr() {
  showQr.value = !showQr.value
}

async function copyValue() {
  copyFailed.value = false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(props.method.value)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = props.method.value
      textarea.setAttribute('readonly', 'true')
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
  } catch {
    copyFailed.value = true
    setTimeout(() => { copyFailed.value = false }, 2000)
    return
  }
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

function activate() {
  emit('activate', props.method.platform)
  if (safeActionHref.value) {
    window.open(safeActionHref.value, '_blank', 'noopener,noreferrer')
    return
  }
  copyValue()
}
</script>

<template>
  <div class="relative">
    <!-- 主行 -->
    <div
      role="button"
      tabindex="0"
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
        <span v-else-if="copyFailed" class="rounded-full bg-orange-50 px-2 py-1 text-orange-600">手动复制</span>
        <!-- 外链指示 -->
        <svg v-if="hasLink" class="h-3.5 w-3.5 opacity-50 transition-opacity group-hover:opacity-100" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />
        </svg>
        <!-- 复制指示 -->
        <svg v-else class="h-3.5 w-3.5 opacity-50 transition-opacity group-hover:opacity-100" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M8 7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V7Z" />
          <path d="M16 5V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" />
        </svg>
        <!-- 二维码指示 -->
        <button
          v-if="hasQr"
          type="button"
          class="ml-1 rounded-full p-1 text-[#bfa46a] transition-colors hover:bg-orange-50 focus:outline-none focus:ring-2 focus:ring-[#d6c39a]"
          :aria-expanded="showQrCode"
          :aria-label="showQrCode ? '收起二维码' : '展开二维码'"
          @click.stop="toggleQr"
          @keydown.enter.stop
          @keydown.space.stop
        >
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm13-2h3v3h-3v-3zm-5 0h3v3h-3v-3zm5 5h3v3h-3v-3zm-5 0h3v3h-3v-3zm2.5-2.5h3v3h-3v-3z" />
          </svg>
        </button>
      </div>
    </div>

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
          :src="safeQrCodeUrl!"
          :alt="`${method.label} 二维码`"
          class="h-40 w-40 rounded-xl object-cover ring-1 ring-white"
        />
        <p class="mt-2 text-xs text-gray-500">扫码添加</p>
        <a
          v-if="hasLink"
          :href="safeActionHref || undefined"
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
