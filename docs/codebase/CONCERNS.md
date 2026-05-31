# 代码库关注点

## 1. 优先风险

| 严重度 | 关注点 | 证据 | 影响 | 建议动作 |
|--------|--------|------|------|----------|
| 中 | Dev 环境复用正式 D1/R2 数据 | `docs/DEPLOYMENT.md`、`packages/api/wrangler.toml`、`packages/web/app/layouts/admin.vue`、`packages/web/app/composables/useApi.ts` | dev 后台写操作可能修改真实内容；当前已有后台风险标识和写操作二次确认降低误操作概率 | 为 dev 写操作建立固定测试账号和测试数据标记；如需更强隔离再拆分 dev D1/R2 |
| 高 | 受保护媒体和视频能力必须持续避免前端信任 | `packages/api/src/routes/media.ts`、`docs/PROJECT_STATUS.md` | 权限绕过会导致资源泄露；Stream 未接入时更容易出现文档/UI误导 | 保持服务端 rank 校验为唯一依据；Stream 接入前为视频 UI 保持关闭或显式规划状态 |
| 中 | 多个路由文件仍偏大 | `admin/galleries.ts` 624 行、`admin/users.ts` 约 420 行、`admin/media.ts` 430 行 | 后续改动容易引入回归 | 继续把批量操作、媒体上传、用户写操作和活动查询抽成 service/helper 并保持测试 |
| 中 | 前端复杂组件测试覆盖仍少 | `packages/web` 已有 Playwright smoke 和 Vitest 组件测试，当前覆盖 `MembershipBadge`、`MediaLock`、`SearchInput`、`TagChip` | 后台表单、上传态和复杂筛选状态仍主要依赖页面级 smoke 与人工检查 | 继续补 Vitest 组件测试覆盖上传态、筛选态和后台表单 |
| 低 | format 策略仍较轻量 | 已有 `eslint.config.mjs` 和 `.editorconfig`，当前 `pnpm lint` 以零 warning 通过；未接入 Prettier | `.editorconfig` 只约束基础格式，复杂 Vue 模板排版仍依赖人工维护 | 后续按团队偏好决定是否接入 Prettier 或更严格 Vue 格式规则 |
| 低 | Cloudflare Stream secrets 和字段存在但生产未接入 | `.env.example`、`packages/api/src/routes/media.ts`、`docs/PROJECT_STATUS.md` | 误以为视频链路已可用 | 文档继续标注未接入；接入时补完整上传、转码、播放、成本测试 |

## 2. 技术债

| 债务 | 原因 | 位置 | 忽略风险 | 建议修复 |
|------|------|------|----------|----------|
| 路由承载过多业务逻辑 | Hono 路由快速迭代形成 | `packages/api/src/routes/admin/galleries.ts`、`packages/api/src/routes/admin/users.ts`、`packages/api/src/routes/admin/media.ts` | 难复用、难局部测试 | 已抽出邮箱验证码和后台用户列表 service；继续拆图库、媒体和用户写操作 |
| 前端复杂组件测试覆盖不足 | 项目优先完成 MVP 功能和 Workers 部署 | `packages/web/` | 局部组件状态回归发现晚 | 已补关键 Playwright smoke 和 4 个基础组件测试，后续扩展后台复杂组件覆盖 |
| 统一错误响应不完全一致 | 历史阶段混合 `{ error }` 和 `{ statusCode, message }` | `packages/api/src/routes/**/*.ts` | 前端错误处理要兼容多种格式 | 新增 API 错误响应约定并逐步收敛 |
| 覆盖率仍需扩大 | 当前 coverage 先覆盖核心安全/导入模块，Web 组件测试刚建立基线 | `packages/api/vitest.config.ts`、`packages/web/vitest.config.ts` | 路由服务化和复杂前端组件仍有盲区 | 继续扩大 service 覆盖范围，扩展核心前端组件测试 |

## 3. 安全关注

| 风险 | OWASP 分类 | 证据 | 现有缓解 | 缺口 |
|------|------------|------|----------|------|
| 媒体访问控制错误导致对象泄露 | A01 Broken Access Control | `packages/api/src/routes/media.ts` | 服务端 session 和 rank 校验、R2 私有对象 | 需要持续补 E2E/集成测试覆盖过期会员、低 rank、外部 URL 分支 |
| SSRF/内部地址访问 | A10 SSRF | `packages/api/src/utils/external-url.ts`、`packages/api/src/utils/cover-url.ts`、`packages/api/src/routes/media.ts`、`packages/api/src/routes/galleries.ts`、`packages/api/src/routes/search.ts`、`packages/api/src/routes/admin/media.ts`、`packages/web/app/utils/mediaUrlSecurity.ts` | `assertSafeExternalUrl` 拒绝 localhost/私网 IP；公开封面外链重定向、公开 API `coverUrl`、后台媒体 `thumbnailUrl` 和后台封面预览均复用安全媒体 URL 解析，拒绝 `http`、localhost 和私网地址 | 其他直接 fetch 或 redirect 外部 URL 的代码需保持同样约束 |
| 公开站点设置 URL 被配置为危险协议 | A03 Injection / A05 Security Misconfiguration | `packages/api/src/utils/public-setting-url.ts`、`packages/api/src/utils/public-site-settings.ts`、`packages/api/src/routes/admin/settings.ts`、`packages/web/app/utils/siteSettingsSecurity.ts`、`packages/web/app/components/HomeAdBand.vue`、`packages/web/app/utils/safeMarkdown.ts` | 广告、站点图标、OG 封面仅允许显式解析通过的站内相对路径或 `https`；规则页只允许显式解析通过的站内相对路径；规则 Markdown 链接仅允许显式解析通过的 `https` URL；公开设置接口会清空历史危险 URL 和异常 Pixel ID；前端读取设置时再次归一化 icon、OG、广告、规则页和 Pixel ID；相关入口均拒绝空白和编码控制字符；前端纯文本渲染，外链使用 `noopener noreferrer` | 后续若接入第三方广告脚本，需单独做隐私、CSP 和追踪合规评审 |
| 联系方式手动链接被配置为危险协议 | A03 Injection / A05 Security Misconfiguration | `packages/api/src/utils/contact-link-url.ts`、`packages/api/src/routes/admin/contact-methods.ts`、`packages/web/app/components/ContactMethodItem.vue` | 后台仅允许 `https`、`mailto`、`tel` 和受支持客户端协议；前端点击前二次校验，不安全链接回退为复制联系值 | 后续新增联系平台协议时必须同步白名单和测试 |
| Import Token 泄露 | A07 Identification and Authentication Failures | `packages/api/src/routes/imports.ts`、`packages/api/src/utils/import-token.ts` | token hash 存储、权限和 sourceBotKey 校验、过期检查 | secret 轮换和撤销流程需文档化 |
| 邮箱/Turnstile 配置缺失 | A05 Security Misconfiguration | `packages/api/src/routes/auth.ts` | production 缺 Turnstile secret 时返回 503 | Email Service 配置、发信域和告警仍需上线检查 |

## 4. 性能和扩展关注

| 关注点 | 证据 | 当前症状 | 扩展风险 | 建议 |
|--------|------|----------|----------|------|
| 批量图库操作依赖 D1 批量 SQL | `packages/api/src/routes/admin/galleries.ts` | 已用 100 条分批 | 大批量 delete/R2 清理时耗时增加 | 对超大操作引入后台任务状态或队列 |
| Telegram 导入串行下载文件 | `packages/api/src/services/telegram-file-id-import.ts` | 逐文件 fetch/put | 大图组导入耗时随文件数线性增加 | 保持文件数限制；必要时设计受控并发和重试 |
| 图片转换单规格回退 | `docs/DEPLOYMENT.md`、`packages/api/src/routes/media.ts` | w=480 单规格，失败回退原图 | 更多尺寸会增加 Transformations 消耗和缓存复杂度 | 接入多规格前先做成本和命中率评估 |
| 高变更首页和详情页 | 扫描高变更文件 | 首页、详情页频繁迭代 | UI 回归概率高 | 已有 Playwright smoke 覆盖首页和详情页；后续补截图基线或更细组件断言 |

## 5. 脆弱/高变更区域

| 区域 | 脆弱原因 | 变更信号 | 安全改动策略 |
|------|----------|----------|--------------|
| `packages/web/app/pages/index.vue` | 首页承载推荐、标签、案例、视频区、联系入口 | 90 天内 20 次变更 | 改前后跑 Web build 和浏览器截图验收 |
| `packages/api/src/index.ts` | 全局中间件、路由挂载、scheduled handler | 90 天内 19 次变更 | 改路由顺序时跑 API 全量测试 |
| `packages/api/wrangler.toml` / `packages/web/wrangler.toml` | 生产/dev 绑定、域名、Service Binding | 18/16 次变更 | 改前对照 `docs/DEPLOYMENT.md`，避免 dev 绑定生产域名 |
| `packages/web/app/pages/gallery/[slug].vue` | 媒体展示、锁定提示、互动数据 | 90 天内 17 次变更 | 覆盖游客/登录/VIP/SVIP手动验收或 E2E |
| `packages/api/src/routes/galleries.ts` | 公开列表/详情、搜索、互动和计数 | 90 天内 13 次变更 | 补充查询组合和权限回归测试 |

## 6. `[ASK USER]` 问题

1. [RESOLVED] dev 环境复用正式 D1/R2 的代码侧误操作防护已完成；是否拆出独立 dev 数据库和 bucket 留作后续运维增强。
2. [RESOLVED] 前端自动化测试已接入 Playwright smoke 和 Vitest 组件测试基线；后续继续扩大组件覆盖。
3. [ASK USER] Cloudflare Stream 接入的优先级是否仍低于图片/图库/案例运营能力？
4. [RESOLVED] CI 已加入 lint 和 API coverage 阈值；format 目前用 `.editorconfig` 作为轻量基线，暂未引入 Prettier。

## 7. 证据

- `package.json`
- `.github/workflows/ci.yml`
- `eslint.config.mjs`
- `.editorconfig`
- `packages/api/src/routes/admin/galleries.ts`
- `packages/api/src/routes/auth.ts`
- `packages/api/src/routes/media.ts`
- `packages/api/src/services/telegram-file-id-import.ts`
- `packages/api/wrangler.toml`
- `packages/web/wrangler.toml`
- `.github/workflows/ci.yml`
