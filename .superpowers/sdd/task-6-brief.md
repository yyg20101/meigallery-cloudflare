### Task 6: 加固 CAPI 超时、状态转换、重试与 DLQ

**Files:**
- Create: `packages/api/src/services/meta-capi-queue.ts`
- Create: `packages/api/src/services/meta-capi-queue.test.ts`
- Modify: `packages/api/src/services/meta-capi.ts`
- Modify: `packages/api/src/services/meta-capi.test.ts`
- Modify: `packages/api/src/services/conversions.ts`
- Modify: `packages/api/src/index.ts:339-359`
- Modify: `packages/api/wrangler.toml:33-40,80-87`
- Modify: `scripts/verify-dev-resources.mjs`
- Modify: `scripts/verify-dev-resources.test.mjs`

**Interfaces:**
- Consumes: Task 5 的 `MetaCapiQueueMessage`。
- Produces: `handleMetaCapiBatch(batch, env)`、`computeMetaRetryDelay(attempts)`、结构化 `MetaCapiSendResult.eventsReceived`。

- [x] **Step 1: 写超时、响应与 DLQ 失败测试**

在 `meta-capi.test.ts` 新增 Graph URL 固定使用 `/v25.0/<pixel-id>/events`、2xx 但 `events_received=0` 为 permanent failure、网络超时为 retryable failure、token 不出现在结果。`meta-capi-queue.test.ts` 新增：

```ts
it('主 Queue 对 retryable 错误退避重试，DLQ 回写 retry_exhausted', async () => {
  expect(computeMetaRetryDelay(1)).toBe(60)
  expect(computeMetaRetryDelay(2)).toBe(300)
  expect(computeMetaRetryDelay(3)).toBe(900)
  await handleMetaCapiBatch(mainBatchWithRetryableMessage(), env)
  expect(mainMessage.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
  await handleMetaCapiBatch(dlqBatch(), env)
  expect(db.delivery.error_code).toBe('retry_exhausted')
  expect(dlqMessage.ack).toHaveBeenCalled()
})
```

同文件再覆盖已 sent delivery：不调用 `fetch`，message ack，返回 `duplicate_suppressed`，D1 delivery 仍为 sent，sent 聚合不减少，duplicate_suppressed 诊断只增加一次。

- [x] **Step 2: 运行 CAPI 测试并确认失败**

Run: `corepack pnpm --filter @meigallery/api test -- src/services/meta-capi.test.ts src/services/meta-capi-queue.test.ts`

Expected: FAIL，queue service 与 `eventsReceived` 尚不存在。

- [x] **Step 3: 实现 8 秒组合超时与 Meta 响应解析**

`sendMetaCapiEvent()` 接受可注入 `fetchFn` 和 `timeoutMs=8000`。使用 `AbortController` 保留调用方 signal；2xx JSON 必须满足 `events_received === 1` 才标记 sent。返回：

```ts
export interface MetaCapiSendResult {
  deliveryId: string
  status: ConversionDeliveryStatus
  reason?: string
  eventsReceived?: number
  traceId?: string
}
```

429、5xx、网络错误和超时抛出带 `retryable=true` 的领域错误；确定性 4xx 和 2xx/0 不重试。

- [x] **Step 4: 实现状态桶转换**

抽取 `transitionDeliveryStatus()`：同一状态重试只更新 `attempt_count/last_attempt_at`，不重复增加日聚合；状态变化时在 D1 batch 中将旧 bucket 减 1、新 bucket 加 1。delivery 创建时先写 pending bucket。Pixel attempted 和 CAPI sent/failed 共用此函数。`sent` 是不可降级终态：Queue 重投时 delivery 继续保持 sent，adapter 返回 `duplicate_suppressed` 诊断结果，并只给 daily 的 duplicate_suppressed 诊断桶加 1，不再次调用 Meta、不从 sent 桶扣减。

- [x] **Step 5: 实现主 Queue 与 DLQ handler**

`handleMetaCapiBatch()` 通过 `batch.queue.endsWith('-dlq')` 区分：

- 主 Queue：逐条 await，成功/永久失败 ack，可重试错误按 60/300/900/1800 秒上限 retry。
- DLQ：调用 `markRetryExhausted()`，写 `status=failed,error_code=retry_exhausted`，然后 ack。
- 已 sent：不调用 Meta，记录一次 duplicate_suppressed 诊断后 ack，delivery 仍为 sent。

`index.ts` 的 queue handler 只调用该 service。

- [x] **Step 6: 配置生产和 dev DLQ**

生产 consumer：

```toml
[[queues.consumers]]
queue = "meigallery-meta-capi"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 5
retry_delay = 60
dead_letter_queue = "meigallery-meta-capi-dlq"

[[queues.consumers]]
queue = "meigallery-meta-capi-dlq"
max_batch_size = 10
max_batch_timeout = 5
```

dev 使用 `meigallery-meta-capi-dev-dlq`，batch size 5。更新资源隔离脚本，断言 dev/prod 主 Queue 与 DLQ 名称均不交叉。

- [x] **Step 7: 验证 CAPI 与 Wrangler**

Run:

```bash
corepack pnpm --filter @meigallery/api test -- src/services/meta-capi.test.ts src/services/meta-capi-queue.test.ts src/services/conversions.test.ts
corepack pnpm test:scripts
corepack pnpm --filter @meigallery/api exec tsc --noEmit
corepack pnpm --filter @meigallery/api exec wrangler deploy --env="" --dry-run --outdir=dist
corepack pnpm --filter @meigallery/api exec wrangler deploy --env dev --dry-run --outdir=dist-dev
```

Expected: 全部 PASS；两个 dry-run 都显示主 Queue 和 DLQ consumer。

- [x] **Step 8: 提交 Task 6**

```bash
git add packages/api/src packages/api/wrangler.toml scripts/verify-dev-resources.mjs scripts/verify-dev-resources.test.mjs
git commit -m "feat: 加固 Meta CAPI 队列可靠性"
```
