<script setup lang="ts">
export interface AnalyticsFunnelStep {
  key?: string
  label: string
  value: number
  rate?: string
  rateFromPrevious?: number
  rateFromEntry?: number
  detailTo?: string
  tone?: 'blue' | 'gold' | 'green' | 'red' | 'default'
}

export interface AnalyticsFunnelDropOff {
  fromLabel?: string
  toLabel?: string
  lost: number
  lossRate: number
}

const props = withDefaults(defineProps<{
  title?: string
  description?: string
  steps: AnalyticsFunnelStep[]
  dropOffs?: AnalyticsFunnelDropOff[]
}>(), {
  title: '关键转化漏斗',
  description: '从访问落地到会员发放的运营路径',
  dropOffs: () => [],
})

const firstValue = computed(() => Math.max(0, Number(props.steps[0]?.value ?? 0)))
const maxValue = computed(() => Math.max(1, ...props.steps.map(step => Math.max(0, Number(step.value ?? 0)))))

function stepRate(step: AnalyticsFunnelStep, index: number) {
  if (step.rate) return step.rate
  if (typeof step.rateFromPrevious === 'number') return formatRate(step.rateFromPrevious)
  if (firstValue.value <= 0) return '--'
  if (index === 0) return '100%'
  return formatAnalyticsPercent(step.value, firstValue.value)
}

function entryRate(step: AnalyticsFunnelStep, index: number) {
  if (typeof step.rateFromEntry === 'number') return formatRate(step.rateFromEntry)
  return index === 0 ? '100%' : stepRate(step, index)
}

function stepWidth(step: AnalyticsFunnelStep) {
  const value = Math.max(0, Number(step.value ?? 0))
  if (value <= 0) return '0%'
  return `${Math.max(8, Math.round((value / maxValue.value) * 100))}%`
}

function barClass(step: AnalyticsFunnelStep) {
  if (step.tone === 'blue') return 'bg-blue-500'
  if (step.tone === 'green') return 'bg-emerald-500'
  if (step.tone === 'red') return 'bg-red-500'
  if (step.tone === 'default') return 'bg-gray-500'
  return 'bg-amber-500'
}

function formatRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0%'
  return `${(value * 100).toFixed(1)}%`
}
</script>

<template>
  <section class="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
    <div class="mb-5 flex items-start justify-between gap-4">
      <div>
        <h2 class="text-sm font-semibold text-gray-900">{{ title }}</h2>
        <p class="mt-1 text-xs leading-5 text-gray-500">{{ description }}</p>
      </div>
      <span class="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">会员线</span>
    </div>

    <div class="space-y-4">
      <div v-for="(step, index) in steps" :key="step.key || step.label" class="grid grid-cols-[5rem_minmax(0,1fr)_5.5rem] items-center gap-3">
        <div class="min-w-0">
          <p class="truncate text-sm font-medium text-gray-700">{{ step.label }}</p>
          <p class="mt-1 text-xs text-gray-400">{{ formatAnalyticsNumber(step.value) }}</p>
        </div>
        <div class="h-3 overflow-hidden rounded-full bg-gray-100">
          <div :class="['h-full rounded-full transition-all', barClass(step)]" :style="{ width: stepWidth(step) }" />
        </div>
        <div class="text-right">
          <p class="text-sm font-semibold text-gray-700">{{ stepRate(step, index) }}</p>
          <p class="text-xs text-gray-400">入口 {{ entryRate(step, index) }}</p>
        </div>
      </div>
    </div>

    <div v-if="dropOffs.length > 0" class="mt-5 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
      <p class="text-xs font-semibold text-gray-500">主要流失点</p>
      <div class="mt-3 space-y-2">
        <div v-for="item in dropOffs.slice(0, 3)" :key="`${item.fromLabel}-${item.toLabel}`" class="flex items-center justify-between gap-3 text-xs">
          <span class="min-w-0 truncate text-gray-600">{{ item.fromLabel }} → {{ item.toLabel }}</span>
          <span class="shrink-0 font-medium text-gray-900">{{ formatAnalyticsNumber(item.lost) }} / {{ formatRate(item.lossRate) }}</span>
        </div>
      </div>
    </div>
  </section>
</template>
