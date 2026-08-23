# Account/Settings-2 账号资料、初始偏好与会话设置跨仓开发基线

更新时间：2026-08-10

App 版本：1.0

累计 App API 契约：`1.20.0`

当前状态：Cloudflare 与 KMP 开发接线完成；环境配置、D1 migration、构建、专项测试、截图和远端联调按既定顺序统一后置。

## 1. 本切片目标

Account/Settings-2 补齐三个此前只有产品/UI 定义、尚未形成权威纵向闭环的能力：

- 新注册观看者可显式选择地区、风格和内容主题，也可确认使用非个性化基础推荐。
- 登录观看者可维护私有昵称与受控头像样式；该资料不会创建、认领或修改公开真人资料。
- 平台话题可管理单会话免打扰，并从会话设置进入举报、屏蔽和关闭；单条平台运营消息继续支持举报。

本切片不改变产品基本边界：注册者始终是观看者；只有管理员认证并发布的真人才能进入公开列表；平台话题由 MeiGallery 平台运营接收，不暗示真人本人入驻、直接收信或承诺回复。

## 2. Figma 是页面实现前置门禁

KMP 页面不得先凭文字需求自行绘制。每个页面或可见交互状态必须先读取最终 Figma 节点的设计上下文和截图；若设计状态缺失，先在 Figma 补齐并完成边界、字体、间距和原型目标检查，再实现代码。

| 页面/状态 | Figma Node ID | KMP 入口 |
|---|---|---|
| APP-AUTH-05 初始偏好—正常 | `159:61358` | `InitialPreferenceScreen` |
| APP-AUTH-05 初始偏好—空目录 | `159:61451` | `InitialPreferenceScreenState.Empty` |
| APP-AUTH-05 初始偏好—保存失败 | `159:61499` | `InitialPreferenceScreenState.SaveFailed` |
| APP-AUTH-05 初始偏好—基础推荐说明 | `159:61600` | `InitialPreferenceScreenState.NonPersonalizedExplanation` |
| APP-SET-02 账号资料—正常 | `159:72641` | `AccountProfileScreenState.Ready` |
| APP-SET-02 账号资料—保存失败 | `159:72689` | `Ready.errorMessage` |
| APP-SET-02 账号资料—重新验证 | `159:72746` | `Ready.reauthenticationRequired` |
| APP-MSG-03 话题会话—正常 | `159:68910` | `ConversationScreenState.Ready` |
| APP-MSG-03 话题会话—消息操作 | `505:2` | 长按平台运营消息后的操作弹层 |
| APP-MSG-03 话题会话—举报消息 | `505:28` | 单条消息举报弹层 |
| APP-MSG-04 会话设置—正常 | `159:69179` | `ConversationSettingsScreenState.Ready` |
| APP-MSG-04 会话设置—操作失败 | `159:69216` | `Ready.saveError` |
| APP-MSG-04 会话设置—已关闭 | `159:69252` | `settings.editable=false` |
| APP-MSG-04 会话设置—举报话题 | `494:24205` | 会话举报弹层 |
| APP-MSG-04 会话设置—确认屏蔽 | `494:24228` | 屏蔽二次确认弹层 |
| APP-MSG-04 会话设置—确认关闭 | `494:24251` | 关闭二次确认弹层 |

新增 Figma 状态复用 `Mobile/Button`、`Mobile/Chip`、现有文字样式和本地颜色/间距/圆角变量；全部文字已确认使用 `Noto Sans SC`，弹层子节点未越出 393×852 页面或弹层边界。APP-MSG-03/04 的入口、取消、提交、重试和关闭后返回路径已建立 prototype reaction。

## 3. 产品与交互规则

### 3.1 初始偏好

- 只在注册成功且 `auth.initialPreferencesEnabled=true` 时打开。
- 只展示统一 Taxonomy 中允许关联公开人物且状态为 `active` 的地区、风格、内容主题词条。
- 最多选择 20 项；保存时重新读取服务端偏好版本并进行乐观并发更新。
- “跳过”必须先展示基础推荐说明；确认后关闭个性化并清空服务端选择。
- 基础推荐只依据地区开放范围、内容安全、公开热度和运营规则，不表示双方匹配，也不使用消息、金币、会员或隐式行为推断偏好。

### 3.2 私有账号资料

- 私有昵称继续使用 `users.nickname` 唯一事实；受控头像仅保存 `rose/coral/lilac/sky/mint/sand` 样式，不允许上传人物照片。
- 响应固定返回 `visibility=private`、`publicPersonProfileCreated=false` 和脱敏登录邮箱。
- 修改昵称或头像样式需要当前密码二次验证；无密码返回 `428 ACCOUNT_PROFILE_REAUTH_REQUIRED`，密码错误返回 `403 ACCOUNT_PROFILE_REAUTH_FAILED`。
- 使用 `expectedVersion` 防止跨设备覆盖。冲突时重新读取权威资料，不把本地草稿误认为已保存。
- 成功修改写入账号安全事件；密码、完整邮箱和内部账号主键不得进入 UI、日志或普通审计 JSON。

### 3.3 会话设置与举报

- 免打扰只影响当前观看者账号的当前平台话题，并抑制之后生成但尚未投递的 `message.platform_reply` 站内通知；它不删除消息、不改变接收主体，也不承诺系统推送能力。
- 关闭话题后设置锁定、历史只读；关闭不删除历史消息、举报记录、免打扰事实或会员额度。
- 屏蔽会停止推荐并清理当前喜欢/关注等既有关系；历史话题保留，解除屏蔽不恢复旧关系。
- 举报当前话题从 APP-MSG-04 进入；单条平台运营消息通过长按进入 APP-MSG-03 消息操作。举报表单只收原因和可选说明，并明确不会通知真人本人。
- 举报、屏蔽和关闭互不替代，屏蔽与关闭必须二次确认。

## 4. Cloudflare 权威实现

### 4.1 D1

`0095_app_account_profile_and_conversation_settings.sql` 新增：

- `app_account_profile_preferences`：账号一对一头像样式、乐观版本和时间戳。
- `idx_app_conversations_id_account`：为会话与账号复合归属提供唯一父键。
- `app_conversation_viewer_settings`：以 `(conversation_id, account_id)` 为主键保存免打扰与版本；复合外键防止跨账号关联。

Migration 不 seed 用户资料、偏好或会话设置，不回填公开真人，也不自动启用能力。

### 4.2 App API v2 `1.20.0`

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/api/v2/me/account-profile` | 读取本人私有账号资料 |
| `PUT` | `/api/v2/me/account-profile` | 密码二次验证后以 `expectedVersion` 更新 |
| `GET` | `/api/v2/conversations/{conversationId}/settings` | 读取本人单会话免打扰和锁定状态 |
| `PUT` | `/api/v2/conversations/{conversationId}/settings` | 以 `expectedVersion` 更新免打扰 |

所有路径先经过 App Bearer 会话和账号归属校验。会话设置查询把 `conversationId + account_id` 同时加入谓词，不能依赖客户端隐藏或单独会话 ID。

### 4.3 默认关闭能力

以下变量只加入类型和运行门禁，本阶段不写入任何 Wrangler 环境：

- `APP_ACCOUNT_PROFILE_ENABLED`
- `APP_INITIAL_PREFERENCES_ENABLED`
- `APP_CONVERSATION_SETTINGS_ENABLED`

Bootstrap 只有在底层 Auth、Recommendation/Taxonomy 或 Messaging 同时可用且对应独立开关为 `true` 时才返回能力开启。路由也重复执行服务端开关检查，不能只信任客户端 capability。

## 5. KMP 实现

- Domain 新增 `AccountProfile`、`AccountAvatarStyle`、`AccountProfileUpdate`、`ConversationViewerSettings` 及对应失败类型。
- Ktor DTO/Mapper 严格验证私有可见性、脱敏邮箱、稳定枚举、ISO 时间、锁定原因和版本推进；未知或矛盾响应安全拒绝。
- `InitialPreferenceScreen`、`AccountProfileScreen`、`ConversationSettingsScreen` 和聊天页均使用 Figma 颜色、字体、间距与 SVG 资源。
- 聊天页按 APP-MSG-03 移除设计稿不存在的内联“举报/关闭”按钮；会话级操作统一进入右上角“设置”。平台运营消息支持长按打开已补齐的 Figma 消息操作状态。
- 底部导航统一使用 Figma 图标、选中态和仅顶部发丝线，不再给整个导航容器增加四边描边。
- 偏好标签使用三列等宽约束和省略规则，避免长文案导致横向溢出。

## 6. 后置验证门禁

根据当前“全部开发完成后再统一配置与测试”的明确顺序，本切片目前不执行：

- `0095` 本地、dev 或 production migration。
- 三个新环境变量配置或 capability 开启。
- Cloudflare TypeScript、Nuxt、Gradle、Android/iOS 构建与专项测试。
- 模拟器/真机、远端 API、通知抑制和截图对比验收。

全部开发任务收口后，必须使用 `android-cli` 对每个 Figma 状态执行启动、导航、截图、语义/布局树、文字截断、边距、对齐、键盘、窄屏和宽屏检查，并把结果与上述 Node ID 一一对应。未经该阶段验证，不得把“开发接线完成”表述为“可发布”。
