<script setup lang="ts">
import type { AdPlatformConnectionStatusData } from '~/composables/useAdminAttribution'
import type {
  AttributionPlatformConnectionDraft,
  AttributionPlatformDefinition,
} from '~/utils/attributionPlatforms'
import { attributionConnectionStateLabel } from '~/utils/attributionPlatforms'

const props = withDefaults(defineProps<{
  platform: AttributionPlatformDefinition
  connection: AdPlatformConnectionStatusData | null
  modelValue: AttributionPlatformConnectionDraft
  isOwner?: boolean
  saving?: boolean
  message?: string
}>(), {
  isOwner: false,
  saving: false,
  message: '',
})

const emit = defineEmits<{
  'update:modelValue': [value: AttributionPlatformConnectionDraft]
  save: []
}>()

const rolloutOptions = [0, 10, 50, 100] as const

function update<K extends keyof AttributionPlatformConnectionDraft>(key: K, value: AttributionPlatformConnectionDraft[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}

function normalizeDestination() {
  const value = props.platform.uppercaseDestination
    ? props.modelValue.destinationId.trim().toUpperCase()
    : props.modelValue.destinationId.trim()
  update('destinationId', value)
}
</script>

<template>
  <div class="min-w-0">
    <div class="flex min-w-0 flex-col gap-3 border-b border-gray-200 pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span :class="platform.accentClass" class="h-3 w-3 rounded-sm" aria-hidden="true" />
          <h2 class="text-base font-semibold text-gray-900">{{ platform.label }} 连接</h2>
        </div>
        <p class="mt-1 text-sm text-gray-500">目标 ID 与运行开关保存在同一连接中，凭证只保存在 Cloudflare Secret。</p>
      </div>
      <span
        :class="connection?.state === 'verified' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : platform.badgeClass"
        class="w-fit shrink-0 rounded-md border px-2.5 py-1 text-xs font-medium"
      >
        {{ attributionConnectionStateLabel(connection?.state || 'not_configured') }}
      </span>
    </div>

    <dl class="grid grid-cols-2 border-b border-gray-200 md:grid-cols-5">
      <div class="px-3 py-3 md:border-r">
        <dt class="text-xs text-gray-500">{{ platform.destinationLabel }}</dt>
        <dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.destinationConfigured ? '已配置' : '未配置' }}</dd>
      </div>
      <div class="px-3 py-3 md:border-r">
        <dt class="text-xs text-gray-500">Server 凭证</dt>
        <dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.serverCredentialConfigured ? '已配置' : '未配置' }}</dd>
      </div>
      <div class="px-3 py-3 md:border-r">
        <dt class="text-xs text-gray-500">Queue</dt>
        <dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.serverQueueConfigured ? '已配置' : '未配置' }}</dd>
      </div>
      <div class="px-3 py-3 md:border-r">
        <dt class="text-xs text-gray-500">数据密钥</dt>
        <dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.serverDataKeyConfigured ? '已配置' : '未配置' }}</dd>
      </div>
      <div class="col-span-2 px-3 py-3 md:col-span-1">
        <dt class="text-xs text-gray-500">运行模式</dt>
        <dd class="mt-1 text-sm font-semibold text-gray-900">{{ connection?.mode || 'disabled' }}</dd>
      </div>
    </dl>

    <form v-if="isOwner" class="grid gap-4 pt-5 sm:grid-cols-2 lg:grid-cols-4" @submit.prevent="emit('save')">
      <label class="sm:col-span-2">
        <span class="mb-1 block text-xs font-medium text-gray-600">{{ platform.label }} {{ platform.destinationLabel }}</span>
        <input
          :value="modelValue.destinationId"
          :inputmode="platform.destinationInputMode"
          :pattern="platform.destinationPattern"
          autocomplete="off"
          required
          class="h-10 w-full rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-gray-500 focus:ring-2 focus:ring-gray-200"
          @input="update('destinationId', ($event.target as HTMLInputElement).value)"
          @blur="normalizeDestination"
        >
      </label>
      <label>
        <span class="mb-1 block text-xs font-medium text-gray-600">运行模式</span>
        <select :value="modelValue.mode" class="h-10 w-full rounded-md border border-gray-300 px-3 text-sm" @change="update('mode', ($event.target as HTMLSelectElement).value as AttributionPlatformConnectionDraft['mode'])">
          <option value="disabled">关闭</option>
          <option value="test">测试</option>
          <option value="production">生产</option>
        </select>
      </label>
      <label v-if="!platform.supportsManagedRollout">
        <span class="mb-1 block text-xs font-medium text-gray-600">Server 放量</span>
        <select :value="modelValue.rolloutPercentage" class="h-10 w-full rounded-md border border-gray-300 px-3 text-sm" @change="update('rolloutPercentage', Number(($event.target as HTMLSelectElement).value) as AttributionPlatformConnectionDraft['rolloutPercentage'])">
          <option v-for="percentage in rolloutOptions" :key="percentage" :value="percentage">{{ percentage }}%</option>
        </select>
      </label>
      <div v-else>
        <span class="mb-1 block text-xs font-medium text-gray-600">Server 放量</span>
        <div class="flex h-10 items-center rounded-md border border-gray-200 bg-gray-50 px-3 text-sm text-gray-700">
          {{ modelValue.rolloutPercentage }}% · 在发布与诊断中调整
        </div>
      </div>

      <div class="grid gap-3 border-y border-gray-200 py-4 sm:col-span-2 sm:grid-cols-2 lg:col-span-4 lg:grid-cols-4">
        <label class="flex items-center gap-2 text-sm text-gray-700"><input :checked="modelValue.enabled" type="checkbox" @change="update('enabled', ($event.target as HTMLInputElement).checked)">启用连接</label>
        <label class="flex items-center gap-2 text-sm text-gray-700"><input :checked="modelValue.browserEnabled" type="checkbox" @change="update('browserEnabled', ($event.target as HTMLInputElement).checked)">{{ platform.browserLabel }}</label>
        <label class="flex items-center gap-2 text-sm text-gray-700"><input :checked="modelValue.serverEnabled" type="checkbox" @change="update('serverEnabled', ($event.target as HTMLInputElement).checked)">{{ platform.serverLabel }}</label>
        <label class="flex items-center gap-2 text-sm text-gray-700"><input :checked="modelValue.debugEnabled" type="checkbox" @change="update('debugEnabled', ($event.target as HTMLInputElement).checked)">调试日志</label>
      </div>

      <div class="flex min-w-0 flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-4">
        <button type="submit" :disabled="saving" class="rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50">
          {{ saving ? '保存中...' : '保存连接' }}
        </button>
        <span role="status" class="min-w-0 text-sm text-gray-600">{{ message }}</span>
      </div>
    </form>

    <p v-else class="pt-4 text-xs text-gray-500">只有站长可以修改平台连接。</p>
  </div>
</template>
