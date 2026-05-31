<script setup lang="ts">
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
  const value = (url || '').trim()
  if (value.startsWith('https://')) return value
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') && !/\s/.test(value)) return value
  return '/discover?sort=hot'
}

const safeUrl = computed(() => normalizeAdUrl(props.url))
const isExternalUrl = computed(() => safeUrl.value.startsWith('https://'))
</script>

<template>
  <section v-if="enabled" aria-label="首页广告推荐" class="relative overflow-hidden rounded-[1.5rem] border border-[#eadfd2] bg-[#fffbf7] shadow-lg shadow-orange-950/8">
    <div class="absolute inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,0.9),rgba(248,231,220,0.72)_58%,rgba(17,17,17,0.06))]" />
    <div class="absolute bottom-0 right-0 h-full w-2/5 bg-[repeating-linear-gradient(135deg,rgba(191,164,106,0.14)_0,rgba(191,164,106,0.14)_1px,transparent_1px,transparent_12px)] opacity-70" />

    <div class="relative grid gap-5 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center lg:px-7">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full border border-[#d6c39a]/60 bg-white/70 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#8f7435]">
            {{ eyebrow || '本周推荐' }}
          </span>
          <span v-if="sponsor" class="text-xs text-gray-500">{{ sponsor }}</span>
        </div>
        <h2 class="mt-3 text-xl font-semibold leading-tight tracking-tight text-gray-950 lg:text-2xl">{{ title || '会员季精选内容' }}</h2>
        <p class="mt-2 max-w-2xl text-sm leading-6 text-gray-600">{{ summary || '探索本周精选图库、真实案例和会员可访问内容。' }}</p>
      </div>

      <a
        v-if="isExternalUrl"
        :href="safeUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-gray-950 px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-gray-900/15 transition-all hover:-translate-y-0.5 hover:bg-gray-800"
      >
        {{ ctaLabel || '查看推荐' }}
      </a>
      <NuxtLink
        v-else
        :to="safeUrl"
        class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-gray-950 px-5 py-2.5 text-sm font-medium text-white shadow-sm shadow-gray-900/15 transition-all hover:-translate-y-0.5 hover:bg-gray-800"
      >
        {{ ctaLabel || '查看推荐' }}
      </NuxtLink>
    </div>
  </section>
</template>
