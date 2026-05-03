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
  <div class="rounded-[1.5rem] border border-[#f0e4d8] bg-white/86 p-4 shadow-sm shadow-orange-950/5">
    <div class="space-y-3">
      <div v-for="(items, type) in tags" :key="type" class="flex flex-wrap items-center gap-2">
        <span class="w-20 shrink-0 text-xs font-medium text-gray-500">{{ tagTypeLabels[type as string] || type }}</span>
        <button
          v-for="tag in items"
          :key="tag.slug"
          :class="[
            'rounded-full border px-3 py-1 text-xs transition-all',
            selectedTags.includes(tag.slug)
              ? 'border-gray-950 bg-gray-950 text-white shadow-sm'
              : 'border-transparent bg-[#f8e7dc]/55 text-gray-700 hover:border-[#e8d5c5] hover:bg-[#fff7ed]'
          ]"
          @click="emit('toggle', tag.slug)"
        >
          {{ tag.name }}
        </button>
      </div>
      <button
        v-if="selectedTags.length > 0"
        class="text-xs text-gray-500 hover:text-[#111] hover:underline"
        @click="emit('clear')"
      >
        清除全部筛选
      </button>
    </div>
  </div>
</template>
