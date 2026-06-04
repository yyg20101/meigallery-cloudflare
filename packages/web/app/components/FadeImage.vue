<script setup lang="ts">
import { ref } from 'vue'

const props = withDefaults(defineProps<{
  src: string
  alt: string
  aspectRatio?: string
  class?: string
}>(), {
  aspectRatio: '3/4',
})

const loaded = ref(false)
const error = ref(false)

function onLoad() {
  loaded.value = true
}

function onError() {
  error.value = true
}
</script>

<template>
  <div class="relative overflow-hidden bg-gradient-to-br from-orange-50 via-gray-100 to-stone-100" :style="{ aspectRatio: props.aspectRatio }">
    <!-- 骨架占位 -->
    <div v-if="!loaded && !error" class="absolute inset-0 animate-pulse bg-[linear-gradient(110deg,#f6f1ec_8%,#fff_18%,#eee7df_33%)] bg-[length:200%_100%]" />
    <!-- 图片 -->
    <img
      v-if="!error"
      :src="props.src"
      :alt="props.alt"
      loading="lazy"
      referrerpolicy="no-referrer"
      class="h-full w-full object-cover transition-all duration-500 ease-out"
      :class="[loaded ? 'opacity-100' : 'opacity-0', props.class]"
      @load="onLoad"
      @error="onError"
    />
    <!-- 加载失败占位 -->
    <div v-if="error" class="flex h-full items-center justify-center text-gray-400">
      <span class="text-sm">加载失败</span>
    </div>
  </div>
</template>
