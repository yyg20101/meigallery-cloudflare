<script setup lang="ts">
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import {
  useAttributionPrivacyPolicy,
} from '~/composables/useAdminAttribution'
import type {
  AttributionPrivacyPolicyView,
} from '~/types/attribution-admin'

definePageMeta({ layout: 'admin' })

const { isOwner } = useAuth()
const rangeState = useAdminAttributionRange('7d')
const manager = useAttributionPrivacyPolicy()
const defaultMode = ref<
  AttributionPrivacyPolicyView['defaultMode']
>('notice_opt_out')
const countryCodesText = ref('')
const message = ref('')

const modeOptions: Array<{
  value: AttributionPrivacyPolicyView['defaultMode']
  label: string
  description: string
}> = [
  {
    value: 'notice_opt_out',
    label: '告知并允许退出',
    description: '一般地区默认进行效果衡量，用户可随时关闭。',
  },
  {
    value: 'prior_consent',
    label: '事先同意',
    description: '所有地区必须先明确同意，之后才进行效果衡量。',
  },
  {
    value: 'disabled',
    label: '暂停效果衡量',
    description: '临时停止所有营销效果衡量，业务功能保持可用。',
  },
]

watch(manager.policy, (policy) => {
  if (!policy) return
  defaultMode.value = policy.defaultMode
  countryCodesText.value = policy.priorConsentCountryCodes.join(', ')
}, { immediate: true })

onMounted(() => void manager.refresh().catch(() => undefined))

async function save() {
  message.value = ''
  const result = await manager.save({
    defaultMode: defaultMode.value,
    priorConsentCountryCodes: parseCountryCodes(
      countryCodesText.value,
    ),
  })
  countryCodesText.value = result.priorConsentCountryCodes.join(', ')
  message.value = '地区策略已保存'
}

function parseCountryCodes(value: string): string[] {
  return [...new Set(
    value
      .split(/[\s,，]+/)
      .map(code => code.trim().toUpperCase())
      .filter(Boolean),
  )].sort()
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="地区与隐私策略"
    description="按访问地区设置营销效果衡量的默认处理方式。"
    :loading="manager.loading.value"
    :error="manager.error.value"
    :show-range-controls="false"
    :show-usage="false"
    @refresh="manager.refresh"
  >
    <form
      v-if="manager.policy.value"
      class="min-w-0 space-y-4"
      @submit.prevent="save"
    >
      <section class="border-y border-gray-200 bg-white px-3 py-5 sm:px-5">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 class="text-base font-semibold text-gray-900">默认地区模式</h2>
            <p class="mt-1 text-sm leading-6 text-gray-500">
              GPC 和用户明确拒绝始终优先于地区默认设置。
            </p>
          </div>
          <span class="text-xs text-gray-500">
            策略版本 {{ manager.policy.value.policyVersion }}
          </span>
        </div>

        <label class="mt-4 block max-w-xl">
          <span class="mb-1 block text-xs font-medium text-gray-600">
            默认地区模式
          </span>
          <select
            v-model="defaultMode"
            aria-label="默认地区模式"
            class="h-10 w-full border border-gray-300 bg-white px-3 text-sm"
          >
            <option
              v-for="option in modeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </label>
        <p class="mt-2 max-w-xl text-xs leading-5 text-gray-500">
          {{ modeOptions.find(option => option.value === defaultMode)?.description }}
        </p>
      </section>

      <section class="border-y border-gray-200 bg-white px-3 py-5 sm:px-5">
        <label for="prior-consent-countries" class="text-base font-semibold text-gray-900">
          需事先同意的国家或地区
        </label>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-gray-500">
          使用两位国家或地区代码，以逗号或空格分隔。无法确认地区时按更严格规则处理。
        </p>
        <textarea
          id="prior-consent-countries"
          v-model="countryCodesText"
          aria-label="需事先同意的国家或地区"
          rows="5"
          spellcheck="false"
          class="mt-4 w-full max-w-3xl border border-gray-300 px-3 py-2 font-mono text-sm uppercase"
        />
      </section>

      <div class="flex flex-wrap items-center gap-3 border-y border-gray-200 bg-white px-3 py-4 sm:px-5">
        <button
          v-if="isOwner"
          type="submit"
          :disabled="!manager.canSave.value"
          class="rounded-md bg-gray-950 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
        >
          {{ manager.saving.value ? '保存中...' : '保存地区策略' }}
        </button>
        <span v-else class="text-sm text-gray-500">
          仅 Owner 可修改地区策略。
        </span>
        <span role="status" class="text-sm text-gray-600">{{ message }}</span>
      </div>
    </form>
  </AttributionPageShell>
</template>
