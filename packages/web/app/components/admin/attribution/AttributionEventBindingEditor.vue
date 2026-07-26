<script setup lang="ts">
import type {
  AttributionEventBindingDraft,
  AttributionPlatformDefinition,
} from '~/utils/attributionPlatforms'

const props = withDefaults(defineProps<{
  platform: AttributionPlatformDefinition
  modelValue: AttributionEventBindingDraft[]
  disabled?: boolean
}>(), {
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: AttributionEventBindingDraft[]]
}>()

function update(index: number, patch: Partial<AttributionEventBindingDraft>) {
  emit('update:modelValue', props.modelValue.map((binding, bindingIndex) => (
    bindingIndex === index ? { ...binding, ...patch } : binding
  )))
}
</script>

<template>
  <section data-attribution-binding-editor class="min-w-0 border-y border-gray-200 bg-white">
    <div class="border-b border-gray-200 px-3 py-4 sm:px-5">
      <h2 class="text-base font-semibold text-gray-900">事件绑定</h2>
      <p class="mt-1 text-xs text-gray-500">{{ platform.browserLabel }} / {{ platform.serverLabel }}</p>
    </div>
    <div class="divide-y divide-gray-200">
      <div v-for="(definition, index) in platform.eventBindings" :key="definition.canonicalEvent" class="grid min-w-0 gap-4 px-3 py-4 sm:px-5 lg:grid-cols-[minmax(10rem,0.7fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div class="flex min-w-0 items-start gap-3">
          <input
            :checked="modelValue[index]?.enabled"
            :disabled="disabled"
            :aria-label="`启用${definition.label}`"
            type="checkbox"
            class="mt-1"
            @change="update(index, { enabled: ($event.target as HTMLInputElement).checked })"
          >
          <div class="min-w-0">
            <p class="text-sm font-semibold text-gray-900">{{ definition.label }}</p>
            <p class="mt-0.5 text-xs text-gray-500">{{ definition.canonicalEvent }}</p>
          </div>
        </div>
        <label class="min-w-0">
          <span class="mb-1 block text-xs font-medium text-gray-600">{{ definition.browser.label }}</span>
          <input
            :value="modelValue[index]?.browserDestination || ''"
            :readonly="!definition.browser.editable"
            :disabled="disabled"
            :required="definition.browser.editable"
            :pattern="definition.browser.pattern"
            :placeholder="definition.browser.placeholder"
            autocomplete="off"
            class="h-10 w-full min-w-0 rounded-md border border-gray-300 px-3 text-sm read-only:bg-gray-50 read-only:text-gray-600 focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
            @input="update(index, { browserDestination: ($event.target as HTMLInputElement).value })"
          >
        </label>
        <label class="min-w-0">
          <span class="mb-1 block text-xs font-medium text-gray-600">{{ definition.server.label }}</span>
          <input
            :value="modelValue[index]?.serverDestination || ''"
            :readonly="!definition.server.editable"
            :disabled="disabled"
            :required="definition.server.editable"
            :pattern="definition.server.pattern"
            :placeholder="definition.server.placeholder"
            autocomplete="off"
            class="h-10 w-full min-w-0 rounded-md border border-gray-300 px-3 text-sm read-only:bg-gray-50 read-only:text-gray-600 focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
            @input="update(index, { serverDestination: ($event.target as HTMLInputElement).value })"
          >
        </label>
      </div>
    </div>
  </section>
</template>
