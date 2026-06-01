<script setup lang="ts">
import { computed, useId } from 'vue'
import { normalizeHomeAdUrl, safeHomeAdText } from '~/utils/siteSettingsSecurity'

const props = defineProps<{
  enabled: boolean
  eyebrow?: string
  title?: string
  summary?: string
  ctaLabel?: string
  url?: string
  sponsor?: string
  preview?: boolean
}>()

const externalNoteId = `${useId()}-home-ad-external-note`

function normalizeAdUrl(url?: string) {
  return normalizeHomeAdUrl(url) || '/discover?sort=hot'
}

const safeUrl = computed(() => normalizeAdUrl(props.url))
const isExternalUrl = computed(() => safeUrl.value.startsWith('https://'))
const externalHostname = computed(() => {
  if (!isExternalUrl.value) return ''

  try {
    return new URL(safeUrl.value).hostname.toLowerCase().replace(/\.+$/, '')
  } catch {
    return ''
  }
})
const ctaSecurityLabel = computed(() => isExternalUrl.value ? '外部链接' : '站内推荐')
const safeEyebrow = computed(() => safeHomeAdText('home_ad_eyebrow', props.eyebrow) || '本周推荐')
const safeTitle = computed(() => safeHomeAdText('home_ad_title', props.title) || '会员季精选内容')
const safeSummary = computed(() => safeHomeAdText('home_ad_summary', props.summary) || '探索本周精选图库、真实案例和会员可访问内容。')
const safeCtaLabel = computed(() => safeHomeAdText('home_ad_cta_label', props.ctaLabel) || '查看推荐')
const safeSponsor = computed(() => safeHomeAdText('home_ad_sponsor', props.sponsor))
</script>

<template>
  <section v-if="enabled" aria-label="首页广告推荐" class="relative overflow-hidden rounded-[1.25rem] border border-[#e5d5c4] bg-[#fffaf3] shadow-lg shadow-stone-900/8">
    <div class="pointer-events-none absolute inset-0 bg-[linear-gradient(118deg,rgba(255,255,255,0.94),rgba(250,235,220,0.78)_54%,rgba(180,145,92,0.14))]" />
    <div class="pointer-events-none absolute inset-x-5 top-5 h-px bg-gradient-to-r from-transparent via-[#d0b27a]/35 to-transparent" />
    <div class="pointer-events-none absolute inset-y-5 left-5 w-px bg-gradient-to-b from-transparent via-[#d0b27a]/24 to-transparent" />
    <div class="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(143,116,53,0.16)_0,rgba(143,116,53,0.16)_1px,transparent_1px,transparent_12px)] opacity-80 [mask-image:linear-gradient(180deg,transparent,black_18%,black_82%,transparent)]" />

    <div class="relative grid gap-5 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center lg:px-7">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full border border-stone-900 bg-stone-950 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white">
            推广
          </span>
          <span class="rounded-full border border-[#d6c39a]/70 bg-white/75 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#81662c]">
            {{ safeEyebrow }}
          </span>
          <span v-if="safeSponsor" class="text-xs text-stone-500">{{ safeSponsor }}</span>
        </div>
        <h2 class="mt-3 line-clamp-2 break-words text-xl font-semibold leading-tight text-stone-950 lg:text-2xl">{{ safeTitle }}</h2>
        <p class="mt-2 max-w-2xl break-words text-sm leading-6 text-stone-600 line-clamp-3">{{ safeSummary }}</p>
      </div>

      <span
        v-if="preview"
        aria-disabled="true"
        :aria-describedby="isExternalUrl ? externalNoteId : undefined"
        class="inline-flex min-h-11 max-w-full shrink-0 cursor-default items-center justify-center gap-2 rounded-full bg-stone-950 px-5 py-2.5 text-center text-sm font-medium leading-tight whitespace-normal break-words text-white shadow-sm shadow-stone-900/15"
      >
        <span>{{ safeCtaLabel }}</span>
        <svg v-if="isExternalUrl" aria-hidden="true" class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 17 17 7" />
          <path d="M9 7h8v8" />
        </svg>
      </span>
      <a
        v-else-if="isExternalUrl"
        :href="safeUrl"
        target="_blank"
        rel="noopener noreferrer nofollow sponsored"
        referrerpolicy="no-referrer"
        :aria-describedby="externalNoteId"
        :aria-label="`${safeCtaLabel}，外部链接${externalHostname ? `，目标域名 ${externalHostname}` : ''}`"
        class="group/cta inline-flex min-h-11 max-w-full shrink-0 items-center justify-center gap-2 rounded-full bg-stone-950 px-5 py-2.5 text-center text-sm font-medium leading-tight whitespace-normal break-words text-white shadow-sm shadow-stone-900/15 transition-all hover:-translate-y-0.5 hover:bg-stone-800"
      >
        <span>{{ safeCtaLabel }}</span>
        <svg aria-hidden="true" class="h-3.5 w-3.5 shrink-0 transition-transform group-hover/cta:-translate-y-0.5 group-hover/cta:translate-x-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M7 17 17 7" />
          <path d="M9 7h8v8" />
        </svg>
      </a>
      <NuxtLink
        v-else
        :to="safeUrl"
        class="inline-flex min-h-11 max-w-full shrink-0 items-center justify-center rounded-full bg-stone-950 px-5 py-2.5 text-center text-sm font-medium leading-tight whitespace-normal break-words text-white shadow-sm shadow-stone-900/15 transition-all hover:-translate-y-0.5 hover:bg-stone-800"
      >
        {{ safeCtaLabel }}
      </NuxtLink>
    </div>

    <p :id="isExternalUrl ? externalNoteId : undefined" class="relative border-t border-[#e5d5c4]/70 bg-white/45 px-5 py-2 text-[11px] font-medium text-stone-500 lg:px-7">
      {{ ctaSecurityLabel }}
      <span v-if="isExternalUrl" class="mx-1 text-stone-300">/</span>
      <span v-if="isExternalUrl && externalHostname">目标域名 {{ externalHostname }}</span>
      <span v-if="isExternalUrl && externalHostname" class="mx-1 text-stone-300">/</span>
      <span v-if="isExternalUrl">不发送来源页信息</span>
    </p>
  </section>
</template>
