<script setup lang="ts">
import type { MarketingConsentPolicyMode } from '@meigallery/shared'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'

type PrivacyPolicy = {
  defaultMode: MarketingConsentPolicyMode
  priorConsentCountryCodes: string[]
  policyVersion: number
  updatedAt: string | null
}

definePageMeta({ layout: 'admin' })

const { api } = useApi()
const { isOwner } = useAuth()
const rangeState = useAdminAttributionRange('7d')
const loading = ref(true)
const saving = ref(false)
const error = ref('')
const message = ref('')
const policy = ref<PrivacyPolicy | null>(null)
const defaultMode = ref<MarketingConsentPolicyMode>('notice_opt_out')
const countryCodesText = ref('')

const modeOptions: Array<{ value: MarketingConsentPolicyMode; label: string; description: string }> = [
  { value: 'notice_opt_out', label: '通知并允许', description: '非严格地区在明确告知后启用效果分析，并保留随时关闭入口。' },
  { value: 'prior_consent', label: '全部先选择', description: '所有地区都必须先选择，未选择前不加载 Pixel 或 Server API。' },
  { value: 'disabled', label: '全部关闭', description: '紧急停用所有广告平台追踪，站内有效联系事实仍会记录。' },
]

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    const response = await api<{ data: PrivacyPolicy }>('/api/admin/attribution/privacy-policy')
    policy.value = response.data
    defaultMode.value = response.data.defaultMode
    countryCodesText.value = response.data.priorConsentCountryCodes.join(', ')
  }
  catch {
    error.value = '地区策略加载失败，请稍后重试。'
  }
  finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  error.value = ''
  message.value = ''
  try {
    const response = await api<{ data: PrivacyPolicy }>('/api/admin/attribution/privacy-policy', {
      method: 'PATCH',
      body: {
        defaultMode: defaultMode.value,
        priorConsentCountryCodes: parseCountryCodes(countryCodesText.value),
      },
    })
    policy.value = response.data
    countryCodesText.value = response.data.priorConsentCountryCodes.join(', ')
    message.value = '地区策略已保存，最长约 60 秒在全部 Worker 实例生效。'
  }
  catch {
    error.value = '保存失败，请检查国家/地区代码后重试。'
  }
  finally {
    saving.value = false
  }
}

function parseCountryCodes(value: string) {
  return [...new Set(value.split(/[\s,，]+/).map(code => code.trim().toUpperCase()).filter(Boolean))].sort()
}

onMounted(refresh)
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="地区与隐私策略"
    description="统一控制 Meta、TikTok 与 Google 的营销衡量授权，不改变平台来源隔离规则。"
    :loading="loading"
    :error="error"
    :show-range-controls="false"
    :show-usage="false"
    @refresh="refresh"
  >
    <form v-if="policy" class="space-y-4" @submit.prevent="save">
      <section class="border-y border-gray-200 bg-white px-3 py-5 sm:px-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 class="text-base font-semibold text-gray-900">默认处理方式</h2>
            <p class="mt-1 text-sm leading-6 text-gray-500">用户明确拒绝和浏览器 GPC 信号始终优先于这里的默认值。</p>
          </div>
          <span class="text-xs text-gray-500">策略版本 {{ policy.policyVersion }}</span>
        </div>
        <URadioGroup
          v-model="defaultMode"
          :items="modeOptions"
          value-key="value"
          color="neutral"
          variant="card"
          class="mt-4"
          :ui="{ fieldset: 'grid gap-2 lg:grid-cols-3' }"
        />
      </section>

      <section class="border-y border-gray-200 bg-white px-3 py-5 sm:px-5">
        <label for="prior-consent-countries" class="text-base font-semibold text-gray-900">必须先选择的国家/地区</label>
        <p class="mt-1 text-sm leading-6 text-gray-500">使用两位 ISO 国家/地区代码，以逗号或空格分隔。无法识别地区和 Tor 流量始终按先选择处理。</p>
        <UTextarea id="prior-consent-countries" v-model="countryCodesText" :rows="5" spellcheck="false" color="neutral" class="mt-4 w-full font-mono uppercase" />
      </section>

      <section class="border-y border-gray-200 bg-white px-3 py-4 sm:px-5">
        <h2 class="text-sm font-semibold text-gray-900">固定保护规则</h2>
        <p class="mt-2 text-sm leading-6 text-gray-600">所有地区都会记录站内有效联系事实；只有允许营销衡量时才加载对应来源平台的 Pixel 和 Server API。Meta、TikTok、Google 不会互相接收事件。</p>
      </section>

      <div class="flex flex-wrap items-center gap-3 border-y border-gray-200 bg-white px-3 py-4 sm:px-5">
        <UButton v-if="isOwner" type="submit" color="neutral" :loading="saving" :disabled="saving" label="保存地区策略" />
        <span v-else class="text-sm text-gray-500">仅站长可修改地区策略。</span>
        <span role="status" class="text-sm text-gray-600">{{ message }}</span>
      </div>
    </form>
  </AttributionPageShell>
</template>
