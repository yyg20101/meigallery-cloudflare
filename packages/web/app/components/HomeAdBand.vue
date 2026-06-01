<script setup lang="ts">
import { normalizePublicSettingUrl } from '~/utils/siteSettingsSecurity'

const props = defineProps<{
  enabled: boolean
  eyebrow?: string
  title?: string
  summary?: string
  ctaLabel?: string
  url?: string
  sponsor?: string
}>()

function normalizeAdUrl(url?: string) {
  return normalizePublicSettingUrl(url) || '/discover?sort=hot'
}

const safeUrl = computed(() => normalizeAdUrl(props.url))
const isExternalUrl = computed(() => safeUrl.value.startsWith('https://'))
</script>

<template>
  <section v-if="enabled" aria-label="首页广告推荐" class="relative overflow-hidden rounded-[1.25rem] border border-[#e5d5c4] bg-[#fffaf3] shadow-lg shadow-stone-900/8">
    <div class="absolute inset-0 bg-[linear-gradient(118deg,rgba(255,255,255,0.94),rgba(250,235,220,0.78)_54%,rgba(180,145,92,0.14))]" />
    <div class="absolute -right-16 top-1/2 h-36 w-36 -translate-y-1/2 rounded-full border border-[#d0b27a]/30" />
    <div class="absolute bottom-0 right-0 h-full w-2/5 bg-[repeating-linear-gradient(135deg,rgba(143,116,53,0.16)_0,rgba(143,116,53,0.16)_1px,transparent_1px,transparent_12px)] opacity-80" />

    <div class="relative grid gap-5 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center lg:px-7">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full border border-[#d6c39a]/70 bg-white/75 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#81662c]">
            {{ eyebrow || '本周推荐' }}
          </span>
          <span v-if="sponsor" class="text-xs text-stone-500">{{ sponsor }}</span>
        </div>
        <h2 class="mt-3 line-clamp-2 text-xl font-semibold leading-tight text-stone-950 lg:text-2xl">{{ title || '会员季精选内容' }}</h2>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-stone-600 line-clamp-3">{{ summary || '探索本周精选图库、真实案例和会员可访问内容。' }}</p>
      </div>

      <a
        v-if="isExternalUrl"
        :href="safeUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-stone-950 px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-stone-900/15 transition-all hover:-translate-y-0.5 hover:bg-stone-800"
      >
        {{ ctaLabel || '查看推荐' }}
      </a>
      <NuxtLink
        v-else
        :to="safeUrl"
        class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-stone-950 px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-stone-900/15 transition-all hover:-translate-y-0.5 hover:bg-stone-800"
      >
        {{ ctaLabel || '查看推荐' }}
      </NuxtLink>
    </div>
  </section>
</template>
