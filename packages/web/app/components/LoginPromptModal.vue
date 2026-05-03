<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const titleId = 'login-prompt-title'
const modalRef = ref<HTMLElement | null>(null)
const previouslyFocusedElement = ref<HTMLElement | null>(null)

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusableElements() {
  return Array.from(modalRef.value?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
    .filter(element => !element.hasAttribute('disabled') && element.tabIndex !== -1)
}

async function focusModal() {
  if (!import.meta.client) return

  await nextTick()
  const firstFocusableElement = getFocusableElements()[0]
  const focusTarget = firstFocusableElement ?? modalRef.value
  focusTarget?.focus()
}

function restoreFocus() {
  if (!import.meta.client) return

  previouslyFocusedElement.value?.focus()
  previouslyFocusedElement.value = null
}

function closeModal() {
  emit('close')
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeModal()
    return
  }

  if (event.key !== 'Tab') return

  const focusableElements = getFocusableElements()
  if (!focusableElements.length) {
    event.preventDefault()
    modalRef.value?.focus()
    return
  }

  const firstElement = focusableElements[0]
  const lastElement = focusableElements[focusableElements.length - 1]

  if (event.shiftKey && document.activeElement === firstElement) {
    event.preventDefault()
    lastElement.focus()
    return
  }

  if (!event.shiftKey && document.activeElement === lastElement) {
    event.preventDefault()
    firstElement.focus()
  }
}

watch(() => props.open, (isOpen) => {
  if (!import.meta.client) return

  if (isOpen) {
    previouslyFocusedElement.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void focusModal()
    return
  }

  restoreFocus()
})

onMounted(() => {
  if (!import.meta.client || !props.open) return

  previouslyFocusedElement.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
  void focusModal()
})

onBeforeUnmount(() => {
  if (props.open) restoreFocus()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/58 px-4 py-6 backdrop-blur-sm"
      @click.self="closeModal"
    >
      <section
        ref="modalRef"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        class="relative w-full max-w-[min(92vw,26rem)] overflow-hidden rounded-[1.75rem] border border-white/70 bg-[#fffaf4] p-5 text-stone-950 shadow-2xl shadow-black/25 ring-1 ring-[#e8d5c5] outline-none sm:p-6"
        @keydown="handleKeydown"
      >
        <div class="pointer-events-none absolute -right-12 -top-16 h-36 w-36 rounded-full bg-[#ead7b7]/70 blur-3xl" />
        <div class="pointer-events-none absolute -bottom-20 -left-16 h-44 w-44 rounded-full bg-white blur-3xl" />

        <button
          type="button"
          class="absolute right-4 top-4 z-10 rounded-full border border-stone-200/80 bg-white/70 px-2.5 py-1 text-xs font-medium text-stone-500 shadow-sm transition hover:border-stone-300 hover:text-stone-900"
          aria-label="关闭登录提示"
          @click="closeModal"
        >
          关闭
        </button>

        <div class="relative pr-12">
          <p class="mb-2 text-[10px] font-semibold tracking-[0.24em] text-[#b99a5f]">登录提示</p>
          <h2 :id="titleId" class="text-xl font-semibold tracking-tight text-stone-950">登录后即可点赞</h2>
          <p class="mt-3 text-sm leading-6 text-stone-600">
            登录账号后可为喜欢的图库点赞，并保留你的互动记录。注册只需邮箱即可开始浏览更多会员内容。
          </p>
        </div>

        <div class="relative mt-6 flex flex-col gap-2 sm:flex-row">
          <NuxtLink
            to="/login"
            class="inline-flex flex-1 items-center justify-center rounded-full bg-black px-4 py-2.5 text-sm font-semibold text-[#d6c39a] shadow-lg shadow-black/15 transition hover:-translate-y-0.5 hover:bg-stone-950"
          >
            登录 / 注册
          </NuxtLink>
          <button
            type="button"
            class="inline-flex flex-1 items-center justify-center rounded-full border border-[#eadfcf] bg-white/70 px-4 py-2.5 text-sm font-semibold text-stone-700 transition hover:-translate-y-0.5 hover:border-[#d6c39a] hover:text-stone-950"
            @click="closeModal"
          >
            稍后再说
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
