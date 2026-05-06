<script setup lang="ts">
const props = defineProps<{
  images: Array<{ id: string; url: string; alt: string; sortOrder: number }>
}>()

const viewerOpen = ref(false)
const activeIndex = ref(0)

function openViewer(index: number) {
  activeIndex.value = index
  viewerOpen.value = true
}

const viewerImages = computed(() => props.images.map(image => ({ id: image.id, url: image.url, alt: image.alt })))
</script>

<template>
  <div>
    <div class="grid gap-3 sm:grid-cols-2">
      <button
        v-for="(image, index) in images"
        :key="image.id"
        type="button"
        class="group overflow-hidden rounded-[1.5rem] bg-orange-50 text-left shadow-sm shadow-orange-950/5 ring-1 ring-white/80"
        :aria-label="`查看案例图片 ${index + 1}`"
        @click="openViewer(index)"
      >
        <img :src="image.url" :alt="image.alt" class="aspect-[4/3] h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" :loading="index === 0 ? 'eager' : 'lazy'" />
      </button>
    </div>
    <ImageViewer v-if="viewerOpen" :images="viewerImages" :start-index="activeIndex" @close="viewerOpen = false" />
  </div>
</template>
