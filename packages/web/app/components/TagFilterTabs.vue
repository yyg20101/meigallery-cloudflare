<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const props = defineProps<{
  tags: Record<string, Array<{ id: string; name: string; slug: string }>>
  selectedSlugs: string[]
}>()

const emit = defineEmits<{
  toggle: [slug: string]
  clear: []
}>()

const typeLabels: Record<string, string> = {
  region_scope: '地区',
  region_group: '地区组',
  city_country: '城市',
  identity: '身份',
  personality: '性格',
  style: '风格',
  occupation: '职业',
  hair: '发型',
  clothing: '服饰',
  scene: '场景',
  content_type: '内容类型',
}

const priorityTypes = ['region_scope', 'region_group', 'city_country', 'region', 'city']
const typeKeys = computed(() => {
  const keys = Object.keys(props.tags).filter(k => props.tags[k]?.length > 0)
  return keys.sort((a, b) => {
    const ai = priorityTypes.includes(a) ? priorityTypes.indexOf(a) : 100
    const bi = priorityTypes.includes(b) ? priorityTypes.indexOf(b) : 100
    return ai - bi
  })
})
const activeType = ref(typeKeys.value[0] || '')

watch(typeKeys, (keys) => {
  if (!keys.includes(activeType.value) && keys.length > 0) {
    activeType.value = keys[0]
  }
})

const activeTags = computed(() => props.tags[activeType.value] || [])

const selectedTagNames = computed(() => {
  const all = Object.values(props.tags).flat()
  return props.selectedSlugs.map(slug => {
    const found = all.find(t => t.slug === slug)
    return found ? { slug, name: found.name } : { slug, name: slug }
  })
})
</script>

<template>
  <div class="rounded-[1.5rem] border border-[#f0e4d8] bg-white/86 p-4 shadow-sm shadow-orange-950/5 backdrop-blur">
    <div class="flex gap-2 overflow-x-auto border-b border-[#f0e4d8] pb-3 text-sm scrollbar-hide">
      <button
        v-for="key in typeKeys"
        :key="key"
        class="whitespace-nowrap rounded-full px-3 py-1.5 transition-all"
        :class="activeType === key ? 'bg-gray-950 text-white shadow-sm' : 'text-gray-500 hover:bg-orange-50 hover:text-gray-950'"
        @click="activeType = key"
      >
        {{ typeLabels[key] || key }}
      </button>
    </div>

    <div class="mt-3 flex flex-wrap gap-2">
      <button
        v-for="tag in activeTags"
        :key="tag.id"
        class="rounded-full border px-3 py-1 text-xs transition-all"
        :class="selectedSlugs.includes(tag.slug) ? 'border-gray-950 bg-gray-950 text-white' : 'border-transparent bg-[#f8e7dc]/55 text-gray-700 hover:border-[#e8d5c5] hover:bg-[#fff7ed]'"
        @click="emit('toggle', tag.slug)"
      >
        {{ tag.name }}
      </button>
    </div>

    <div v-if="selectedSlugs.length > 0" class="mt-3 flex items-center gap-2 border-t border-[#f0e4d8] pt-3">
      <span class="text-xs text-gray-400">筛选：</span>
      <span
        v-for="st in selectedTagNames"
        :key="st.slug"
        class="flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-xs text-gray-800 ring-1 ring-[#eadfd2]"
      >
        {{ st.name }}
        <button class="hover:text-gray-950" @click="emit('toggle', st.slug)">✕</button>
      </span>
      <button class="ml-auto text-xs text-gray-400 hover:text-gray-700" @click="emit('clear')">清除全部</button>
    </div>
  </div>
</template>
