<script setup lang="ts">
interface FilterBarProps {
  tags: Record<string, Array<{ id: string; name: string; slug: string }>>
  selectedTags: string[]
}
defineProps<FilterBarProps>()
const emit = defineEmits<{ toggle: [slug: string]; clear: [] }>()

const tagTypeLabels: Record<string, string> = {
  region_scope: '地区范围',
  region_group: '地区组',
  city_country: '城市/国家',
  identity: '身份',
  personality: '性格',
  style: '风格',
  occupation: '职业',
  hair: '发型',
  clothing: '服饰',
  scene: '场景',
  content_type: '内容类型',
}
</script>

<template>
  <div class="space-y-3">
    <div v-for="(items, type) in tags" :key="type" class="flex flex-wrap items-center gap-2">
      <span class="text-xs font-medium text-gray-500 w-20 shrink-0">{{ tagTypeLabels[type as string] || type }}</span>
      <button
        v-for="tag in items"
        :key="tag.slug"
        :class="[
          'rounded-full px-3 py-1 text-xs transition-colors',
          selectedTags.includes(tag.slug)
            ? 'bg-blue-600 text-white'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
        ]"
        @click="emit('toggle', tag.slug)"
      >
        {{ tag.name }}
      </button>
    </div>
    <button
      v-if="selectedTags.length > 0"
      class="text-xs text-blue-600 hover:underline"
      @click="emit('clear')"
    >
      清除全部筛选
    </button>
  </div>
</template>
