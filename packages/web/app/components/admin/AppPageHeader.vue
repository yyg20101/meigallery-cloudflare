<script setup lang="ts">
import type { AdminFigmaPageId } from '~/utils/admin-figma-pages'
import { getAdminFigmaPage } from '~/utils/admin-figma-pages'
import { requireAdminFigmaState } from '~/utils/admin-figma-states'

type StateTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

const props = withDefaults(defineProps<{
  pageId: AdminFigmaPageId
  route?: string
  title: string
  description: string
  state?: string
  figmaState: string
  stateTone?: StateTone
}>(), {
  state: '正常',
  stateTone: 'info',
  route: '',
})

const stateClass = computed(() => ({
  neutral: 'border-[#eaded8] bg-white text-stone-600',
  info: 'border-[#b2ddff] bg-[#d1e9ff] text-[#175cd3]',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  danger: 'border-red-200 bg-red-50 text-red-700',
}[props.stateTone]))

const stateDotClass = computed(() => ({
  neutral: 'bg-stone-400',
  info: 'bg-[#1570ef]',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
}[props.stateTone]))

const figmaPage = computed(() => getAdminFigmaPage(props.pageId))
const designRoute = computed(() => props.route || figmaPage.value.route)
const officialFigmaState = computed(() => requireAdminFigmaState(props.pageId, props.figmaState))
</script>

<template>
  <header
    class="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between"
    :data-figma-page-id="pageId"
    :data-figma-design-route="designRoute"
    :data-figma-primary-node-id="figmaPage.nodeId"
    :data-figma-node-id="officialFigmaState.nodeId"
    :data-figma-state-name="officialFigmaState.stateName"
    :data-figma-state-node-id="officialFigmaState.nodeId"
    :data-figma-runtime-state="state"
    data-figma-state-exact="true"
  >
    <div class="min-w-0">
      <h1 class="break-words text-[28px] font-bold leading-9 text-[#2c2421]">{{ title }}</h1>
      <p class="mt-1 max-w-3xl break-words text-sm leading-[22px] text-[#6a5f5a]">{{ description }}</p>
    </div>
    <div class="flex w-full min-w-0 flex-wrap items-center gap-3 lg:w-auto lg:shrink-0 lg:justify-end">
      <span class="inline-flex min-h-7 max-w-full shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium" :class="stateClass">
        <span class="size-1.5 shrink-0 rounded-full" :class="stateDotClass" />
        {{ state }}
      </span>
      <div class="flex min-w-0 max-w-full flex-1 flex-wrap items-center gap-2 [overflow-wrap:anywhere] sm:flex-initial">
        <slot name="actions" />
      </div>
    </div>
  </header>
</template>
