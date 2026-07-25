<script setup lang="ts">
import type { AttributionProvider } from '@meigallery/shared'
import type { AttributionConnectionView } from '~/types/attribution-admin'
import {
  ATTRIBUTION_PLATFORMS,
} from '~/utils/attributionPlatforms'

const props = withDefaults(defineProps<{
  connections: AttributionConnectionView[]
  provider: AttributionProvider | ''
  connectionId?: string
  search?: string
  showConnection?: boolean
  showSearch?: boolean
}>(), {
  connectionId: '',
  search: '',
  showConnection: true,
  showSearch: false,
})

const emit = defineEmits<{
  'update:provider': [value: AttributionProvider | '']
  'update:connectionId': [value: string]
  'update:search': [value: string]
}>()

const connectionOptions = computed(() => props.connections.filter(
  connection => !props.provider || connection.provider === props.provider,
))

function updateProvider(event: Event) {
  const value = (
    event.target as HTMLSelectElement
  ).value as AttributionProvider | ''
  emit('update:provider', value)
  if (
    props.connectionId
    && !props.connections.some(connection => (
      connection.id === props.connectionId
      && (!value || connection.provider === value)
    ))
  ) {
    emit('update:connectionId', '')
  }
}
</script>

<template>
  <div class="grid min-w-0 gap-3 border-y border-gray-200 bg-white px-3 py-3 sm:grid-cols-2 sm:px-5 lg:flex lg:items-end">
    <label class="min-w-0 lg:w-52">
      <span class="mb-1 block text-xs font-medium text-gray-600">平台</span>
      <select
        :value="provider"
        class="h-10 w-full min-w-0 border border-gray-300 bg-white px-3 text-sm"
        @change="updateProvider"
      >
        <option value="">全部平台</option>
        <option
          v-for="platform in ATTRIBUTION_PLATFORMS"
          :key="platform.provider"
          :value="platform.provider"
        >
          {{ platform.label }}
        </option>
      </select>
    </label>

    <label v-if="showConnection" class="min-w-0 lg:w-72">
      <span class="mb-1 block text-xs font-medium text-gray-600">连接</span>
      <select
        :value="connectionId"
        class="h-10 w-full min-w-0 border border-gray-300 bg-white px-3 text-sm"
        @change="emit(
          'update:connectionId',
          ($event.target as HTMLSelectElement).value,
        )"
      >
        <option value="">全部连接</option>
        <option
          v-for="connection in connectionOptions"
          :key="connection.id"
          :value="connection.id"
        >
          {{ connection.name }}
        </option>
      </select>
    </label>

    <label v-if="showSearch" class="min-w-0 sm:col-span-2 lg:w-80">
      <span class="mb-1 block text-xs font-medium text-gray-600">搜索</span>
      <input
        :value="search"
        type="search"
        placeholder="连接名称或目标标识"
        class="h-10 w-full min-w-0 border border-gray-300 px-3 text-sm"
        @input="emit(
          'update:search',
          ($event.target as HTMLInputElement).value,
        )"
      >
    </label>
  </div>
</template>
