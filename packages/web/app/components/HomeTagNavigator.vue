<script setup lang="ts">
type HomeTag = { id: string; name: string; slug: string; type: string }

const props = defineProps<{
  cities: HomeTag[]
  regions: HomeTag[]
  styles: HomeTag[]
}>()
const { trackFilterSelected } = useFacebookPixel()

const groups = computed(() => [
  { key: 'cities', title: '热门城市', description: '优先进入具体城市与地区内容。', items: props.cities },
  { key: 'regions', title: '地区组', description: '按国内外、地区范围快速浏览。', items: props.regions },
  { key: 'styles', title: '风格偏好', description: '用气质、场景和风格继续细分。', items: props.styles },
].filter(group => group.items.length > 0))

function trackTagClick(tag: HomeTag) {
  trackFilterSelected({ tagSlug: tag.slug, tagType: tag.type, location: 'home_tag_navigator' })
}
</script>

<template>
  <section v-if="groups.length" class="overflow-hidden rounded-[2rem] border border-[#f0e4d8] bg-[#fffbf7] p-4 shadow-xl shadow-orange-950/6 lg:p-6">
    <EditorialSectionHeading eyebrow="Tag Navigator" title="按城市和风格直达" description="城市优先，风格辅助，减少从首页到目标内容的点击路径。" />

    <div class="mt-5 grid gap-3 lg:grid-cols-3">
      <div v-for="group in groups" :key="group.key" class="rounded-[1.5rem] border border-white/80 bg-white/88 p-4 shadow-sm shadow-orange-950/4">
        <h3 class="text-sm font-semibold text-gray-950">{{ group.title }}</h3>
        <p class="mt-1 text-xs text-gray-500">{{ group.description }}</p>
        <div class="mt-4 flex gap-2 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible">
          <NuxtLink
            v-for="tag in group.items"
            :key="tag.slug"
            :to="{ path: '/discover', query: { tag: tag.slug } }"
            class="flex min-h-11 shrink-0 items-center rounded-full border border-[#f0e4d8] bg-[#fffbf7] px-3 py-2 text-sm text-gray-700 transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:bg-gray-950 hover:text-white"
            @click="trackTagClick(tag)"
          >
            {{ tag.name }}
          </NuxtLink>
        </div>
      </div>
    </div>
  </section>
</template>
