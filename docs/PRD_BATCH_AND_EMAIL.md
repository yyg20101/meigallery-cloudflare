# PRD: 后台批量操作 & 邮箱验证系统

> 版本: 1.0 | 日期: 2026-04-30 | 状态: 草案，批量图库操作和邮箱验证基础能力已部分落地；当前生产状态以 `docs/PROJECT_STATUS.md` 为准。

---

## 1. 执行摘要

### 问题陈述

1. **后台批量操作缺失**：606 个 WordPress 迁移图库均为 draft 状态，管理员只能逐一操作，无法高效完成审核发布、等级设置和标签管理。
2. **注册无邮箱验证**：当前注册仅需邮箱+密码即可完成，无法验证邮箱真实性。恶意用户可批量注册垃圾账号，也无法实现密码重置。

### 解决方案

1. 在管理后台图库列表页增加批量选择和批量操作功能（发布、下架、删除、设置会员等级、打标签）。
2. 基于 Cloudflare Email Service 构建邮箱验证系统，覆盖注册验证码、密码重置、会员到期提醒和新图库通知四个场景。

当前实现备注：后台图库批量 `publish` / `unpublish` / `delete` / `set_level` / `add_tags` / `remove_tags` 已实现；邮箱验证码、密码重置、会员到期提醒和 Email binding 已实现基础链路，`email_verification_enabled` 默认关闭，新图库通知仍按后续阶段处理。

### 成功指标

| 指标 | 目标 |
|------|------|
| 批量操作 — 606 图库全量发布耗时 | < 2 分钟（含全选+确认） |
| 批量操作 — 单次操作最大图库数 | >= 100 |
| 邮箱验证码送达率 | >= 95%（30 秒内到达） |
| 注册转化率（输入验证码后完成注册） | >= 80% |
| 垃圾注册降低比例 | >= 90%（对比上线前） |

---

## 2. 用户体验 & 功能需求

### 2.1 用户角色

| 角色 | 描述 |
|------|------|
| 管理员（Owner/Admin） | 后台操作者，管理图库、用户和内容 |
| 普通用户 | 前台注册、浏览图库的访客 |

### 2.2 功能 A：后台图库批量操作

#### 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| A1 | 作为管理员，我想全选/勾选多个图库，然后一键发布，以便快速上线迁移内容 | - 列表每行有 checkbox；支持全选当前页 / 全选所有匹配项<br>- 工具栏显示已选数量<br>- 点击"批量发布"后二次确认弹窗<br>- 执行后显示成功/失败数量，失败项有原因 |
| A2 | 作为管理员，我想批量下架已发布的图库 | - 同 A1 选择机制<br>- 状态从 published 改为 draft<br>- 写审计日志 |
| A3 | 作为管理员，我想批量删除图库及其关联的媒体和标签 | - 二次确认弹窗，显示"将删除 N 个图库及其所有图片"<br>- 删除 galleries + gallery_tags + media_assets 记录<br>- R2 中对应的图片对象一并删除<br>- 写审计日志 |
| A4 | 作为管理员，我想批量设置图库所需会员等级 | - 选择目标等级（免费/VIP/SVIP）<br>- 更新所有选中图库的 required_level_rank |
| A5 | 作为管理员，我想给选中图库批量添加或移除标签 | - 弹出标签选择器，支持搜索现有标签<br>- 两种模式：添加标签 / 移除标签<br>- 执行后写审计日志 |

#### API 设计

```
POST /api/admin/galleries/batch
Content-Type: application/json

{
  "action": "publish" | "unpublish" | "delete" | "set_level" | "add_tags" | "remove_tags",
  "galleryIds": string[],          // 指定 ID 列表
  "selectAll": boolean,            // 或全选（配合 filter 条件）
  "filter": {                      // selectAll=true 时的筛选条件
    "status": "draft" | "published",
    "tag": string,
    "search": string
  },
  "params": {                      // 各操作的参数
    "requiredLevelRank": number,   // set_level 时
    "tagIds": string[]             // add_tags / remove_tags 时
  }
}
```

响应:
```json
{
  "affected": 606,
  "success": 600,
  "failed": 6,
  "errors": [{ "galleryId": "xxx", "error": "原因" }]
}
```

#### 前端交互

- **选择模式**：checkbox 列 + 顶部工具栏（已选 N 项）
- **全选逻辑**：
  - "全选本页"：勾选当前页所有行
  - "全选所有 N 个匹配结果"：banner 提示，使用 `selectAll=true` + `filter`
- **操作工具栏**：选中 > 0 时显示，包含 5 个操作按钮
- **确认弹窗**：所有操作均需二次确认，删除操作使用红色警告样式
- **执行反馈**：操作完成后 toast 显示结果，列表自动刷新

### 2.3 功能 B：邮箱验证系统

> 注意：Cloudflare Email Service 使用前需按官方文档和 Dashboard 当前状态确认可用计划、发信额度和费用；当前 `email_verification_enabled` 默认为 `false`。

#### 用户故事

| # | 故事 | 验收标准 |
|---|------|----------|
| B1 | 作为新用户，注册时我需要输入邮箱收到的 6 位验证码来证明邮箱是我的 | - 填写邮箱+密码后，点击"发送验证码"<br>- 邮箱收到 6 位数字验证码，有效期 10 分钟<br>- 60 秒内不可重复发送（前后端双重限制）<br>- 输入正确验证码后完成注册<br>- 3 次输入错误后需重新发送 |
| B2 | 作为已注册用户，我忘记密码后可以通过邮箱验证码重置 | - 在登录页点击"忘记密码"进入重置页<br>- 输入邮箱 → 发送验证码 → 输入验证码 → 设置新密码<br>- 验证码有效期 10 分钟<br>- 重置成功后清除所有已有 session |
| B3 | 作为 VIP/SVIP 用户，会员到期前 3 天我收到邮件提醒 | - 系统每天检查即将到期的会员（Cron Trigger）<br>- 到期前 3 天发送一封提醒邮件<br>- 每个到期周期只发一次（去重） |
| B4 | 作为注册用户，新图库发布时我收到邮件通知 | - 管理员发布图库后触发通知<br>- 仅通知已验证邮箱的用户<br>- 邮件含图库标题、封面缩略图和链接<br>- 用户可在个人设置中关闭此通知 |

#### 注册流程变更

```
现有流程:
  邮箱+密码 → Turnstile → 注册完成

新流程:
  邮箱+密码 → Turnstile → 发送验证码 → 输入验证码 → 注册完成
```

关键决策：注册改为两步式，第一步收集信息并发送验证码，第二步验证后创建账号。这样未验证的信息不会写入 users 表。

#### 验证码存储

D1 新增 `email_verification_codes` 表：

```sql
CREATE TABLE email_verification_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,              -- 6位数字
  purpose TEXT NOT NULL,           -- 'register' | 'password_reset'
  expires_at TEXT NOT NULL,        -- 10 分钟后
  attempts INTEGER NOT NULL DEFAULT 0,  -- 已尝试次数
  used INTEGER NOT NULL DEFAULT 0,      -- 是否已使用
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_evc_email_purpose ON email_verification_codes(email, purpose);
```

#### API 设计

```
# 发送验证码（注册）
POST /api/auth/send-code
{ "email": "user@example.com", "purpose": "register" }
→ { "message": "验证码已发送", "cooldown": 60 }

# 发送验证码（密码重置）
POST /api/auth/send-code
{ "email": "user@example.com", "purpose": "password_reset" }
→ { "message": "验证码已发送", "cooldown": 60 }

# 注册（含验证码）
POST /api/auth/register
{ "email": "...", "password": "...", "nickname": "...", "code": "123456", "turnstileToken": "..." }

# 密码重置
POST /api/auth/reset-password
{ "email": "...", "code": "123456", "newPassword": "..." }
```

#### 邮件模板

所有邮件使用统一的品牌模板：
- 发件人: `noreply@616618.xyz`
- 品牌色: #111（黑色主色）
- 模板包含: Logo + 标题 + 正文 + 行动按钮（可选）+ 底部说明

4 种邮件类型：

| 类型 | 主题 | 正文核心 |
|------|------|----------|
| 注册验证码 | `[MeiGallery] 你的注册验证码：{code}` | 验证码 + 10 分钟有效期提示 |
| 密码重置 | `[MeiGallery] 密码重置验证码` | 验证码 + 安全提示 |
| 会员到期提醒 | `[MeiGallery] 你的{level}会员即将到期` | 到期日期 + 联系站长续费 |
| 新图库通知 | `[MeiGallery] 新内容发布：{title}` | 标题 + 封面 + 查看链接 + 退订链接 |

### 2.4 非目标（Not Goals）

- 不实现邮件营销/群发系统
- 不实现 Magic Link 登录
- 不实现邮箱变更功能（首期）
- 批量操作不支持跨页拖拽排序
- 不实现邮件模板可视化编辑器（代码中硬编码模板）

---

## 3. 技术规格

### 3.1 架构概览

#### 批量操作

```
管理后台 → POST /api/admin/galleries/batch
  → 验证管理员权限
  → 解析 galleryIds 或 selectAll+filter
  → 按 action 分发处理
  → 事务性批量更新 D1
  → 写审计日志
  → 返回结果
```

注意：D1 单次查询最大 128KB SQL，大批量操作需分批（每批 100 条）。

#### 邮件系统

```
前端 → POST /api/auth/send-code
  → 速率限制检查（同一邮箱 60 秒内不可重发）
  → 生成 6 位验证码 → 存入 D1
  → 调用 Cloudflare Email Service 发送
  → 返回 cooldown

Cron Trigger（每天 UTC 08:00）
  → 查询 3 天内到期的会员
  → 去重（检查是否已发送过）
  → 批量发送到期提醒邮件
```

### 3.2 Cloudflare Email Service 集成

**前置条件**：需先确认 Cloudflare Email Service 当前可用计划、发信额度、费用和 DNS 要求。

**wrangler.toml 配置**（API Worker）：
```toml
# Email Service binding
[[send_email]]
name = "EMAIL"
```

**Worker 中发送邮件**：
```typescript
await c.env.EMAIL.send({
  to: email,
  from: 'noreply@616618.xyz',
  subject: '...',
  html: '...',
  text: '...'
})
```

**DNS 配置**：需为 `616618.xyz` 配置 SPF、DKIM、DMARC 记录（Cloudflare Email Service 自动管理）。

### 3.3 数据库变更

新增表：
- `email_verification_codes`：验证码存储（见 2.3 节）

修改表：
- `users` 新增列：
  - `email_verified INTEGER NOT NULL DEFAULT 0`（邮箱是否已验证）
  - `notification_enabled INTEGER NOT NULL DEFAULT 1`（是否接收新图库通知）
- `user_memberships` 新增列：
  - `expiry_notified INTEGER NOT NULL DEFAULT 0`（到期提醒是否已发送）

### 3.4 Cron Trigger

API Worker 新增 scheduled handler：

```toml
# wrangler.toml
[triggers]
crons = ["0 0 * * *"]  # 每天 UTC 00:00（北京时间 08:00）
```

任务：
1. 清理过期验证码（> 1 小时前的记录）
2. 发送会员到期提醒（到期前 3 天，`expiry_notified = 0`）

### 3.5 安全 & 隐私

- 验证码有效期 10 分钟，3 次错误后作废
- 同一邮箱 60 秒内只能发一次验证码（D1 查询 + 速率限制）
- 同一 IP 每小时最多发送 10 次验证码请求
- 批量删除操作需要 Owner 角色（Admin 不可）
- 所有批量操作写入审计日志，记录操作者、操作类型、影响的 ID 列表

---

## 4. 风险 & 路线图

### 4.1 分阶段实施

| 阶段 | 内容 | 优先级 |
|------|------|--------|
| **Phase 1** | 后台批量操作（5 种操作 + 前端 UI）✅ 已实现核心链路 | P0 — 立即需要（606 图库等待发布） |
| **Phase 2** | 邮箱验证码注册 + 密码重置 ✅ 已实现基础链路，默认由开关控制 | P0 — 安全基础 |
| **Phase 3** | 会员到期提醒已接入 Cron；新图库通知仍为后续阶段 | P1 — Phase 2 完成后 |

### 4.2 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| Cloudflare Email Service 仍为 Beta | API 可能变更 | 封装发送逻辑为独立 service，便于切换 |
| Workers/Email 计划要求 | 可能需要升级或启用额外服务 | Phase 1 不依赖邮件，可先完成；Phase 2 开始前按官方 pricing 和 Dashboard 当前状态确认 |
| D1 批量操作性能 | 大批量 UPDATE 可能超时 | 分批执行，每批 100 条 |
| 邮件送达率 | 验证码邮件进垃圾箱 | 配置 SPF/DKIM/DMARC；使用 noreply@ 发件地址 |
| 验证码暴力破解 | 攻击者穷举 6 位数字（100 万种组合） | 3 次错误作废 + IP 速率限制 + Turnstile |

### 4.3 依赖项

- **Phase 1**：无外部依赖，当前架构即可实现
- **Phase 2-3**：需要确认 Cloudflare Email Service 当前计划要求、完成 Email Service 配置和 DNS 记录
