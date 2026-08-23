export class WorkflowEntrypoint<Env, _Params> {
  protected readonly ctx: ExecutionContext
  protected readonly env: Env

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}

export class DurableObject<Env> {
  protected readonly ctx: DurableObjectState
  protected readonly env: Env

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}

export type WorkflowEvent<Params> = {
  payload: Params
  timestamp: Date
  instanceId: string
  workflowName: string
}

export type WorkflowStep = {
  do(name: string, callback: () => Promise<unknown>): Promise<unknown>
  do(name: string, config: unknown, callback: () => Promise<unknown>): Promise<unknown>
  waitForEvent(name: string, options: unknown): Promise<{ payload: unknown }>
}
