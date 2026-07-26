<script setup lang="ts">
import type { AdPlatformRolloutPercentage } from '@meigallery/shared'

withDefaults(defineProps<{
  browserEnabled: boolean
  serverTargetPercentage: AdPlatformRolloutPercentage
  serverEffectivePercentage?: AdPlatformRolloutPercentage
  disabled?: boolean
}>(), {
  serverEffectivePercentage: 0,
  disabled: false,
})

const emit = defineEmits<{
  'update:browserEnabled': [value: boolean]
  'update:serverTargetPercentage': [value: AdPlatformRolloutPercentage]
}>()

const browserOptions = [
  { label: '0%', value: false },
  { label: '100%', value: true },
] as const
const serverOptions: readonly AdPlatformRolloutPercentage[] = [0, 10, 50, 100]
</script>

<template>
  <section data-attribution-rollout-control class="min-w-0 border-y border-gray-200 bg-white">
    <div class="border-b border-gray-200 px-3 py-4 sm:px-5">
      <h2 class="text-base font-semibold text-gray-900">投放控制</h2>
      <p class="mt-1 text-xs text-gray-500">Server effective {{ serverEffectivePercentage }}%</p>
    </div>
    <div class="grid gap-5 px-3 py-5 sm:px-5 lg:grid-cols-2">
      <fieldset>
        <legend class="mb-2 text-xs font-medium text-gray-600">Browser</legend>
        <div class="grid w-full max-w-xs grid-cols-2 rounded-md border border-gray-300 bg-gray-50 p-1 sm:inline-grid sm:w-auto">
          <button
            v-for="option in browserOptions"
            :key="option.label"
            type="button"
            :disabled="disabled"
            :aria-pressed="browserEnabled === option.value"
            :class="browserEnabled === option.value ? 'bg-gray-950 text-white' : 'text-gray-600 hover:bg-white'"
            class="min-h-9 min-w-0 rounded px-3 text-sm font-medium disabled:opacity-50 sm:min-w-20"
            @click="emit('update:browserEnabled', option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </fieldset>
      <fieldset>
        <legend class="mb-2 text-xs font-medium text-gray-600">Server target</legend>
        <div class="grid w-full grid-cols-4 rounded-md border border-gray-300 bg-gray-50 p-1 sm:inline-grid sm:w-auto">
          <button
            v-for="percentage in serverOptions"
            :key="percentage"
            type="button"
            :disabled="disabled"
            :aria-pressed="serverTargetPercentage === percentage"
            :class="serverTargetPercentage === percentage ? 'bg-gray-950 text-white' : 'text-gray-600 hover:bg-white'"
            class="min-h-9 min-w-0 rounded px-2 text-sm font-medium disabled:opacity-50 sm:min-w-16"
            @click="emit('update:serverTargetPercentage', percentage)"
          >
            {{ percentage }}%
          </button>
        </div>
      </fieldset>
    </div>
  </section>
</template>
