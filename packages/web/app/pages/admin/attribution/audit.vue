<script setup lang="ts">
interface AttributionAuditLog {
  id: string
  admin_email: string
  admin_nickname: string
  action: string
  target_type: string
  target_id: string
  created_at: string
}

definePageMeta({ layout: 'admin' })

const rangeState = useAdminAttributionRange('7d')
const auditLogs = useAdminAttribution<AttributionAuditLog[]>('/api/admin/audit-logs', {
  rangeState,
  query: { page: 1, pageSize: 100 },
})

const attributionTargetTypes = new Set(['attribution_platform_connection'])
const rows = computed(() => (auditLogs.data.value || []).filter(log => (
  attributionTargetTypes.has(log.target_type) && withinSelectedRange(log.created_at)
)))

function withinSelectedRange(value: string) {
  const timestamp = new Date(value).getTime()
  if (!Number.isFinite(timestamp)) return false
  const query = rangeState.query.value
  if (query.from && query.to) {
    const from = new Date(`${query.from}T00:00:00+08:00`).getTime()
    const to = new Date(`${query.to}T23:59:59.999+08:00`).getTime()
    return timestamp >= from && timestamp <= to
  }
  const days = Number.parseInt(String(query.range || '7d'), 10) || 7
  return timestamp >= Date.now() - days * 24 * 60 * 60 * 1_000
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    title="审计日志"
    description="记录平台连接、凭证轮换、验证和投放控制变更。"
    :loading="auditLogs.loading.value"
    :error="auditLogs.error.value"
    :show-usage="false"
    @refresh="auditLogs.refresh"
  >
    <section class="min-w-0 border-y border-gray-200 bg-white">
      <div class="overflow-x-auto">
        <table class="w-full min-w-[52rem] text-left text-sm">
          <thead class="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
            <tr><th class="px-3 py-2 font-medium sm:px-5">时间</th><th class="px-3 py-2 font-medium">管理员</th><th class="px-3 py-2 font-medium">操作</th><th class="px-3 py-2 font-medium">目标类型</th><th class="px-3 py-2 font-medium">目标 ID</th></tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            <tr v-for="log in rows" :key="log.id">
              <td class="whitespace-nowrap px-3 py-3 text-gray-600 sm:px-5">{{ formatAnalyticsDateTime(log.created_at) }}</td>
              <td class="px-3 py-3 text-gray-700">{{ log.admin_nickname || log.admin_email }}</td>
              <td class="px-3 py-3 font-medium text-gray-900">{{ log.action }}</td>
              <td class="px-3 py-3 text-gray-600">{{ log.target_type }}</td>
              <td class="max-w-xs truncate px-3 py-3 text-gray-500">{{ log.target_id }}</td>
            </tr>
            <tr v-if="!rows.length"><td colspan="5" class="px-3 py-10 text-center text-gray-500">当前范围没有归因配置变更</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </AttributionPageShell>
</template>
