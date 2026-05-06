# Facebook 像素广告归因技术方案

## 1. 方案摘要

本方案在不接入 Meta Conversions API 的前提下，为 MeiGallery 前台接入客户端 Meta Pixel。Pixel ID、启用状态和调试开关由后台站点设置管理；生产环境按设置加载 Pixel，非生产环境默认强制禁用，避免 Workers dev 子域读取正式 D1 时污染正式广告数据。

核心原则：
- 只采集广告归因所需的公开页面上下文，不发送 PII、Cookie、session token、联系方式值、R2 key、Stream token 或受保护媒体 URL。
- `/admin/**` 后台页面不初始化 Pixel，也不触发任何 Pixel 事件。
- `PageView` 由统一 client plugin 负责，并以 `route.fullPath` 去重，避免 Meta snippet 与 Nuxt 路由监听双发。
- 注册、登录、搜索、图库详情、筛选和联系站长事件都通过统一 composable 发送，业务页面不直接调用 `window.fbq`。
- 首期不做 Cookie 同意弹窗，但代码结构预留 `hasTrackingConsent()` 接入点，后续可在加载 Pixel 前增加同意判断。

## 2. 数据与配置

### 2.1 D1 migration

新增 migration：`packages/api/migrations/0015_facebook_pixel_settings.sql`。

`0014` 已在首页真实案例计划中预留；即使真实案例未先落地，本方案仍使用 `0015`，避免两个并行计划争用同一 migration 文件名。

```sql
-- Facebook Pixel 广告归因配置
INSERT OR IGNORE INTO site_settings (key, value, updated_at)
VALUES
  ('facebook_pixel_enabled', 'false', datetime('now')),
  ('facebook_pixel_id', '""', datetime('now')),
  ('facebook_pixel_debug_enabled', 'false', datetime('now'));
```

### 2.2 站点设置 key

修改 `packages/api/src/utils/site-settings.ts`：

- `ADMIN_SETTING_KEYS` 新增 `facebook_pixel_enabled`、`facebook_pixel_id`、`facebook_pixel_debug_enabled`。
- `PUBLIC_SETTING_KEYS` 新增同样 3 个 key，因为 Pixel ID 是客户端公开标识，不作为 Worker secret。

### 2.3 后台设置校验

修改 `packages/api/src/routes/admin/settings.ts`，在保存 `facebook_pixel_id` 前执行校验：

- 空字符串合法，表示不加载 Pixel。
- 非空时只允许数字字符串。
- 长度限制为 5 到 30 位。
- 保存前 trim。

校验失败响应：

```json
{
  "statusCode": 400,
  "message": "Facebook Pixel ID 只能填写 5-30 位数字"
}
```

`facebook_pixel_enabled` 和 `facebook_pixel_debug_enabled` 可接受 `true`、`false`、`"true"`、`"false"`，保存为布尔值，减少前端重复判断。

## 3. 环境隔离

### 3.1 运行时配置

修改 `packages/web/nuxt.config.ts`：

```ts
runtimeConfig: {
  public: {
    apiBaseUrl: 'http://localhost:8787',
    appEnv: 'development',
    turnstileSiteKey: '',
    siteUrl: 'http://localhost:3000',
    facebookPixelAllowDev: 'false',
    facebookPixelDevId: '',
  },
},
```

环境规则：

| 环境 | 加载规则 |
|------|----------|
| `appEnv === 'production'` | `facebook_pixel_enabled=true` 且 `facebook_pixel_id` 非空时加载站点设置中的 Pixel ID |
| `appEnv !== 'production'` | 默认不加载站点设置中的 Pixel ID |
| `appEnv !== 'production'` 且 `facebookPixelAllowDev === 'true'` | 仅当 `facebookPixelDevId` 非空时加载 dev/test Pixel ID |

这样即使 dev Worker 读取正式 D1，也不会因为正式库中开启 Pixel 而加载正式 Pixel。dev 测试必须显式配置 `NUXT_PUBLIC_FACEBOOK_PIXEL_ALLOW_DEV=true` 和 `NUXT_PUBLIC_FACEBOOK_PIXEL_DEV_ID=<test pixel id>`。

### 3.2 DEV 标识

Facebook Pixel PRD 依赖首页真实案例计划中的 dev 环境标识。若先实现本方案，需在 `packages/web/app/app.vue` 或 `packages/web/app/layouts/default.vue` 保留 `appEnv !== 'production'` 时的 `DEV 测试环境` 标识；如果真实案例计划已先实现，则复用既有标识。

## 4. 前端模块设计

### 4.1 纯工具

新增 `packages/web/app/utils/facebookPixel.ts`：

- `normalizePixelId(value)`：返回 trim 后的数字 ID，非法返回空字符串。
- `sanitizeAnalyticsText(value, maxLength)`：去除邮箱、手机号、URL、token/cookie/session 样式文本，限制长度。
- `isAdminPath(path)`：判断 `/admin` 和 `/admin/**`。
- `resolveFacebookPixelConfig(settings, runtimeConfig)`：决定是否加载 Pixel、使用哪个 ID、是否 debug。

PII 过滤规则：

| 输入类型 | 处理 |
|----------|------|
| 邮箱 | 替换为 `[redacted_email]` |
| 中国大陆手机号或常见国际电话样式 | 替换为 `[redacted_phone]` |
| URL | 替换为 `[redacted_url]` |
| 包含 `token=`、`session=`、`cookie=` 的片段 | 替换为 `[redacted_token]` |
| 超长搜索词或标题 | 截断到 80 字符 |

### 4.2 composable

新增 `packages/web/app/composables/useFacebookPixel.ts`：

对外方法：

```ts
type PixelEventParams = Record<string, string | number | boolean | string[] | number[] | null | undefined>

export function useFacebookPixel() {
  return {
    initFacebookPixel,
    trackPageView,
    trackViewContent,
    trackSearch,
    trackLeadOnce,
    trackCompleteRegistration,
    trackLoginCompleted,
    trackFilterSelected,
  }
}
```

内部规则：

- `initFacebookPixel(pixelId)` 只在客户端执行，只加载一次 `https://connect.facebook.net/en_US/fbevents.js`。
- 初始化时只调用 `fbq('init', pixelId)`，不直接使用 Meta snippet 自动 `PageView`。
- `trackPageView(fullPath)` 自行发送 `fbq('track', 'PageView')`，以 `lastTrackedPagePath` 去重。
- 所有事件发送前调用 `isReady()`，Pixel 未启用时静默跳过。
- debug 开启时使用 `console.info('[facebook-pixel]', eventName, payload)`，但 payload 必须已脱敏。

### 4.3 client plugin

新增 `packages/web/app/plugins/facebook-pixel.client.ts`：

职责：

- 读取 `useSiteSettings()` 和 `useRuntimeConfig()`。
- 调用 `resolveFacebookPixelConfig()` 得到最终配置。
- 排除 `/admin/**` 后初始化 Pixel。
- 首次初始化后发送当前页面 1 次 `PageView`。
- 使用 `router.afterEach()` 监听客户端路由切换；`to.fullPath` 变化且不是后台路由时发送新 `PageView`。

去重口径：

- `lastTrackedPagePath` 存完整 `fullPath`，包含 query，不包含 hash。
- 同一路由重复渲染、同一 query 重复 replace 不重复触发。
- 从公开页进入 `/admin/**` 不发送 `PageView`。
- 从 `/admin/**` 返回公开页，如 Pixel 已初始化，发送公开页 `PageView`。

## 5. 事件映射

| 事件 | 类型 | 触发点 | 参数 |
|------|------|--------|------|
| `PageView` | Meta 标准事件 | client plugin 首屏与公开路由切换 | 无自定义参数 |
| `ViewContent` | Meta 标准事件 | `packages/web/app/pages/gallery/[slug].vue` 图库成功加载后 | `content_type='gallery'`、`content_ids=[id]`、`content_name`、`required_rank`、`tags` |
| `Search` | Meta 标准事件 | `packages/web/app/pages/search.vue` 搜索结果返回后 | `search_string`、`result_count` |
| `Lead` | Meta 标准事件 | `packages/web/app/components/ContactPanel.vue` 首次展开，或未展开时首次激活联系方式 | `location`、`method_type` |
| `CompleteRegistration` | Meta 标准事件 | `packages/web/app/pages/register.vue` 注册 API 成功后 | `method='email'` |
| `login_completed` | 自定义事件 | `packages/web/app/pages/login.vue` 登录 API 成功后 | `method='email'` |
| `filter_selected` | 自定义事件 | `discover`、`search`、首页标签导航点击 | `tag_slug`、`tag_type`、`location` |

### 5.1 ViewContent

实现位置：`packages/web/app/pages/gallery/[slug].vue`。

规则：

- 只在 `gallery.value` 存在且 `status === 'published'` 时触发。
- `content_name` 使用 `sanitizeAnalyticsText(gallery.title, 80)`。
- `tags` 最多发送前 8 个 tag slug。
- 不发送图片 URL、媒体资产 ID、R2 key、会员状态、邮箱或用户 ID。

### 5.2 Search

实现位置：`packages/web/app/pages/search.vue`。

规则：

- 搜索结果返回后触发，确保能带 `result_count`。
- `search_string` 使用用户关键词和 tag slug 的摘要，例如 `q=summer tags=city-a,style-b`。
- `search_string` 先脱敏再截断到 80 字符。
- 同一个搜索 key 只触发一次；搜索 key 由 `keyword`、`selectedTags`、`sort` 组成，不包含分页。

### 5.3 Lead

实现位置：`packages/web/app/components/ContactPanel.vue` 和 `packages/web/app/components/ContactMethodItem.vue`。

规则：

- `ContactPanel` 内维护 `leadTracked`，同一次页面生命周期只发一次 `Lead`。
- 首次展开面板发送：`{ location: 'floating_contact_panel', method_type: 'panel_open' }`。
- 如果用户未展开面板但直接激活联系方式，则发送：`{ location: 'floating_contact_panel', method_type: method.platform }`。
- 不发送 `method.value`、`method.linkUrl`、`method.qrCodeUrl`。

### 5.4 Registration 与 Login

实现位置：`packages/web/app/pages/register.vue` 和 `packages/web/app/pages/login.vue`。

规则：

- 只在 `register()` 或 `login()` promise 成功 resolve 后触发。
- 失败、校验错误、Turnstile 失败不触发。
- 不发送 email、username、redirect URL 或错误信息。

### 5.5 filter_selected

实现位置：

- `packages/web/app/pages/discover.vue` 的 `toggleTag(slug)`。
- `packages/web/app/pages/search.vue` 的 `toggleTag(slug)`、`goToTag(slug)`。
- 首页真实案例计划新增的 `HomeTagNavigator.vue` 点击事件；如果该计划尚未落地，本任务只处理现有 `discover` 与 `search`。

规则：

- `tag_type` 从当前 `tagsData` 分组反查。
- `location` 使用固定枚举：`discover_filter`、`search_filter`、`search_related_tag`、`home_tag_navigator`。
- 只发送 slug 和类型，不发送用户输入。

## 6. 后台 UI

修改 `packages/web/app/pages/admin/settings.vue`：

新增字段：

- `facebook_pixel_id` 文本输入，说明“只填写数字 Pixel ID，留空不加载”。
- `facebook_pixel_enabled` 开关，说明“生产环境启用后开始上报事件”。
- `facebook_pixel_debug_enabled` 开关，说明“只输出脱敏调试日志；dev 加载仍需环境变量显式允许”。

保存策略：

- 文本输入随 `onSave()` 一起 PATCH。
- 两个开关可复用当前功能开关模式单独 PATCH，或统一并入 `onSave()`；为减少重复代码，建议并入 `onSave()`。
- 保存失败时展示 API 返回的 Pixel ID 校验错误。

## 7. 隐私与合规

首期风险：未实现 Cookie 同意弹窗，若后续面向 EU/UK/CA 等强隐私合规地区投放广告，默认加载 Pixel 可能不满足当地要求。

预留点：

```ts
function hasTrackingConsent() {
  return true
}
```

后续接入同意管理时，只需要把 `resolveFacebookPixelConfig()` 或 `initFacebookPixel()` 前的判断改为读取用户同意状态；用户拒绝时不加载 `fbevents.js`，并调用 `fbq('consent', 'revoke')` 的兼容逻辑。

## 8. 验证方案

自动验证：

- `pnpm --filter @meigallery/api test -- src/utils/site-settings.test.ts src/utils/facebook-pixel-settings.test.ts`
- `pnpm --filter @meigallery/api exec tsc --noEmit`
- `pnpm --filter @meigallery/web exec nuxt build`

手动验证：

- Pixel 关闭或 Pixel ID 为空时，浏览器 Network 中不得出现 `fbevents.js` 或 `facebook.com/tr`。
- 生产启用后，Meta Pixel Helper 在首页、发现页、搜索页、图库详情页、注册页各只检测到 1 次 `PageView`。
- 搜索、注册、登录、联系站长和筛选事件可在 Meta Events Manager Test Events 中看到。
- `/admin/**` 页面不加载 Pixel，不发送 `PageView`。
- dev Worker 默认不加载正式 Pixel；只有显式配置 dev allow 和 dev pixel id 后才加载测试 Pixel。

## 9. 上线策略

1. 合入代码后，先部署 Workers dev 子域，确认默认不加载生产 Pixel。
2. 在 dev 子域使用测试 Pixel ID 和显式 dev allow 验证事件触发。
3. 本地部署生产 Worker 后，后台填写正式 Pixel ID 但保持关闭。
4. 通过生产页面 Network 确认关闭状态无 Meta 请求。
5. 打开 `facebook_pixel_enabled`，使用 Meta Pixel Helper 和 Events Manager 验证生产事件。
6. 若发现重复 `PageView` 或误报事件，立即关闭后台 Pixel 开关，无需回滚代码。
