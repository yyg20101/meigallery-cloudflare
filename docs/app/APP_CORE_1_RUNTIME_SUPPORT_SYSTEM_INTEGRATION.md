# App Core-1 运行策略、帮助与系统状态跨仓开发基线

更新时间：2026-08-10

状态：Cloudflare 与 KMP 开发完成；环境配置、构建、专项测试、模拟器/真机和远端联调统一后置

## 1. 交付范围

App Core-1 以 App API v2 `1.19.0` 补齐以下移动端 Page ID：

| Page ID | 页面 | 当前实现 |
|---|---|---|
| `APP-SET-11` | 帮助中心 | 版本化主题、搜索、展开详情、平台联系方式、加载/无结果/错误状态 |
| `APP-SET-12` | 关于与法律 | App 版本、服务边界、四类法律文档、主要开源许可、文档不可用状态 |
| `APP-SYS-01` | 强制升级 | 最低支持版本门禁、更新地址可用/不可用、帮助入口 |
| `APP-SYS-02` | 服务维护 | `maintenance/partial` 两类全局状态、重试时间、状态页与帮助入口 |
| `APP-SYS-03` | 账号受限 | `partial/full` 范围、稳定原因类别、帮助/数据权利/退出安全入口 |
| `APP-SYS-04` | 对象不可用 | 人物下线、撤回授权或暂停公开后的返回、重试与帮助入口 |
| `APP-SYS-05` | 地区不可用 | 服务端国家代码判断、未开放/政策变化兼容枚举、停止业务入口 |

本阶段不新增 D1 migration，不改变人物、会员、消息、钱包或数据权利的权威事实表。

## 2. App API v2 `1.19.0`

### 2.1 Bootstrap 兼容新增

`GET /api/v2/app/bootstrap` 新增：

- `runtime.policyVersion`：稳定运行策略版本；
- `runtime.service`：`normal/maintenance/partial`、用户可见标题、说明、建议重试时间和可选状态页；
- `runtime.client`：最低支持版本、最新版本、可选更新地址和商店可用状态；
- `runtime.region`：服务端识别国家、地区可用性和稳定不可用原因；
- `capabilities.support` 与 `support.contentVersion/centerPath`：帮助中心能力及只读路径。

服务端不接受客户端提交的“我所在地区”作为政策事实。Worker 使用 Cloudflare 写入的 `CF-IPCountry`；启用国家白名单后，无法确认国家同样不进入业务页。

### 2.2 帮助中心

`GET /api/v2/app/support` 是恢复场景也可访问的公开只读接口，返回：

- 六类稳定帮助主题：平台与人物、会员、私信与话题、金币、安全、隐私与数据；
- 可搜索标题、摘要、分段正文和关键词；
- 已启用的平台联系方式，复用当前 `contact_methods` 权威表和安全链接净化；
- 用户条款、隐私政策、平台代运营说明、必要资格说明四类当前文档目录。

该接口不返回内部风控规则、审核证据、管理员身份、R2 key、账号敏感数据或未审核自由文本。

### 2.3 受限账号摘要

`GET /api/v2/me` 兼容新增 `restriction`：

- 正常账号必须为 `null`；
- 受限账号返回 `partial/full`、稳定原因类别、用户可见说明、可选参考时间和允许操作；
- 原始 `restriction_reason_code` 只在服务端映射为 `security_review/account_deletion/policy/administrative`，不透传内部规则；
- 当前没有独立账号限制申诉状态机，因此不会把 Safety-2 的举报复核伪装成账号申诉；用户通过帮助中心联系平台。

受限会话仍只有既有 `/me` 与必要数据权利路径可以通过服务端校验，其他 API 不因客户端页面存在而放宽。

## 3. KMP 全局交互顺序

客户端严格按以下优先级决定首屏：

1. 当前 App 版本低于 `minimumVersion`：显示 `APP-SYS-01`；
2. 服务模式不是 `normal`：显示 `APP-SYS-02`；
3. 当前地区不可用：显示 `APP-SYS-05`；
4. 已恢复账号存在 `restriction`：显示 `APP-SYS-03`；
5. 全部条件通过后才进入发现、账号、消息、媒体等业务页面。

`LoadDiscoveryHome` 在运行门禁未通过时不会继续拉取人物列表。全局状态页只允许重试、打开受控更新/状态 URL、帮助中心和关于与法律；旧页面缓存不能越过门禁继续展示为最新事实。

## 4. 页面与自适应布局

- 系统状态页使用单一居中事实卡；手机最大宽度 `560dp`，宽屏最大宽度 `720dp`。
- 帮助中心手机为单列主题卡，`>=760dp` 为双列主题卡；展开正文仍限制在卡片内，不横向溢出。
- 关于与法律页使用最大 `980dp` 内容容器，法律文档不可用时禁用跳转并显示明确状态。
- 受限账号页隐藏底部业务导航，仅保留服务端允许的安全操作。
- 人物对象失效继续使用人物详情上下文，提供返回发现、重新确认和帮助入口。

当前根导航仍沿用项目既有 Compose 状态编排；App Core-1 不引入实验性 Grid API，也不在本阶段扩大为 Navigation 3 全量迁移。

## 5. 配置边界

代码已声明但尚未写入 Wrangler 的运行策略绑定：

- `APP_RUNTIME_ENABLED`
- `APP_RUNTIME_PRODUCTION_READY`
- `APP_RUNTIME_POLICY_VERSION`
- `APP_RUNTIME_SERVICE_MODE`
- `APP_RUNTIME_MINIMUM_CLIENT_VERSION`
- `APP_RUNTIME_LATEST_CLIENT_VERSION`
- `APP_RUNTIME_UPGRADE_URL`
- `APP_RUNTIME_STATUS_URL`
- `APP_RUNTIME_RETRY_AFTER_SECONDS`
- `APP_RUNTIME_ALLOWED_COUNTRIES`
- `APP_RUNTIME_REGION_UNAVAILABLE_REASON`

未启用 `APP_RUNTIME_ENABLED` 时返回兼容的 `normal + 1.0` 基线，不改变现有环境。显式启用但字段非法、版本倒挂或 production 未通过 `APP_RUNTIME_PRODUCTION_READY` 时，服务端返回安全维护状态而不是猜测为正常。

## 6. 后置工作

遵循当前“先完成所有开发、后统一配置与测试”的顺序，本阶段不执行：

- Wrangler dev/production 变量写入；
- 运行策略真实国家白名单、更新地址或状态页配置；
- Cloudflare API 类型检查、Nuxt build、OpenAPI 校验；
- KMP Gradle、Android/iOS 编译、单元测试、截图测试；
- 模拟器/真机和远端环境联调。

统一验证阶段至少覆盖：正常、强制升级、更新地址缺失、维护、部分恢复、国家允许/拒绝/未知、帮助离线/无结果/文档缺失、部分/全部受限、对象下线，以及未知枚举安全降级。
