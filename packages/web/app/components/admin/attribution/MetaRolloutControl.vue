<script setup lang="ts">
import type { MetaCapiRolloutPercentage, MetaRolloutSnapshot } from '~/composables/useAdminAttribution'

const props = withDefaults(defineProps<{
  rollout: MetaRolloutSnapshot | null
  isOwner?: boolean
}>(), {
  isOwner: false,
})
const emit = defineEmits<{ refreshed: [] }>()
const { api } = useApi()
const percentages: MetaCapiRolloutPercentage[] = [0, 10, 50, 100]
const requested = ref<MetaCapiRolloutPercentage | null>(null)
const modalMode = ref<'standard' | 'force' | null>(null)
const forceReason = ref('')
const submitting = ref(false)
const message = ref('')
const messageTone = ref<'success' | 'error'>('success')

const target = computed(() => props.rollout?.targetPercentage ?? 0)
const effective = computed(() => props.rollout?.effectivePercentage ?? 0)
const upgrading = computed(() => requested.value !== null && requested.value > target.value)
const hardBlockers = computed(() => props.rollout?.promotion.hardBlockers ?? [])
const hasHardBlockers = computed(() => hardBlockers.value.length > 0)
const canForce = computed(() => upgrading.value && !hasHardBlockers.value && props.rollout?.promotion.requiresOverrideReason === true)
const forceReasonValid = computed(() => (forceReason.value.match(/[\u3400-\u9fff]/g)?.length ?? 0) >= 20)
const modalTitle = computed(() => modalMode.value === 'force' ? '强制升级 CAPI rollout' : '确认调整 CAPI rollout')
const blockerLabels: Record<string, string> = {
  connection_unverified: 'Meta 连接尚未验证',
  release_commit_invalid: '当前 RELEASE_COMMIT 无效',
  meta_live_verification_missing: '当前 commit 缺少 Meta live 验证',
  tracking_mode_not_production: 'production rollout 要求 Meta 运行模式为 production',
  circuit_open: 'critical incident 尚未关闭',
  metrics_unavailable: 'rollout 指标暂不可用',
  non_adjacent_promotion: '只允许升级到相邻档位',
}

function upgradeBlocked(value: MetaCapiRolloutPercentage) {
  return value > target.value && hasHardBlockers.value
}

function choosePercentage(value: MetaCapiRolloutPercentage) {
  if (!props.isOwner || submitting.value || value === target.value || upgradeBlocked(value)) return
  requested.value = value
  forceReason.value = ''
  message.value = ''
  modalMode.value = 'standard'
}

function openForceModal() {
  if (!canForce.value) return
  forceReason.value = ''
  modalMode.value = 'force'
}

function closeModal() {
  if (!submitting.value) modalMode.value = null
}

async function submitRollout(force: boolean) {
  if (requested.value === null) return
  if (requested.value > target.value && hasHardBlockers.value) {
    messageTone.value = 'error'
    message.value = '存在不可强制绕过的升级阻断，只能选择合法降级'
    return
  }
  if (force && (!canForce.value || !forceReasonValid.value)) return
  submitting.value = true
  message.value = ''
  try {
    await api('/api/admin/attribution/meta/rollout', {
      method: 'POST',
      body: { percentage: requested.value, force, reason: force ? forceReason.value : '' },
    })
    messageTone.value = 'success'
    message.value = `rollout target 已调整为 ${requested.value}%`
    modalMode.value = null
    emit('refreshed')
  }
  catch (error) {
    messageTone.value = 'error'
    message.value = rolloutErrorMessage(error)
  }
  finally {
    submitting.value = false
  }
}

function rolloutErrorMessage(error: unknown) {
  const status = Number((error as { statusCode?: number; status?: number })?.statusCode ?? (error as { status?: number })?.status)
  if (status === 409) return 'rollout 状态已变化或升级门禁未通过，请刷新后重试'
  if (status === 403) return '需要站长权限才能调整 rollout'
  return resolveApiErrorMessage(error, 'rollout 调整失败，请检查网络后重试')
}
</script>

<template>
  <div data-meta-rollout-control class="min-w-0">
    <div class="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <dl class="flex min-w-0 gap-6 text-sm">
        <div>
          <dt class="text-xs text-gray-500">target</dt>
          <dd class="mt-1 font-semibold tabular-nums text-gray-900">{{ target }}%</dd>
        </div>
        <div>
          <dt class="text-xs text-gray-500">effective</dt>
          <dd :class="effective === 0 && target > 0 ? 'text-red-700' : 'text-gray-900'" class="mt-1 font-semibold tabular-nums">{{ effective }}%</dd>
        </div>
      </dl>
      <div data-rollout-segmented class="grid min-w-0 grid-cols-4 rounded-md border border-gray-300 bg-white p-1">
        <button
          v-for="percentage in percentages"
          :key="percentage"
          :data-rollout-percentage="percentage"
          :aria-pressed="target === percentage"
          :class="[
            'min-h-9 min-w-12 rounded px-3 text-sm font-medium tabular-nums',
            target === percentage ? 'bg-gray-950 text-white' : 'text-gray-600 hover:bg-gray-100',
          ]"
          type="button"
          :disabled="!isOwner || submitting || upgradeBlocked(percentage)"
          @click="choosePercentage(percentage)"
        >
          {{ percentage }}%
        </button>
      </div>
    </div>

    <div v-if="rollout?.openIncident" data-rollout-incident class="mt-3 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-800">
      critical incident 已打开，effective 强制为 0%；target {{ rollout.openIncident.targetPercentage }}% 保留。
    </div>
    <div v-if="hardBlockers.length" data-rollout-hard-blockers class="mt-3 border-l-2 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-800">
      <p class="font-medium">升级已阻断，只允许保持当前档位或合法降级：</p>
      <ul class="mt-1 list-disc pl-5">
        <li v-for="blocker in hardBlockers" :key="blocker">{{ blockerLabels[blocker] || blocker }}</li>
      </ul>
    </div>
    <p v-if="!isOwner" class="mt-3 text-xs text-gray-500">只有站长可调整 rollout。</p>
    <p v-if="message" role="status" :class="messageTone === 'error' ? 'text-red-700' : 'text-emerald-700'" class="mt-3 text-sm">{{ message }}</p>

    <Teleport to="body">
      <div v-if="modalMode" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" @click.self="closeModal">
        <div role="dialog" aria-modal="true" :aria-label="modalTitle" class="w-full max-w-lg rounded-lg border border-gray-200 bg-white p-5 shadow-xl">
          <h3 class="text-base font-semibold text-gray-900">{{ modalTitle }}</h3>
          <p class="mt-2 text-sm leading-6 text-gray-600">
            target 将从 {{ target }}% 调整为 {{ requested }}%。effective 仍受 critical incident 控制。
          </p>
          <label v-if="modalMode === 'force'" class="mt-4 block">
            <span class="text-sm font-medium text-gray-700">强制升级原因</span>
            <textarea v-model="forceReason" data-force-reason rows="4" class="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="说明指标阻断、风险判断和回退安排" />
            <span class="mt-1 block text-xs text-gray-500">至少 20 个汉字，当前 {{ forceReason.match(/[\u3400-\u9fff]/g)?.length || 0 }} 个。</span>
          </label>
          <p v-if="messageTone === 'error' && message" class="mt-3 text-sm text-red-700">{{ message }}</p>
          <div class="mt-5 flex flex-wrap justify-end gap-2">
            <button class="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700" type="button" :disabled="submitting" @click="closeModal">取消</button>
            <button v-if="modalMode === 'standard' && canForce" class="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800" type="button" :disabled="submitting" @click="openForceModal">强制升级</button>
            <button class="rounded-md bg-gray-950 px-3 py-2 text-sm font-medium text-white disabled:opacity-60" type="button" :disabled="submitting || (modalMode === 'force' && !forceReasonValid)" @click="submitRollout(modalMode === 'force')">
              {{ submitting ? '提交中...' : modalMode === 'force' ? '确认强制升级' : '确认调整' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
