import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MetaRolloutSnapshot } from '~/composables/useAdminAttribution'
import MetaRolloutControl from './MetaRolloutControl.vue'

function rollout(overrides: Partial<MetaRolloutSnapshot> = {}): MetaRolloutSnapshot {
  return {
    environment: 'dev',
    targetPercentage: 10,
    effectivePercentage: 10,
    connectionVerified: true,
    liveEvidencePresent: true,
    openIncident: null,
    metrics: { sent: 9, failed: 1, permissionErrors: 0, retryExhausted: 0, stalePending: 0, criticalQualityDiagnostics: 0 },
    metricsStatus: { available: true, errorCode: null },
    promotion: {
      from: 10,
      to: 50,
      allowed: false,
      requiresOverrideReason: true,
      blockers: ['insufficient_attempts'],
      hardBlockers: [],
    },
    ...overrides,
  }
}

function mountControl(value: MetaRolloutSnapshot) {
  const api = vi.fn().mockResolvedValue({})
  vi.stubGlobal('useApi', () => ({ api }))
  vi.stubGlobal('resolveApiErrorMessage', (_error: unknown, fallback: string) => fallback)
  return { api, wrapper: mount(MetaRolloutControl, { props: { rollout: value, isOwner: true }, attachTo: document.body }) }
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('MetaRolloutControl', () => {
  it('hard blocker 禁用全部升级和 force，显示原因但允许合法降级', async () => {
    const { api, wrapper } = mountControl(rollout({
      effectivePercentage: 0,
      promotion: {
        from: 10,
        to: 50,
        allowed: false,
        requiresOverrideReason: true,
        blockers: ['insufficient_attempts'],
        hardBlockers: ['circuit_open'],
      },
    }))

    expect(wrapper.get('[data-rollout-percentage="50"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-rollout-percentage="100"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-rollout-percentage="0"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-rollout-hard-blockers]').text()).toContain('critical incident 尚未关闭')

    await wrapper.get('[data-rollout-percentage="0"]').trigger('click')
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).not.toContain('强制升级')
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('确认调整'))!
    confirm.click()
    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/admin/attribution/meta/rollout', expect.objectContaining({
      body: { percentage: 0, force: false, reason: '' },
    })))
  })

  it('只有 metric blocker 可填写合格理由后 force 成功', async () => {
    const { api, wrapper } = mountControl(rollout())
    await wrapper.get('[data-rollout-percentage="50"]').trigger('click')
    let dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const force = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('强制升级'))!
    force.click()
    await wrapper.vm.$nextTick()

    dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    const reason = '当前已核对投递指标与回退方案确认由站长承担本次灰度升级风险并持续观察'
    const textarea = dialog.querySelector<HTMLTextAreaElement>('[data-force-reason]')!
    textarea.value = reason
    textarea.dispatchEvent(new Event('input'))
    await wrapper.vm.$nextTick()
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent?.includes('确认强制升级'))!
    expect(confirm.disabled).toBe(false)
    confirm.click()

    await vi.waitFor(() => expect(api).toHaveBeenCalledWith('/api/admin/attribution/meta/rollout', expect.objectContaining({
      body: { percentage: 50, force: true, reason },
    })))
  })
})
