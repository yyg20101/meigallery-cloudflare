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

async function rollback() {
  if (
    import.meta.client
    && !window.confirm('确认回滚到上一生产版本？当前运行策略保持不变。')
  ) return
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
  if (
    import.meta.client
    && !window.confirm('确认停用此连接？该连接将不再接收新的归因流量。')
  ) return
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
  if (
    import.meta.client
    && !window.confirm('确认停用此投放来源？已发出的链接将不再建立新归因。')
  ) return
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
        @rollback="rollback"
        @disable="disableConnection"
      />

      <AttributionManagedSourceList
        :provider="connection.provider"
        :sources="sourceManager.sources.value"
        :generated-url="generatedUrl"
        :disabled="!isOwner"
        :saving="sourceManager.saving.value"
        @create="createSource"
        @disable="disableSource"
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
  </AttributionPageShell>
</template>
