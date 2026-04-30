<script setup lang="ts">
const { contactMethods, fetchContactMethods, hasContactMethods } = useContactMethods()

await fetchContactMethods()
</script>

<template>
  <div v-if="hasContactMethods" class="bg-white border border-gray-200 rounded-xl p-4">
    <p class="font-semibold text-sm mb-3">联系站长</p>
    <div class="space-y-1">
      <ContactMethodItem
        v-for="method in contactMethods"
        :key="method.id"
        :method="method"
      />
    </div>
    <div class="bg-gray-50 rounded-lg p-3 mt-3 text-xs text-gray-500">
      如需开通会员或有任何问题，请通过以上方式联系站长。
    </div>
  </div>
</template>
