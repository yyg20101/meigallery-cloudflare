<script setup lang="ts">
import type {
  AttributionIncidentView,
} from '~/types/attribution-admin'
import {
  attributionPlatformDefinition,
} from '~/utils/attributionPlatforms'

withDefaults(defineProps<{
  incidents?: AttributionIncidentView[]
}>(), {
  incidents: () => [],
})

function providerLabel(incident: AttributionIncidentView): string {
  if (
    incident.provider === 'meta'
    || incident.provider === 'tiktok'
    || incident.provider === 'google'
  ) {
    return attributionPlatformDefinition(incident.provider).label
  }
  return incident.provider === 'cloudflare' ? 'Cloudflare' : '系统'
}

function channelLabel(value: string): string {
  if (value === 'server') return 'Server'
  if (value === 'browser') return 'Browser'
  if (value === 'routing') return '路由'
  return value || '全链路'
}
</script>

<template>
  <section data-attribution-incident-list class="min-w-0 border-y border-gray-200 bg-white">
    <div class="border-b border-gray-200 px-3 py-4 sm:px-5">
      <h2 class="text-base font-semibold text-gray-900">异常记录</h2>
    </div>
    <div v-if="incidents.length" class="divide-y divide-gray-200">
      <article
        v-for="incident in incidents"
        :key="incident.id"
        class="grid min-w-0 gap-3 px-3 py-4 text-sm sm:grid-cols-[minmax(12rem,1.2fr)_7rem_minmax(13rem,1fr)_10rem] sm:px-5"
      >
        <div class="min-w-0">
          <p class="font-semibold text-gray-900">
            {{ providerLabel(incident) }} / {{ incident.connectionName || '未绑定连接' }}
          </p>
          <p class="mt-1 min-w-0 [overflow-wrap:anywhere] text-xs text-gray-500">
            {{ incident.code }}
          </p>
        </div>
        <div>
          <p class="font-medium text-gray-800">
            {{ channelLabel(incident.affectedChannel) }}
          </p>
          <p v-if="incident.affectedEvent" class="mt-1 text-xs text-gray-500">
            {{ incident.affectedEvent }}
          </p>
        </div>
        <div class="text-gray-600">
          <p>
            影响事实 {{ formatAnalyticsNumber(incident.affectedFactCount) }}
            · 投递 {{ formatAnalyticsNumber(incident.affectedDeliveryCount) }}
          </p>
          <p v-if="incident.automaticAction" class="mt-1 text-xs text-gray-500">
            自动处置：{{ incident.automaticAction }}
          </p>
        </div>
        <div class="sm:text-right">
          <p
            class="font-medium"
            :class="incident.recoveryStatus === 'recovered'
              ? 'text-emerald-700'
              : incident.severity === 'critical'
                ? 'text-red-700'
                : 'text-amber-700'"
          >
            {{ incident.recoveryStatus === 'recovered' ? '已恢复' : '处理中' }}
          </p>
          <time class="mt-1 block text-xs text-gray-500">
            {{ formatAnalyticsDateTime(
              incident.recoveredAt || incident.detectedAt,
            ) }}
          </time>
        </div>
      </article>
    </div>
    <p v-else class="px-3 py-8 text-center text-sm text-gray-500 sm:px-5">当前没有未处理异常</p>
  </section>
</template>
