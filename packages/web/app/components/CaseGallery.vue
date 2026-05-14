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
    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <button
        v-for="(image, index) in images"
        :key="image.id"
        type="button"
        class="group relative overflow-hidden rounded-[1.5rem] bg-orange-50 text-left shadow-sm shadow-orange-950/5 ring-1 ring-white/80 transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-orange-950/10"
        :class="index === 0 ? 'lg:col-span-2 lg:row-span-2' : ''"
        :aria-label="`查看案例图片 ${index + 1}`"
        @click="openViewer(index)"
      >
        <img :src="image.url" :alt="image.alt" class="aspect-[4/3] h-full w-full object-cover transition-transform duration-700 group-hover:scale-105" :loading="index === 0 ? 'eager' : 'lazy'" />
        <div class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/28 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        <span class="absolute bottom-3 left-3 rounded-full bg-white/88 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-950 opacity-0 shadow-sm shadow-gray-950/10 backdrop-blur transition-opacity duration-300 group-hover:opacity-100">{{ String(index + 2).padStart(2, '0') }}</span>
      </button>
    </div>
    <ImageViewer v-if="viewerOpen" :images="viewerImages" :start-index="activeIndex" @close="viewerOpen = false" />
  </div>
</template>
