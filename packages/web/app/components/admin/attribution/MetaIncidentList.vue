<script setup lang="ts">
import type { MetaIncident } from '~/composables/useAdminAttribution'

withDefaults(defineProps<{
  incidents: MetaIncident[]
  isOwner?: boolean
}>(), {
  isOwner: false,
})
const emit = defineEmits<{ refreshed: [] }>()
const { api } = useApi()
const selected = ref<MetaIncident | null>(null)
const resolution = ref('')
const submitting = ref(false)
const message = ref('')
const messageTone = ref<'success' | 'error'>('success')

function openCloseModal(incident: MetaIncident) {
  selected.value = incident
  resolution.value = ''
  message.value = ''
}

function closeModal() {
  if (!submitting.value) selected.value = null
}

async function closeIncident() {
  if (!selected.value) return
  submitting.value = true
  message.value = ''
  try {
    await api(`/api/admin/attribution/meta/incidents/${selected.value.id}/close`, {
      method: 'POST',
      body: { resolution: resolution.value },
    })
    messageTone.value = 'success'
    message.value = 'incident 已关闭'
    selected.value = null
    emit('refreshed')
  }
  catch (error) {
    messageTone.value = 'error'
    message.value = incidentErrorMessage(error)
  }
  finally {
    submitting.value = false
  }
}

function incidentErrorMessage(error: unknown) {
  const status = Number((error as { statusCode?: number; status?: number })?.statusCode ?? (error as { status?: number })?.status)
  if (status === 409) return 'incident 关闭门禁未通过，请核对证据后重试'
  if (status === 403) return '需要站长权限才能关闭 incident'
  return resolveApiErrorMessage(error, 'incident 关闭失败，请检查网络后重试')
}
</script>

<template>
  <div data-meta-incident-list class="min-w-0">
    <div class="overflow-x-auto">
      <table class="w-full min-w-[46rem] border-collapse text-left text-sm">
        <thead class="border-y border-gray-200 bg-gray-50 text-xs text-gray-500">
          <tr>
            <th class="px-3 py-2 font-medium">状态</th>
            <th class="px-3 py-2 font-medium">触发原因</th>
            <th class="px-3 py-2 font-medium">target / effective</th>
            <th class="px-3 py-2 font-medium">最近观察</th>
            <th class="px-3 py-2 font-medium">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          <tr v-for="incident in incidents" :key="incident.id">
            <td class="px-3 py-3"><span :class="incident.severity === 'critical' ? 'text-red-700' : 'text-gray-700'" class="font-medium">{{ incident.status }} · {{ incident.severity }}</span></td>
            <td class="max-w-md px-3 py-3 text-gray-700">{{ incident.triggerSummary || incident.triggerCode }}</td>
            <td class="px-3 py-3 tabular-nums text-gray-700">{{ incident.targetPercentage }}% / {{ incident.effectivePercentage }}%</td>
            <td class="px-3 py-3 text-gray-500">{{ formatAnalyticsDateTime(incident.lastObservedAt) }}</td>
            <td class="px-3 py-3">
              <button v-if="incident.status === 'open' && isOwner" data-close-incident class="min-w-24 whitespace-nowrap rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50" type="button" @click="openCloseModal(incident)">关闭 incident</button>
              <span v-else class="text-xs text-gray-400">{{ incident.resolution || '-' }}</span>
            </td>
          </tr>
          <tr v-if="incidents.length === 0"><td colspan="5" class="px-3 py-8 text-center text-gray-500">当前范围没有 incident</td></tr>
        </tbody>
      </table>
    </div>
    <p v-if="message" role="status" :class="messageTone === 'error' ? 'text-red-700' : 'text-emerald-700'" class="mt-3 text-sm">{{ message }}</p>

    <Teleport to="body">
      <div v-if="selected" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="closeModal">
        <div role="dialog" aria-modal="true" aria-label="关闭 Meta incident" class="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-5 shadow-xl">
          <h3 class="text-base font-semibold text-gray-900">关闭 Meta incident</h3>
          <p class="mt-2 text-sm leading-6 text-gray-600">关闭前需要记录复核结论。API 会再次检查 incident 状态和关闭门禁。</p>
          <label class="mt-4 block">
            <span class="text-sm font-medium text-gray-700">处理结论</span>
            <textarea v-model="resolution" data-incident-resolution rows="4" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="说明证据、修复结果与后续观察安排" />
          </label>
          <p v-if="messageTone === 'error' && message" class="mt-3 text-sm text-red-700">{{ message }}</p>
          <div class="mt-5 flex justify-end gap-2">
            <button class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700" type="button" :disabled="submitting" @click="closeModal">取消</button>
            <button class="rounded-md bg-gray-950 px-3 py-2 text-sm font-medium text-white disabled:opacity-60" type="button" :disabled="submitting || !resolution.trim()" @click="closeIncident">{{ submitting ? '提交中...' : '确认关闭' }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
