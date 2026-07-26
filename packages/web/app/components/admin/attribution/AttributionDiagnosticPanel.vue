<script setup lang="ts">
import type { AdPlatformDiagnosticData } from '~/composables/useAdminAttribution'
import type { AttributionPlatformDefinition } from '~/utils/attributionPlatforms'

withDefaults(defineProps<{
  platform: AttributionPlatformDefinition
  diagnostic?: AdPlatformDiagnosticData | null
  testEventCode: string
  loading?: boolean
  disabled?: boolean
}>(), {
  diagnostic: null,
  loading: false,
  disabled: false,
})

const emit = defineEmits<{
  'update:testEventCode': [value: string]
  test: []
}>()
</script>

<template>
  <section data-attribution-diagnostic class="border-y border-gray-200 bg-white">
    <div class="px-3 py-4 sm:px-5">
      <h2 class="text-base font-semibold text-gray-900">实时连接测试</h2>
      <p class="mt-1 text-sm text-gray-500">直接检查目标、凭证和事件接口；不创建任务，不等待人工确认。</p>
    </div>

    <div class="grid gap-4 border-t border-gray-200 px-3 py-4 sm:grid-cols-[minmax(0,24rem)_auto] sm:items-end sm:px-5">
      <label v-if="platform.testEvent" class="min-w-0">
        <span class="mb-1 block text-xs font-medium text-gray-600">{{ platform.testEvent.label }}</span>
        <input
          :value="testEventCode"
          :disabled="disabled || loading"
          :pattern="platform.testEvent.pattern"
          :maxlength="platform.testEvent.maxLength"
          :placeholder="platform.testEvent.placeholder"
          autocomplete="off"
          class="h-10 w-full rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-gray-500 focus:ring-2 focus:ring-gray-200"
          @input="emit('update:testEventCode', ($event.target as HTMLInputElement).value)"
        >
      </label>
      <button
        type="button"
        :disabled="disabled || loading"
        class="h-10 w-fit rounded-md bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        @click="emit('test')"
      >
        {{ loading ? '测试中...' : '测试连接' }}
      </button>
    </div>

    <dl v-if="diagnostic" class="grid border-t border-emerald-200 bg-emerald-50 sm:grid-cols-3">
      <div class="px-3 py-3 sm:border-r sm:border-emerald-200">
        <dt class="text-xs text-emerald-700">结果</dt>
        <dd class="mt-1 text-sm font-semibold text-emerald-900">通过</dd>
      </div>
      <div class="px-3 py-3 sm:border-r sm:border-emerald-200">
        <dt class="text-xs text-emerald-700">测试事件</dt>
        <dd class="mt-1 text-sm font-semibold tabular-nums text-emerald-900">{{ diagnostic.testEventsSent }}</dd>
      </div>
      <div class="px-3 py-3">
        <dt class="text-xs text-emerald-700">完成时间</dt>
        <dd class="mt-1 text-sm font-semibold text-emerald-900">{{ new Date(diagnostic.testedAt).toLocaleString('zh-CN') }}</dd>
      </div>
    </dl>
  </section>
</template>
