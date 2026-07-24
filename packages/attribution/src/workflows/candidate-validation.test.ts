import { describe, expect, it, vi } from 'vitest'
import type { WorkflowStep } from 'cloudflare:workers'
import {
  runCandidateValidationWorkflow,
  type CandidateValidationOperations,
} from './candidate-validation'

describe('候选验证 Workflow', () => {
  it('按固定顺序验证、等待 Queue、激活、smoke 并清理秘密', async () => {
    const calls: string[] = []
    const operations = fakeOperations(calls)
    operations.readDeliveryState = vi.fn()
      .mockImplementationOnce(async () => {
        calls.push('delivery')
        return { status: 'pending', accepted: 1, total: 2 }
      })
      .mockImplementationOnce(async () => {
        calls.push('delivery')
        return { status: 'accepted', accepted: 2, total: 2 }
      })

    await expect(runCandidateValidationWorkflow(
      operations,
      'validation_1',
      workflowStep(calls),
    )).resolves.toEqual({ status: 'verified' })

    expect(calls).toEqual([
      'prepare',
      'facts',
      'browser',
      'delivery',
      'sleep',
      'delivery',
      'activate',
      'smoke',
      'complete',
      'destroy',
    ])
  })

  it('确定性失败只终结候选，不修改或回滚旧 Active', async () => {
    const calls: string[] = []
    const operations = fakeOperations(calls)
    operations.prepare = vi.fn(async () => {
      calls.push('prepare')
      throw new Error('candidate invalid')
    })

    await expect(runCandidateValidationWorkflow(
      operations,
      'validation_2',
      workflowStep(calls),
    )).resolves.toEqual({
      status: 'failed',
      code: 'candidate_validation_failed',
    })

    expect(calls).toEqual(['prepare', 'fail', 'destroy'])
    expect(operations.activate).not.toHaveBeenCalled()
    expect(operations.rollbackActivation).not.toHaveBeenCalled()
  })

  it('超过 30 分钟进入 timed_out 并销毁秘密', async () => {
    const calls: string[] = []
    const operations = fakeOperations(calls)
    operations.deadlineExceeded = vi.fn().mockResolvedValue(true)
    operations.readDeliveryState = vi.fn(async () => {
      calls.push('delivery')
      return { status: 'pending', accepted: 0, total: 2 }
    })

    await expect(runCandidateValidationWorkflow(
      operations,
      'validation_3',
      workflowStep(calls),
    )).resolves.toEqual({ status: 'timed_out' })

    expect(calls).toEqual([
      'prepare',
      'facts',
      'browser',
      'delivery',
      'timeout',
      'destroy',
    ])
    expect(operations.activate).not.toHaveBeenCalled()
  })

  it('激活后 smoke 失败先回滚再终结候选', async () => {
    const calls: string[] = []
    const operations = fakeOperations(calls)
    operations.smoke = vi.fn(async () => {
      calls.push('smoke')
      throw new Error('smoke failed')
    })

    await expect(runCandidateValidationWorkflow(
      operations,
      'validation_4',
      workflowStep(calls),
    )).resolves.toEqual({
      status: 'failed',
      code: 'candidate_validation_failed',
    })

    expect(calls).toEqual([
      'prepare',
      'facts',
      'browser',
      'delivery',
      'activate',
      'smoke',
      'rollback',
      'fail',
      'destroy',
    ])
    expect(operations.complete).not.toHaveBeenCalled()
  })

  it('终态秘密清理暂时失败不会回滚已验证候选', async () => {
    const calls: string[] = []
    const operations = fakeOperations(calls)
    operations.destroySecret = vi.fn(async () => {
      calls.push('destroy')
      throw new Error('D1 unavailable')
    })

    await expect(runCandidateValidationWorkflow(
      operations,
      'validation_5',
      workflowStep(calls),
    )).rejects.toThrow('D1 unavailable')

    expect(calls).toEqual([
      'prepare',
      'facts',
      'browser',
      'delivery',
      'activate',
      'smoke',
      'complete',
      'destroy',
    ])
    expect(operations.rollbackActivation).not.toHaveBeenCalled()
    expect(operations.fail).not.toHaveBeenCalled()
  })
})

function fakeOperations(
  calls: string[],
): CandidateValidationOperations {
  return {
    prepare: vi.fn(async () => {
      calls.push('prepare')
    }),
    createSyntheticFacts: vi.fn(async () => {
      calls.push('facts')
    }),
    verifyBrowserPairing: vi.fn(async () => {
      calls.push('browser')
    }),
    readDeliveryState: vi.fn(async () => {
      calls.push('delivery')
      return { status: 'accepted', accepted: 2, total: 2 }
    }),
    deadlineExceeded: vi.fn().mockResolvedValue(false),
    activate: vi.fn(async () => {
      calls.push('activate')
    }),
    smoke: vi.fn(async () => {
      calls.push('smoke')
    }),
    complete: vi.fn(async () => {
      calls.push('complete')
    }),
    fail: vi.fn(async () => {
      calls.push('fail')
    }),
    timeout: vi.fn(async () => {
      calls.push('timeout')
    }),
    rollbackActivation: vi.fn(async () => {
      calls.push('rollback')
    }),
    destroySecret: vi.fn(async () => {
      calls.push('destroy')
    }),
  }
}

function workflowStep(calls: string[]): WorkflowStep {
  return {
    async do(
      _name: string,
      configOrCallback: unknown,
      maybeCallback?: () => Promise<unknown>,
    ) {
      const callback = typeof configOrCallback === 'function'
        ? configOrCallback as () => Promise<unknown>
        : maybeCallback!
      return callback()
    },
    async sleep() {
      calls.push('sleep')
    },
  } as unknown as WorkflowStep
}
