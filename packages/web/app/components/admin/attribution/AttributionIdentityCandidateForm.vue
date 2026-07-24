<script setup lang="ts">
import AttributionCandidateStatus from './AttributionCandidateStatus.vue'
import type {
  AttributionConnectionView,
  CreateCandidateRequest,
} from '~/types/attribution-admin'
import type {
  AttributionCandidateDraft,
} from '~/utils/attributionPlatforms'
import {
  attributionCandidatePayload,
  attributionPlatformDefinition,
  emptyAttributionCandidateDraft,
} from '~/utils/attributionPlatforms'

const props = withDefaults(defineProps<{
  connection: AttributionConnectionView
  disabled?: boolean
  saving?: boolean
}>(), {
  disabled: false,
  saving: false,
})

const emit = defineEmits<{
  save: [payload: CreateCandidateRequest]
}>()

const platform = computed(() =>
  attributionPlatformDefinition(props.connection.provider))
const draft = ref<AttributionCandidateDraft>(
  emptyAttributionCandidateDraft(platform.value),
)
const credentialPlaintext = ref('')
const testEventCode = ref('')
const credentialError = ref('')
const selectedFilename = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

watch(
  () => [props.connection.id, props.connection.provider] as const,
  reset,
  { immediate: true },
)

function reset() {
  const next = emptyAttributionCandidateDraft(platform.value)
  const primaryField = platform.value.publicConfigFields[0]
  if (primaryField && props.connection.activeTarget) {
    next.publicConfig[primaryField.key] = props.connection.activeTarget
  }
  draft.value = next
  credentialPlaintext.value = ''
  testEventCode.value = ''
  credentialError.value = ''
  selectedFilename.value = ''
  if (fileInput.value) fileInput.value.value = ''
}

function updateBinding(
  index: number,
  patch: Partial<AttributionCandidateDraft['eventBindings'][number]>,
) {
  draft.value.eventBindings = draft.value.eventBindings.map(
    (binding, bindingIndex) => (
      bindingIndex === index ? { ...binding, ...patch } : binding
    ),
  )
}

async function readCredentialFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  credentialPlaintext.value = ''
  credentialError.value = ''
  selectedFilename.value = ''
  if (!file) return
  if (file.size > 32 * 1024) {
    input.value = ''
    credentialError.value = 'Service Account 文件不能超过 32KB'
    return
  }
  try {
    const plaintext = await file.text()
    JSON.parse(plaintext)
    credentialPlaintext.value = plaintext
    selectedFilename.value = file.name
  } catch {
    input.value = ''
    credentialError.value = 'Service Account 文件不是有效 JSON'
  }
}

function submit() {
  credentialError.value = ''
  if (
    props.connection.state === 'not_configured'
    && !credentialPlaintext.value.trim()
  ) {
    credentialError.value = `请填写${platform.value.credential.label}`
    return
  }
  emit('save', attributionCandidatePayload(
    platform.value,
    draft.value,
    {
      credentialPlaintext: credentialPlaintext.value,
      testEventCode: testEventCode.value,
    },
  ))
  credentialPlaintext.value = ''
  selectedFilename.value = ''
  if (fileInput.value) fileInput.value.value = ''
}
</script>

<template>
  <form
    data-test="identity-candidate-form"
    class="min-w-0 space-y-4"
    @submit.prevent="submit"
  >
    <section class="min-w-0 border-y border-gray-200 bg-white">
      <div class="border-b border-gray-200 px-3 py-4 sm:px-5">
        <h2 class="text-base font-semibold text-gray-900">身份候选</h2>
        <p class="mt-1 max-w-3xl text-sm leading-6 text-gray-500">
          保存后先独立验证，不会直接替换当前生产配置。
        </p>
      </div>

      <div class="space-y-4 px-3 py-4 sm:px-5">
        <AttributionCandidateStatus :candidate="connection.candidate" />

        <div class="grid min-w-0 gap-4 md:grid-cols-2">
          <label
            v-for="field in platform.publicConfigFields"
            :key="field.key"
            class="min-w-0"
          >
            <span class="mb-1 block text-xs font-medium text-gray-700">
              {{ field.label }}
            </span>
            <input
              v-model="draft.publicConfig[field.key]"
              :name="field.key"
              :disabled="disabled || saving"
              :required="field.required"
              :inputmode="field.inputMode"
              :pattern="field.pattern"
              :placeholder="field.placeholder"
              :autocomplete="field.autocomplete"
              class="h-10 w-full min-w-0 border border-gray-300 px-3 text-sm focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
            >
          </label>
        </div>
      </div>
    </section>

    <section class="min-w-0 border-y border-gray-200 bg-white">
      <div class="border-b border-gray-200 px-3 py-4 sm:px-5">
        <h2 class="text-base font-semibold text-gray-900">Server 凭证</h2>
        <p class="mt-1 text-sm leading-6 text-gray-500">
          {{ connection.state === 'not_configured'
            ? '首次配置必须提供凭证。'
            : '留空将沿用当前生产凭证。' }}
        </p>
      </div>
      <div class="px-3 py-4 sm:px-5">
        <label class="block max-w-2xl">
          <span class="mb-1 block text-xs font-medium text-gray-700">
            {{ platform.credential.label }}
          </span>
          <input
            v-if="platform.credential.inputType === 'password'"
            v-model="credentialPlaintext"
            :disabled="disabled || saving"
            :required="connection.state === 'not_configured'"
            type="password"
            autocomplete="new-password"
            class="h-10 w-full border border-gray-300 px-3 text-sm focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
          >
          <input
            v-else
            ref="fileInput"
            :accept="platform.credential.accept"
            :disabled="disabled || saving"
            :required="connection.state === 'not_configured'"
            type="file"
            class="block w-full border border-gray-300 text-sm text-gray-600 file:mr-3 file:border-0 file:border-r file:border-gray-200 file:bg-gray-50 file:px-3 file:py-2.5 file:text-sm file:font-medium"
            @change="readCredentialFile"
          >
        </label>
        <p v-if="selectedFilename" class="mt-2 text-xs text-gray-500">
          已选择 {{ selectedFilename }}
        </p>
        <p v-if="credentialError" role="alert" class="mt-2 text-sm text-red-700">
          {{ credentialError }}
        </p>

        <label v-if="platform.testEvent" class="mt-4 block max-w-2xl">
          <span class="mb-1 block text-xs font-medium text-gray-700">
            {{ platform.testEvent.label }}（可选）
          </span>
          <input
            v-model="testEventCode"
            :disabled="disabled || saving"
            :pattern="platform.testEvent.pattern"
            :maxlength="platform.testEvent.maxLength"
            :placeholder="platform.testEvent.placeholder"
            autocomplete="off"
            class="h-10 w-full border border-gray-300 px-3 text-sm focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
          >
          <span class="mt-1 block text-xs text-gray-500">
            仅用于本次验证，不保存为长期配置。
          </span>
        </label>
      </div>
    </section>

    <section class="min-w-0 border-y border-gray-200 bg-white">
      <div class="border-b border-gray-200 px-3 py-4 sm:px-5">
        <h2 class="text-base font-semibold text-gray-900">事件映射</h2>
        <p class="mt-1 text-sm text-gray-500">
          {{ platform.browserLabel }} / {{ platform.serverLabel }}
        </p>
      </div>
      <div class="divide-y divide-gray-200">
        <div
          v-for="(definition, index) in platform.eventBindings"
          :key="definition.canonicalEvent"
          class="grid min-w-0 gap-4 px-3 py-4 sm:px-5 lg:grid-cols-[minmax(10rem,0.7fr)_minmax(0,1fr)_minmax(0,1fr)]"
        >
          <label class="flex min-w-0 items-start gap-3">
            <input
              :checked="draft.eventBindings[index]?.enabled"
              :disabled="disabled || saving"
              type="checkbox"
              class="mt-1"
              @change="updateBinding(index, {
                enabled: ($event.target as HTMLInputElement).checked,
              })"
            >
            <span class="min-w-0">
              <span class="block text-sm font-semibold text-gray-900">
                {{ definition.label }}
              </span>
              <span class="mt-0.5 block text-xs text-gray-500">
                {{ definition.canonicalEvent }}
              </span>
            </span>
          </label>

          <label class="min-w-0">
            <span class="mb-1 block text-xs font-medium text-gray-700">
              {{ definition.browser.label }}
            </span>
            <input
              :value="draft.eventBindings[index]?.browserDestination || ''"
              :readonly="!definition.browser.editable"
              :disabled="disabled || saving"
              :required="definition.browser.editable"
              :pattern="definition.browser.pattern"
              :placeholder="definition.browser.placeholder"
              autocomplete="off"
              class="h-10 w-full min-w-0 border border-gray-300 px-3 text-sm read-only:bg-gray-50 read-only:text-gray-600 focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
              @input="updateBinding(index, {
                browserDestination:
                  ($event.target as HTMLInputElement).value,
              })"
            >
          </label>

          <label class="min-w-0">
            <span class="mb-1 block text-xs font-medium text-gray-700">
              {{ definition.server.label }}
            </span>
            <input
              :value="draft.eventBindings[index]?.serverDestination || ''"
              :readonly="!definition.server.editable"
              :disabled="disabled || saving"
              :required="definition.server.editable"
              :pattern="definition.server.pattern"
              :placeholder="definition.server.placeholder"
              autocomplete="off"
              class="h-10 w-full min-w-0 border border-gray-300 px-3 text-sm read-only:bg-gray-50 read-only:text-gray-600 focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
              @input="updateBinding(index, {
                serverDestination:
                  ($event.target as HTMLInputElement).value,
              })"
            >
          </label>
        </div>
      </div>
    </section>

    <div class="flex min-w-0 flex-wrap items-center gap-3 border-y border-gray-200 bg-white px-3 py-4 sm:px-5">
      <button
        type="submit"
        :disabled="disabled || saving"
        class="min-h-10 bg-gray-950 px-4 text-sm font-medium text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {{ saving ? '保存中...' : '保存并自动验证' }}
      </button>
      <span class="text-sm text-gray-500">
        运行策略保持不变
      </span>
    </div>
  </form>
</template>
