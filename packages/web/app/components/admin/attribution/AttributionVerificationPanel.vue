<script setup lang="ts">
import type { AdPlatformVerificationData } from '~/composables/useAdminAttribution'
import type { AttributionPlatformDefinition } from '~/utils/attributionPlatforms'
import { attributionVerificationStatusLabel } from '~/utils/attributionPlatforms'

const props = withDefaults(defineProps<{
  platform: AttributionPlatformDefinition
  verification: AdPlatformVerificationData | null
  loading?: boolean
  disabled?: boolean
}>(), {
  loading: false,
  disabled: false,
})

const emit = defineEmits<{
  verify: [testEventCode: string]
  reverify: [testEventCode: string]
  confirmEvidence: [reference: string]
  refresh: []
}>()

const testEventCode = defineModel<string>('testEventCode', { default: '' })
const evidenceReference = ref('')
const confirmingReverify = ref(false)

const active = computed(() => ['queued', 'running'].includes(props.verification?.status || ''))
const testCodeReady = computed(() => !props.platform.testEvent || testEventCode.value.trim().length > 0)

function requestVerification() {
  emit('verify', testEventCode.value)
}

function confirmReverification() {
  confirmingReverify.value = false
  emit('reverify', testEventCode.value)
}

function submitEvidence() {
  emit('confirmEvidence', evidenceReference.value)
  evidenceReference.value = ''
}
</script>

<template>
  <section data-attribution-verification-panel class="min-w-0 border-y border-gray-200 bg-white">
    <div class="flex min-w-0 flex-col gap-3 border-b border-gray-200 px-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
      <div>
        <h2 class="text-base font-semibold text-gray-900">连接验证</h2>
        <p class="mt-1 text-xs text-gray-500">第 {{ verification?.attempt || 0 }} 次 · {{ attributionVerificationStatusLabel(verification?.status || '') }}</p>
      </div>
      <button type="button" class="w-fit rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50" :disabled="loading" @click="emit('refresh')">
        刷新状态
      </button>
    </div>

    <dl class="grid grid-cols-2 border-b border-gray-200 md:grid-cols-4">
      <div class="px-3 py-3 md:border-r md:border-gray-200"><dt class="text-xs text-gray-500">状态</dt><dd class="mt-1 text-sm font-semibold text-gray-900">{{ attributionVerificationStatusLabel(verification?.status || '') }}</dd></div>
      <div class="px-3 py-3 md:border-r md:border-gray-200"><dt class="text-xs text-gray-500">连接版本</dt><dd class="mt-1 truncate text-sm font-semibold text-gray-900">{{ verification?.connectionRevision || '-' }}</dd></div>
      <div class="px-3 py-3 md:border-r md:border-gray-200"><dt class="text-xs text-gray-500">开始时间</dt><dd class="mt-1 text-sm font-semibold text-gray-900">{{ verification?.startedAt ? formatAnalyticsDateTime(verification.startedAt) : '-' }}</dd></div>
      <div class="px-3 py-3"><dt class="text-xs text-gray-500">完成时间</dt><dd class="mt-1 text-sm font-semibold text-gray-900">{{ verification?.completedAt ? formatAnalyticsDateTime(verification.completedAt) : '-' }}</dd></div>
    </dl>

    <form class="grid gap-4 px-3 py-5 sm:px-5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end" @submit.prevent="requestVerification">
      <label v-if="platform.testEvent" class="min-w-0 max-w-xl">
        <span class="mb-1 block text-xs font-medium text-gray-600">{{ platform.testEvent.label }}</span>
        <input
          v-model="testEventCode"
          :pattern="platform.testEvent.pattern"
          :placeholder="platform.testEvent.placeholder"
          :maxlength="platform.testEvent.maxLength"
          :disabled="disabled || loading"
          type="password"
          autocomplete="off"
          required
          class="h-10 w-full rounded-md border border-gray-300 px-3 text-sm focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
        >
      </label>
      <div v-else class="text-sm text-gray-600">{{ platform.label }} 自动验证无需测试码。</div>
      <div class="flex min-w-0 flex-wrap gap-2">
        <button type="submit" :disabled="disabled || loading || active || !testCodeReady" class="rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50">
          {{ active ? '验证进行中' : '验证连接' }}
        </button>
        <button v-if="verification" type="button" :disabled="disabled || loading || active || !testCodeReady" class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50" @click="confirmingReverify = true">
          重新验证
        </button>
      </div>
    </form>

    <div v-if="confirmingReverify" role="alert" class="flex min-w-0 flex-col gap-3 border-t border-amber-200 bg-amber-50 px-3 py-4 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <p>重新验证会创建新的验证尝试，当前验证记录保留。</p>
      <div class="flex shrink-0 gap-2">
        <button type="button" class="rounded-md border border-amber-300 bg-white px-3 py-2 font-medium" @click="confirmingReverify = false">取消</button>
        <button type="button" class="rounded-md bg-amber-900 px-3 py-2 font-medium text-white" @click="confirmReverification">确认重新验证</button>
      </div>
    </div>

    <form v-if="verification?.status === 'awaiting_human_evidence'" class="grid gap-3 border-t border-gray-200 px-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:px-5" @submit.prevent="submitEvidence">
      <label class="min-w-0">
        <span class="mb-1 block text-xs font-medium text-gray-600">平台证据引用（可选）</span>
        <input v-model="evidenceReference" maxlength="500" autocomplete="off" class="h-10 w-full rounded-md border border-gray-300 px-3 text-sm focus:border-gray-500 focus:outline-none">
      </label>
      <button type="submit" :disabled="disabled || loading" class="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50">确认平台已收到测试事件</button>
    </form>

    <p v-if="verification?.evidence.failureCode" class="border-t border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700 sm:px-5">{{ verification.evidence.failureCode }}</p>
  </section>
</template>
