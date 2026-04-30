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

const typeKeys = computed(() => Object.keys(props.tags).filter(k => props.tags[k]?.length > 0))
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
  <div>
    <!-- 类型 Tab 行 -->
    <div class="flex gap-4 text-sm border-b border-gray-100 pb-2 mb-3 overflow-x-auto">
      <button
        v-for="key in typeKeys"
        :key="key"
        class="whitespace-nowrap"
        :class="activeType === key ? 'text-gray-900 font-semibold' : 'text-gray-400 hover:text-gray-600'"
        @click="activeType = key"
      >
        {{ typeLabels[key] || key }}
      </button>
    </div>

    <!-- 子标签 pill 行 -->
    <div class="flex flex-wrap gap-2">
      <button
        v-for="tag in activeTags"
        :key="tag.id"
        class="px-3 py-1 rounded-full text-xs transition-colors"
        :class="selectedSlugs.includes(tag.slug) ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'"
        @click="emit('toggle', tag.slug)"
      >
        {{ tag.name }}
      </button>
    </div>

    <!-- 已选标签展示行 -->
    <div v-if="selectedSlugs.length > 0" class="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
      <span class="text-gray-400 text-xs">筛选：</span>
      <span
        v-for="st in selectedTagNames"
        :key="st.slug"
        class="bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full text-xs flex items-center gap-1"
      >
        {{ st.name }}
        <button class="hover:text-blue-900" @click="emit('toggle', st.slug)">✕</button>
      </span>
      <button class="text-xs text-gray-400 hover:text-gray-600 ml-auto" @click="emit('clear')">清除全部</button>
    </div>
  </div>
</template>
