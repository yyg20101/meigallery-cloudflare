<script setup lang="ts">
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
</script>

<template>
  <a
    v-if="safeHref"
    :href="safeHref"
    target="_blank"
    rel="noopener noreferrer nofollow"
    referrerpolicy="no-referrer"
    class="break-all text-blue-600 hover:underline"
  >
    <slot>{{ displayText }}</slot>
  </a>
  <span v-else class="break-all text-gray-400" :title="displayText">
    {{ displayText === '-' ? '-' : fallbackLabel }}
  </span>
</template>
