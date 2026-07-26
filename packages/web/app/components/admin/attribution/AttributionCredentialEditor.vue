<script setup lang="ts">
import type { AttributionPlatformDefinition } from '~/utils/attributionPlatforms'

const props = withDefaults(defineProps<{
  platform: AttributionPlatformDefinition
  configured?: boolean
  modelValue: string
  disabled?: boolean
}>(), {
  configured: false,
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  error: [message: string]
}>()

const filename = ref('')
const fileInput = ref<HTMLInputElement | null>(null)

watch(() => props.modelValue, (value) => {
  if (value) return
  filename.value = ''
  if (fileInput.value) fileInput.value.value = ''
})

async function readCredentialFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  emit('update:modelValue', '')
  emit('error', '')
  filename.value = ''
  if (!file) return
  if (file.size > 32 * 1024) {
    input.value = ''
    emit('error', 'Service Account 文件不能超过 32KB')
    return
  }
  try {
    const plaintext = await file.text()
    JSON.parse(plaintext)
    filename.value = file.name
    emit('update:modelValue', plaintext)
  }
  catch {
    input.value = ''
    emit('error', 'Service Account 文件不是有效 JSON')
  }
}
</script>

<template>
  <section data-attribution-credential-editor class="min-w-0 border-y border-gray-200 bg-white px-3 py-4 sm:px-5">
    <div class="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-center justify-between gap-3">
          <div>
            <h2 class="text-base font-semibold text-gray-900">Server 凭证</h2>
            <p class="mt-1 text-xs text-gray-500">{{ configured ? '已配置；留空可继续使用现有凭证' : '尚未配置' }}</p>
          </div>
        </div>
        <label class="mt-3 block max-w-2xl">
          <span class="mb-1 block text-xs font-medium text-gray-600">{{ platform.credential.label }}</span>
          <input
            v-if="platform.credential.inputType === 'password'"
            :value="modelValue"
            :disabled="disabled"
            :required="!configured"
            type="password"
            autocomplete="new-password"
            class="h-10 w-full rounded-md border border-gray-300 px-3 text-sm focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
            @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
          >
          <input
            v-else
            ref="fileInput"
            :accept="platform.credential.accept"
            :disabled="disabled"
            :required="!configured"
            type="file"
            class="block w-full rounded-md border border-gray-300 text-sm text-gray-600 file:mr-3 file:border-0 file:border-r file:border-gray-200 file:bg-gray-50 file:px-3 file:py-2.5 file:text-sm file:font-medium"
            @change="readCredentialFile"
          >
        </label>
      </div>
      <p v-if="filename" class="min-w-0 truncate text-xs text-gray-500">已选择 {{ filename }}</p>
    </div>
  </section>
</template>
