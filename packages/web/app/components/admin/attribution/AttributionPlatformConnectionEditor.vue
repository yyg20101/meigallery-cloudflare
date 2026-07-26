<script setup lang="ts">
import type { AdPlatformConnectionData } from '~/composables/useAdminAttribution'
import type {
  AttributionPlatformConnectionDraft,
  AttributionPlatformDefinition,
} from '~/utils/attributionPlatforms'
import { attributionConnectionStateLabel } from '~/utils/attributionPlatforms'

const props = withDefaults(defineProps<{
  platform: AttributionPlatformDefinition
  connection: AdPlatformConnectionData | null
  modelValue: AttributionPlatformConnectionDraft
  isOwner?: boolean
}>(), {
  isOwner: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: AttributionPlatformConnectionDraft]
}>()

function update<K extends keyof AttributionPlatformConnectionDraft>(key: K, value: AttributionPlatformConnectionDraft[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

function updatePublicConfig(key: string, value: string) {
  update('publicConfig', { ...props.modelValue.publicConfig, [key]: value })
}
</script>

<template>
  <section data-attribution-connection-editor class="min-w-0 border-y border-gray-200 bg-white">
    <div class="flex min-w-0 flex-col gap-3 border-b border-gray-200 px-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
      <div class="flex min-w-0 items-center gap-3">
        <span :class="platform.accentClass" class="h-8 w-1 shrink-0 rounded-sm" aria-hidden="true" />
        <div class="min-w-0">
          <h2 class="text-base font-semibold text-gray-900">{{ platform.label }} 连接</h2>
          <p class="mt-1 text-xs text-gray-500">统一控制 Browser 与 Server 投递</p>
        </div>
      </div>
      <span :class="connection ? platform.badgeClass : 'border-gray-200 bg-gray-50 text-gray-600'" class="w-fit rounded-md border px-2.5 py-1 text-xs font-medium">
        {{ attributionConnectionStateLabel(connection) }}
      </span>
    </div>

    <dl data-connection-status-rail class="grid grid-cols-3 border-b border-gray-200">
      <div class="px-3 py-3 md:border-r md:border-gray-200">
        <dt class="text-xs text-gray-500">Browser</dt>
        <dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.browserEnabled ? '已启用' : '已关闭' }}</dd>
      </div>
      <div class="px-3 py-3 md:border-r md:border-gray-200">
        <dt class="text-xs text-gray-500">Server</dt>
        <dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.serverEnabled ? '已启用' : '已关闭' }}</dd>
      </div>
      <div class="px-3 py-3 md:border-r md:border-gray-200">
        <dt class="text-xs text-gray-500">凭证</dt>
        <dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.credential.configured ? '已配置' : '未配置' }}</dd>
      </div>
    </dl>

    <div v-if="isOwner" class="grid gap-4 px-3 py-5 sm:grid-cols-2 sm:px-5 lg:grid-cols-4">
      <label v-for="field in platform.publicConfigFields" :key="field.key" class="min-w-0">
        <span class="mb-1 block text-xs font-medium text-gray-600">{{ field.label }}</span>
        <input
          :value="modelValue.publicConfig[field.key] || ''"
          :inputmode="field.inputMode"
          :pattern="field.pattern"
          :placeholder="field.placeholder"
          :autocomplete="field.autocomplete || 'off'"
          :required="field.required"
          class="h-10 w-full min-w-0 rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-gray-500 focus:ring-2 focus:ring-gray-200"
          @input="updatePublicConfig(field.key, ($event.target as HTMLInputElement).value.trimStart())"
        >
      </label>

      <div data-connection-controls class="grid gap-3 border-y border-gray-200 py-4 sm:col-span-2 sm:grid-cols-3 lg:col-span-4">
        <label class="flex min-h-9 items-center gap-2 text-sm text-gray-700">
          <input :checked="modelValue.enabled" type="checkbox" @change="update('enabled', ($event.target as HTMLInputElement).checked)">
          启用连接
        </label>
        <label class="flex min-h-9 items-center gap-2 text-sm text-gray-700">
          <input :checked="modelValue.browserEnabled" type="checkbox" @change="update('browserEnabled', ($event.target as HTMLInputElement).checked)">
          {{ platform.browserLabel }}
        </label>
        <label class="flex min-h-9 items-center gap-2 text-sm text-gray-700">
          <input :checked="modelValue.serverEnabled" type="checkbox" @change="update('serverEnabled', ($event.target as HTMLInputElement).checked)">
          {{ platform.serverLabel }}
        </label>
      </div>
    </div>

    <p v-else class="px-3 py-4 text-xs text-gray-500 sm:px-5">只有站长可以修改平台连接。</p>
  </section>
</template>
