<script setup lang="ts">
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import { serializeReadinessSettingRows, serializeReadinessVerificationRows } from '~/utils/attributionReadiness'

definePageMeta({ layout: 'admin' })

interface ReadinessData {
  ready: boolean
  checks: Array<{ key: string; label: string; level: 'blocker' | 'warning'; ok: boolean; detail: string }>
  settings: Record<string, unknown>
  verifications: {
    metaLive?: { present?: boolean; verifiedAt?: string; expiresAt?: string }
    metaResources?: { present?: boolean; verifiedAt?: string; expiresAt?: string }
  }
}

const { isOwner } = useAuth()
const attribution = useAdminAttribution<ReadinessData>('/api/admin/attribution/readiness')
const data = computed(() => attribution.data.value)
const settingRows = computed(() => serializeReadinessSettingRows(data.value?.settings ?? {}))
const verificationRows = computed(() => serializeReadinessVerificationRows(data.value?.verifications ?? {}))
const blockerChecks = computed(() => data.value?.checks.filter(check => check.level === 'blocker') ?? [])
const warningChecks = computed(() => data.value?.checks.filter(check => check.level === 'warning') ?? [])

function checkClass(check: ReadinessData['checks'][number]) {
  if (check.ok) return 'border-emerald-100 bg-emerald-50 text-emerald-900'
  return check.level === 'blocker'
    ? 'border-red-200 bg-red-50 text-red-900'
    : 'border-amber-200 bg-amber-50 text-amber-900'
}
</script>

<template>
  <AttributionPageShell
    v-model:range="attribution.range.value"
    v-model:date="attribution.date.value"
    title="发布检查"
    description="上线广告前确认站内分析、转化账本、Meta 配置和失败堆积状态。"
    :loading="attribution.loading.value"
    :error="attribution.error.value"
    :usage="attribution.usage.value"
    @refresh="attribution.refresh"
  >
    <template v-if="data">
      <section :class="['rounded-lg border px-4 py-3 text-sm font-medium', data.ready ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900']">
        {{ data.ready ? '生产阻断项已通过' : '生产阻断项仍需处理' }}
      </section>

      <section aria-label="阻断项" class="space-y-3">
        <div>
          <h2 class="text-sm font-semibold text-gray-900">阻断项</h2>
          <p class="mt-1 text-sm text-gray-500">任一未通过都会阻止 CAPI 开关启用。</p>
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <article v-for="check in blockerChecks" :key="check.key" :class="['rounded-lg border p-4', checkClass(check)]">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="text-sm font-semibold">{{ check.label }}</h3>
                <p class="mt-1 break-words text-xs leading-5 opacity-80">{{ check.detail }}</p>
                <p class="mt-1 break-all font-mono text-xs opacity-60">{{ check.key }}</p>
              </div>
              <span class="shrink-0 text-xs font-medium">{{ check.ok ? '通过' : '阻断' }}</span>
            </div>
          </article>
        </div>
      </section>

      <section aria-label="警告项" class="space-y-3">
        <div>
          <h2 class="text-sm font-semibold text-gray-900">警告项</h2>
          <p class="mt-1 text-sm text-gray-500">用于提示质量和稳定性风险，不改变顶部生产阻断状态。</p>
        </div>
        <div class="grid gap-3 md:grid-cols-2">
          <article v-for="check in warningChecks" :key="check.key" :class="['rounded-lg border p-4', checkClass(check)]">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3 class="text-sm font-semibold">{{ check.label }}</h3>
                <p class="mt-1 break-words text-xs leading-5 opacity-80">{{ check.detail }}</p>
                <p class="mt-1 break-all font-mono text-xs opacity-60">{{ check.key }}</p>
              </div>
              <span class="shrink-0 text-xs font-medium">{{ check.ok ? '正常' : '警告' }}</span>
            </div>
          </article>
        </div>
      </section>

      <section class="space-y-3 border-t border-gray-200 pt-5">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="text-sm font-semibold text-gray-900">相关配置</h2>
            <p class="mt-1 text-sm text-gray-500">这里只展示状态，配置修改请进入站点设置。</p>
          </div>
          <NuxtLink v-if="isOwner" to="/admin/settings" class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
            前往站点设置
          </NuxtLink>
        </div>
        <div class="grid border-y border-gray-200 md:grid-cols-2">
          <div v-for="item in settingRows" :key="item.key" class="min-w-0 border-b border-gray-100 px-3 py-3 md:odd:border-r">
            <p class="text-xs font-medium text-gray-500">{{ item.label }}</p>
            <p class="mt-1 font-mono text-xs text-gray-400">{{ item.key }}</p>
            <p class="mt-1 break-all text-sm font-medium text-gray-900">{{ item.value || '-' }}</p>
          </div>
        </div>
      </section>

      <section class="space-y-3 border-t border-gray-200 pt-5">
        <div>
          <h2 class="text-sm font-semibold text-gray-900">发布验证摘要</h2>
          <p class="mt-1 text-sm text-gray-500">仅展示当前有效记录的存在状态与时间，不返回资源 ID 或凭证。</p>
        </div>
        <div class="grid border-y border-gray-200 md:grid-cols-2">
          <div v-for="item in verificationRows" :key="item.key" class="min-w-0 border-b border-gray-100 px-3 py-3 md:odd:border-r">
            <div class="flex items-center justify-between gap-3">
              <p class="text-sm font-medium text-gray-900">{{ item.label }}</p>
              <span :class="item.present ? 'text-emerald-700' : 'text-red-700'" class="text-xs font-medium">{{ item.present ? '已确认' : '未确认' }}</span>
            </div>
            <p class="mt-2 text-xs text-gray-500">验证时间：{{ formatAnalyticsDateTime(item.verifiedAt) }}</p>
            <p class="mt-1 text-xs text-gray-500">有效期至：{{ formatAnalyticsDateTime(item.expiresAt) }}</p>
          </div>
        </div>
      </section>
    </template>
  </AttributionPageShell>
</template>
