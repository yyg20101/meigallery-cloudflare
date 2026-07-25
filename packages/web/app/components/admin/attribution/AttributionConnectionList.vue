<script setup lang="ts">
import type {
  AttributionConnectionView,
} from '~/types/attribution-admin'
import {
  ATTRIBUTION_PLATFORMS,
  attributionPlatformDefinition,
} from '~/utils/attributionPlatforms'

const props = defineProps<{
  connections: AttributionConnectionView[]
}>()

const groups = computed(() => ATTRIBUTION_PLATFORMS.map(platform => ({
  platform,
  connections: props.connections.filter(
    connection => connection.provider === platform.provider,
  ),
})).filter(group => group.connections.length > 0))

function stateLabel(connection: AttributionConnectionView) {
  if (connection.state === 'active') return '生产运行'
  if (connection.state === 'disabled') return '已停用'
  return '待配置'
}

function healthLabel(connection: AttributionConnectionView) {
  if (connection.health.level === 'healthy') return '正常'
  if (connection.health.level === 'warning') return '需关注'
  return '异常'
}

function healthClass(connection: AttributionConnectionView) {
  if (connection.health.level === 'healthy') {
    return 'bg-emerald-50 text-emerald-700'
  }
  if (connection.health.level === 'warning') {
    return 'bg-amber-50 text-amber-700'
  }
  return 'bg-red-50 text-red-700'
}
</script>

<template>
  <div v-if="groups.length" class="min-w-0 space-y-4">
    <section
      v-for="group in groups"
      :key="group.platform.provider"
      class="min-w-0 border-y border-gray-200 bg-white"
    >
      <div class="flex min-w-0 items-center gap-3 border-b border-gray-200 px-3 py-3 sm:px-5">
        <span :class="['h-2.5 w-2.5 shrink-0', group.platform.accentClass]" />
        <h2 class="text-sm font-semibold text-gray-900">
          {{ group.platform.label }}
        </h2>
        <span class="text-xs text-gray-500">
          {{ group.connections.length }} 个连接
        </span>
      </div>

      <div class="divide-y divide-gray-200">
        <article
          v-for="connection in group.connections"
          :key="connection.id"
          class="grid min-w-0 gap-3 px-3 py-4 sm:px-5 lg:grid-cols-[minmax(13rem,1.2fr)_minmax(10rem,1fr)_9rem_8rem_auto] lg:items-center"
        >
          <div class="min-w-0">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <h3 class="min-w-0 truncate text-sm font-semibold text-gray-900">
                {{ connection.name }}
              </h3>
              <span
                v-if="connection.isDefault"
                class="bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
              >
                默认
              </span>
            </div>
            <p class="mt-1 min-w-0 truncate text-xs text-gray-500">
              {{ attributionPlatformDefinition(connection.provider).browserLabel }}
            </p>
          </div>

          <div class="min-w-0">
            <p class="text-xs text-gray-500">当前目标</p>
            <p class="mt-1 min-w-0 truncate font-mono text-xs text-gray-800">
              {{ connection.activeTarget || '尚未配置' }}
            </p>
          </div>

          <div>
            <p class="text-xs text-gray-500">运行状态</p>
            <p class="mt-1 text-sm font-medium text-gray-800">
              {{ stateLabel(connection) }}
            </p>
          </div>

          <div>
            <p class="text-xs text-gray-500">健康度</p>
            <span
              :class="[
                'mt-1 inline-flex px-2 py-0.5 text-xs font-medium',
                healthClass(connection),
              ]"
            >
              {{ healthLabel(connection) }}
            </span>
          </div>

          <NuxtLink
            :to="`/admin/attribution/connections/${encodeURIComponent(connection.id)}`"
            class="inline-flex min-h-9 items-center justify-center border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            管理
          </NuxtLink>
        </article>
      </div>
    </section>
  </div>

  <section v-else class="border-y border-gray-200 bg-white px-4 py-14 text-center">
    <h2 class="text-sm font-semibold text-gray-900">没有符合条件的连接</h2>
    <p class="mt-2 text-sm text-gray-500">
      调整筛选条件，或新建一个广告平台连接。
    </p>
  </section>
</template>
