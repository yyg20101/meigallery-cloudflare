<script setup lang="ts">
definePageMeta({ layout: 'admin' })

onMounted(() => {
  navigateTo('/admin/analytics/invites', { replace: true })
})
</script>

<template>
  <div class="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-600">
    正在打开邀请码管理...
  </div>
</template>
