<script setup lang="ts">
import { computed, useId } from 'vue'
import { normalizeMediaUrl } from '~/utils/mediaUrlSecurity'

const props = withDefaults(defineProps<{
  href: string | null
  fallbackLabel?: string
}>(), {
  fallbackLabel: '链接已隐藏',
})

const safeHref = computed(() => {
  const normalized = normalizeMediaUrl(props.href)
  return normalized && !normalized.startsWith('/') ? normalized : ''
})

const displayText = computed(() => String(props.href ?? '').trim() || '-')
const externalNoteId = `${useId()}-admin-safe-external-note`
const externalHostname = computed(() => {
  if (!safeHref.value) return ''

  try {
    return new URL(safeHref.value).hostname
  } catch {
    return ''
  }
})
</script>

<template>
  <span v-if="safeHref" class="inline-flex min-w-0 max-w-full flex-col gap-1 whitespace-normal align-top">
    <a
      :href="safeHref"
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerpolicy="no-referrer"
      :aria-describedby="externalNoteId"
      :aria-label="`${displayText}，外部链接${externalHostname ? `，目标域名 ${externalHostname}` : ''}`"
      class="min-w-0 break-words whitespace-normal text-blue-600 hover:underline"
    >
      <slot>{{ displayText }}</slot>
    </a>
    <span :id="externalNoteId" class="min-w-0 break-words whitespace-normal text-[11px] leading-4 text-gray-400">
      外部链接
      <template v-if="externalHostname"> / 目标域名 {{ externalHostname }}</template>
      / 不发送来源页信息
    </span>
  </span>
  <span v-else class="break-words whitespace-normal text-gray-400" :title="displayText">
    {{ displayText === '-' ? '-' : fallbackLabel }}
  </span>
</template>
