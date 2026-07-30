# MeiGallery App 1.0 Figma 最终交付审计与实施计划

App 版本：1.0

文档状态：Phase 0 审计、Phase 1 Foundations、Phase 2 文件结构与 Delivery Index 已完成

审计日期：2026-07-30

Figma 文件：`Peachmote UI 借鉴审查板 - MeiGallery`

Figma File Key：`LaNSwwGsznwcpV8msj7BQC`

## 1. 结论

现有 Figma 已具备可延续的粉白品牌方向、颜色变量、尺寸变量、中文文字样式和部分核心组件，也已经覆盖移动端 49 个 Page ID；但它还不能作为“所有流程 UI 最终可交付稿”。

当前最主要的差距不是单页美化，而是多批次设计叠加后形成的系统不一致：

- 移动端存在 181 张 393 × 852 的正式画板，覆盖 49 个 Page ID，但只有通知与金币 5 页、23 个状态进入现有最终映射与导出清单。
- 43 个管理后台 Page ID 只有需求确认型静态原型，Figma 中没有对应的最终桌面 UI。
- 移动端需求目录定义 186 个必备状态；Figma 去重后有 177 个状态画板名称，23 个 Page ID 的状态数量与需求不一致。按数量初筛，至少缺少 25 个需求状态，同时存在 16 个额外或尚未映射的状态，必须逐项按语义重新对齐，不能只补齐总数。
- `05｜原型流程` 页面为空。现有 62 个 Flow starting point 分散在页面画板中，没有形成客户和研发可直接理解的完整旅程板。
- 字体、文字样式、图标、组件、变量绑定和点击热区尚未统一，不能直接进入像素级视觉冻结。

产品功能与 Page ID 体系可以继续使用，无需推翻；正确做法是先统一设计系统，再按稳定 Page ID 完成移动端和后台全部状态、交互、映射与验收。

## 2. Phase 0 Checklist

| ID | 检查项 | 状态 | 结论 |
|---|---|---|---|
| `P0.a` | 代码、文档、Page ID、Code Connect 盘点 | 完成 | 92 个 Page ID、349 个必备状态；仓库未发现 Figma Code Connect 映射 |
| `P0.b` | Figma 页面、变量、样式、组件和画板盘点 | 完成 | 10 个文件页、59 个变量、8 个文字样式、2 个渐变、2 个阴影、11 组本地组件 |
| `P0.c` | 代表页截图与源设计同屏审查 | 完成 | 色彩方向可延续；排版、Icon、标注污染、状态和多批次一致性需要系统修复 |
| `P0.d` | 全流程与状态覆盖差距 | 完成 | 移动端状态需重新对齐；后台 43 页最终 UI 缺失；原型流程页为空 |
| `P0.e` | 冲突与建议 | 完成 | 保留产品边界和品牌方向，重构 Design System、文件结构和最终画板 |
| `P0.f` | 输出实施计划并等待确认 | 完成 | 用户已批准实施方案，已进入分阶段执行 |

说明：本轮使用 Figma Desktop、当前文件 Plugin API 的只读结构数据、现有导出图和客户原始视觉参考交叉审查。结构化 Figma 连接器在当前会话不可用，因此外部团队 Library 搜索无法完成；不据此声称已经完成组织级设计系统检索。当前结论也不等同于完整无障碍认证。

## 3. 当前资产盘点

### 3.1 Figma 文件结构

| 页面 | 当前状态 |
|---|---|
| `00｜封面` | 已有 |
| `01｜设计说明` | 已有 |
| `02｜视觉基础` | 已有 |
| `—— 组件 ——` | 分隔页，无内容 |
| `03｜核心组件` | 5 个组件说明板 |
| `—— 页面 ——` | 分隔页，无内容 |
| `04｜App 1.0 核心页面` | 202 个顶层 Frame，含 181 张正式移动端画板 |
| `05｜原型流程` | 空白，0 个子节点 |
| `06｜色彩校准审查` | 4 个审查板 |
| `UI 借鉴审查` | 1 个 Peachmote 借鉴边界审查板 |

### 3.2 变量与样式

- `MeiGallery / Dimension`：18 个变量。
  - spacing：4、8、12、16、20、24、32、40、48。
  - radius：8、12、16、20、24、28、Full。
  - size：`touch-target=48`、`icon-md=24`。
- `MeiGallery / Primitives`：19 个原始颜色变量。
- `MeiGallery / Semantic`：22 个语义颜色变量。
- 文字样式：8 个。
  - `App/Display`：32/40。
  - `App/Heading/Large`：24/32。
  - `App/Heading/Medium`：20/28。
  - `App/Title/Medium`：18/26。
  - `App/Body/Large`：16/24。
  - `App/Body/Medium`：14/22。
  - `App/Label/Large`：14/20。
  - `App/Label/Small`：12/18。
- Paint Style：`App/Gradient/Brand Action`、`App/Gradient/Image Scrim`。
- Effect Style：`App/Shadow/Card`、`App/Shadow/Floating`。

品牌主渐变实际使用 `#D63363 → #C72555`。白字对两端的对比度约为 4.65:1 和 5.49:1，核心按钮配色可以保留。`tertiary` 文本 `#8D817B` 在画布色 `#FFF9F5` 上约为 3.62:1，不适合继续承载普通字号的关键说明。

### 3.3 本地组件

现有 11 组本地组件：

| 组件 | 变体数 |
|---|---:|
| `Action` | 8 |
| `BenefitRow` | 3 |
| `TierTab` | 10 |
| `ConversationRow` | 4 |
| `MessageBubble` | 5 |
| `SettingRow` | 5 |
| `Profile` | 4 |
| `Status` | 2 |
| `P10 / 按钮 / 主操作` | 页面级组件 |
| `P10 / 按钮 / 次操作` | 页面级组件 |
| `P10 / 按钮 / 危险操作` | 页面级组件 |

缺少可支撑 92 页最终稿的 App Bar、Bottom Navigation、Icon Button、Tabs、Chip、Input、Search、Avatar、List Item、Empty/Error State、Banner、Dialog、Bottom Sheet、Toast、Skeleton、Upload、Table、Filter、Pagination、Audit Timeline 等基础组件。

## 4. 关键问题

### 4.1 P0：最终交付范围不完整

1. 43 个后台 Page ID 没有 Figma 最终页面。
2. 只有 `APP-MSG-05/06`、`APP-WAL-01/02/03` 共 23 个状态进入正式 Figma 导出和文档映射。
3. `05｜原型流程` 为空，无法按完整旅程评审。
4. 现有移动端 181 张画板中有 4 张完全重名的重复画板。
5. 正式 UI、设计说明板、状态矩阵和历史批次混放在同一页面，交付边界不清晰。

### 4.2 P0：需求状态与 Figma 状态未对齐

移动端需求目录共有 186 个必备状态；Figma 正式画板去重后共有 177 个名称。以下 23 个 Page ID 数量不一致：

| Page ID | 需求状态 | Figma 唯一画板 | 差值 |
|---|---:|---:|---:|
| `APP-AUTH-06` | 3 | 4 | +1 |
| `APP-DSC-01` | 6 | 2 | -4 |
| `APP-DSC-02` | 4 | 1 | -3 |
| `APP-DSC-05` | 4 | 2 | -2 |
| `APP-DSC-06` | 4 | 6 | +2 |
| `APP-DSC-07` | 5 | 3 | -2 |
| `APP-DSC-08` | 4 | 8 | +4 |
| `APP-INT-03` | 4 | 3 | -1 |
| `APP-MSG-01` | 4 | 3 | -1 |
| `APP-MSG-02` | 5 | 2 | -3 |
| `APP-MSG-03` | 6 | 4 | -2 |
| `APP-MSG-04` | 3 | 4 | +1 |
| `APP-MBR-01` | 4 | 3 | -1 |
| `APP-MBR-02` | 5 | 2 | -3 |
| `APP-MBR-03` | 7 | 4 | -3 |
| `APP-SET-03` | 3 | 4 | +1 |
| `APP-SET-06` | 3 | 4 | +1 |
| `APP-SET-10` | 4 | 5 | +1 |
| `APP-SYS-01` | 2 | 3 | +1 |
| `APP-SYS-02` | 2 | 3 | +1 |
| `APP-SYS-03` | 2 | 3 | +1 |
| `APP-SYS-04` | 3 | 4 | +1 |
| `APP-SYS-05` | 2 | 3 | +1 |

差值仅用于定位，不代表多出的状态必须删除。实施时需按“Page ID + 需求状态 + 触发条件 + 权威边界”逐项匹配；交互中间态可以保留，但必须明确归属，不能冒充需求状态。

### 4.3 P0：交互热区不满足移动端基线

- 181 张正式画板共有 928 个带 Prototype reaction 的节点。
- 其中 361 个节点宽或高小于 48dp。
- 现有审计文档记录“点击热区不足 0”，与本次直接读取 reaction 节点尺寸的结果不一致，需要重新定义校验口径。

处理原则：

- 移动端所有可点击 Icon 外层统一为至少 48 × 48。
- 视觉 Icon 与点击容器分离，Icon 使用 16/20/24 三级槽位。
- 不把 reaction 直接挂在 18、20、22 或 24 的 Vector 上。
- 后台鼠标操作组件保证可见焦点和键盘路径，常规操作高度不低于 36，关键操作不低于 40。

### 4.4 P0：设计标注进入用户界面

- 81 张正式画板内出现 Page ID、设计路由或类似设计标记。
- 23 张现有 Figma 最终状态把“正常、首次空、分页失败、目标失效、无权限”等 QA 状态标签直接放在用户界面中。
- `APP-MSG-05/06`、`APP-WAL-01/02/03` 顶部的 Page ID/路由胶囊属于交付标注，不应由最终 App 渲染。

处理原则：状态、Page ID、路由、触发条件和服务端边界统一放到画板外的 Spec Card；用户界面只保留真实业务信息。

### 4.5 P1：文字系统不统一

结构审计结果：

- 3836 个文字节点中，2052 个没有绑定 Text Style，占 53.5%。
- 836 个文字节点小于 12sp，另有 1169 个为 12sp。
- 17 张画板仍使用 PingFang SC；12 张画板在同一屏混用 PingFang SC 与 Noto Sans SC。
- 早期与中期批次存在大量 10–11sp 辅助文案，视觉上过轻，动态字体下风险较高。

统一方案：

- KMP/Android/iOS 设计基线统一使用 Noto Sans SC；系统缺失时使用明确的平台回退链。
- 所有用户可见文字绑定 8 个正式样式或经确认扩展出的语义样式。
- 11sp 仅允许非关键、可隐藏的设计标注，不进入用户界面。
- 最小用户可见字号原则上为 12sp；关键说明、金额、权限、运营身份和错误文案不低于 14sp。
- 页面标题、App Bar 标题和内容 H1 不重复表达同一语义。

### 4.6 P1：Icon 系统缺失

结构审计结果：

- 4216 个 Vector/Line/Ellipse 等图形节点中，4056 个不在组件实例内。
- 3799 个节点仍使用 `Vector`、`图标` 或 `Icon` 等通用名称。
- 图标容器同时存在 18、19、20、21、22、24、38、40、42、44 等多个尺寸。
- 目前没有独立 Icon Library 或统一 Icon 组件。

统一方案：

- 采用项目已有授权的 Tabler Icons 作为基础线性图标库。
- 常规线宽统一为 1.75；仅选中态、品牌标识和安全警示允许专用实心图标。
- Inline Icon 16、常规 Icon 20、导航/Icon Button 24；全部放入标准方形槽位。
- 对返回、搜索、筛选、通知、设置、关注、喜欢、收藏、消息、会员、金币、安全等高频 Icon 建立语义命名和组件。
- 同一导航层级不混用不同线宽、端点、视觉面积和填充方式。

### 4.7 P1：组件与变量绑定不完整

- 181 张正式画板中只有 109 张根画板绑定变量，72 张仍使用直接色值或历史样式。
- 181 张画板共使用 315 个组件实例，平均每屏约 1.7 个；大量列表、导航、按钮和 Icon 仍是独立图层。
- 多批次画板的字体、返回按钮、顶部栏、底部导航和状态呈现明显不同。

处理原则：先完成 Design System，再批量替换页面。不得在 92 页上继续复制独立 Vector 和文字节点。

### 4.8 P1：平台运营身份仍有误导风险

`APP-MSG-03` 已在标题和说明中显示“平台运营接收”，方向正确；但平台消息气泡仍使用对应真人的头像，容易让用户误认为消息由真人本人发送。

最终方案：

- 平台回复统一使用平台运营头像或清晰的“平台运营”身份图标。
- 真人头像只用于“话题与谁相关”的上下文，不作为平台消息发送者头像。
- 每个会话首屏、平台消息和只读状态持续披露平台接收，不承诺本人回复。

## 5. 品牌与视觉方向判断

### 5.1 可保留

- 粉白、奶油色和深可可色的整体方向。
- `#D63363 → #C72555` 的主操作渐变。
- 大圆角卡片、柔和背景、人物内容优先、深色会员卡和金币只读信息卡。
- 认证、平台运营、会员、金币分别使用不同语义。

### 5.2 需要调整

- 原始宣传图的亮粉色只用于品牌高光和装饰，不用于低对比度小字。
- 减少顶部装饰色块对正文层级的干扰。
- 删除界面内的 Page ID、路由和 QA 状态。
- 统一多批次页面的 App Bar、返回按钮、底部导航、Icon、文字基线和卡片内边距。
- 不继承原宣传图中的“本人在线、快速匹配、立即聊天、充值、送礼”等不符合 App 1.0 边界的内容。

结论：颜色方向符合已确认的最初设计气质，不需要重新选色；需要做的是规范化、对比度约束和跨批次统一。

## 6. 已批准的实施计划

实施方案已于 2026-07-30 获用户批准。以下计划作为执行基线继续保留，不再标记为“等待确认”。

### Phase 1：Design System 统一

当前状态：基础变量、Code Syntax、文字与效果样式已完成；Icon 与组件工作进入后续批次。

1. 已补齐颜色、间距、圆角、尺寸、透明度、描边、动效和断点变量。
2. 已统一 Noto Sans SC 文字样式和数字/金额排版。
3. 待建立 Tabler Icon Library、Icon 槽位和 48dp 点击容器。
4. 待建立移动端和后台核心组件及状态变体。
5. 待将页面级按钮组件迁移到正式组件库。

Phase 1 基础产出与校验见 [Figma Design System Phase 1](./FIGMA_DESIGN_SYSTEM_PHASE1.md)。

### Phase 2：Figma 文件重构

当前状态：已完成。

1. 已把原有 10 页无损归档为 `90｜Archive`，未删除历史画板。
2. 已建立 11 个正式交付页，覆盖 Foundation、Icon、Mobile Components、Admin Components、Mobile Pages、Admin Pages、Prototype Flows、Delivery Index 和 QA。
3. 已固定 `Page ID｜页面名｜状态` 命名规则。
4. 已固定画板外 Spec Card 必填字段和用户界面标注边界。
5. 已建立 92 Page ID、14 个模块和 349 个状态数量的 Delivery Index。

Phase 2 结构、Page ID、校验与证据见 [Figma 文件结构 Phase 2](./FIGMA_FILE_STRUCTURE_PHASE2.md)。

### Phase 3：移动端最终 UI

1. 按 49 个 Page ID 完成 186 个需求状态的语义对齐。
2. 保留有价值的交互中间态，但纳入状态映射，不与需求状态混淆。
3. 统一所有页面文字、Icon、App Bar、Bottom Navigation、反馈和空错状态。
4. 优先顺序：
   - 启动与认证。
   - 发现、搜索、筛选、真人详情和媒体。
   - 喜欢、关注、收藏和历史。
   - 平台话题、通知。
   - 会员、金币。
   - 我的、设置、数据权利和系统状态。

### Phase 4：管理后台最终 UI

1. 为 43 个后台 Page ID 完成 163 个需求状态。
2. 基准画板采用 1440 × 1024；关键工作台补充 1280 和 1024 响应式验证。
3. 建立统一的 Side Navigation、Top Bar、Filter Bar、Data Table、Detail Panel、Form、Approval、Timeline、Upload、Batch Job、Conflict 和 Audit 组件。
4. 优先完成真人认证发布、平台话题运营、会员发放、调币复核、审计和异常处置等高风险流程。

### Phase 5：完整原型流程

在 `05｜原型流程` 或新的 `30｜Prototype Flows` 中建立至少以下完整旅程：

1. 首次启动 → 注册/登录 → 初始偏好 → 推荐。
2. 推荐 → 地区/分类/搜索/筛选 → 真人详情 → 媒体。
3. 真人详情 → 关注/喜欢/收藏 → 互动管理。
4. 非会员发起话题 → 会员目录 → 申请 → 后台发放 → 权益生效 → 创建话题。
5. 平台话题 → 发送/审核/失败/冻结/到期只读 → 会话设置。
6. 通知列表 → 通知详情 → 有效/失效/无权限/升级目标。
7. 钱包 → 明细筛选 → 分录详情 → 申诉。
8. 举报 → 拉黑 → 申诉 → 结果。
9. 数据导出、设备退出和账号注销。
10. 后台真人新建/导入 → 认证 → 发布 → 暂停。
11. 后台平台话题领取 → 回复 → 转派/关闭 → 安全升级。
12. 后台会员申请 → 发放 → 独立复核 → 生效。
13. 后台调币申请 → 复核 → 追加分录 → 对账/冲正。
14. 后台审计查询 → 异常详情 → 处置记录。

### Phase 6：最终 QA 与交付同步

1. 逐页检查文字基线、换行、Icon 光学校准、间距、圆角、图片裁切、状态和交互。
2. 检查所有连接目标、返回路径、Flow starting point 和无出口页面。
3. 检查移动端 48dp 热区、动态字体和关键页面无障碍顺序。
4. 检查后台键盘路径、可见焦点和 200% 缩放。
5. 导出统一截图，更新 Manifest、Markdown、开发文档和客户 DOCX。
6. 输出 Figma Delivery Index、组件/变量清单、92 页映射和 QA 报告。

## 7. 最终验收标准

- 49 个移动端 Page ID 和 43 个后台 Page ID 在 Figma 中均有独立最终页面。
- 186 个移动端需求状态、163 个后台需求状态全部有确定性映射。
- 设计标注不进入用户界面。
- 用户可见文字 100% 使用批准的文字样式，不混用 PingFang SC。
- 页面颜色、间距、圆角和尺寸使用变量；例外有说明。
- 高频 Icon 100% 来自批准的 Icon 组件，不保留无语义的 `Vector`。
- 移动端所有交互热区不小于 48dp。
- 核心旅程可从 Flow starting point 完整点击到结果或安全出口。
- 原型连接缺失目标为 0，重复正式画板为 0。
- 平台运营、认证、会员、金币和权限文案符合已确认产品边界。
- 页面通过同屏参考对照、视觉 QA、状态 QA 和交付映射校验。

## 8. 审计证据

本轮截图位于 `docs/app/assets/figma-qa/phase0/`：

- `01-page-structure.jpeg`：Figma 页面结构。
- `03-foundations-colors.jpeg`：颜色变量板。
- `04-foundations-typography.jpeg`：文字样式板。
- `05-foundations-geometry.jpeg`：间距、圆角和阴影。
- `06-components-overview.jpeg` 至 `18-styles-color-effect.jpeg`：组件、变量与样式盘点。
- `19-reference-final-comparison.png`：客户原始视觉参考与 5 个代表性最终页面同屏对照。
- `20-prototype-flows-empty.jpeg`：空白原型流程页。
- `22-mobile-discovery-default.jpeg`：推荐首页抽检。
- `23-mobile-membership-free.jpeg`：会员目录抽检。
- `24-mobile-message-default.jpeg`：平台话题抽检。
- `25-mobile-me-default.jpeg`：我的页面抽检。
- `26-mobile-login-default.jpeg`：登录页面抽检。

Phase 1 证据：

- `assets/figma-qa/phase1-variables-20260730.jpeg`：5 个变量集合、数量和语义别名。
- `FIGMA_DESIGN_SYSTEM_PHASE1.md`：变量、代码映射、文字、效果和结构校验记录。

Phase 2 证据：

- `assets/figma-qa/phase2/01-page-structure.jpeg`：正式交付页和 Delivery Index 全景。
- `assets/figma-qa/phase2/02-delivery-index-overview.jpeg`：Delivery Index 顶部与模块结构。
- `assets/figma-qa/phase2/03-delivery-index-detail.jpeg`：Page ID 行、路由、状态数和设计状态排版。
- `assets/figma-qa/phase2/04-design-principles.jpeg`：命名、Spec Card 和标注边界。
- `FIGMA_FILE_STRUCTURE_PHASE2.md`：21 页结构、92 Page ID 和原型目标校验记录。

## 9. 决策门禁

进入 Phase 1 前需要确认的 5 项决策已由用户批准：

1. 按本文范围完成移动端 49 页、后台 43 页和 349 个需求状态的最终 UI。
2. 保留现有粉白/奶油/深可可品牌方向和主操作渐变。
3. 统一采用 Noto Sans SC 与 Tabler Icons。
4. 现有 Figma 历史画板保留为归档，新的最终页按稳定 Page ID 重构。
5. 先完成 Design System 和 P0 高风险流程，再分批完成全部页面；每批均执行视觉与交互 QA。

当前已按批准范围完成 Phase 1 和 Phase 2；历史业务画板已无损归档，尚未批量迁移到新的正式页面。后续仍按阶段门禁和 QA 逐批推进。
