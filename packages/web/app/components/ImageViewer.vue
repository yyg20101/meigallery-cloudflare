<script setup lang="ts">
/**
 * 图片查看器（Lightbox）
 * 全屏展示图片，支持左右导航、键盘操作、触摸滑动
 */

interface ViewerImage {
  id: string
  url: string
  alt?: string
}

const props = defineProps<{
  images: ViewerImage[]
  startIndex?: number
}>()

const emit = defineEmits<{
  close: []
}>()

const currentIndex = ref(props.startIndex ?? 0)
const imageLoading = ref(true)
const touchStartX = ref(0)
const touchDeltaX = ref(0)

const currentImage = computed(() => props.images[currentIndex.value])
const total = computed(() => props.images.length)

function prev() {
  if (currentIndex.value > 0) {
    imageLoading.value = true
    currentIndex.value--
  }
}

function next() {
  if (currentIndex.value < total.value - 1) {
    imageLoading.value = true
    currentIndex.value++
  }
}

function onImageLoaded() {
  imageLoading.value = false
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
  else if (e.key === 'ArrowLeft') prev()
  else if (e.key === 'ArrowRight') next()
}

function onTouchStart(e: TouchEvent) {
  touchStartX.value = e.touches[0]!.clientX
  touchDeltaX.value = 0
}

function onTouchMove(e: TouchEvent) {
  touchDeltaX.value = e.touches[0]!.clientX - touchStartX.value
}

function onTouchEnd() {
  if (Math.abs(touchDeltaX.value) > 60) {
    if (touchDeltaX.value > 0) prev()
    else next()
  }
  touchDeltaX.value = 0
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  // 禁止背景滚动
  document.body.style.overflow = 'hidden'
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <div
      class="fixed inset-0 z-[100] flex items-center justify-center bg-black/95"
      @click.self="emit('close')"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @touchend="onTouchEnd"
    >
      <!-- 顶部栏 -->
      <div class="absolute top-0 inset-x-0 z-10 flex items-center justify-between px-4 py-3">
        <span class="text-white/70 text-sm">
          {{ currentIndex + 1 }} / {{ total }}
        </span>
        <button
          class="text-white/70 hover:text-white p-2 transition-colors"
          @click="emit('close')"
        >
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- 上一张按钮 -->
      <button
        v-if="currentIndex > 0"
        class="absolute left-2 sm:left-4 z-10 text-white/50 hover:text-white p-2 rounded-full bg-black/30 hover:bg-black/50 transition-all"
        @click.stop="prev"
      >
        <svg class="w-6 h-6 sm:w-8 sm:h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <!-- 图片 -->
      <div class="flex items-center justify-center w-full h-full px-12 sm:px-20 py-16">
        <!-- 加载指示器 -->
        <div v-if="imageLoading" class="absolute inset-0 flex items-center justify-center">
          <div class="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        </div>
        <img
          v-if="currentImage"
          :key="currentImage.id"
          :src="currentImage.url"
          :alt="currentImage.alt || ''"
          referrerpolicy="no-referrer"
          class="max-w-full max-h-full object-contain select-none transition-opacity duration-200"
          :class="imageLoading ? 'opacity-0' : 'opacity-100'"
          draggable="false"
          @load="onImageLoaded"
        />
      </div>

      <!-- 下一张按钮 -->
      <button
        v-if="currentIndex < total - 1"
        class="absolute right-2 sm:right-4 z-10 text-white/50 hover:text-white p-2 rounded-full bg-black/30 hover:bg-black/50 transition-all"
        @click.stop="next"
      >
        <svg class="w-6 h-6 sm:w-8 sm:h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  </Teleport>
</template>
