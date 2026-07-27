<script setup lang="ts">
import { renderSafeMarkdown } from '~/utils/safeMarkdown'

const { contactMethods, fetchContactMethods, hasContactMethods } = useContactMethods()
const {
  rulesEntryEnabled,
  rulesEntryTitle,
  rulesEntrySummary,
  rulesModalContent,
  rulesPageUrl,
} = useSiteSettings()
const { trackContact, trackAnalytics } = useTracking()

await fetchContactMethods()

const mounted = ref(false)
const contactOpen = ref(false)
const rulesOpen = ref(false)
const contactCount = computed(() => contactMethods.value.length)
const primaryContact = computed(() => contactMethods.value[0]?.label || '在线咨询')
const renderedRules = computed(() => renderSafeMarkdown(rulesModalContent.value || rulesEntrySummary.value))
const serviceSteps = ['看规则', '联系站长', '开通访问']

function toggleOpen() {
  contactOpen.value = !contactOpen.value
  if (contactOpen.value) rulesOpen.value = false
  if (contactOpen.value) {
    trackContactPanelOpen()
  }
}

function trackContactMethod(contactMethodId: string, methodType: string, actionType = 'unknown') {
  if (actionType === 'copy') {
    trackAnalytics('contact_value_copy', {
      entityType: 'contact',
      props: {
        contact_method_id: contactMethodId,
        method_type: methodType,
        action_type: 'copy',
        location: 'floating_contact_panel',
      },
    })
    return
  }
  if (actionType !== 'open_link') return
  void Promise.resolve(trackContact({ contactMethodId, methodType, actionType })).catch(() => {})
}

function trackContactInspection(contactMethodId: string, methodType: string, actionType: string) {
  if (actionType !== 'qr_expand') return
  trackAnalytics('contact_qr_expand', {
    entityType: 'contact',
    props: {
      contact_method_id: contactMethodId,
      method_type: methodType,
      action_type: actionType,
      location: 'floating_contact_panel',
    },
  })
}

function openContactPanel() {
  contactOpen.value = true
  rulesOpen.value = false
  trackContactPanelOpen()
}

onMounted(() => {
  mounted.value = true
  window.addEventListener('meigallery:open-contact-panel', openContactPanel)
})

onUnmounted(() => {
  window.removeEventListener('meigallery:open-contact-panel', openContactPanel)
})

function toggleRules() {
  rulesOpen.value = !rulesOpen.value
  if (rulesOpen.value) contactOpen.value = false
  if (rulesOpen.value) {
    trackAnalytics('rules_panel_open', {
      entityType: 'page',
      props: { location: 'floating_rules_panel' },
    })
  }
}

function trackContactPanelOpen() {
  trackAnalytics('contact_panel_open', {
    entityType: 'contact',
    flush: true,
    props: { location: 'floating_contact_panel' },
  })
}

function trackRulesPageClick() {
  trackAnalytics('rules_page_click', {
    entityType: 'page',
    props: { location: 'floating_rules_panel' },
  })
}
</script>

<template>
  <div
    v-if="mounted && (hasContactMethods || rulesEntryEnabled)"
    class="fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-3 z-50 flex flex-col items-end lg:bottom-6 lg:right-6 lg:w-[min(calc(100vw-2rem),24rem)]"
    :class="contactOpen || rulesOpen ? 'w-[min(calc(100vw-1.5rem),24rem)]' : 'w-auto'"
  >
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-3 opacity-0 scale-95"
      enter-to-class="translate-y-0 opacity-100 scale-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="translate-y-0 opacity-100 scale-100"
      leave-to-class="translate-y-3 opacity-0 scale-95"
    >
      <div
        v-if="rulesOpen"
        class="mb-3 w-full overflow-hidden rounded-2xl border border-[#e8dcc7] bg-[#fffdf9]/95 shadow-[0_24px_70px_rgba(17,24,39,0.16)] ring-1 ring-white/80 backdrop-blur-xl"
      >
        <div class="border-b border-[#f0e5d6] bg-[#151515] p-5 text-white">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-xs font-semibold tracking-[0.22em] text-[#d6c39a]">服务流程</p>
              <h2 class="mt-1.5 text-lg font-semibold tracking-normal text-white">{{ rulesEntryTitle }}</h2>
              <p class="mt-1.5 text-xs leading-5 text-white/68">{{ rulesEntrySummary }}</p>
            </div>
            <button
              type="button"
              class="rounded-full bg-white/10 p-2 text-white/65 ring-1 ring-white/15 transition-all hover:-translate-y-0.5 hover:bg-white hover:text-gray-950"
              aria-label="关闭规则说明"
              @click="rulesOpen = false"
            >
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <ol class="mt-4 grid grid-cols-3 gap-2">
            <li
              v-for="(step, index) in serviceSteps"
              :key="step"
              class="rounded-xl border border-white/10 bg-white/[0.06] px-2.5 py-2 text-center"
            >
              <span class="block text-[10px] font-semibold text-[#d6c39a]">0{{ index + 1 }}</span>
              <span class="mt-0.5 block text-xs font-medium text-white">{{ step }}</span>
            </li>
          </ol>
        </div>
        <div class="rules-content max-h-[42vh] overflow-y-auto px-5 pb-4 text-sm leading-6 text-gray-600" v-html="renderedRules" />
        <div class="border-t border-[#f0e5d6] bg-white/70 px-5 py-3">
          <NuxtLink :to="rulesPageUrl" class="inline-flex items-center gap-1 text-xs font-medium text-gray-950 underline decoration-[#d6c39a] underline-offset-4" @click="trackRulesPageClick">
            查看完整规则
            <span aria-hidden="true">→</span>
          </NuxtLink>
        </div>
      </div>
    </Transition>

    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-3 opacity-0 scale-95"
      enter-to-class="translate-y-0 opacity-100 scale-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="translate-y-0 opacity-100 scale-100"
      leave-to-class="translate-y-3 opacity-0 scale-95"
    >
      <div
        v-if="contactOpen"
        class="mb-3 w-full overflow-hidden rounded-2xl border border-[#e8dcc7] bg-white/95 shadow-[0_28px_80px_rgba(17,24,39,0.18)] ring-1 ring-white/80 backdrop-blur-xl"
      >
        <div class="border-b border-[#f0e5d6] bg-[#151515] p-5 text-white">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-xs font-semibold tracking-[0.22em] text-[#d6c39a]">有新消息</p>
              <h2 class="mt-1.5 text-lg font-semibold tracking-normal text-white">站长在线回复</h2>
              <p class="mt-1.5 text-xs leading-5 text-white/68">开通会员、内容授权或站点问题，可选择任一方式联系。</p>
            </div>
            <button
              type="button"
              class="rounded-full bg-white/10 p-2 text-white/65 ring-1 ring-white/15 transition-all hover:-translate-y-0.5 hover:bg-white hover:text-gray-950"
              aria-label="关闭联系方式"
              @click="contactOpen = false"
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
            @activate="trackContactMethod"
            @inspect="trackContactInspection"
          />
        </div>

        <button
          v-if="rulesEntryEnabled"
          type="button"
          class="mx-3 mb-3 flex min-h-12 w-[calc(100%-1.5rem)] items-center justify-between gap-3 rounded-xl border border-[#e8dcc7] bg-[#fff9ef] px-4 py-3 text-left text-gray-950 transition-colors hover:border-[#d6c39a] hover:bg-white focus:outline-none focus:ring-2 focus:ring-[#d6c39a] focus:ring-offset-2 lg:hidden"
          aria-label="查看服务流程"
          @click="toggleRules"
        >
          <span>
            <span class="block text-sm font-semibold">服务流程</span>
            <span class="mt-0.5 block text-xs text-gray-500">查看规则与开通说明</span>
          </span>
          <span class="text-lg leading-none text-[#bfa46a]" aria-hidden="true">→</span>
        </button>

        <div class="border-t border-[#f0e5d6] bg-[#fffdf9] px-5 py-3 text-xs leading-5 text-gray-500">
          支持官方跳转的平台会直接打开；无法生成跳转时，点击会复制联系值。
        </div>
      </div>
    </Transition>

    <div class="flex items-center gap-2 rounded-full border border-white/75 bg-white/92 p-1.5 shadow-[0_14px_36px_rgba(17,24,39,0.2)] ring-1 ring-[#eadfd2]/80 backdrop-blur-xl lg:block lg:w-full lg:rounded-2xl lg:p-2 lg:shadow-[0_22px_70px_rgba(17,24,39,0.24)]">
      <button
        v-if="rulesEntryEnabled"
        type="button"
        class="group h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[#e8dcc7] bg-[#fff9ef] text-left transition-all hover:-translate-y-0.5 hover:border-[#d6c39a] hover:bg-white focus:outline-none focus:ring-2 focus:ring-[#d6c39a] focus:ring-offset-2 lg:h-auto lg:w-full lg:justify-start lg:gap-3 lg:rounded-xl lg:px-3 lg:py-3"
        :class="hasContactMethods ? 'hidden lg:flex' : 'flex'"
        :aria-expanded="rulesOpen"
        aria-label="打开服务流程"
        @click="toggleRules"
      >
        <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#151515] text-[#d6c39a] shadow-sm lg:h-11 lg:w-11 lg:rounded-xl">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M7 3h8l4 4v14H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M14 3v5h5M9 13h6M9 17h4" />
          </svg>
        </span>
        <span class="hidden min-w-0 flex-1 lg:block">
          <span class="block text-base font-semibold leading-5 text-gray-950">服务流程</span>
          <span class="mt-1 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 text-[11px] font-medium leading-5 text-gray-500">
            <span>看规则</span>
            <span class="text-[#bfa46a]">→</span>
            <span>联系站长</span>
            <span class="text-[#bfa46a]">→</span>
            <span>开通访问</span>
          </span>
        </span>
        <svg class="hidden h-4 w-4 shrink-0 text-gray-400 transition-transform group-hover:translate-x-0.5 lg:block" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6" />
        </svg>
      </button>

      <button
        v-if="hasContactMethods"
        type="button"
        class="group relative flex h-12 w-12 shrink-0 items-center justify-center overflow-visible rounded-full border border-[#151515] bg-[#151515] text-left text-white shadow-[0_10px_24px_rgba(17,24,39,0.2)] transition-all hover:-translate-y-1 hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-[#d6c39a] focus:ring-offset-2 lg:mt-2 lg:h-auto lg:w-full lg:justify-start lg:gap-3 lg:overflow-hidden lg:rounded-xl lg:px-3 lg:py-3.5 lg:shadow-[0_16px_38px_rgba(17,24,39,0.24)]"
        :aria-expanded="contactOpen"
        aria-label="打开联系方式"
        @click="toggleOpen"
      >
        <span class="absolute right-0 top-0 flex h-3 w-3 lg:right-3 lg:top-3">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-70" />
          <span class="relative inline-flex h-3 w-3 rounded-full bg-red-500 ring-2 ring-[#151515]" />
        </span>
        <span class="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-gray-950 ring-1 ring-white/25 transition-transform group-hover:scale-105 lg:h-11 lg:w-11 lg:rounded-xl">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z" />
          </svg>
        </span>
        <span class="relative hidden min-w-0 flex-1 leading-tight lg:block">
          <span class="block text-base font-semibold">有新消息</span>
          <span class="mt-1 block truncate text-xs font-normal text-white/62">{{ primaryContact }} · {{ contactCount }} 种方式 · 站长在线回复</span>
        </span>
        <svg class="relative hidden h-4 w-4 shrink-0 text-white/60 transition-transform group-hover:translate-x-0.5 lg:block" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.rules-content :deep(h2),
.rules-content :deep(h3) {
  margin-top: 0.85rem;
  margin-bottom: 0.35rem;
  color: #111827;
  font-weight: 650;
}

.rules-content :deep(p) {
  margin: 0.45rem 0;
}

.rules-content :deep(ul) {
  margin: 0.45rem 0;
  padding-left: 1.1rem;
  list-style: disc;
}

.rules-content :deep(a) {
  color: #111827;
  text-decoration: underline;
  text-decoration-color: #d6c39a;
  text-underline-offset: 4px;
}
</style>
