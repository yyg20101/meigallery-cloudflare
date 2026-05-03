<script setup lang="ts">
const { contactMethods, fetchContactMethods, hasContactMethods } = useContactMethods()

await fetchContactMethods()
</script>

<template>
  <div v-if="hasContactMethods" class="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
    <div class="grid gap-4 p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div>
        <p class="text-xs font-medium uppercase tracking-[0.18em] text-gray-400">Contact</p>
        <h2 class="mt-1 text-base font-semibold text-gray-900">联系站长</h2>
        <p class="mt-1 text-sm text-gray-500">开通会员、内容授权或站点问题，可通过以下方式联系。</p>
      </div>

      <div class="grid gap-2 sm:min-w-64">
        <ContactMethodItem
          v-for="method in contactMethods"
          :key="method.id"
          :method="method"
        />
      </div>
    </div>
    <div class="border-t border-gray-100 bg-gray-50 px-5 py-3 text-xs text-gray-500">
      后台启用的联系方式会自动同步展示；未配置跳转链接时，点击联系方式将复制联系值。
    </div>
  </div>
</template>
