<script setup lang="ts">
import type {
  AttributionOperationMetrics,
} from '~/types/attribution-admin'

const props = defineProps<{
  metrics: AttributionOperationMetrics
}>()

const businessMetrics = computed(() => [
  {
    key: 'business-contact',
    label: '业务 Contact',
    value: props.metrics.contactCount,
    tone: 'text-emerald-700',
  },
  {
    key: 'business-registration',
    label: '业务 CompleteRegistration',
    value: props.metrics.completeRegistrationCount,
    tone: 'text-emerald-700',
  },
  {
    key: 'unattributed-facts',
    label: '未归因事实',
    value: props.metrics.unattributedFactCount,
    tone: props.metrics.unattributedFactCount > 0
      ? 'text-amber-700'
      : 'text-gray-900',
  },
])

const stages = computed(() => [
  {
    key: 'business-facts',
    label: '业务事实',
    value: props.metrics.factCount,
    detail: '站内已确认',
  },
  {
    key: 'attributed-facts',
    label: '已归因事实',
    value: props.metrics.attributedFactCount,
    detail: '已绑定连接',
  },
  {
    key: 'browser-attempted',
    label: 'Browser Attempted',
    value: props.metrics.browserAttempted,
    detail: '收到浏览器回执',
  },
  {
    key: 'server-planned',
    label: 'Server Planned',
    value: props.metrics.serverPlanned,
    detail: '已生成投递计划',
  },
  {
    key: 'server-queued',
    label: 'Server Queued',
    value: props.metrics.serverQueued,
    detail: '至少完成一次入队',
  },
  {
    key: 'server-processed',
    label: 'Server Processed',
    value: props.metrics.serverProcessed,
    detail: '平台已接收或处理',
  },
])
</script>

<template>
  <section
    data-attribution-delivery-funnel
    class="min-w-0 border-y border-gray-200 bg-white"
  >
    <div class="grid grid-cols-1 divide-y divide-gray-200 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <dl
        v-for="metric in businessMetrics"
        :key="metric.key"
        :data-metric="metric.key"
        class="min-w-0 px-3 py-3 sm:px-4"
      >
        <dt class="text-xs font-medium text-gray-500">
          {{ metric.label }}
        </dt>
        <dd
          :class="metric.tone"
          class="mt-1 text-xl font-semibold tabular-nums"
        >
          {{ formatAnalyticsNumber(metric.value) }}
        </dd>
      </dl>
    </div>

    <div class="overflow-x-auto border-t border-gray-200">
      <ol class="grid min-w-[54rem] grid-cols-6">
        <li
          v-for="(stage, index) in stages"
          :key="stage.key"
          :data-metric="stage.key"
          class="relative min-w-0 border-r border-gray-200 px-3 py-4 last:border-r-0"
        >
          <span class="text-[11px] font-medium text-gray-400">
            {{ String(index + 1).padStart(2, '0') }}
          </span>
          <p class="mt-1 text-xs font-medium text-gray-600">
            {{ stage.label }}
          </p>
          <p class="mt-2 text-xl font-semibold tabular-nums text-gray-950">
            {{ formatAnalyticsNumber(stage.value) }}
          </p>
          <p class="mt-1 text-xs text-gray-400">
            {{ stage.detail }}
          </p>
        </li>
      </ol>
    </div>

    <div
      v-if="metrics.serverRejected || metrics.serverDeadLetter"
      class="flex flex-wrap gap-x-5 gap-y-1 border-t border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 sm:px-4"
    >
      <span>Server Rejected {{ formatAnalyticsNumber(metrics.serverRejected) }}</span>
      <span>Dead Letter {{ formatAnalyticsNumber(metrics.serverDeadLetter) }}</span>
    </div>
  </section>
</template>
