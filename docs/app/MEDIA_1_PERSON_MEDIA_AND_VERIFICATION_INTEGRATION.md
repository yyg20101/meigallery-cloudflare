# Media-1 人物图片与认证说明跨仓开发基线

更新时间：2026-08-11

App 版本：1.0

状态：Cloudflare 契约开发完成；`APP-DSC-08/09` Figma 与 KMP 静态接线完成；能力默认关闭，配置与验证后置

## 1. 目标与边界

Media-1 落地 `APP-DSC-08` 人物媒体浏览和 `APP-DSC-09` 认证说明。它复用现有 `galleries`、`media_assets` 与 App 人物公开投影，不复制媒体、不建立第二套人物或图库事实，也不新增 migration。

- 只返回当前仍满足认证、发布、授权、可见性、有效期和来源图库发布条件的人物媒体。
- 只支持 R2 中上传完成的 `image + content|preview`；视频固定为 `false`，不接入 Cloudflare Stream。
- 认证说明只披露四项核验范围、政策版本、审核时间、有效期、资料版本和运营主体说明，不返回证件、授权文件、证据引用、审核人或内部备注。
- 未认领资料继续明确“消息由平台运营接收”；认证不表示本人已入驻，也不构成平台背书。

## 2. App API v2 `1.18.0`

新增路径：

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v2/person-profiles/:profileId/media` | 匿名 | 当前人物图片清单；游标绑定公开投影版本 |
| GET | `/api/v2/person-profiles/:profileId/verification` | 匿名 | 当前公开审核版本的最小认证说明 |
| POST | `/api/v2/person-profiles/:profileId/media/:mediaId/access` | App Bearer | 签发绑定账号会话、人物和单图的 5 分钟凭证 |
| GET | `/api/v2/person-profiles/:profileId/media/:mediaId/content` | 公开图匿名；会员图媒体凭证 | Worker 代理 R2 字节并重新检查当前资格 |

bootstrap 新增：

- `capabilities.media.gallery`
- `capabilities.media.protectedImages`
- `capabilities.media.video=false`
- `media.transport=http_get`
- `media.defaultPageSize=20`、`maxPageSize=40`
- `media.accessTokenHeader=X-Media-Access-Token`
- `media.accessTokenTtlSeconds=300`
- `media.protectedImageCache=memory_only`

运行门禁为 `APP_MEDIA_ENABLED`、`APP_PROTECTED_MEDIA_ENABLED` 与 production 的 `APP_MEDIA_PRODUCTION_READY`。本阶段只声明绑定和解析，不修改 Wrangler，也不启用任何环境。

## 3. 服务端安全约束

1. 列表、签发和取图都复用 `PUBLIC_PROFILE_ELIGIBILITY_SQL`；资料下线、授权撤回、认证过期或来源图库停止发布后，旧路径立即失效。
2. API 永不返回 R2 key。服务端只接受与图库和媒体 ID 匹配的规范对象 key。
3. 会员图片的 HMAC 凭证只绑定账号公开 ID、当前 App session、人物、单张图片和过期时间；不能跨会话、跨人物或跨媒体复用。
4. 签发前读取当前 App 会员 rank；实际取图时再次验证会话、设备、账号状态、session version、有效期和当前会员 rank。
5. 图片只允许 JPEG、PNG、WebP、AVIF，最大 24 MiB；响应为 `no-store`、`nosniff`，并携带 App API/契约/请求追踪头。
6. protected capability 关闭时不降级为公开访问；token 无效或过期返回 401，会员不足返回 403。

## 4. KMP 交互与内存边界

- 人物详情新增“查看图片”和“真人资料已认证”入口。
- `APP-DSC-08` 的 4 张正式稿固定对应 `159:66285`、`159:66346`、`159:66400`、`159:66437`；交互支持 Section `750:3580` 含 19 张首载、空态、当前图/分页加载、访问门槛、缩放、媒体说明、举报和失效稿。可见页面与状态必须先存在于 Figma，KMP 不得自行补造布局。
- 媒体页使用 Figma 定义的全屏主图、顶部 44dp 返回/说明操作、页码胶囊、底部标题/访问说明和缩放/下一张/举报/认证入口。当前 Figma 未定义缩略图条或宽屏侧栏，因此 App 1.0 不实现这两种自拟结构；更宽窗口仅居中约束内容，不改变任务与信息层级。
- 主图支持 1～5 倍双指缩放、拖动、显式缩放复位、下一张、末尾分页和页码；翻页与分页加载保留当前内存图片，分页失败使用非阻断错误卡，不清空当前媒体。
- 网络层先校验 JSON 契约；图片字节再校验 `X-Api-Version`、`X-Contract-Version`、`Content-Type`、`Content-Length` 和 24 MiB 上限。
- 媒体 token 只存在于 Repository 局部变量，不进入 Domain、UI、日志或安全存储。UI 只接收图片字节；受保护图片只保留于当前 Compose 内存状态，到授权 TTL 时清空并重新取权威权限。
- 认证页完整展示四项公开范围、运营主体、政策/审核/有效期/资料版本和责任边界；错误时不回退展示旧认证详情。
- `APP-DSC-09` 的 3 张正式稿固定对应 `159:66476`、`159:66553`、`159:66636`；交互支持 Section `783:3600` 含 13 张首载/失败、规则、举报与刷新状态。所有可见状态均先完成 Figma 边界、文字、热区和原型目标复核，再进入 Compose。
- 客户端仅在当前会话保留同一 `profileId` 的最近认证详情；重新读取到不同 `profileVersion` 时进入资料变化态。用户明确刷新前不把旧摘要继续标记为当前事实；刷新失败保留旧摘要和版本说明但不覆盖服务端记录。
- 人物不再满足公开资格时认证页进入通用失效状态，并停止恢复旧媒体页；不会从客户端推断或展示授权撤回、审核内部原因或安全处置细节。
- 媒体举报复用 Message-2 的稳定原因目录与 `SafetyReportTarget.Media`，默认不预选原因；提交稳定 code，提交中防重复，失败保留选择，成功可进入举报记录，仍要求登录并由平台运营处理。
- 认证问题举报复用同一 Safety 目录与 `SafetyReportTarget.PersonProfile`；Figma 只定义原因选择和提交反馈，不新增匿名举报、客户端本地原因事实或第二套安全记录。

## 5. 明确后置

- 不修改或执行 migration。
- 不修改 Wrangler 或 dev/production 环境变量。
- 不接入视频、预加载、离线下载、磁盘缓存、系统分享或 DRM。
- 不运行专项测试、Gradle 构建、模拟器/真机、远端联调或生产发布；统一进入开发任务收口后的配置与验证阶段。

## 6. 验证状态与后续门禁

当前开发提交前已完成：

- Cloud API TypeScript 类型检查通过。
- OpenAPI `1.18.0` YAML 语法解析通过。
- Nuxt Cloudflare Worker 生产构建通过；受限网络下字体目录探测产生非阻断警告，不影响构建产物。

开发任务全部收口后统一执行：

- App API 媒体列表/资格撤回/游标换版、token 篡改/过期/跨对象、会员到期、超大文件与类型伪装测试。
- KMP MockEngine 对公开/会员图片、二次权限失败、长度限制、token 不落盘和认证四项严格映射测试。
- 手机、平板/折叠屏的居中约束、缩放、翻页、横竖屏、TalkBack、内存压力和后台恢复验证；若未来需要缩略图条或宽屏侧栏，必须先补充对应 Figma 页面和状态。
