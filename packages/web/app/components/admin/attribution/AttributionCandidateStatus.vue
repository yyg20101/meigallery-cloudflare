<script setup lang="ts">
import type {
  AttributionConnectionCandidateView,
} from '~/types/attribution-admin'

const props = defineProps<{
  candidate: AttributionConnectionCandidateView | null
}>()

const status = computed(() => {
  if (!props.candidate) {
    return {
      label: '没有待处理候选',
      detail: '当前没有正在验证的新身份配置。',
      className: 'border-gray-200 bg-gray-50 text-gray-700',
    }
  }
  if (props.candidate.state === 'validating') {
    return {
      label: '验证中',
      detail: '候选配置正在独立验证，当前生产版本继续运行。',
      className: 'border-blue-200 bg-blue-50 text-blue-800',
    }
  }
  if (props.candidate.state === 'ready') {
    return {
      label: '可以启用',
      detail: '候选配置已完成验证，当前生产版本继续运行。',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    }
  }
  if (props.candidate.state === 'failed') {
    return {
      label: '验证未通过',
      detail: '候选配置未替换生产版本，当前生产版本继续运行。',
      className: 'border-red-200 bg-red-50 text-red-800',
    }
  }
  return {
    label: '等待验证',
    detail: '候选配置已保存，当前生产版本继续运行。',
    className: 'border-amber-200 bg-amber-50 text-amber-800',
  }
})
</script>

<template>
  <div
    data-candidate-status
    :class="[
      'min-w-0 border px-3 py-3 text-sm',
      status.className,
    ]"
  >
    <p class="font-semibold">{{ status.label }}</p>
    <p class="mt-1 leading-6">{{ status.detail }}</p>
  </div>
</template>
