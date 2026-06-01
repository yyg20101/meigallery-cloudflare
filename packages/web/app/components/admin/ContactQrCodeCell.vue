<script setup lang="ts">
import { normalizeContactQrCodeUrl } from '~/utils/contactUrlSecurity'

const props = defineProps<{
  contactId: string
  qrCodeUrl: string | null
}>()

const emit = defineEmits<{
  upload: [contactId: string]
  remove: [contactId: string]
}>()

const safeQrCodeUrl = computed(() => normalizeContactQrCodeUrl(props.qrCodeUrl))
const hasQrCode = computed(() => !!props.qrCodeUrl)
</script>

<template>
  <div class="flex items-center gap-2">
    <img
      v-if="safeQrCodeUrl"
      :src="safeQrCodeUrl"
      alt="联系方式二维码预览"
      class="h-10 w-10 rounded object-cover"
    />
    <span
      v-else-if="hasQrCode"
      class="inline-flex h-10 min-w-16 items-center justify-center rounded border border-amber-200 bg-amber-50 px-2 text-[11px] text-amber-700"
    >
      预览已隐藏
    </span>
    <button class="text-xs text-blue-600 hover:underline" @click="emit('upload', contactId)">
      {{ hasQrCode ? '更换' : '上传' }}
    </button>
    <button v-if="hasQrCode" class="text-xs text-red-600 hover:underline" @click="emit('remove', contactId)">
      删除
    </button>
  </div>
</template>
