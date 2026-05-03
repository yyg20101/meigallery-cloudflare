<script setup lang="ts">
const { contactMethods, fetchContactMethods, hasContactMethods } = useContactMethods()

await fetchContactMethods()

const open = ref(false)
const contactCount = computed(() => contactMethods.value.length)

function toggleOpen() {
  open.value = !open.value
}
</script>

<template>
  <div v-if="hasContactMethods" class="fixed bottom-20 right-4 z-50 lg:bottom-6 lg:right-6">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-3 opacity-0 scale-95"
      enter-to-class="translate-y-0 opacity-100 scale-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="translate-y-0 opacity-100 scale-100"
      leave-to-class="translate-y-3 opacity-0 scale-95"
    >
      <div
        v-if="open"
        class="mb-3 w-[min(calc(100vw-2rem),22rem)] overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-2xl shadow-gray-900/10"
      >
        <div class="relative p-5">
          <div class="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-gray-100 blur-2xl" />
          <div class="relative flex items-start justify-between gap-4">
            <div>
              <p class="text-xs font-medium uppercase tracking-[0.2em] text-gray-400">Contact</p>
              <h2 class="mt-1 text-base font-semibold text-gray-900">联系站长</h2>
              <p class="mt-1 text-xs leading-5 text-gray-500">开通会员、内容授权或站点问题，可选择任一方式联系。</p>
            </div>
            <button
              type="button"
              class="rounded-full p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
              aria-label="关闭联系方式"
              @click="open = false"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div class="max-h-[45vh] space-y-1 overflow-y-auto px-3 pb-3">
          <ContactMethodItem
            v-for="method in contactMethods"
            :key="method.id"
            :method="method"
          />
        </div>

        <div class="border-t border-gray-100 bg-gray-50 px-5 py-3 text-xs leading-5 text-gray-500">
          未配置跳转链接时，点击联系方式会复制联系值。
        </div>
      </div>
    </Transition>

    <button
      type="button"
      class="group flex items-center gap-2 rounded-full border border-gray-200 bg-gray-950 px-4 py-3 text-sm font-medium text-white shadow-xl shadow-gray-900/20 transition-all hover:-translate-y-0.5 hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-2"
      :aria-expanded="open"
      aria-label="打开联系方式"
      @click="toggleOpen"
    >
      <span class="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white ring-1 ring-white/15">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" />
        </svg>
      </span>
      <span class="leading-tight">
        <span class="block">联系站长</span>
        <span class="block text-[11px] font-normal text-white/60">{{ contactCount }} 种方式</span>
      </span>
      <svg class="h-4 w-4 text-white/60 transition-transform group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6" />
      </svg>
    </button>
  </div>
</template>
