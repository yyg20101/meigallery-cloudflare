# Meta Dataset Quality 官方契约

- Review status：`approved`
- Contract version：`1`

## 1. 验证环境与 commit

- 环境：`production`
- Graph version：`v25.0`
- RELEASE_COMMIT：`54295644ceff91e148dbf89769b4da62a9da5f41`
- capturedAt：`2026-07-12T02:04:00.000Z`
- Dataset：`1277...6781`

## 2. 官方入口与权限

- https://developers.facebook.com/documentation/ads-commerce/conversions-api/dataset-quality-api
- https://eventsmanager.facebook.com/events_manager2/list/dataset/1277...6781/settings?business_id

- 所需权限：`ads_read`、`business_management`

## 3. HTTP request contract

- Method：`GET`
- Graph version：`v25.0`
- Endpoint path：`/dataset_quality`
- Query keys：`dataset_id`、`fields`
- Dataset：`1277...6781`

## 4. allowlisted response schema

| JSON path | Type | Nullable |
|---|---|---|
| `$.web[].event_match_quality.composite_score` | `number` | 否 |
| `$.web[].event_match_quality.match_key_feedback[].coverage.percentage` | `integer | number` | 否 |
| `$.web[].event_match_quality.match_key_feedback[].identifier` | `string` | 否 |
| `$.web[].event_name` | `string` | 否 |

## 5. error classification

- `authentication_failed`
- `invalid_request`
- `network_error`
- `permission_denied`
- `rate_limited`
- `server_error`
- `success`

## 6. freshness/window semantics

- Freshness paths：本次 capture 未批准 freshness 字段，不得推断新鲜度。
- Window paths：本次 capture 未批准 window 字段，不得推断统计窗口。

## 7. retention and privacy

- 一次性 raw JSON 在任何处理结果后销毁；契约不保存响应值、完整 Dataset ID、token、用户数据或事件级标识。
- 正式 collector 只能使用本契约批准的 schema path，并从 verified MetaConnection 读取完整 Dataset ID。

## 8. redacted acceptance evidence

- Owner allowlist：已明确批准。
- 请求绑定：`production` / `v25.0` / `54295644ceff91e148dbf89769b4da62a9da5f41`。
- Dataset 证据：`1277...6781`。
- Schema 统计：批准 4 个路径，拒绝 0 个未知路径。

## 9. rejected unknown fields

- 无；本次 capture 未发现 allowlist 之外的字段路径。
