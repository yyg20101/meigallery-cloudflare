# Task 4 API/data 子任务报告

## 完成范围

- 新增 `packages/api/src/services/attribution-dashboard.ts`，集中承载 summary、trends、quality、breakdown 查询、序列化和逐日补齐。
- 新增或整理统一看板接口：`GET /summary`、`GET /trends`、`GET /quality`、`GET /breakdown`、`GET /meta/status`、`GET /readiness`。
- `/meta/status` 直接复用现有 MetaConnection、rollout snapshot 和 open critical incident 读取，不复制晋级或 incident 关闭规则。
- 保留 `/overview`、`/conversions`、`/links`、`/meta`、`/duplicates` 等 legacy 接口；活动业务 SQL 明确只读取 `contact`、`complete_registration`，Lead 与会员发放改为独立历史/运维查询。
- 未修改 web、未访问远端 D1、未推送、未部署、未更新 `progress.md`。

## 通用响应契约

六个接口都返回：

```json
{
  "range": { "from": "2026-07-10", "to": "2026-07-10", "days": 1 },
  "usage": { "rowsRead": 4, "rowsWritten": 0, "durationMs": 1 },
  "data": {}
}
```

日期使用 Asia/Shanghai 业务日期。`from`、`to` 非法或超过 90 天返回 `ANALYTICS_RANGE_INVALID`。看板查询失败统一返回 503：

```json
{
  "statusCode": 503,
  "message": "归因看板数据暂时不可用",
  "code": "ATTRIBUTION_DASHBOARD_UNAVAILABLE"
}
```

## API schema 示例

### `GET /summary?from=2026-07-10&to=2026-07-10`

```json
{
  "data": {
    "business": { "contactCount": 3, "completeRegistrationCount": 2, "actionCount": 5 },
    "historical": { "leadCount": 9 },
    "delivery": {
      "pixelAttempted": 5,
      "capiSent": 4,
      "failed": 1,
      "skipped": 2,
      "pending": 3,
      "retryExhausted": 1
    }
  }
}
```

`capiSent` 只表示 CAPI API 接收，不表示 Meta 归因成功。

### `GET /trends?from=2026-07-10&to=2026-07-10&granularity=day`

```json
{
  "data": {
    "granularity": "day",
    "rows": [{
      "date": "2026-07-10",
      "business": { "contactCount": 3, "completeRegistrationCount": 2, "actionCount": 5 },
      "delivery": {
        "pixelAttempted": 5,
        "capiSent": 4,
        "failed": 1,
        "skipped": 2,
        "pending": 3,
        "retryExhausted": 1
      }
    }]
  }
}
```

单日始终恰好一行；多日缺失日期补零。当前只允许 `granularity=day`。

### `GET /quality?from=2026-07-10&to=2026-07-10`

```json
{
  "data": {
    "match": {
      "summary": {
        "fbp": { "availability": "available", "numerator": 3, "denominator": 4, "rate": 0.75 },
        "fbc": { "availability": "available", "numerator": 2, "denominator": 4, "rate": 0.5 },
        "email": { "availability": "available", "numerator": 4, "denominator": 4, "rate": 1 },
        "externalId": { "availability": "available", "numerator": 1, "denominator": 4, "rate": 0.25 }
      },
      "rows": []
    },
    "datasetQuality": { "availability": "not_available", "latest": null, "rows": [] }
  }
}
```

Match denominator 只取活动 action 对应且状态为 `pending/sent/failed/duplicate_suppressed` 的已规划 CAPI delivery；`fbc` denominator 进一步限定 Meta 付费来源。denominator 为 0 时返回 `availability=unavailable`、`rate=null`。没有 Dataset Quality snapshot 时不伪造 0 分。

### `GET /breakdown?...&dimension=utm_campaign&limit=50`

```json
{
  "data": {
    "dimension": "utm_campaign",
    "rows": [{
      "value": "summer-campaign",
      "actionCount": 5,
      "contactCount": 3,
      "completeRegistrationCount": 2,
      "delivery": { "pixelAttempted": 5, "capiSent": 4, "failed": 1, "skipped": 0, "pending": 0, "retryExhausted": 0 }
    }]
  }
}
```

dimension 白名单为 `utm_campaign`、`utm_content`、`tracking_link`，空值统一为“未标记”，limit 为 1 到 100、默认 50。查询先建立 conversion action fact，再按 action ID 聚合每渠道 delivery，因此 Pixel+CAPI 双通道不会把 `actionCount` 翻倍。

### `GET /meta/status` 与 `GET /readiness`

- `/meta/status.data` 包含 `connection`、`rollout`、`activity`；rollout 内保留 target/effective 与现有 open incident。
- `/readiness.data` 保留既有 `ready/checks/settings/verifications` 结构，指标查询改为绑定同一 `from/to`。
- 两者均返回统一 `range/usage/data`；读取异常 fail closed 为稳定 503。

## TDD 记录

红灯命令：

```bash
corepack pnpm --filter @meigallery/api test -- src/routes/admin/attribution.test.ts
```

初始结果：96 个测试文件中 1 个失败；969 项测试中新增 20 项失败。失败原因是 `/summary`、`/trends`、`/quality`、`/breakdown`、`/meta/status` 尚不存在，符合预期红灯。

最终验证：

```text
corepack pnpm --filter @meigallery/api test
Test Files  96 passed (96)
Tests       971 passed (971)

corepack pnpm --filter @meigallery/api exec tsc --noEmit
通过

git diff --check
通过
```

覆盖重点包括 2026-07-10 单日、零数据补日、match 分子/分母/null availability、双通道 action 基数、六接口日期范围、运行时 SQL Lead 扫描、dimension 白名单和查询异常 fail closed。

## 后续 UI 对接注意

- UI 统一持有一份 `from/to`，六个 panel 直接复用，不应各自生成日期状态。
- 图例文案应使用“站内事实 / Pixel 尝试 / CAPI 接收 / Meta 质量”；禁止把 `capiSent` 展示为“Meta 归因成功”。
- Match 与 Dataset Quality 必须按 `availability` 渲染；`null` 不得格式化成 0%。
- rollout 操作继续调用现有 `/meta/rollout`，incident 列表和关闭继续调用现有 `/meta/incidents` 专用 API；不要通过 `/meta/status` 或通用 settings 写状态。
- breakdown 表格应以 `actionCount` 为业务基数，delivery 字段只作为同一 action fact 的渠道证据。
