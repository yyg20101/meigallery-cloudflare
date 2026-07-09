<script setup lang="ts">
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import { serializeReadinessSettingRows } from '~/utils/attributionReadiness'

definePageMeta({ layout: 'admin' })

interface ReadinessData {
  ready: boolean
  checks: Array<{ key: string; label: string; ok: boolean }>
  settings: Record<string, unknown>
}

const { isOwner } = useAuth()
const attribution = useAdminAttribution<ReadinessData>('/api/admin/attribution/readiness')
const data = computed(() => attribution.data.value)
const settingRows = computed(() => serializeReadinessSettingRows(data.value?.settings ?? {}))

function checkClass(ok: boolean) {
  return ok ? 'border-emerald-100 bg-emerald-50 text-emerald-900' : 'border-amber-100 bg-amber-50 text-amber-900'
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
      <section :class="['rounded-lg border px-4 py-3 text-sm', data.ready ? 'border-emerald-100 bg-emerald-50 text-emerald-900' : 'border-amber-100 bg-amber-50 text-amber-900']">
        {{ data.ready ? '当前归因检查通过' : '归因检查仍有项目需要确认' }}
      </section>

      <div class="grid gap-3 md:grid-cols-2">
        <article v-for="check in data.checks" :key="check.key" :class="['rounded-lg border p-4 shadow-sm', checkClass(check.ok)]">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h2 class="text-sm font-semibold">{{ check.label }}</h2>
              <p class="mt-1 font-mono text-xs opacity-70">{{ check.key }}</p>
            </div>
            <span class="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-xs font-medium">{{ check.ok ? '通过' : '待处理' }}</span>
          </div>
        </article>
      </div>

      <section class="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 class="text-sm font-semibold text-gray-900">相关配置</h2>
            <p class="mt-1 text-sm text-gray-500">这里只展示状态，配置修改请进入站点设置。</p>
          </div>
          <NuxtLink v-if="isOwner" to="/admin/settings" class="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
            前往站点设置
          </NuxtLink>
        </div>
        <div class="mt-4 grid gap-2 md:grid-cols-2">
          <div v-for="item in settingRows" :key="item.key" class="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
            <p class="text-xs font-medium text-gray-500">{{ item.label }}</p>
            <p class="mt-1 font-mono text-xs text-gray-400">{{ item.key }}</p>
            <p class="mt-1 break-all text-sm font-medium text-gray-900">{{ item.value || '-' }}</p>
          </div>
        </div>
      </section>
    </template>
  </AttributionPageShell>
</template>
