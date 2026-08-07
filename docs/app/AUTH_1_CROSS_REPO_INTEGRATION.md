# Auth-1 跨仓联调与上线门禁

## 1. 阶段目标

本阶段把 Cloudflare API 与 KMP App 的 Auth-1 开发基线连接成可验证闭环，但不开放生产注册、不执行 production D1 migration、不部署生产环境。App 产品版本继续保持 `1.0`，App API v2 契约版本提升为 `1.2.0`。

本阶段仅新增：

- 四份法律/资格文档的版本号与可阅读 URL；
- 受控 Turnstile WebView 挑战页；
- 登录、请求注册验证码、完成注册三种独立 challenge action；
- Android/iOS WebView 回传一次性 Turnstile token 的客户端契约；
- 本地测试密钥和本地 D1 的联调路径。

消息、支付、系统推送、人物认领、会员自助购买、金币消费仍不在本阶段开放。

## 2. App API v2 契约 1.2.0

### 2.1 Bootstrap 增量字段

`GET /api/v2/app/bootstrap` 的 `auth.documents` 在四个版本字段之外，必须同时返回：

- `termsUrl`：用户条款正文；
- `privacyUrl`：隐私政策正文；
- `platformOperationUrl`：平台代运营说明正文；
- `eligibilityUrl`：必要资格说明正文。

`auth.challenge.type=turnstile` 时必须同时返回：

- `siteKey`：Turnstile 公开 Site Key；
- `pagePath`：固定为 `/api/v2/auth/turnstile`；
- `resultPath`：固定为 `/api/v2/auth/turnstile/result`。

新增字段均为向后兼容字段。1.1 客户端可忽略它们，但仍保持当时“不支持 Turnstile 交互”的关闭策略；1.2 客户端必须完整校验 URL 和相对路径，任一字段不安全时 fail closed。

### 2.2 挑战用途与 action

| 客户端用途 `purpose` | Siteverify 期望 `action` | 后续业务请求 |
|---|---|---|
| `email_challenge` | `app_email_challenge` | `POST /api/v2/auth/email-challenges` |
| `register` | `app_register` | `POST /api/v2/auth/register` |
| `login` | `app_login` | `POST /api/v2/auth/login` |

Turnstile token 最长 2048 字符、有效期短且只能使用一次。请求邮箱验证码和完成注册必须分别获取 token，禁止复用。

## 3. Turnstile WebView 安全边界

Cloudflare Turnstile 不能作为原生控件运行，App 使用平台 WebView 加载 API Worker 提供的 HTTPS 挑战页。安全约束如下：

- 挑战页只接受白名单 `purpose`，不接受任意 action；
- 页面只包含公开 Site Key，不包含 Secret Key；
- 页面启用一次性 CSP nonce、`frame-ancestors 'none'`、`no-store` 和 `no-referrer`；
- 原生端不注册 JavaScript bridge；
- 成功 token 只放入同源结果 URL 的 fragment，原生端拦截后立即关闭 WebView；fragment 不会发送给服务器；
- Android 禁止 file/content access、混合内容和非白名单主框架跳转；
- iOS 禁止非白名单主框架跳转，不注册 script message handler；
- token 只保存在一次业务调用的内存局部变量中，不写日志、不落盘、不进入分析事件；
- 服务端始终调用 Siteverify，并核对 action；生产环境额外核对 hostname；
- Siteverify 网络异常、非 2xx 或响应异常均 fail closed，返回可重试的 `CHALLENGE_UNAVAILABLE`。

## 4. 法律文档配置门禁

新增非密钥配置：

- `APP_AUTH_TERMS_URL`
- `APP_AUTH_PRIVACY_URL`
- `APP_AUTH_PLATFORM_NOTICE_URL`
- `APP_AUTH_ELIGIBILITY_URL`

生产环境只接受无账号密码、无 fragment 的 HTTPS URL。本地环境额外允许 `localhost`、`127.0.0.1`、`10.0.2.2` 的 HTTP URL。任一版本或 URL 缺失/非法时，bootstrap 必须返回 `capabilities.auth=false`。

这些配置只提供“可阅读正文入口”，不等于法律文本已经审批。G-01/G-03 仍需产品、法务和运营书面确认后才能关闭。

## 5. 本地联调策略与验证记录

Cloudflare 官方 always-pass 测试密钥的 Siteverify 成功响应可能返回 `action=test`，也可能省略 `action`。服务端只在以下条件同时成立时兼容这两种测试响应：

- `APP_ENV=local`；
- `TURNSTILE_SECRET_KEY` 精确等于 Cloudflare 官方公开的 always-pass 测试 Secret；
- Siteverify 仍返回 `success=true`。

该例外不跳过 Siteverify，也不适用于 `dev` 或 `production`。真实密钥始终要求 action 与当前业务用途一致，production 还必须校验 hostname；官方测试密钥禁止进入任何远端环境。

2026-08-05 已完成一次本地闭环验证：

1. 仅在本地 D1 应用 `0065`–`0069` migration，并创建固定本地测试账号；
2. 该次 Android 本地联调以命令行临时变量启用 Auth capability；production 开关保持 `false`，后续 dev 仅为 Safety-2 隔离数据联调开启 Auth 且注册继续关闭；
3. Android 模拟器通过 `10.0.2.2` 加载 `127.0.0.1` Worker 的挑战页；
4. 首次登录完成 Turnstile 后，服务端正确返回 `CONSENT_REQUIRED`；
5. App 展示四份正文入口和当前版本，用户确认后重新获取独立 Turnstile token；
6. `POST /api/v2/auth/login`、`GET /api/v2/me`、`GET /api/v2/me/devices` 均返回 200，账号与当前设备正确展示。

该次本地记录只证明 Android 模拟器的登录与协议更新闭环，不证明正式正文可用，也不替代注册双挑战、超时/取消/离线、iOS 真机或生产 Widget 验收。该次记录本身未执行远端 migration、未部署 Worker、未修改远端数据；后续 dev Safety-2 联调状态以 `docs/PROJECT_STATUS.md` 为准。

## 6. 上线门禁

只有下列条件全部满足，才允许另行申请启用 production，或在 dev 开放注册/接入真实账号数据：

1. 四份正文完成审批并部署到稳定 HTTPS URL；
2. 首发地区、必要资格规则、账号删除与数据保留期完成书面确认；
3. Turnstile Widget hostname/action 配置和 Siteverify 监控完成验证；
4. D1 `0069_app_account_access.sql` 完成备份、隐私评审和独立 migration 授权；
5. Android/iOS 真机完成登录、双挑战注册、取消、超时、离线和 token 单次使用回归；
6. production smoke、回滚点和审计记录准备完成。

在上述门禁关闭前，production 的 `APP_AUTH_ENABLED` 与 `APP_AUTH_REGISTRATION_ENABLED` 必须继续保持 `false`。dev 可以在隔离数据、可回滚、可审计的内部阶段开启 `APP_AUTH_ENABLED`，但 `APP_AUTH_REGISTRATION_ENABLED` 必须保持 `false`，不得使用临时正文收集真实用户同意。
