# Facebook 广告投放启动设计

## 1. 背景

站点准备开始投放 Facebook / Instagram 广告。当前项目已经接入浏览器端 Meta Pixel，后台可配置 Pixel ID，并已覆盖 `PageView`、`ViewContent`、`Search`、`Contact`、`Lead`、`CompleteRegistration`、`StartTrial` 等关键事件。Meta 后台提示可以通过 Conversions API 降低单次成效费用，说明当前仅靠浏览器 Pixel 的信号质量还可以继续增强。

本设计用于第一阶段投放启动，目标不是一次性完成完整广告平台，而是让第一批小预算投放具备清晰归因、可控合规和可观察数据。

## 2. 已确认决策

- 首轮广告主转化目标：点击聊天 / 联系站长。
- 首轮广告落地地址：生产首页，不新建独立广告落地页。
- 首轮链接规范：生产首页 + UTM 参数。
- 首轮追踪方案：保留现有浏览器 Pixel，新增最小 Meta Conversions API 服务端上报。
- 首轮去重方案：浏览器 Pixel 和服务端 CAPI 使用同一个 `event_id`。
- 当前 Meta 后台状态：已有 Pixel ID，尚未生成 Conversions API Access Token。
- 首轮投放地区：暂不限定，先小预算测试。
- 基础设施边界：继续使用 Cloudflare Workers / D1 / Worker Secrets，不引入第三方 CAPI Gateway。

## 3. 非目标

- 不在第一阶段接入 Meta Marketing API，不自动创建广告系列、广告组或素材。
- 不在第一阶段新建专用广告落地页。
- 不实现完整 Cookie 同意管理平台。
- 不上传邮箱、手机号、联系方式具体值、会员备注或受保护媒体信息到 Meta。
- 不把 CAPI Access Token 存入 D1、后台设置页或前端公开配置。
- 不追踪后台管理行为。

## 4. 广告链接与归因口径

首轮广告链接统一使用生产首页：

```text
https://616618.xyz/?utm_source=facebook&utm_medium=paid_social&utm_campaign=fb_contact_test_202607&utm_content=creative_a_interest
```

UTM 约定：

| 参数 | 口径 |
|------|------|
| `utm_source` | 固定为 `facebook`，表示 Facebook / Instagram 广告来源 |
| `utm_medium` | 固定为 `paid_social`，表示付费社交广告 |
| `utm_campaign` | 广告系列标识，例如 `fb_contact_test_202607` |
| `utm_content` | 素材、受众或版位标识，例如 `creative_a_interest` |

后台数据分析按 UTM 关联访问、联系面板打开、联系方式点击、注册成功和开始试用。Meta 后台和站内后台都使用同一组 UTM 解释广告效果，避免两套口径分叉。

## 5. Pixel + CAPI 去重架构

一期保留现有浏览器 Pixel，并在 API Worker 中新增最小 CAPI 服务端补强。

用户触发联系事件时：

1. 用户点击右下角联系方式。
2. 前端生成 `event_id`。
3. 前端通过 Pixel 发送 `Contact` / `Lead`，并携带同一个 `eventID`。
4. 前端调用 API Worker 的 CAPI 事件接口。
5. API Worker 使用 `META_CAPI_ACCESS_TOKEN` 调用 Meta Conversions API。
6. 服务端事件携带同一个 `event_id`。
7. Meta 按 `event_name + event_id` 对浏览器事件和服务端事件去重。

一期服务端 CAPI 覆盖事件：

| 事件 | 用途 |
|------|------|
| `Contact` | 用户点击具体联系方式 |
| `Lead` | 用户产生联系意向，用于主优化目标 |
| `CompleteRegistration` | 注册成功辅助观察 |
| `StartTrial` | 开始试用辅助观察 |

不对 `PageView`、后台行为、普通筛选行为做服务端 CAPI 补强，避免第一阶段事件量和调试复杂度过高。

## 6. CAPI 事件数据口径

服务端只发送 Meta 必要字段和低风险业务字段。

标准字段：

| 字段 | 来源 |
|------|------|
| `event_name` | 前端白名单事件名 |
| `event_time` | API Worker 接收时间 |
| `event_id` | 前端生成并传入 |
| `event_source_url` | 当前公开页面 URL，经敏感 query 过滤 |
| `action_source` | 固定为 `website` |

`user_data` 字段：

| 字段 | 来源 |
|------|------|
| `client_ip_address` | Cloudflare 请求头 / Worker 请求上下文 |
| `client_user_agent` | 请求头 `User-Agent` |
| `fbp` | 浏览器读取 `_fbp` 后传入，服务端校验格式 |
| `fbc` | 浏览器读取 `_fbc` 后传入，服务端校验格式 |

`custom_data` 字段：

| 字段 | 口径 |
|------|------|
| `location` | 触发位置，例如 `floating_contact_panel` |
| `method_type` | 联系方式类型，例如 `telegram`、`wechat`、`email` |
| `action_type` | 行为类型，例如 `open_link`、`copy`、`qr_view` |
| `utm_source` | 当前会话来源 |
| `utm_medium` | 当前会话媒介 |
| `utm_campaign` | 当前广告系列 |
| `utm_content` | 当前素材或受众标识 |

第一阶段不做高级匹配，不上传邮箱或手机号 hash。这样匹配质量不会最高，但隐私风险更低，适合首轮小预算测试。

## 7. API 与配置设计

新增一个 API Worker 服务端接口，用于接收前端高价值事件并转发到 Meta CAPI。接口名称在实施计划中可按现有路由风格微调，设计口径固定为：

```text
POST /api/analytics/meta-capi-event
```

接口职责：

- 只接受白名单事件：`Contact`、`Lead`、`CompleteRegistration`、`StartTrial`。
- 校验 `event_id`、`event_source_url`、`fbp`、`fbc`、UTM 和业务字段长度。
- 使用请求 IP 与 User-Agent 组装 `user_data`。
- 调用 Meta Conversions API。
- 记录最小上报结果，用于后台数据分析展示成功 / 失败计数。

配置职责：

- Pixel ID 继续使用后台站点设置中的 `facebook_pixel_id`。
- CAPI Token 使用 Cloudflare Worker Secret：`META_CAPI_ACCESS_TOKEN`。
- dev 和 production 分别设置 Worker Secret，避免测试和生产混用。
- 如果 Secret 缺失，API 不调用 Meta，只记录“未配置 CAPI”的可观测状态，不影响用户联系流程。

## 8. 后台数据分析口径

后台数据分析需要能回答首轮投放最重要的问题：哪条广告带来了有效联系。

看板应覆盖：

- 按日期查看单日广告访问、联系点击、注册和试用。
- 按 `utm_campaign` 查看广告系列效果。
- 按 `utm_content` 查看素材 / 受众 / 版位效果。
- 按漏斗查看：
  - 广告访问
  - 联系面板打开
  - 联系方式点击
  - 注册成功
  - 开始试用
- 按 Meta 上报状态查看：
  - CAPI 请求数
  - CAPI 成功数
  - CAPI 失败数
  - Secret 缺失数
  - Meta 参数错误数

Pixel 事件数如果无法从 Meta 后台 API 直接取回，则不在站内后台承诺精确展示，只展示站内触发数和 CAPI 上报结果。

## 9. 失败处理

- CAPI 失败不阻断用户跳转聊天、复制联系方式或查看二维码。
- Meta API 超时或返回错误时，前端不展示错误。
- API Worker 记录可排查的最小错误分类，不记录 Token、联系方式值或完整敏感 URL。
- CAPI 接口被异常频繁调用时，沿用现有 API 速率限制模式或新增轻量限制，避免恶意刷事件污染数据。
- 如果 `event_id` 缺失或格式非法，服务端拒绝 CAPI 上报，但站内业务事件仍可记录为普通分析事件。

## 10. 合规与广告审核口径

广告素材和落地页必须保持“图库 / 内容展示 / 联系咨询”表达，不得暗示或承诺成人服务、商业性性服务、露骨内容或个人属性判断。

素材和文案原则：

- 不使用裸露、性暗示姿势、过度挑逗文案。
- 不写“找你喜欢的类型”“附近女生”等暗示用户个人属性或成人服务的文案。
- 不承诺私密服务或线下交易。
- 不使用未经授权图片或第三方版权素材。
- 落地页公开内容继续符合项目边界：合法写真、时尚、生活、艺术类素材。

CAPI 数据原则：

- 不向 Meta 发送邮箱、手机号、联系方式具体值、会员备注、R2 key、Stream token、私有媒体 URL 或后台路径。
- 不追踪管理员后台操作。
- 后续如果面向强隐私合规地区扩大投放，应补充 Cookie / tracking consent 机制，再默认加载 Pixel 和 CAPI。

## 11. 上线前置条件

上线前需要完成：

1. Meta Events Manager 中已有 Pixel。
2. 后台站点设置已填入 Pixel ID，并启用 Pixel。
3. 在 Meta Events Manager 中生成 Conversions API Access Token。
4. 将 Token 写入 Cloudflare API Worker Secret：`META_CAPI_ACCESS_TOKEN`。
5. 生产首页通过 Meta Pixel Helper 验证 `PageView`。
6. 使用 Meta Test Events 验证 `Contact` 或 `Lead` 可见。
7. 检查 Meta 后台是否仍提示重复事件；如提示，优先检查 `event_id` 是否一致。
8. 后台数据分析可按 `utm_campaign`、`utm_content` 查看站内联系点击。

## 12. 测试策略

单元测试：

- CAPI payload 构造测试。
- 白名单事件校验测试。
- `event_id`、`fbp`、`fbc`、UTM 字段格式测试。
- 敏感 URL 和 PII 过滤测试。
- Secret 缺失时的降级测试。

集成测试：

- 联系方式点击同时触发 Pixel 和 CAPI 请求。
- 注册成功触发 `CompleteRegistration` Pixel 和 CAPI。
- 开始试用触发 `StartTrial` Pixel 和 CAPI。
- 后台路由不触发 Pixel 或 CAPI。
- CAPI 失败不影响用户原本操作。

人工验收：

- Meta Pixel Helper 验证生产首页和联系点击。
- Meta Test Events 验证 `Contact` / `Lead`。
- 后台数据分析按 UTM 查看广告效果。
- 浏览器 Network 检查不包含邮箱、手机号、Token、R2 key 或私有媒体 URL。

## 13. 分阶段发布

阶段 1：设计和实施计划

- 完成本设计文档。
- 用户确认后创建实施计划。

阶段 2：开发和 dev 验证

- 新增 CAPI 服务端接口、payload 构造、测试和后台统计口径。
- dev 环境使用测试 Pixel 或 Meta Test Events，不污染生产广告数据。

阶段 3：生产上线准备

- 配置 `META_CAPI_ACCESS_TOKEN`。
- 验证 Pixel、CAPI 和去重。
- 准备首批 UTM 广告链接。

阶段 4：小预算投放

- 首轮以联系站长为主目标。
- 按 `utm_campaign` 和 `utm_content` 每日观察联系点击、注册和试用。
- 根据数据决定是否进入专用广告落地页、多语言或更细 CAPI 事件。

## 14. 参考

- Meta Conversions API：`https://developers.facebook.com/documentation/ads-commerce/conversions-api/get-started`
- Meta Conversions API Gateway：`https://developers.facebook.com/documentation/ads-commerce/gateway-products/conversions-api-gateway/setup`
- Meta Advertising Standards：`https://transparency.meta.com/policies/ad-standards/`
- 当前 Pixel 方案：`docs/superpowers/specs/2026-05-06-facebook-pixel-attribution-technical-solution.md`
