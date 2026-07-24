<script setup lang="ts">
import type {
  AttributionVerificationView,
} from '~/types/attribution-admin'
import {
  attributionPlatformDefinition,
} from '~/utils/attributionPlatforms'

withDefaults(defineProps<{
  records?: AttributionVerificationView[]
}>(), {
  records: () => [],
})

function statusLabel(
  status: AttributionVerificationView['status'],
): string {
  if (status === 'queued') return '等待验证'
  if (status === 'running') return '验证中'
  if (status === 'verified') return '已验证'
  if (status === 'timed_out') return '已超时'
  return '验证失败'
}
</script>

<template>
  <section
    data-attribution-verification-panel
    class="min-w-0 border-y border-gray-200 bg-white"
  >
    <div class="border-b border-gray-200 px-3 py-4 sm:px-5">
      <h2 class="text-base font-semibold text-gray-900">候选验证记录</h2>
      <p class="mt-1 text-xs leading-5 text-gray-500">
        每次创建完整身份候选都会自动生成一条验证记录。
      </p>
    </div>
    <div v-if="records.length" class="overflow-x-auto">
      <table class="w-full min-w-[54rem] text-left text-sm">
        <thead class="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
          <tr>
            <th class="px-3 py-2 font-medium sm:px-5">平台 / 连接</th>
            <th class="px-3 py-2 font-medium">状态</th>
            <th class="px-3 py-2 font-medium">身份检查</th>
            <th class="px-3 py-2 font-medium">Browser 配对</th>
            <th class="px-3 py-2 font-medium">开始时间</th>
            <th class="px-3 py-2 font-medium">完成时间</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="record in records" :key="`${record.connectionId}:${record.createdAt}`">
            <td class="px-3 py-3 sm:px-5">
              <p class="font-medium text-gray-900">
                {{ attributionPlatformDefinition(record.provider).label }}
                / {{ record.connectionName }}
              </p>
            </td>
            <td class="px-3 py-3">
              <span
                class="font-medium"
                :class="record.status === 'verified'
                  ? 'text-emerald-700'
                  : record.status === 'failed' || record.status === 'timed_out'
                    ? 'text-red-700'
                    : 'text-amber-700'"
              >
                {{ statusLabel(record.status) }}
              </span>
              <p v-if="record.failureCode" class="mt-1 text-xs text-red-600">
                {{ record.failureCode }}
              </p>
            </td>
            <td class="px-3 py-3 text-gray-700">
              {{ record.candidateChecked ? '已完成' : '未完成' }}
            </td>
            <td class="px-3 py-3 tabular-nums text-gray-700">
              {{ record.pairedEventCount }} 个事件
            </td>
            <td class="px-3 py-3 text-gray-600">
              {{ record.startedAt
                ? formatAnalyticsDateTime(record.startedAt)
                : '-' }}
            </td>
            <td class="px-3 py-3 text-gray-600">
              {{ record.completedAt
                ? formatAnalyticsDateTime(record.completedAt)
                : '-' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="px-3 py-10 text-center text-sm text-gray-500 sm:px-5">
      当前范围没有候选验证记录
    </p>
  </section>
</template>
