# MeiGallery App 1.0 逐页产品与交互设计

App 版本：1.0

文档状态：需求讨论中

更新时间：2026-07-28

## 1. 文档目标

本文把 App 1.0 的产品范围落实到可独立评审的页面级设计对象，覆盖移动端 49 页与管理后台 43 页，共 92 页。每个 Page ID 都有唯一设计路由、页面目标、入口、主操作、次要操作、必备状态、下一页面、不可变规则、需求追踪键和页面级验收标准。92 页代表完整需求覆盖，不代表全部页面同时进入首批开发。

[打开 92 页逐页交互设计库](./interactive-prototype/pages.html)

[查看 92 页详细功能与 146 张原型说明](./APP_DETAILED_FUNCTION_PROTOTYPE_SPEC.md)

[查看产品需求、发布范围、Feature PRD 与 Page ID 追踪矩阵](./APP_REQUIREMENTS_TRACEABILITY.md)

[查看研发、测试与任务拆分使用的 App 1.0 开发需求规格](./MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md)

逐页设计库支持：

- 按移动端或管理后台筛选页面，或按 Page ID、名称、路由搜索。
- 通过 URL 查询参数直接打开任意页面，例如 `pages.html?page=APP-DSC-07`。
- 切换正常、空、错误、受限、过期、冲突等页面状态。
- 操作页面内主按钮、标签、筛选、开关、前后页和关键跨页入口。
- 在右侧同步查看页面目标、入口、路由、主次操作、状态、不可变规则和验收条件。

当前原型交付包含 92 张默认状态原型，以及 54 个 P0 页面的关键异常、受限、冲突或处理中状态原型，共 146 张。页面优先级为 P0 54 页、P1 31 页、P2 7 页。

本文、[需求追踪矩阵](./APP_REQUIREMENTS_TRACEABILITY.md)、[移动端页面与交互规格](./MOBILE_APP_INTERACTION_SPEC.md)、[管理后台页面与交互规格](./ADMIN_CONSOLE_INTERACTION_SPEC.md) 与逐页设计库共同构成页面设计基线；研发统一从 [App 1.0 开发需求规格](./MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md) 进入。出现冲突时，客户 DOCX 的已确认结论决定产品边界，产品总需求和发布范围决定功能边界，Feature PRD 决定模块规则，页面规格决定详细交互，服务端契约决定最终业务事实。

## 2. 页面级设计记录标准

每个页面必须具备以下十类信息：

1. **页面身份**：稳定 Page ID、设计路由、页面名称和所属平台。
2. **页面目标**：用户或管理员在该页面要完成的单一主要任务。
3. **进入方式**：上游页面、深链、系统守卫或后台任务入口。
4. **信息结构**：标题、事实说明、主体内容、主操作、次要操作和安全说明。
5. **主操作**：页面只突出一个主动作；危险动作必须独立确认。
6. **次要操作**：不抢占主动作层级，且不隐藏关键退出或帮助路径。
7. **必备状态**：除正常态外，覆盖与该页面相关的空、加载、错误、受限、过期、冲突和不可用状态。
8. **出口与返回**：成功后的下一页面、失败后的安全下一步、返回栈和深链失效回退。
9. **需求追踪**：明确对应的产品总需求编号、发布范围编号和 Feature PRD。
10. **验收**：入口、状态、权限、文案、反馈、返回和 App 1.0 范围均可验证。

## 3. 全局交互规则

### 3.1 移动端

- 一级导航固定为“推荐、关注、消息、我的”，四个 Tab 分别保存返回栈与滚动位置。
- 主操作使用粉色实心按钮；次操作使用描边、文字或图标按钮；危险操作使用红色并二次确认。
- 页面切换采用短距离淡入或共享元素过渡，建议 180–260ms；加载骨架不使用强闪烁。
- 所有远端提交先进入进行中状态，成功后提供明确结果，失败后保留用户输入并给出重试或安全返回。
- 服务端权限撤回、会员到期、资料下架或对象失效后，已打开页面必须刷新为安全状态，不能依赖本地旧快照继续操作。
- 观看者昵称与头像仅属于私有账号资料，不得进入真人发现列表。

### 3.2 管理后台

- 采用左侧领域导航、顶部环境与范围、主工作区、详情或审计侧栏的桌面布局。
- 列表页支持筛选、列显示、分页和稳定对象链接；批量操作仅在选中对象后出现。
- 表单明确草稿、提交审核、批准执行三个不同动作；高风险业务必须职责分离。
- 详情页显示对象版本、更新时间、数据新鲜度、操作者权限范围与关联审计。
- 并发冲突不得静默覆盖，必须展示服务器新版本、差异与重新提交入口。
- 所有后台写操作都由服务端重新校验能力、对象范围、强认证和审批状态，并写入审计日志。

### 3.3 不可变产品边界

- 只有管理员认证且发布的真人资料可以进入发现列表。
- 当前平台话题由平台管理员接收和处理；前台持续披露平台运营身份，不伪装真人本人。
- `platform_managed` 资料的用户入口为“发起话题（平台接收）”；只有未来 `person_managed` 资料才能显示“给本人发私信”。
- 只有有效会员可创建和发送平台话题；不需要双方同意，不形成匹配关系，也不承诺回复。
- App 1.0 不展示支付、充值、礼物、头像框、皮肤、媒体消息、系统推送或真人认领入口。
- 金币只展示管理员调整产生的追加式账本；不得直接修改余额、删除历史分录或允许用户转账提现。

## 4. 移动端逐页设计目录（49 页）

表中每个 Page ID 均可直接打开独立页面设计；进入页面后可切换该页全部必备状态并查看完整交互说明。

| Page ID / 独立原型 | 页面 | 页面目标 | 主操作 | 必备状态 |
|---|---|---|---|---|
| [APP-AUTH-01](./interactive-prototype/pages.html?page=APP-AUTH-01) | 启动与会话恢复 | 进入业务前恢复配置、会话和最低版本约束 | 继续进入 | 首次、恢复中、离线、升级、维护 |
| [APP-AUTH-02](./interactive-prototype/pages.html?page=APP-AUTH-02) | 登录 | 让观看者安全登录并明确条款与隐私入口 | 手机号登录 | 正常、输入错误、验证中、频控、账号受限 |
| [APP-AUTH-03](./interactive-prototype/pages.html?page=APP-AUTH-03) | 注册 | 只创建观看者账号，不创建公开真人资料 | 创建观看者账号 | 正常、标识占用、验证码失效、地区不可用 |
| [APP-AUTH-04](./interactive-prototype/pages.html?page=APP-AUTH-04) | 风险验证 | 在敏感操作前完成二次验证并解释原因 | 完成验证 | 等待、失败、次数限制 |
| [APP-AUTH-05](./interactive-prototype/pages.html?page=APP-AUTH-05) | 初始偏好 | 收集可跳过的地区和内容偏好 | 保存偏好 | 正常、空目录、保存失败、非个性化说明 |
| [APP-AUTH-06](./interactive-prototype/pages.html?page=APP-AUTH-06) | 条款与隐私文档 | 展示生效版本、更新时间和完整正文 | 返回原页面 | 正常、加载失败、版本更新 |
| [APP-DSC-01](./interactive-prototype/pages.html?page=APP-DSC-01) | 推荐首页 | 按地区、热度和偏好展示合格真人资料 | 查看真人详情 | 正常、首次空、骨架、分页、离线缓存、规则刷新 |
| [APP-DSC-02](./interactive-prototype/pages.html?page=APP-DSC-02) | 地区选择 | 以模糊地区层级控制内容范围 | 应用地区 | 正常、定位未使用、目录更新、无结果 |
| [APP-DSC-03](./interactive-prototype/pages.html?page=APP-DSC-03) | 分类 | 按身份、职业、风格和内容类型浏览 | 进入分类 | 正常、空分类、目录失效 |
| [APP-DSC-04](./interactive-prototype/pages.html?page=APP-DSC-04) | 搜索 | 搜索名字、地区、职业和标签 | 提交搜索 | 初始、输入中、有结果、无结果、历史关闭 |
| [APP-DSC-05](./interactive-prototype/pages.html?page=APP-DSC-05) | 筛选 | 配置基础与会员高级条件并反馈结果数 | 应用筛选 | 正常、权益门槛、目录冲突、无结果 |
| [APP-DSC-06](./interactive-prototype/pages.html?page=APP-DSC-06) | 已保存条件 | 管理常用筛选条件和目录变化 | 使用条件 | 正常、空、额度满、标签已合并 |
| [APP-DSC-07](./interactive-prototype/pages.html?page=APP-DSC-07) | 真人详情 | 呈现授权资料、认证范围和平台维护说明 | 发起话题 | 正常、下架、受限、离线摘要、媒体不可用 |
| [APP-DSC-08](./interactive-prototype/pages.html?page=APP-DSC-08) | 媒体浏览 | 安全浏览已授权图片并支持说明与举报 | 查看下一张 | 正常、凭证刷新、加载失败、内容隐藏 |
| [APP-DSC-09](./interactive-prototype/pages.html?page=APP-DSC-09) | 认证说明 | 解释核验范围、更新时间和失效条件 | 返回真人详情 | 正常、认证失效、资料变化 |
| [APP-INT-01](./interactive-prototype/pages.html?page=APP-INT-01) | 关注更新 | 聚合已关注真人的新公开内容 | 查看更新 | 正常、首次空、无更新、资料下架 |
| [APP-INT-02](./interactive-prototype/pages.html?page=APP-INT-02) | 喜欢 | 保存和撤销用户喜欢过的真人 | 查看真人 | 正常、空、资料不可用 |
| [APP-INT-03](./interactive-prototype/pages.html?page=APP-INT-03) | 收藏夹 | 用文件夹管理收藏的真人资料 | 打开收藏夹 | 正常、空、额度满、离线 |
| [APP-INT-04](./interactive-prototype/pages.html?page=APP-INT-04) | 收藏夹详情 | 查看、移动或移除文件夹内真人 | 查看真人 | 正常、文件夹已删除、资料下架 |
| [APP-INT-05](./interactive-prototype/pages.html?page=APP-INT-05) | 浏览历史 | 按时间查看并清理浏览记录 | 查看历史详情 | 正常、空、保留到期、清除失败 |
| [APP-MSG-01](./interactive-prototype/pages.html?page=APP-MSG-01) | 平台话题列表 | 展示平台代运营话题、未读和限制状态 | 打开话题 | 正常、首次空、离线、会话受限 |
| [APP-MSG-02](./interactive-prototype/pages.html?page=APP-MSG-02) | 发起话题确认 | 创建前披露接收主体、会员资格和额度 | 确认发起话题 | 正常、无会员、额度尽、资料失效、已有会话 |
| [APP-MSG-03](./interactive-prototype/pages.html?page=APP-MSG-03) | 平台会话 | 让有效会员发送文本并持续披露平台运营 | 发送消息 | 正常、补拉、审核中、只读、冻结、关闭 |
| [APP-MSG-04](./interactive-prototype/pages.html?page=APP-MSG-04) | 会话设置 | 管理静音、举报、拉黑和关闭 | 保存会话设置 | 正常、操作失败、已关闭 |
| [APP-MSG-05](./interactive-prototype/pages.html?page=APP-MSG-05) | 通知列表 | 按类别展示站内通知和未读状态 | 打开通知 | 正常、首次空、分页失败、实时离线 |
| [APP-MSG-06](./interactive-prototype/pages.html?page=APP-MSG-06) | 通知详情 | 展示安全正文、事件时间和当前目标状态 | 前往相关页面 | 正常、目标失效、无权限、需要升级 |
| [APP-MBR-01](./interactive-prototype/pages.html?page=APP-MBR-01) | 五级会员目录 | 展示五级会员差异和人工获取方式 | 提交会员申请 | 免费、已提交、处理中、同步失败 |
| [APP-MBR-02](./interactive-prototype/pages.html?page=APP-MBR-02) | 当前权益 | 展示当前等级、有效期和额度事实 | 查看权益说明 | 正常、即将到期、到期、撤销、受限 |
| [APP-MBR-03](./interactive-prototype/pages.html?page=APP-MBR-03) | 会员申请与进度 | 提交申请并查看人工处理状态 | 提交会员申请 | 未申请、已提交、处理中、待补充、已通过、已拒绝 |
| [APP-WAL-01](./interactive-prototype/pages.html?page=APP-WAL-01) | 金币钱包 | 只读展示余额、同步时间和调整规则 | 查看金币明细 | 正常、空钱包、离线缓存、同步失败 |
| [APP-WAL-02](./interactive-prototype/pages.html?page=APP-WAL-02) | 金币明细 | 按方向查看不可覆盖的有效分录 | 查看分录详情 | 正常、首次空、分页、对账维护 |
| [APP-WAL-03](./interactive-prototype/pages.html?page=APP-WAL-03) | 金币分录详情 | 展示数量、原因、业务单号和冲正关系 | 提交申诉 | 正常、分录不可用、冲正中 |
| [APP-SET-01](./interactive-prototype/pages.html?page=APP-SET-01) | 我的 | 汇总私有账号、会员、金币和设置入口 | 查看账号资料 | 正常、账号受限、摘要同步失败 |
| [APP-SET-02](./interactive-prototype/pages.html?page=APP-SET-02) | 账号资料 | 编辑私有昵称头像且不生成真人资料 | 保存账号资料 | 正常、保存失败、需要重新验证 |
| [APP-SET-03](./interactive-prototype/pages.html?page=APP-SET-03) | 设备管理 | 查看设备并远程退出其他会话 | 退出其他设备 | 正常、仅当前设备、撤销失败 |
| [APP-SET-04](./interactive-prototype/pages.html?page=APP-SET-04) | 隐私与推荐 | 管理个性化推荐、历史和可选分析 | 保存隐私设置 | 正常、保存冲突、政策更新 |
| [APP-SET-05](./interactive-prototype/pages.html?page=APP-SET-05) | 站内通知偏好 | 管理可选通知并保留必要通知 | 保存通知偏好 | 正常、同步失败、策略变化 |
| [APP-SET-06](./interactive-prototype/pages.html?page=APP-SET-06) | 拉黑名单 | 查看影响并解除拉黑 | 解除拉黑 | 正常、空、解除失败 |
| [APP-SET-07](./interactive-prototype/pages.html?page=APP-SET-07) | 举报记录 | 查看举报对象、时间和用户可见进度 | 查看举报进度 | 正常、空、状态延迟 |
| [APP-SET-08](./interactive-prototype/pages.html?page=APP-SET-08) | 申诉 | 创建申诉并跟踪独立复核 | 提交申诉 | 正常、已有处理中、提交失败 |
| [APP-SET-09](./interactive-prototype/pages.html?page=APP-SET-09) | 数据导出 | 创建任务并在重新验证后下载 | 创建导出任务 | 正常、处理中、失败、已过期、需要重新验证 |
| [APP-SET-10](./interactive-prototype/pages.html?page=APP-SET-10) | 注销账号 | 解释不可逆影响、阻塞项和取消阶段 | 提交注销申请 | 正常、存在阻塞项、处理中、失败 |
| [APP-SET-11](./interactive-prototype/pages.html?page=APP-SET-11) | 帮助中心 | 搜索常见问题并联系平台 | 打开帮助主题 | 正常、离线、无结果 |
| [APP-SET-12](./interactive-prototype/pages.html?page=APP-SET-12) | 关于与法律 | 展示版本、协议、隐私和开源许可 | 查看法律文档 | 正常、文档不可用 |
| [APP-SYS-01](./interactive-prototype/pages.html?page=APP-SYS-01) | 强制升级 | 版本无法安全支持时阻止继续业务 | 更新 App | 必须升级、商店不可用 |
| [APP-SYS-02](./interactive-prototype/pages.html?page=APP-SYS-02) | 服务维护 | 说明服务暂不可用和缓存时效 | 重新尝试 | 维护中、部分恢复 |
| [APP-SYS-03](./interactive-prototype/pages.html?page=APP-SYS-03) | 账号受限 | 展示限制范围、原因类别和申诉入口 | 查看限制详情 | 部分受限、全部受限 |
| [APP-SYS-04](./interactive-prototype/pages.html?page=APP-SYS-04) | 对象不可用 | 对象失效时提供安全返回 | 返回推荐 | 已下架、无权限、已删除 |
| [APP-SYS-05](./interactive-prototype/pages.html?page=APP-SYS-05) | 地区不可用 | 说明当前地区未开放并停止业务入口 | 查看地区说明 | 未开放、政策变化 |

## 5. 管理后台逐页设计目录（43 页）

| Page ID / 独立原型 | 页面 | 页面目标 | 主操作 | 必备状态 |
|---|---|---|---|---|
| [ADM-OV-01](./interactive-prototype/pages.html?page=ADM-OV-01) | 运营总览 | 汇总供给、发现、消息、会员、钱包、安全和健康 | 进入专题 | 正常、数据延迟、质量异常、部分无权限 |
| [ADM-OV-02](./interactive-prototype/pages.html?page=ADM-OV-02) | 异常中心 | 集中处理跨领域异常、优先级和责任人 | 认领异常 | 正常、P0/P1、未分配、已缓解 |
| [ADM-OV-03](./interactive-prototype/pages.html?page=ADM-OV-03) | 异常详情 | 记录影响、时间线、处置和安全开关 | 添加处置记录 | 正常、影响扩大、并发更新、证据不足 |
| [ADM-PER-01](./interactive-prototype/pages.html?page=ADM-PER-01) | 真人列表 | 管理草稿、认证和发布双状态 | 新建真人 | 正常、草稿、待审、已发布、已暂停、争议 |
| [ADM-PER-02](./interactive-prototype/pages.html?page=ADM-PER-02) | 手动新建真人 | 创建带来源、授权、主体和媒体的草稿 | 保存草稿 | 正常、缺少来源、重复候选、媒体失败 |
| [ADM-PER-03](./interactive-prototype/pages.html?page=ADM-PER-03) | 真人工作台 | 分区维护事实、草稿、认证和发布版本 | 发起认证审核 | 正常、认证待审、发布待审、授权过期 |
| [ADM-PER-04](./interactive-prototype/pages.html?page=ADM-PER-04) | 导入任务 | 校验导入包并允许部分失败重试 | 执行导入 | 正常、校验中、部分失败、已暂停、已完成 |
| [ADM-PER-05](./interactive-prototype/pages.html?page=ADM-PER-05) | 认证审核 | 独立检查主体、成年、授权、一致性和媒体权利 | 通过认证 | 正常、证据不足、版本冲突、需要复核 |
| [ADM-PER-06](./interactive-prototype/pages.html?page=ADM-PER-06) | 发布审核 | 预览锁定版本并校验公开资格 | 发布到 App | 正常、未认证、授权失效、投影失败 |
| [ADM-TAX-01](./interactive-prototype/pages.html?page=ADM-TAX-01) | Taxonomy 目录树 | 维护地区、身份、职业、风格和内容目录 | 新建词条 | 正常、草稿目录、生效目录、归档目录 |
| [ADM-TAX-02](./interactive-prototype/pages.html?page=ADM-TAX-02) | 词条详情 | 编辑词条、别名和旧值映射 | 保存词条草稿 | 正常、被引用、合并冲突、版本过期 |
| [ADM-TAX-03](./interactive-prototype/pages.html?page=ADM-TAX-03) | 目录发布 | 校验变更对资料、筛选和客户端的影响 | 提交目录发布 | 正常、未知引用、客户端不兼容、待复核 |
| [ADM-REC-01](./interactive-prototype/pages.html?page=ADM-REC-01) | 推荐规则版本 | 管理候选、排序、热度、灰度和回滚 | 创建规则草稿 | 正常、当前生效、灰度中、已回滚 |
| [ADM-REC-02](./interactive-prototype/pages.html?page=ADM-REC-02) | 推荐规则编辑 | 配置规则且安全过滤不可关闭 | 提交规则审核 | 正常、Schema 错误、触碰安全过滤、并发冲突 |
| [ADM-REC-03](./interactive-prototype/pages.html?page=ADM-REC-03) | 推荐 Dry-run | 以合成场景比较新旧规则结果 | 运行对比 | 正常、样本不足、数据延迟 |
| [ADM-REC-04](./interactive-prototype/pages.html?page=ADM-REC-04) | 运营精选 | 配置精选位置、时间和披露 | 创建排期 | 正常、时间冲突、资料下架 |
| [ADM-MSG-01](./interactive-prototype/pages.html?page=ADM-MSG-01) | 会话队列 | 按组、地区、等待时间和安全状态分配会话 | 领取会话 | 正常、待分配、待平台、待用户、安全审核 |
| [ADM-MSG-02](./interactive-prototype/pages.html?page=ADM-MSG-02) | 会话工作台 | 以固定平台身份回复并支持备注、转派和升级 | 以平台身份回复 | 正常、租约冲突、只读、冻结、关闭 |
| [ADM-MSG-03](./interactive-prototype/pages.html?page=ADM-MSG-03) | 分组与班次 | 配置运营组、班次、容量和自动分配 | 保存分配规则 | 正常、无值班、过载、配置冲突 |
| [ADM-MSG-04](./interactive-prototype/pages.html?page=ADM-MSG-04) | 会话质量与抽检 | 检查身份披露、服务质量和违规文案 | 记录抽检结论 | 正常、无正文授权、披露缺失 |
| [ADM-SAF-01](./interactive-prototype/pages.html?page=ADM-SAF-01) | 安全审核队列 | 分配真人、媒体、会话和消息举报案件 | 领取案件 | 正常、P0、超时、未分配 |
| [ADM-SAF-02](./interactive-prototype/pages.html?page=ADM-SAF-02) | 安全案件详情 | 以最小证据完成处置并联动限制 | 提交处置 | 正常、证据受限、并发冲突、已冻结 |
| [ADM-SAF-03](./interactive-prototype/pages.html?page=ADM-SAF-03) | 申诉队列 | 将申诉分配给独立复核人员 | 分配申诉 | 正常、原审核人隔离、逾期 |
| [ADM-SAF-04](./interactive-prototype/pages.html?page=ADM-SAF-04) | 申诉详情 | 独立复核事实、原处置和新增说明 | 提交复核结论 | 正常、证据不足、需要升级 |
| [ADM-MBR-01](./interactive-prototype/pages.html?page=ADM-MBR-01) | 五级会员目录 | 版本化配置名称、rank 和 entitlement | 新建目录版本 | 正常、草稿、生效、待回滚 |
| [ADM-MBR-02](./interactive-prototype/pages.html?page=ADM-MBR-02) | Entitlement 定义 | 管理稳定能力键、Schema 和客户端兼容 | 新建 Entitlement | 正常、未知客户端、合并冲突 |
| [ADM-MBR-03](./interactive-prototype/pages.html?page=ADM-MBR-03) | 会员申请与发放 | 处理用户申请、搜索账号并查看发放时间线 | 处理会员申请 | 正常、待处理、待补充、已通过、已拒绝、到期 |
| [ADM-MBR-04](./interactive-prototype/pages.html?page=ADM-MBR-04) | 会员发放申请 | 填写等级、有效期、来源和业务原因 | 提交发放申请 | 正常、账号错误、高风险、重复业务单 |
| [ADM-MBR-05](./interactive-prototype/pages.html?page=ADM-MBR-05) | 会员发放复核 | 独立比较前后权益并批准或拒绝 | 批准发放 | 正常、发起人冲突、账号状态已变 |
| [ADM-MBR-06](./interactive-prototype/pages.html?page=ADM-MBR-06) | 旧会员映射 | 对 legacy 证据 Dry-run、复核和迁移 | 执行迁移 | 正常、证据不足、映射冲突 |
| [ADM-WAL-01](./interactive-prototype/pages.html?page=ADM-WAL-01) | 钱包查询 | 按稳定账号查询余额、分录和对账 | 查看钱包 | 正常、账号受限、对账异常 |
| [ADM-WAL-02](./interactive-prototype/pages.html?page=ADM-WAL-02) | 钱包详情 | 展示余额、sequence 和冲正关系 | 新建调币申请 | 正常、余额锁定、Sequence 异常 |
| [ADM-WAL-03](./interactive-prototype/pages.html?page=ADM-WAL-03) | 调币申请 | 填写加扣币、原因、说明、备注和业务单号 | 提交调币申请 | 正常、预计负余额、高风险、重复业务单 |
| [ADM-WAL-04](./interactive-prototype/pages.html?page=ADM-WAL-04) | 调币复核 | 由不同管理员复核变化、阈值和证据 | 批准并入账 | 正常、余额已变化、发起人冲突 |
| [ADM-WAL-05](./interactive-prototype/pages.html?page=ADM-WAL-05) | 批量调币任务 | 校验、复核批量调币并允许重试失败项 | 提交批量复核 | 正常、部分成功、重复项、总额异常 |
| [ADM-WAL-06](./interactive-prototype/pages.html?page=ADM-WAL-06) | 钱包对账差异 | 识别差异并以追加式修复 | 认领差异 | 正常、钱包冻结、差异未解释 |
| [ADM-NTF-01](./interactive-prototype/pages.html?page=ADM-NTF-01) | 通知事件定义 | 查看事件 Schema、必要性和敏感字段策略 | 查看事件版本 | 正常、未登记、已停用 |
| [ADM-NTF-02](./interactive-prototype/pages.html?page=ADM-NTF-02) | 通知模板版本 | 编辑安全文案、变量和地区语言版本 | 提交模板审核 | 正常、变量缺失、地区冲突、语言冲突 |
| [ADM-NTF-03](./interactive-prototype/pages.html?page=ADM-NTF-03) | 通知生成结果 | 查询生成、失败、抑制和防重 | 查看生成详情 | 正常、积压、模板失败、重复抑制 |
| [ADM-AUD-01](./interactive-prototype/pages.html?page=ADM-AUD-01) | 审计查询 | 按动作、对象、操作者、时间和请求链查询 | 执行审计查询 | 正常、范围过大、完整性告警 |
| [ADM-AUD-02](./interactive-prototype/pages.html?page=ADM-AUD-02) | 审计详情 | 展示事件时间线、脱敏差异和审批关系 | 查看关联事件 | 正常、关联缺失、敏感字段受限 |
| [ADM-AUD-03](./interactive-prototype/pages.html?page=ADM-AUD-03) | 审计完整性状态 | 检查 sequence 缺口和高风险无审计 | 运行完整性校验 | 正常、Sequence 缺口、业务无审计 |
| [ADM-AUD-04](./interactive-prototype/pages.html?page=ADM-AUD-04) | 受控导出 | 通过申请、复核和短期凭证导出 | 提交导出申请 | 正常、待批准、已过期、范围变化 |

### 5.1 页面交付优先级

| 层级 | 含义 | 交付门禁 |
|------|------|----------|
| P0 | 限量 Alpha/Beta 的端到端闭环页面 | 未完成不得邀请真实用户 |
| P1 | App 1.0 客户最终验收页面 | 未完成不得确认 App 1.0 业务交付 |
| P2 | Nuxt 管理后台运营增强页面 | 不阻塞移动端 1.0，可独立发布 |

移动端 P0：

`APP-AUTH-01`、`APP-AUTH-02`、`APP-AUTH-03`、`APP-AUTH-06`、`APP-DSC-01`、`APP-DSC-02`、`APP-DSC-04`、`APP-DSC-05`、`APP-DSC-07`、`APP-DSC-08`、`APP-DSC-09`、`APP-INT-01`、`APP-INT-02`、`APP-MSG-01`、`APP-MSG-02`、`APP-MSG-03`、`APP-MSG-04`、`APP-MSG-05`、`APP-MBR-01`、`APP-MBR-02`、`APP-MBR-03`、`APP-WAL-01`、`APP-WAL-02`、`APP-SET-01`、`APP-SET-06`、`APP-SET-07`、`APP-SET-08`、`APP-SET-11`、`APP-SYS-03`、`APP-SYS-04`。

管理后台 P0：

`ADM-PER-01` 至 `ADM-PER-06`、`ADM-MSG-01` 至 `ADM-MSG-04`、`ADM-SAF-01` 至 `ADM-SAF-04`、`ADM-MBR-03` 至 `ADM-MBR-05`、`ADM-WAL-01` 至 `ADM-WAL-04`、`ADM-WAL-06`、`ADM-AUD-01` 至 `ADM-AUD-02`。

其余页面默认属于 P1。`ADM-OV-02`、`ADM-OV-03`、`ADM-REC-03`、`ADM-WAL-05`、`ADM-NTF-03`、`ADM-AUD-03`、`ADM-AUD-04` 属于 P2；审计完整性的最小自动校验与告警属于 P0 后端门禁，但不改变 `ADM-AUD-03` 完整可视化页面的 P2 优先级。

## 6. 重点跨页旅程

### 6.1 观看者发现与互动

`APP-AUTH-01 → APP-AUTH-02 → APP-AUTH-05 → APP-DSC-01 → APP-DSC-07 → APP-INT-01/02/03`

- 登录后只创建观看者账号。
- 推荐只展示认证、发布、授权和安全状态均合格的真人。
- 喜欢、关注和收藏是三个独立的单向互动，不形成匹配。

### 6.2 会员申请、平台话题与代运营

`APP-DSC-07 → APP-MSG-02 → APP-MBR-01 → APP-MBR-03 → ADM-MBR-03/04/05 → APP-MBR-02 → APP-MSG-03 → ADM-MSG-01 → ADM-MSG-02`

- 无会员时先提交并查询会员申请；管理员发放后刷新 entitlement。
- 发起话题前同时校验会员、额度、资料状态和既有会话。
- 前台在确认页、会话列表、会话页和设置页持续披露平台接收主体。
- 后台发送身份固定为平台运营，不提供真人身份切换器。

### 6.3 真人供给与公开

`ADM-PER-01 → ADM-PER-02/04 → ADM-PER-03 → ADM-PER-05 → ADM-PER-06 → APP-DSC-01/07`

- 管理员上传和 MeiGallery 导入都先形成草稿。
- 认证与发布是两个独立状态和审核动作。
- 授权失效、认证撤销或安全暂停必须立即从公开投影撤权。

### 6.4 会员与金币内控

`ADM-MBR-03 → ADM-MBR-04 → ADM-MBR-05 → APP-MBR-02`

`ADM-WAL-01 → ADM-WAL-02 → ADM-WAL-03 → ADM-WAL-04 → APP-WAL-01/02/03`

- 会员和高风险调币采用申请、独立复核、执行、通知和审计链路。
- 金币错误通过新增冲正分录修复，原分录不可编辑或删除。

## 7. 页面状态与反馈规范

| 状态 | 页面行为 |
|---|---|
| 加载 | 使用骨架或局部进行中状态；避免整页无意义遮罩 |
| 首次空 | 解释为什么为空，并给出可执行的首个动作 |
| 搜索无结果 | 保留关键词与筛选，提供清除或调整条件 |
| 网络失败 | 保留本地输入，展示最近事实的时效并允许重试 |
| 权限不足 | 说明缺少的资格或管理员能力，不泄露内部敏感规则 |
| 对象失效 | 停止业务操作，提供推荐页、列表页或帮助页的安全返回 |
| 并发冲突 | 不覆盖服务端新版本，展示差异并要求刷新后重新提交 |
| 成功 | 展示结果、业务单号或当前状态；避免只显示短暂 Toast 而无可追溯结果 |

## 8. 动效与响应式要求

- 移动端设计基准宽度为 390dp，关键点击区域不小于 44dp；支持系统字体放大、深色模式评估和减少动态效果。
- Android 与 iOS 使用同一信息结构和业务状态；系统返回、权限弹窗、键盘、日期选择等保持平台习惯。
- 后台优先适配 1440px 及以上桌面；1180px 以下收起说明侧栏，窄屏仅用于评审，不承诺完整移动后台操作。
- 页面过渡、按钮反馈和状态切换必须尊重 `prefers-reduced-motion`；不得使用持续抖动、强闪烁或误导性在线动画。
- 人物素材必须保持真实图片比例，卡片裁切优先保留面部和上半身，不拉伸、不使用模糊占位冒充正式素材。

## 9. 页面级验收清单

每个 Page ID 在进入开发前必须逐项通过：

1. 独立 URL 能打开正确页面，Page ID、标题和设计路由一致。
2. 页面目标只有一个主任务，主按钮文案是可执行动词。
3. 上游入口、成功出口、失败下一步和返回行为明确。
4. 目录中列出的所有状态均可在原型或测试夹具中复现。
5. 主操作有进行中、成功、失败和防重复提交反馈。
6. 服务端状态变化后不继续展示过期权限、余额、会员或公开资料。
7. 平台代运营、认证范围、会员门槛和金币原因文案与 PRD 一致。
8. App 1.0 不出现未来能力入口、不可执行占位或暗示性促销文案。
9. 移动端可完成键盘、返回、滚动和无障碍操作；后台可完成键盘焦点和高风险确认。
10. 埋点不采集消息正文、认证证据、内部备注或非必要敏感字段。
11. 页面具有唯一需求追踪键，产品需求编号、发布范围编号和 Feature PRD 与 [需求追踪矩阵](./APP_REQUIREMENTS_TRACEABILITY.md) 一致。

## 10. 客户逐页确认方法

建议按下列顺序评审，而不是一次浏览 92 页：

1. 先评审移动端关键闭环：`APP-DSC-01`、`APP-DSC-07`、`APP-MSG-02`、`APP-MSG-03`、`APP-MBR-01`、`APP-WAL-01`。
2. 再评审后台关键闭环：`ADM-PER-05`、`ADM-PER-06`、`ADM-MSG-02`、`ADM-MBR-05`、`ADM-WAL-04`、`ADM-AUD-02`。
3. 对每页确认页面目标、主操作、必备状态、身份披露、需求编号和下一页面。
4. 意见必须引用 Page ID；若改变业务规则，还需引用对应 PRD/SCP 编号。例如“APP-MSG-02 / PRD-FR-050 的无会员状态需调整”，避免只使用截图位置描述。
5. 关键闭环确认后，再按目录评审其余页面和异常状态。

本阶段确认的是产品范围、页面结构、交互规则、状态和视觉方向；人物名称、图片、账号、金额、日期和业务单号均为虚构演示数据，不代表生产内容。
