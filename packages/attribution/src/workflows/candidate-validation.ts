import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'
import {
  parseAttributionEnvironment,
  type AttributionBindings,
  type CandidateValidationWorkflowPayload,
} from '../env'
import {
  activateValidatedCandidate,
  candidateValidationDeadlineExceeded,
  completeCandidateValidation,
  createCandidateSyntheticFacts,
  destroyValidationSecret,
  failCandidateValidation,
  prepareCandidateValidation,
  readCandidateDeliveryState,
  rollbackCandidateActivation,
  smokeValidatedCandidate,
  timeoutCandidateValidation,
  verifyCandidateBrowserPairing,
  type CandidateDeliveryState,
  type CandidateValidationEnvironment,
} from '../services/validation-service'

export interface CandidateValidationOperations {
  prepare(validationId: string): Promise<void>
  createSyntheticFacts(validationId: string): Promise<void>
  verifyBrowserPairing(validationId: string): Promise<void>
  readDeliveryState(
    validationId: string,
  ): Promise<CandidateDeliveryState>
  deadlineExceeded(validationId: string): Promise<boolean>
  activate(validationId: string): Promise<void>
  smoke(validationId: string): Promise<void>
  complete(validationId: string): Promise<void>
  fail(validationId: string, code: string): Promise<void>
  timeout(validationId: string): Promise<void>
  rollbackActivation(validationId: string): Promise<void>
  destroySecret(validationId: string): Promise<void>
}

export type CandidateValidationWorkflowResult =
  | { status: 'verified' }
  | { status: 'failed'; code: string }
  | { status: 'timed_out' }

const POLL_INTERVAL = '15 seconds'
const MAX_POLLS = 120

export async function runCandidateValidationWorkflow(
  operations: CandidateValidationOperations,
  validationId: string,
  step: WorkflowStep,
): Promise<CandidateValidationWorkflowResult> {
  let activated = false
  let result: CandidateValidationWorkflowResult
  try {
    await step.do('校验候选配置', () =>
      operations.prepare(validationId))
    await step.do('创建候选合成事实', () =>
      operations.createSyntheticFacts(validationId))
    await step.do('核对浏览器与服务端事件配对', () =>
      operations.verifyBrowserPairing(validationId))

    let accepted = false
    for (let index = 0; index < MAX_POLLS; index += 1) {
      const state = await step.do(
        '读取候选投递状态',
        () => operations.readDeliveryState(validationId),
      )
      if (state.status === 'accepted') {
        accepted = true
        break
      }
      if (state.status === 'failed') {
        throw new Error('candidate delivery rejected')
      }
      if (await operations.deadlineExceeded(validationId)) {
        await step.do('候选验证超时', () =>
          operations.timeout(validationId))
        result = { status: 'timed_out' }
        return result
      }
      await step.sleep(
        `等待候选投递-${index + 1}`,
        POLL_INTERVAL,
      )
    }
    if (!accepted) {
      await step.do('候选验证超时', () =>
        operations.timeout(validationId))
      result = { status: 'timed_out' }
      return result
    }

    await step.do('激活已验证候选', () =>
      operations.activate(validationId))
    activated = true
    await step.do('执行激活后冒烟检查', () =>
      operations.smoke(validationId))
    await step.do('完成候选验证', () =>
      operations.complete(validationId))
    result = { status: 'verified' }
    return result
  } catch {
    if (activated) {
      await step.do('回滚候选激活', () =>
        operations.rollbackActivation(validationId))
    }
    const code = 'candidate_validation_failed'
    await step.do('终结失败候选', () =>
      operations.fail(validationId, code))
    result = { status: 'failed', code }
    return result
  } finally {
    await step.do('销毁候选测试秘密', () =>
      operations.destroySecret(validationId))
  }
}

export class CandidateValidationWorkflow extends WorkflowEntrypoint<
  AttributionBindings,
  CandidateValidationWorkflowPayload
> {
  async run(
    event: Readonly<WorkflowEvent<CandidateValidationWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<CandidateValidationWorkflowResult> {
    const parsed = parseAttributionEnvironment(this.env)
    const environment: CandidateValidationEnvironment = {
      db: this.env.DB,
      appEnvironment: parsed.appEnvironment,
      credentialMasterKeys: parsed.credentialMasterKeys,
      dataEncryptionKeys: parsed.dataEncryptionKeys,
      signingKeys: parsed.signingKeys,
      queues: parsed.queues,
      workflow: parsed.validationWorkflow,
    }
    const operations = candidateValidationOperations(environment)
    return runCandidateValidationWorkflow(
      operations,
      event.payload.validationId,
      step,
    )
  }
}

function candidateValidationOperations(
  environment: CandidateValidationEnvironment,
): CandidateValidationOperations {
  return {
    prepare: async validationId => {
      await prepareCandidateValidation(environment, validationId)
    },
    createSyntheticFacts: async validationId => {
      await createCandidateSyntheticFacts(environment, validationId)
    },
    verifyBrowserPairing: async validationId => {
      await verifyCandidateBrowserPairing(environment, validationId)
    },
    readDeliveryState: validationId =>
      readCandidateDeliveryState(environment, validationId),
    deadlineExceeded: validationId =>
      candidateValidationDeadlineExceeded(environment, validationId),
    activate: validationId =>
      activateValidatedCandidate(environment, validationId),
    smoke: validationId =>
      smokeValidatedCandidate(environment, validationId),
    complete: validationId =>
      completeCandidateValidation(environment, validationId),
    fail: (validationId, code) =>
      failCandidateValidation(environment, validationId, code),
    timeout: validationId =>
      timeoutCandidateValidation(environment, validationId),
    rollbackActivation: validationId =>
      rollbackCandidateActivation(environment, validationId),
    destroySecret: validationId =>
      destroyValidationSecret(environment, validationId),
  }
}
