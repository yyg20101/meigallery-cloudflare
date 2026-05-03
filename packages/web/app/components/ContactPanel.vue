<script setup lang="ts">
const { contactMethods, fetchContactMethods, hasContactMethods } = useContactMethods()

await fetchContactMethods()

const open = ref(false)
const contactCount = computed(() => contactMethods.value.length)
const primaryContact = computed(() => contactMethods.value[0]?.label || '在线咨询')

function toggleOpen() {
  open.value = !open.value
}
</script>

<template>
  <div v-if="hasContactMethods" class="fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-4 z-50 lg:bottom-6 lg:right-6">
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
        class="mb-3 w-[min(calc(100vw-2rem),23rem)] overflow-hidden rounded-[1.75rem] border border-white/80 bg-white/92 shadow-[0_28px_80px_rgba(17,24,39,0.16)] ring-1 ring-[#f8e7dc]/80 backdrop-blur-xl"
      >
        <div class="relative overflow-hidden p-5">
          <div class="absolute -right-12 -top-16 h-36 w-36 rounded-full bg-[#f8e7dc] blur-3xl" />
          <div class="absolute -left-16 top-10 h-32 w-32 rounded-full bg-[#fff7ed] blur-3xl" />
          <div class="relative flex items-start justify-between gap-4">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.22em] text-[#bfa46a]">Private Contact</p>
              <h2 class="mt-1.5 text-lg font-semibold tracking-tight text-gray-950">联系站长</h2>
              <p class="mt-1.5 text-xs leading-5 text-gray-500">开通会员、内容授权或站点问题，可选择任一方式联系。</p>
            </div>
            <button
              type="button"
              class="rounded-full bg-white/70 p-2 text-gray-400 shadow-sm ring-1 ring-gray-100 transition-all hover:-translate-y-0.5 hover:bg-gray-950 hover:text-white"
              aria-label="关闭联系方式"
              @click="open = false"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div class="max-h-[45vh] space-y-2 overflow-y-auto px-3 pb-3">
          <ContactMethodItem
            v-for="method in contactMethods"
            :key="method.id"
            :method="method"
          />
        </div>

        <div class="border-t border-orange-100 bg-gradient-to-r from-[#fffbf7] to-white px-5 py-3 text-xs leading-5 text-gray-500">
          未配置跳转链接时，点击联系方式会复制联系值；二维码可点击展开查看。
        </div>
      </div>
    </Transition>

    <button
      type="button"
      class="group relative flex items-center gap-2 overflow-hidden rounded-full border border-white/15 bg-gray-950 px-3.5 py-3 text-sm font-medium text-white shadow-[0_18px_48px_rgba(17,24,39,0.28)] transition-all hover:-translate-y-1 hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-[#d6c39a] focus:ring-offset-2"
      :aria-expanded="open"
      aria-label="打开联系方式"
      @click="toggleOpen"
    >
      <span class="absolute inset-0 bg-[radial-gradient(circle_at_24%_0%,rgba(214,195,154,0.24),transparent_34%)] opacity-90" />
      <span class="relative flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white ring-1 ring-white/15 transition-transform group-hover:scale-105">
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" />
        </svg>
      </span>
      <span class="relative leading-tight">
        <span class="block">联系站长</span>
        <span class="block text-[11px] font-normal text-white/60">{{ primaryContact }} · {{ contactCount }} 种方式</span>
      </span>
      <svg class="relative h-4 w-4 text-white/60 transition-transform group-hover:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6" />
      </svg>
    </button>
  </div>
</template>
