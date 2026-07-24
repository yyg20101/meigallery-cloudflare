<script setup lang="ts">
import AttributionIdentityCandidateForm from '~/components/admin/attribution/AttributionIdentityCandidateForm.vue'
import AttributionManagedSourceList from '~/components/admin/attribution/AttributionManagedSourceList.vue'
import AttributionPageShell from '~/components/admin/attribution/AttributionPageShell.vue'
import AttributionRuntimePolicyPanel from '~/components/admin/attribution/AttributionRuntimePolicyPanel.vue'
import {
  useAttributionManagedSources,
} from '~/composables/useAdminAttribution'
import type {
  AttributionConnectionView,
  CreateAttributionManagedSourceRequest,
  CreateCandidateRequest,
  SetRuntimePolicyRequest,
} from '~/types/attribution-admin'
import { resolveApiErrorMessage } from '~/utils/apiErrorMessage'
import {
  buildAttributionManagedSourceUrl,
} from '~/utils/attributionManagedSourceUrl'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const { isOwner } = useAuth()
const toast = useToast()
const rangeState = useAdminAttributionRange('7d')
const candidateManager = useAttributionCandidate()
const runtimeManager = useAttributionRuntimePolicy()
const sourceManager = useAttributionManagedSources()
const generatedUrl = ref('')
const actionError = ref('')
const confirmationOpen = ref(false)
const confirmationAction = ref<
  'rollback' | 'disable-connection' | 'disable-source' | null
>(null)
const confirmationSourceId = ref('')

const connectionId = computed(() => {
  const value = route.params.id
  return String(Array.isArray(value) ? value[0] : value ?? '').trim()
})
const connection = computed(() => candidateManager.connection.value)
const pageError = computed(() => (
  actionError.value
  || candidateManager.error.value
  || runtimeManager.error.value
  || sourceManager.error.value
))
const pageLoading = computed(() => (
  candidateManager.loading.value
  || sourceManager.loading.value
))
const commandSaving = computed(() => (
  candidateManager.saving.value
  || runtimeManager.saving.value
  || sourceManager.saving.value
))
const confirmation = computed(() => {
  if (confirmationAction.value === 'rollback') {
    return {
      title: '确认回滚',
      message: '确认回滚到上一生产版本？当前运行策略保持不变。',
      confirmLabel: '确认回滚',
      destructive: false,
    }
  }
  if (confirmationAction.value === 'disable-connection') {
    return {
      title: '确认停用连接',
      message: '确认停用此连接？该连接将不再接收新的归因流量。',
      confirmLabel: '确认停用',
      destructive: true,
    }
  }
  return {
    title: '确认停用投放来源',
    message: '确认停用此投放来源？已发出的链接将不再建立新归因。',
    confirmLabel: '确认停用',
    destructive: true,
  }
})

onMounted(() => void refresh())

async function refresh() {
  actionError.value = ''
  generatedUrl.value = ''
  try {
    const loaded = await candidateManager.load(connectionId.value)
    runtimeManager.initialize(loaded)
    await sourceManager.load(connectionId.value)
  } catch {
    // 各 composable 已提供可读错误。
  }
}

function synchronize(next: AttributionConnectionView) {
  candidateManager.initialize(next)
  runtimeManager.initialize(next)
}

async function saveCandidate(payload: CreateCandidateRequest) {
  if (candidateManager.saving.value) return
  actionError.value = ''
  try {
    const next = await candidateManager.saveCandidate(
      connectionId.value,
      payload,
    )
    synchronize(next)
    toast.add({ title: '候选配置已进入独立验证', color: 'success' })
  } catch (cause) {
    actionError.value = resolveApiErrorMessage(
      cause,
      '身份候选保存失败',
    )
  }
}

async function saveRuntimePolicy(payload: SetRuntimePolicyRequest) {
  if (
    runtimeManager.saving.value
    || runtimePolicyMatchesCurrent(payload)
  ) return
  actionError.value = ''
  try {
    const next = await runtimeManager.saveRuntimePolicy(
      connectionId.value,
      payload,
    )
    synchronize(next)
    toast.add({ title: '运行策略已更新', color: 'success' })
  } catch (cause) {
    actionError.value = resolveApiErrorMessage(
      cause,
      '运行策略保存失败',
    )
  }
}

function runtimePolicyMatchesCurrent(
  payload: SetRuntimePolicyRequest,
): boolean {
  const current = runtimeManager.connection.value?.runtime
  return Boolean(
    current
    && current.enabled === payload.enabled
    && current.browserEnabled === payload.browserEnabled
    && current.serverEnabled === payload.serverEnabled
    && current.serverTargetPercentage === payload.serverTargetPercentage
  )
}

function requestConfirmation(
  action: 'rollback' | 'disable-connection' | 'disable-source',
  sourceId = '',
) {
  confirmationAction.value = action
  confirmationSourceId.value = sourceId
  confirmationOpen.value = true
}

function closeConfirmation() {
  if (commandSaving.value) return
  confirmationOpen.value = false
  confirmationAction.value = null
  confirmationSourceId.value = ''
}

async function confirmAction() {
  const action = confirmationAction.value
  if (!action) return
  if (action === 'rollback') await rollback()
  else if (action === 'disable-connection') await disableConnection()
  else await disableSource(confirmationSourceId.value)
  if (!pageError.value) closeConfirmation()
}

async function rollback() {
  if (runtimeManager.saving.value) return
  actionError.value = ''
  try {
    const next = await runtimeManager.rollback(connectionId.value)
    synchronize(next)
    toast.add({ title: '已回滚上一生产版本', color: 'success' })
  } catch (cause) {
    actionError.value = resolveApiErrorMessage(cause, '连接回滚失败')
  }
}

async function disableConnection() {
  if (runtimeManager.saving.value) return
  actionError.value = ''
  try {
    const next = await runtimeManager.disable(connectionId.value)
    synchronize(next)
    toast.add({ title: '归因连接已停用', color: 'success' })
  } catch (cause) {
    actionError.value = resolveApiErrorMessage(cause, '连接停用失败')
  }
}

async function createSource(input: CreateAttributionManagedSourceRequest) {
  if (sourceManager.saving.value) return
  actionError.value = ''
  generatedUrl.value = ''
  try {
    const result = await sourceManager.create(connectionId.value, input)
    if (!result.proof || result.proofDelivery !== 'issued_once') {
      throw new Error('ATTRIBUTION_MANAGED_SOURCE_PROOF_UNAVAILABLE')
    }
    if (!import.meta.client) {
      throw new Error('ATTRIBUTION_MANAGED_SOURCE_ORIGIN_UNAVAILABLE')
    }
    generatedUrl.value = buildAttributionManagedSourceUrl(
      window.location.origin,
      result.source,
      result.proof,
    )
    toast.add({ title: '投放链接已生成', color: 'success' })
  } catch (cause) {
    actionError.value = resolveApiErrorMessage(
      cause,
      '投放来源创建失败',
    )
  }
}

async function disableSource(sourceId: string) {
  if (sourceManager.saving.value) return
  actionError.value = ''
  try {
    await sourceManager.disableSource(connectionId.value, sourceId)
    toast.add({ title: '投放来源已停用', color: 'success' })
  } catch (cause) {
    actionError.value = resolveApiErrorMessage(
      cause,
      '投放来源停用失败',
    )
  }
}
</script>

<template>
  <AttributionPageShell
    v-model:range="rangeState.range.value"
    v-model:date="rangeState.date.value"
    :title="connection?.name || '归因连接'"
    :description="connection
      ? `${connection.provider.toUpperCase()} · 身份候选、运行策略与投放来源相互独立`
      : '加载归因连接配置'"
    :loading="pageLoading"
    :error="pageError"
    :show-range-controls="false"
    :show-usage="false"
    @refresh="refresh"
  >
    <template v-if="connection">
      <section class="border-y border-gray-200 bg-white">
        <dl class="grid min-w-0 grid-cols-2 md:grid-cols-4">
          <div class="min-w-0 border-b border-gray-200 px-3 py-3 md:border-b-0 md:border-r sm:px-5">
            <dt class="text-xs text-gray-500">平台</dt>
            <dd class="mt-1 text-sm font-semibold text-gray-900">
              {{ connection.provider.toUpperCase() }}
            </dd>
          </div>
          <div class="min-w-0 border-b border-gray-200 px-3 py-3 md:border-b-0 md:border-r sm:px-5">
            <dt class="text-xs text-gray-500">当前目标</dt>
            <dd class="mt-1 truncate font-mono text-xs text-gray-900">
              {{ connection.activeTarget || '尚未配置' }}
            </dd>
          </div>
          <div class="min-w-0 px-3 py-3 md:border-r sm:px-5">
            <dt class="text-xs text-gray-500">连接状态</dt>
            <dd class="mt-1 text-sm font-semibold text-gray-900">
              {{ connection.state === 'active'
                ? '生产运行'
                : connection.state === 'disabled'
                  ? '已停用'
                  : '待配置' }}
            </dd>
          </div>
          <div class="min-w-0 px-3 py-3 sm:px-5">
            <dt class="text-xs text-gray-500">健康度</dt>
            <dd class="mt-1 text-sm font-semibold text-gray-900">
              {{ connection.health.level === 'healthy'
                ? '正常'
                : connection.health.level === 'warning'
                  ? '需关注'
                  : '异常' }}
            </dd>
          </div>
        </dl>
      </section>

      <AttributionIdentityCandidateForm
        :connection="connection"
        :disabled="!isOwner"
        :saving="candidateManager.saving.value"
        @save="saveCandidate"
      />

      <AttributionRuntimePolicyPanel
        :connection="connection"
        :disabled="!isOwner"
        :saving="runtimeManager.saving.value"
        @save="saveRuntimePolicy"
        @rollback="requestConfirmation('rollback')"
        @disable="requestConfirmation('disable-connection')"
      />

      <AttributionManagedSourceList
        :provider="connection.provider"
        :sources="sourceManager.sources.value"
        :generated-url="generatedUrl"
        :disabled="!isOwner"
        :saving="sourceManager.saving.value"
        @create="createSource"
        @disable="sourceId => requestConfirmation('disable-source', sourceId)"
        @clear-generated="generatedUrl = ''"
      />

      <p
        v-if="commandSaving"
        role="status"
        class="border-y border-gray-200 bg-white px-3 py-3 text-sm text-gray-500 sm:px-5"
      >
        正在处理，请勿重复提交。
      </p>
    </template>

    <UModal
      v-model:open="confirmationOpen"
      :dismissible="!commandSaving"
      :title="confirmation.title"
    >
      <template #content>
        <div
          data-attribution-confirm-dialog
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="attribution-confirm-title"
          aria-describedby="attribution-confirm-description"
          class="p-5 sm:p-6"
        >
          <h2
            id="attribution-confirm-title"
            class="text-base font-semibold text-gray-900"
          >
            {{ confirmation.title }}
          </h2>
          <p
            id="attribution-confirm-description"
            class="mt-2 text-sm leading-6 text-gray-600"
          >
            {{ confirmation.message }}
          </p>
          <div class="mt-5 flex flex-wrap justify-end gap-3">
            <button
              type="button"
              :disabled="commandSaving"
              autofocus
              class="min-h-10 border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              @click="closeConfirmation"
            >
              取消
            </button>
            <button
              type="button"
              :disabled="commandSaving"
              :class="[
                'min-h-10 px-4 text-sm font-medium text-white disabled:opacity-50',
                confirmation.destructive
                  ? 'bg-red-700 hover:bg-red-600'
                  : 'bg-gray-950 hover:bg-gray-800',
              ]"
              @click="confirmAction"
            >
              {{ commandSaving ? '处理中...' : confirmation.confirmLabel }}
            </button>
          </div>
        </div>
      </template>
    </UModal>
  </AttributionPageShell>
</template>
