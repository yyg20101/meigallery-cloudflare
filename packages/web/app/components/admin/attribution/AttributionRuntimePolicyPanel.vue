<script setup lang="ts">
import type {
  AttributionConnectionView,
  AttributionRuntimePercentage,
  SetRuntimePolicyRequest,
} from '~/types/attribution-admin'

const props = withDefaults(defineProps<{
  connection: AttributionConnectionView
  disabled?: boolean
  saving?: boolean
}>(), {
  disabled: false,
  saving: false,
})

const emit = defineEmits<{
  save: [policy: SetRuntimePolicyRequest]
  rollback: []
  disable: []
}>()

const percentages: AttributionRuntimePercentage[] = [0, 10, 50, 100]
const draft = reactive<SetRuntimePolicyRequest>({
  enabled: false,
  browserEnabled: false,
  serverEnabled: false,
  serverTargetPercentage: 0,
})
const dirty = computed(() => (
  draft.enabled !== props.connection.runtime.enabled
  || draft.browserEnabled !== props.connection.runtime.browserEnabled
  || draft.serverEnabled !== props.connection.runtime.serverEnabled
  || draft.serverTargetPercentage
    !== props.connection.runtime.serverTargetPercentage
))

watch(
  () => props.connection.runtime,
  (runtime) => {
    draft.enabled = runtime.enabled
    draft.browserEnabled = runtime.browserEnabled
    draft.serverEnabled = runtime.serverEnabled
    draft.serverTargetPercentage = runtime.serverTargetPercentage
  },
  { immediate: true, deep: true },
)

function save() {
  if (!dirty.value || props.disabled || props.saving) return
  emit('save', {
    enabled: draft.enabled,
    browserEnabled: draft.browserEnabled,
    serverEnabled: draft.serverEnabled,
    serverTargetPercentage: draft.serverTargetPercentage,
  })
}
</script>

<template>
  <section
    data-test="runtime-policy-panel"
    class="min-w-0 border-y border-gray-200 bg-white"
  >
    <div class="border-b border-gray-200 px-3 py-4 sm:px-5">
      <h2 class="text-base font-semibold text-gray-900">运行策略</h2>
      <p class="mt-1 max-w-3xl text-sm leading-6 text-gray-500">
        只控制当前生产版本的 Browser 与 Server 投递，不修改身份配置。
      </p>
    </div>

    <div class="grid min-w-0 gap-5 px-3 py-4 sm:px-5 xl:grid-cols-2">
      <div class="space-y-3">
        <label class="flex min-w-0 items-start gap-3">
          <input
            v-model="draft.enabled"
            name="connectionEnabled"
            :disabled="disabled || saving"
            type="checkbox"
            class="mt-1"
          >
          <span>
            <span class="block text-sm font-semibold text-gray-900">
              启用此连接
            </span>
            <span class="mt-0.5 block text-xs leading-5 text-gray-500">
              关闭后，此连接不再接收新的归因流量。
            </span>
          </span>
        </label>

        <label class="flex min-w-0 items-start gap-3">
          <input
            v-model="draft.browserEnabled"
            name="browserEnabled"
            :disabled="disabled || saving || !draft.enabled"
            type="checkbox"
            class="mt-1"
          >
          <span>
            <span class="block text-sm font-semibold text-gray-900">
              Browser 投递
            </span>
            <span class="mt-0.5 block text-xs leading-5 text-gray-500">
              在浏览器中发送 Pixel 或 Tag 事件。
            </span>
          </span>
        </label>

        <label class="flex min-w-0 items-start gap-3">
          <input
            v-model="draft.serverEnabled"
            name="serverEnabled"
            :disabled="disabled || saving || !draft.enabled"
            type="checkbox"
            class="mt-1"
          >
          <span>
            <span class="block text-sm font-semibold text-gray-900">
              Server 投递
            </span>
            <span class="mt-0.5 block text-xs leading-5 text-gray-500">
              通过平台 Server API 投递同一业务事件。
            </span>
          </span>
        </label>
      </div>

      <div class="min-w-0">
        <p class="text-xs font-medium text-gray-700">Server 灰度比例</p>
        <div
          class="mt-2 grid grid-cols-4 border border-gray-200 bg-white p-1"
          role="group"
          aria-label="Server 灰度比例"
        >
          <button
            v-for="percentage in percentages"
            :key="percentage"
            data-runtime-percentage
            name="serverTargetPercentage"
            type="button"
            :disabled="disabled || saving || !draft.enabled || !draft.serverEnabled"
            :class="[
              'min-h-9 px-2 text-sm font-medium',
              draft.serverTargetPercentage === percentage
                ? 'bg-gray-950 text-white'
                : 'text-gray-600 hover:bg-gray-100',
              'disabled:cursor-not-allowed disabled:opacity-50',
            ]"
            @click="draft.serverTargetPercentage = percentage"
          >
            {{ percentage }}%
          </button>
        </div>
        <dl class="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div class="border-l-2 border-gray-200 pl-3">
            <dt class="text-xs text-gray-500">目标比例</dt>
            <dd class="mt-1 font-semibold text-gray-900">
              {{ connection.runtime.serverTargetPercentage }}%
            </dd>
          </div>
          <div class="border-l-2 border-gray-200 pl-3">
            <dt class="text-xs text-gray-500">当前生效</dt>
            <dd class="mt-1 font-semibold text-gray-900">
              {{ connection.runtime.serverEffectivePercentage }}%
            </dd>
          </div>
        </dl>
        <p
          v-if="connection.runtime.circuitState === 'server_open'"
          class="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          Server 投递已自动暂停，Browser 投递不受影响。
        </p>
      </div>
    </div>

    <div class="flex min-w-0 flex-wrap items-center gap-3 border-t border-gray-200 px-3 py-4 sm:px-5">
      <button
        type="button"
        :disabled="disabled || saving || !dirty"
        class="min-h-10 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        @click="save"
      >
        {{ saving ? '处理中...' : '保存运行策略' }}
      </button>
      <button
        type="button"
        :disabled="disabled || saving"
        class="min-h-10 border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        @click="emit('rollback')"
      >
        回滚上一生产版本
      </button>
      <button
        type="button"
        :disabled="disabled || saving || connection.state === 'disabled'"
        class="min-h-10 border border-red-200 bg-white px-4 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
        @click="emit('disable')"
      >
        停用连接
      </button>
    </div>
  </section>
</template>
