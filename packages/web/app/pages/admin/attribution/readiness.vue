<script setup lang="ts">
definePageMeta({
  layout: 'admin',
  middleware: [to => navigateTo({ path: '/admin/attribution/deliveries', query: to.query }, { replace: true })],
})
</script>

<template>
  <div />
</template>
