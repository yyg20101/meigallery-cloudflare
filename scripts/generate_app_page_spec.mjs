#!/usr/bin/env node

/**
 * 从逐页交互目录生成详细功能说明、截图映射清单和捕获计划。
 *
 * 本脚本不启动浏览器，也不写入 App 业务代码。截图由浏览器按照
 * manifest.json 中的 sourceUrl 与 image 字段生成。
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const CATALOG_PATH = path.join(ROOT, 'docs/app/interactive-prototype/page-catalog.js')
const OUTPUT_DIR = path.join(ROOT, 'docs/app/assets/page-prototypes')
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json')
const MARKDOWN_PATH = path.join(ROOT, 'docs/app/APP_DETAILED_FUNCTION_PROTOTYPE_SPEC.md')
const TRACEABILITY_PATH = path.join(ROOT, 'docs/app/APP_REQUIREMENTS_TRACEABILITY.md')
const DEVELOPMENT_MARKDOWN_PATH = path.join(ROOT, 'docs/app/MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md')
const PRODUCT_REQUIREMENTS_PATH = path.join(ROOT, 'docs/app/PRODUCT_REQUIREMENTS.md')
const RELEASE_SCOPE_PATH = path.join(
  ROOT,
  'docs/ways-of-work/plan/real-person-discovery-platform/app-1-0-release-scope/prd.md'
)

const catalogSource = fs.readFileSync(CATALOG_PATH, 'utf8')
const sandbox = { window: {} }
vm.runInNewContext(catalogSource, sandbox, { filename: CATALOG_PATH })

const catalog = sandbox.window.MeiGalleryPageCatalog
if (!catalog || !Array.isArray(catalog.pages)) {
  throw new Error('未能从 page-catalog.js 读取页面目录')
}

const layoutDescriptions = {
  launch: '品牌、会话恢复和系统门槛居中展示，最低版本、维护和离线状态优先于业务入口。',
  auth: '采用单任务认证表单，输入错误就近呈现，观看者身份边界紧邻主操作。',
  challenge: '风险原因、验证目标、验证码输入和重试限制按任务顺序纵向组织。',
  preferences: '按地区、风格和主题分组选择，持续披露偏好用途及跳过后的推荐方式。',
  document: '固定展示文档版本、更新时间、完整正文与返回原入口动作。',
  discover: '推荐范围、搜索、频道和真人卡片构成首屏，认证状态与推荐依据优先展示。',
  selection: '搜索、当前选择、最近使用和完整目录分区组织，并明确不使用精确定位。',
  categories: '分类入口按业务维度分组，空分类和目录失效均保留可恢复路径。',
  search: '搜索输入、历史、建议、结果和无结果解释围绕同一搜索任务组织。',
  filter: '基础筛选、高级权益门槛、预计结果数和应用动作处于同一工作面。',
  saved: '已保存条件、额度、目录变化和管理动作按可恢复性组织。',
  profile: '媒体主视觉、认证事实、单向互动、平台维护披露和资料正文依次展开。',
  media: '媒体画布、页码、说明、缩放和举报动作保持清晰分层。',
  verification: '核验范围、更新时间、失效条件和平台责任边界集中披露。',
  feed: '关注更新按时间组织，不使用匹配、在线或关系暗示。',
  'people-list': '真人列表与移除、筛选或解除动作并列，资料不可用时解释原因。',
  folders: '收藏夹、额度和管理动作按文件夹层级呈现。',
  history: '按时间分组浏览记录，并提供单条清除和全部清除。',
  'chat-list': '平台接收主体、未读、限制状态和话题摘要组成会话列表。',
  confirm: '在创建话题前集中披露会员资格、额度、接收主体和不保证回复。',
  chat: '接收主体固定置顶，消息线程、审核状态和输入区保持清晰分层。',
  settings: '会话披露、静音、举报、拉黑和关闭动作按风险程度组织。',
  notifications: '通知按业务分类和时间排列，必要通知与可选通知有明确差异。',
  'notice-detail': '正文、事件时间、目标当前状态和安全下一步构成单一通知详情。',
  membership: '五级会员、当前状态、精确权益和站内申请入口构成完整会员门槛。',
  benefits: '等级、有效期、当期额度和可用权益以权威事实形式展示。',
  'membership-application': '申请表单、人工处理说明、状态时间线和管理员发放结果形成闭环。',
  wallet: '余额、同步时间、只读规则和明细入口组成钱包首页。',
  ledger: '不可覆盖的有效分录按方向和时间筛选，并保留对账维护说明。',
  'ledger-detail': '方向、数量、原因、业务单号、冲正关系和申诉入口集中展示。',
  me: '账号、会员、金币、帮助和数据权利以私有个人中心信息架构组织。',
  account: '只编辑观看者账号识别信息，并持续说明不会生成公开真人资料。',
  devices: '当前设备、其他设备、最后活动时间和远程退出动作清晰分层。',
  toggles: '设置项包含用途说明、当前状态和保存反馈，必要能力不可被错误关闭。',
  cases: '案件对象、创建时间、用户可见进度和下一步集中呈现。',
  appeal: '申诉原因、说明、证据和独立复核进度围绕单一任务组织。',
  task: '任务范围、状态、过期时间、重新验证和下载动作依次展示。',
  danger: '不可逆影响、阻塞项、重新验证和可取消阶段在危险操作前完整披露。',
  help: '主题搜索、常见问题、服务边界和联系平台入口按问题解决路径组织。',
  about: '版本、协议、隐私政策和开源许可集中展示。',
  system: '单一事实、影响范围和安全下一步居中呈现，不暴露内部风控细节。',
  dashboard: '指标摘要、质量状态和专题入口分层，未知值不显示为零。',
  queue: '筛选、范围、等待时间、状态和列表详情入口保持稳定。',
  incident: '异常事实、影响对象、处置状态和后续动作集中展示。',
  table: '筛选、批量动作、业务表格、分页和审计入口组成标准后台列表。',
  form: '对象事实、表单字段、风险提示、预览和提交动作按任务顺序组织。',
  workbench: '素材、资料编辑、校验结果和发布准备区并列，支持逐步保存。',
  import: '上传、解析、逐项校验、部分成功和失败重试形成批量导入闭环。',
  review: '锁定版本预览与审核检查并列，编辑和批准职责分离。',
  tree: '分类树、词条详情、合并关系和影响范围在同一运营工作区呈现。',
  term: '词条属性、别名、引用范围和变更影响集中展示。',
  release: '规则版本、检查清单、预览差异和发布动作依次呈现。',
  rules: '推荐规则、权重、适用范围和回退条件以可审计配置展示。',
  editor: '配置编辑、即时预览、校验提示和保存发布路径并列。',
  compare: '版本前后差异、影响范围和回滚条件在同一比较视图呈现。',
  calendar: '排期、优先级、冲突和发布窗口以日历与列表结合展示。',
  conversation: '队列、会话正文和最小必要上下文分栏，固定平台发送主体。',
  schedule: '领取、预约回复、超时和交接动作围绕会话运营排期组织。',
  quality: '抽检样本、问题分类、评分和改进动作集中展示。',
  case: '事实证据、原处置、复核分工和结论理由形成完整案件视图。',
  catalog: '会员目录版本、等级 rank、权益差异和发布状态集中展示。',
  definition: '稳定能力键、参数 Schema、兼容范围和影响查询并列。',
  'grant-list': '申请队列、账号事实、处理状态和发放时间线保持可追溯。',
  approval: '申请事实与复核检查并列，前后影响和职责分离始终可见。',
  migration: '证据、映射、Dry-run、冲突和受控执行形成迁移闭环。',
  'wallet-search': '稳定账号搜索、余额、分录和对账状态组成钱包查询入口。',
  'wallet-admin': '余额、sequence、有效分录与冲正关系展示为不可直接编辑的事实。',
  batch: '文件上传、逐项校验、总额复核、部分成功和失败重试形成批量闭环。',
  reconciliation: '余额、sequence 和分录差异并列，修复只采用追加式 forward-fix。',
  event: '事件 Schema、必要性、敏感字段策略和版本状态集中展示。',
  'template-editor': '用户安全文案、变量、地区语言版本和预览在同一编辑面呈现。',
  delivery: '生成、失败、抑制、防重和积压结果以最小必要信息展示。',
  audit: '查询条件、结果、请求链和受控导出入口构成审计检索工作区。',
  'audit-detail': '事件时间线、脱敏差异和申请—批准—执行关系集中展示。',
  integrity: 'sequence 缺口、无审计业务和校验结果按风险程度组织。',
  export: '范围、目的、独立复核、短期凭证和过期状态形成受控导出闭环。'
}

const FIGMA_FILE_KEY = 'LaNSwwGsznwcpV8msj7BQC'
const FIGMA_FILE_SLUG = 'Peachmote-UI-%E5%80%9F%E9%89%B4%E5%AE%A1%E6%9F%A5%E6%9D%BF---MeiGallery'
const FIGMA_PAGE_ID = '9:8'

function figmaPrototypeUrl(frameId) {
  const nodeId = frameId.replace(':', '-')
  return `https://www.figma.com/proto/${FIGMA_FILE_KEY}/${FIGMA_FILE_SLUG}?node-id=${nodeId}&scaling=min-zoom&content-scaling=fixed&starting-point-node-id=${encodeURIComponent(frameId)}&show-proto-sidebar=1&page-id=${encodeURIComponent(FIGMA_PAGE_ID)}`
}

function figmaState({
  state,
  screen,
  frameId,
  image,
  trigger,
  interaction,
  expected,
  authority
}) {
  return {
    state,
    screen,
    frameId,
    image: `figma-final/phase14/${image}`,
    trigger,
    interaction,
    expected,
    authority,
    prototypeUrl: figmaPrototypeUrl(frameId)
  }
}

const detailedFigmaStateSpecs = {
  'APP-MSG-05': [
    figmaState({
      state: '正常',
      screen: 'APP-MSG-05｜通知列表｜Default',
      frameId: '145:52718',
      image: 'phase14-01-noticeDefault.png',
      trigger: '进入通知中心或 HTTP 刷新成功，且当前分类存在可见通知。',
      interaction: '切换“全部/话题/互动/会员金币/安全”分类；点击通知先标记已读，再读取目标当前状态；“全部已读”只提交一次幂等请求。',
      expected: '展示未读数量、分类、时间、摘要和必要通知标识；成功点击进入 APP-MSG-06，列表未读状态以服务端回读为准。',
      authority: 'HTTP 查询结果是列表与未读权威；实时事件只触发失效与重新拉取。'
    }),
    figmaState({
      state: '全部已读',
      screen: 'APP-MSG-05｜通知列表｜Read',
      frameId: '145:52918',
      image: 'phase14-02-noticeRead.png',
      trigger: '用户点击“全部已读”且服务端确认成功。',
      interaction: '按钮进入处理中并防重复提交；成功后清除当前账号的未读标记，多设备差异通过下一次 HTTP 回读收敛。',
      expected: '显示“全部已读”反馈，卡片内容继续保留；失败时恢复按钮并保留原未读状态。',
      authority: '客户端不得仅本地清零；以服务端 unreadCount 和 readAt 为准。'
    }),
    figmaState({
      state: '首次空',
      screen: 'APP-MSG-05｜通知列表｜Empty',
      frameId: '145:53118',
      image: 'phase14-03-noticeEmpty.png',
      trigger: '当前分类查询成功但没有任何可见通知。',
      interaction: '用户可切回“全部”或查看其他分类；不展示虚构通知和占位营销内容。',
      expected: '说明当前分类暂无通知并提供“查看全部通知”安全出口，底部导航仍可用。',
      authority: '空状态来自成功响应的空集合，不与请求失败混淆。'
    }),
    figmaState({
      state: '分页失败',
      screen: 'APP-MSG-05｜通知列表｜Error',
      frameId: '145:53287',
      image: 'phase14-04-noticeError.png',
      trigger: '已有列表可用，但加载下一页或刷新增量失败。',
      interaction: '保留已加载通知和滚动位置；失败区块就近提供“重新加载后续通知”。',
      expected: '用户仍可打开已有通知；重试复用原筛选条件和分页游标，不重复插入项目。',
      authority: '失败页不得覆盖最近一次成功结果；新结果按稳定 notificationId 去重。'
    }),
    figmaState({
      state: '实时离线',
      screen: 'APP-MSG-05｜通知列表｜Offline',
      frameId: '145:53483',
      image: 'phase14-05-noticeOffline.png',
      trigger: '实时连接断开，但最近一次 HTTP 列表仍可展示。',
      interaction: '顶部显示非阻断提示；用户可手动重新连接并对账，仍可打开缓存列表中的通知。',
      expected: '不宣称通知为最新；恢复后先 HTTP 补拉，再恢复实时监听。',
      authority: '缓存只读，未读、目标状态和必要通知均需联网确认。'
    })
  ],
  'APP-MSG-06': [
    figmaState({
      state: '正常',
      screen: 'APP-MSG-06｜通知详情｜Default',
      frameId: '145:53849',
      image: 'phase14-06-detailDefault.png',
      trigger: '通知存在、当前账号可见，且通知目标仍可安全访问。',
      interaction: '展示事件时间、用户安全正文、接收主体说明和目标当前状态；主按钮按目标类型进入对应页面。',
      expected: '进入目标前再次读取当前状态；平台话题通知明确由平台运营接收和处理。',
      authority: '通知历史正文可读，但跳转能力以目标当前状态和当前 entitlement 为准。'
    }),
    figmaState({
      state: '目标失效',
      screen: 'APP-MSG-06｜通知详情｜Unavailable',
      frameId: '145:53999',
      image: 'phase14-07-detailUnavailable.png',
      trigger: '通知仍存在，但关联资料、会话、内容或业务对象已下架、删除或关闭。',
      interaction: '保留用户安全历史说明，不再执行原深链；提供返回通知列表和安全说明。',
      expected: '不显示内部下架原因或访问凭证，不产生循环跳转。',
      authority: '目标当前状态覆盖通知生成时的历史目标状态。'
    }),
    figmaState({
      state: '无权限',
      screen: 'APP-MSG-06｜通知详情｜Forbidden',
      frameId: '145:54144',
      image: 'phase14-08-detailForbidden.png',
      trigger: '账号、会员或对象权限下降，当前用户不再具备目标 entitlement。',
      interaction: '正文仅显示允许保留的历史摘要；主操作改为查看当前权益或返回列表。',
      expected: '不因旧通知恢复过期能力，不把客户端缓存当作授权。',
      authority: '服务端权限校验优先；客户端未知 entitlement 必须安全拒绝。'
    }),
    figmaState({
      state: '需要升级',
      screen: 'APP-MSG-06｜通知详情｜Upgrade',
      frameId: '145:54288',
      image: 'phase14-09-detailUpgrade.png',
      trigger: '通知目标需要当前客户端尚未实现、但服务端已声明最低版本的新能力。',
      interaction: '展示版本能力说明和安全返回；仅在存在可信更新渠道时提供更新入口。',
      expected: '旧版本不渲染未知功能、不崩溃、不扩大权限。',
      authority: '最低客户端版本和能力兼容由服务端配置与 App 版本共同判定。'
    })
  ],
  'APP-WAL-01': [
    figmaState({
      state: '正常',
      screen: 'APP-WAL-01｜金币钱包｜Default',
      frameId: '145:54433',
      image: 'phase14-10-walletDefault.png',
      trigger: '余额投影和最近有效分录同步成功。',
      interaction: '展示余额、最后同步时间、只读规则和最近分录；点击“查看金币明细”进入 APP-WAL-02。',
      expected: '明确金币不具现金价值，页面不存在购买、充值、消费、兑换、转账或提现入口。',
      authority: '余额来自有效分录投影；客户端不得直接修改或自行汇总覆盖。'
    }),
    figmaState({
      state: '空钱包',
      screen: 'APP-WAL-01｜金币钱包｜Empty',
      frameId: '145:54618',
      image: 'phase14-11-walletEmpty.png',
      trigger: '账号余额为 0，且没有任何已生效分录。',
      interaction: '保留规则说明和明细入口，不展示充值或消费引导。',
      expected: '显示“还没有生效分录”，后续管理员调整生效后可正常刷新。',
      authority: '0 是服务端权威结果，不用缺失值或请求失败替代。'
    }),
    figmaState({
      state: '离线缓存',
      screen: 'APP-WAL-01｜金币钱包｜Offline',
      frameId: '145:54793',
      image: 'phase14-12-walletOffline.png',
      trigger: '当前离线，但本地存在最近一次成功同步的钱包快照。',
      interaction: '显示缓存时间和“重新连接并刷新”；允许查看缓存明细，禁止执行任何写操作。',
      expected: '明确“不是当前最新余额”；联网后先刷新权威余额再移除离线提示。',
      authority: '离线快照仅用于只读展示，不能用于授权或业务结算。'
    }),
    figmaState({
      state: '同步失败',
      screen: 'APP-WAL-01｜金币钱包｜SyncFailed',
      frameId: '145:54977',
      image: 'phase14-13-walletFailed.png',
      trigger: '同步请求失败或余额 projection 暂不可用。',
      interaction: '保留最近一次成功余额并标记时间；提供重新同步和查看缓存明细。',
      expected: '不把失败显示成 0，不覆盖缓存，不生成任何补偿分录。',
      authority: '同步失败只影响展示新鲜度，分录与余额仍以服务端为唯一权威。'
    })
  ],
  'APP-WAL-02': [
    figmaState({
      state: '正常',
      screen: 'APP-WAL-02｜金币明细｜Default',
      frameId: '145:55148',
      image: 'phase14-14-ledgerDefault.png',
      trigger: '全部方向的有效分录查询成功。',
      interaction: '按时间倒序展示增加、扣减和冲正关系；点击分录进入 APP-WAL-03，加载更多使用稳定游标。',
      expected: '每项显示方向、数量、原因、时间和安全业务引用；不展示内部备注。',
      authority: '只展示已生效分录；原分录不可修改或删除。'
    }),
    figmaState({
      state: '增加筛选',
      screen: 'APP-WAL-02｜金币明细｜CreditFilter',
      frameId: '145:55320',
      image: 'phase14-15-ledgerCredit.png',
      trigger: '用户选择“增加”。',
      interaction: '重新以 direction=credit 查询并重置分页游标；切换筛选时保留页面结构。',
      expected: '只显示增加、补偿或冲正增加等已生效分录，筛选结果为空时进入对应空状态。',
      authority: '筛选由服务端执行，客户端不得隐藏不理解的分录后自行计算余额。'
    }),
    figmaState({
      state: '扣减筛选',
      screen: 'APP-WAL-02｜金币明细｜DebitFilter',
      frameId: '145:55483',
      image: 'phase14-16-ledgerDebit.png',
      trigger: '用户选择“扣减”。',
      interaction: '重新以 direction=debit 查询并重置分页游标；负向数量使用一致视觉语义。',
      expected: '只显示管理员扣减、冲正扣减等已生效分录，不出现用户消费记录。',
      authority: 'App 1.0 没有消费能力；扣减只能来自管理员受控调整或冲正。'
    }),
    figmaState({
      state: '首次空',
      screen: 'APP-WAL-02｜金币明细｜Empty',
      frameId: '145:55637',
      image: 'phase14-17-ledgerEmpty.png',
      trigger: '当前筛选查询成功但没有已生效分录。',
      interaction: '显示筛选相关空状态；允许切回全部或查看金币规则。',
      expected: '不生成示例分录，不把待审批调整显示为已生效。',
      authority: '空集合来自服务端成功响应。'
    }),
    figmaState({
      state: '分页加载',
      screen: 'APP-WAL-02｜金币明细｜Loading',
      frameId: '145:55785',
      image: 'phase14-18-ledgerLoading.png',
      trigger: '用户点击加载更多且仍有 nextCursor。',
      interaction: '按钮进入加载状态并防重复请求；成功后按 entryId 去重追加，失败保留已有分录。',
      expected: '不打乱已加载顺序；nextCursor 为空时不再展示加载入口。',
      authority: '分页游标由服务端签发，客户端不按本地页码推算。'
    }),
    figmaState({
      state: '对账维护',
      screen: 'APP-WAL-02｜金币明细｜Maintenance',
      frameId: '145:55962',
      image: 'phase14-19-ledgerMaintenance.png',
      trigger: '钱包正在对账或投影存在可恢复延迟。',
      interaction: '保留已验证历史，冻结最新余额摘要并提供刷新状态和帮助入口。',
      expected: '不删除或改写历史分录；维护完成后整体回读权威余额和游标。',
      authority: '对账修复只允许追加 forward-fix/冲正分录，不直接覆盖余额。'
    })
  ],
  'APP-WAL-03': [
    figmaState({
      state: '正常',
      screen: 'APP-WAL-03｜分录详情｜Default',
      frameId: '145:56138',
      image: 'phase14-20-entryDefault.png',
      trigger: '分录存在、已生效且当前账号可见。',
      interaction: '展示方向、数量、原因、发生时间、业务单号、执行结果和冲正关系；可复制业务单号或进入独立申诉。',
      expected: '原分录明确不可编辑删除；申诉只创建案件，不改变余额。',
      authority: '分录事实、状态和冲正关系由服务端返回。'
    }),
    figmaState({
      state: '业务单号已复制',
      screen: 'APP-WAL-03｜分录详情｜Copied',
      frameId: '145:56296',
      image: 'phase14-21-entryCopied.png',
      trigger: '用户点击“复制业务单号”。',
      interaction: '仅复制对用户安全的业务引用并展示短暂成功反馈；不复制内部审计 ID 或敏感备注。',
      expected: '重复点击保持幂等，不改变分录状态。',
      authority: '可复制字段由服务端 DTO 明确提供。'
    }),
    figmaState({
      state: '分录不可用',
      screen: 'APP-WAL-03｜分录详情｜Unavailable',
      frameId: '145:56461',
      image: 'phase14-22-entryUnavailable.png',
      trigger: '分录不存在、已超出可见范围或引用失效。',
      interaction: '不显示缓存详情；提供返回金币明细和帮助入口。',
      expected: '不泄露其他账号分录是否存在，不把不可用解释为余额为 0。',
      authority: '服务端对象级授权和返回状态优先。'
    }),
    figmaState({
      state: '冲正中',
      screen: 'APP-WAL-03｜分录详情｜Reversing',
      frameId: '145:56598',
      image: 'phase14-23-entryReversing.png',
      trigger: '原分录已关联待执行或已执行的冲正流程。',
      interaction: '展示冲正状态与关联引用；允许查看冲正进度，但原分录继续保留。',
      expected: '冲正完成后追加反向分录并刷新关系，不修改或删除原记录。',
      authority: '冲正由申请—复核—执行状态机驱动，客户端只读。'
    })
  ]
}

const featureSources = {
  account: {
    feature: 'F-01',
    title: '观看者注册、登录与设备安全',
    requirementGroup: 'ACC-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/account-access-and-device-management/prd.md'
  },
  discovery: {
    feature: 'F-02–F-05',
    title: '真人发现、搜索与资料浏览',
    requirementGroup: 'DSP-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/person-discovery-and-profile-experience/prd.md'
  },
  source: {
    feature: 'A-01–A-02',
    title: '真人来源、上传与 MeiGallery 导入',
    requirementGroup: 'SRC-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/person-source-upload-and-meigallery-import/prd.md'
  },
  verification: {
    feature: 'A-03',
    title: '真人认证与发布审核',
    requirementGroup: 'VER-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/person-verification-and-publication/prd.md'
  },
  interaction: {
    feature: 'F-06',
    title: '喜欢、关注、收藏与浏览历史',
    requirementGroup: 'VIR-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/viewer-interactions-and-history/prd.md'
  },
  messaging: {
    feature: 'F-07、A-06',
    title: '会员平台话题、实时会话与运营工作台',
    requirementGroup: 'MOP-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/member-messaging-and-managed-operations/prd.md'
  },
  membership: {
    feature: 'F-09、A-08',
    title: '心享会员、Entitlement 与管理员手动发放',
    requirementGroup: 'MBR-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/membership-entitlements-and-manual-grants/prd.md'
  },
  wallet: {
    feature: 'F-10、A-10',
    title: '金币钱包与管理员调币',
    requirementGroup: 'WAL-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/wallet-ledger-and-admin-coin-adjustments/prd.md'
  },
  notification: {
    feature: 'F-12',
    title: '站内通知中心与通知偏好',
    requirementGroup: 'NTF-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/in-app-notification-center/prd.md'
  },
  privacy: {
    feature: 'F-13',
    title: '我的、隐私设置与数据权利',
    requirementGroup: 'PDR-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/privacy-settings-and-data-rights/prd.md'
  },
  taxonomy: {
    feature: 'A-04',
    title: '标签、地区与分类目录管理',
    requirementGroup: 'TAX-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/taxonomy-region-and-category-management/prd.md'
  },
  recommendation: {
    feature: 'A-05',
    title: '推荐位、排序规则与热度运营',
    requirementGroup: 'ROP-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/recommendation-and-popularity-operations/prd.md'
  },
  safety: {
    feature: 'A-07',
    title: '举报、拉黑与安全审核',
    requirementGroup: 'MOD-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/report-blocking-and-moderation/prd.md'
  },
  operations: {
    feature: 'A-13',
    title: '运营看板、审计日志与异常追踪',
    requirementGroup: 'OAU-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/operations-dashboard-and-audit-log/prd.md'
  },
  release: {
    feature: 'App 1.0 范围',
    title: '发布范围与能力启用策略',
    requirementGroup: 'SCP-FR-*',
    document: '../ways-of-work/plan/real-person-discovery-platform/app-1-0-release-scope/prd.md'
  }
}

function ids(prefix, values) {
  return values.map(value => `${prefix}-${value}`)
}

function requirementTraceFor(page) {
  const id = page.id
  let product = []
  let release = []
  let nonFunctional = []
  let acceptance = []
  let features = []

  if (id.startsWith('APP-AUTH')) {
    product = ids('PRD-FR', ['001', '002', '003', '004'])
    release = ids('SCP-FR', ['001', '013'])
    nonFunctional = ids('PRD-NFR', ['001', '005', '006', '007'])
    acceptance = ids('PRD-AC', ['001', '010'])
    features = [featureSources.account]
  } else if (id.startsWith('APP-DSC')) {
    const profilePage = ['APP-DSC-07', 'APP-DSC-08', 'APP-DSC-09'].includes(id)
    product = profilePage
      ? ids('PRD-FR', ['030', '031', '032'])
      : ids('PRD-FR', ['020', '021', '022', '023'])
    release = ids('SCP-FR', ['002', '003'])
    nonFunctional = ids('PRD-NFR', ['001', '004', '005', '006', '007'])
    acceptance = ids('PRD-AC', ['002', '010'])
    features = [featureSources.discovery]
    if (['APP-DSC-02', 'APP-DSC-03', 'APP-DSC-04', 'APP-DSC-05', 'APP-DSC-06'].includes(id)) {
      features.push(featureSources.taxonomy)
    }
    if (id === 'APP-DSC-01') features.push(featureSources.recommendation)
    if (id === 'APP-DSC-09') features.push(featureSources.verification)
  } else if (id.startsWith('APP-INT')) {
    product = ids('PRD-FR', ['040', '041', '042'])
    release = ids('SCP-FR', ['003'])
    nonFunctional = ids('PRD-NFR', ['001', '005', '006', '007'])
    acceptance = ids('PRD-AC', ['003'])
    features = [featureSources.interaction]
  } else if (id.startsWith('APP-MSG')) {
    const notificationPage = ['APP-MSG-05', 'APP-MSG-06'].includes(id)
    product = notificationPage
      ? ids('PRD-FR', ['080', '081'])
      : ids('PRD-FR', ['050', '051', '052', '053', '054', '055', '056'])
    release = notificationPage
      ? ids('SCP-FR', ['009'])
      : ids('SCP-FR', ['005', '006', '007', '008', '015'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '003', '005', '006', '007', '008'])
    acceptance = notificationPage
      ? ids('PRD-AC', ['010'])
      : ids('PRD-AC', ['004', '005', '011'])
    features = [notificationPage ? featureSources.notification : featureSources.messaging]
  } else if (id.startsWith('APP-MBR')) {
    product = ids('PRD-FR', ['060', '061', '062', '063', '064', '065', '066'])
    release = ids('SCP-FR', ['004', '005', '005A', '005B'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '004', '005', '006', '007'])
    acceptance = ids('PRD-AC', ['004', '007', '009', '011'])
    features = [featureSources.membership]
  } else if (id.startsWith('APP-WAL')) {
    product = ids('PRD-FR', ['070', '071', '074'])
    release = ids('SCP-FR', ['010', '011'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '005', '006', '007'])
    acceptance = ids('PRD-AC', ['006'])
    features = [featureSources.wallet]
  } else if (id.startsWith('APP-SET')) {
    product = ids('PRD-FR', ['080', '081', '082'])
    release = ids('SCP-FR', ['013'])
    nonFunctional = ids('PRD-NFR', ['001', '005', '006', '007'])
    acceptance = ids('PRD-AC', ['001', '010'])
    features = [featureSources.privacy]
    if (['APP-SET-02', 'APP-SET-03'].includes(id)) {
      product.push(...ids('PRD-FR', ['001', '002']))
      features.push(featureSources.account)
    }
    if (['APP-SET-06', 'APP-SET-07', 'APP-SET-08'].includes(id)) {
      features.push(featureSources.safety)
    }
  } else if (id.startsWith('APP-SYS')) {
    const mapping = {
      'APP-SYS-01': ids('PRD-FR', ['080']),
      'APP-SYS-02': ids('PRD-FR', ['080']),
      'APP-SYS-03': ids('PRD-FR', ['001', '002', '082']),
      'APP-SYS-04': ids('PRD-FR', ['013', '032']),
      'APP-SYS-05': ids('PRD-FR', ['020', '022'])
    }
    product = mapping[id]
    release = ids('SCP-FR', ['031', '032', '033'])
    nonFunctional = ids('PRD-NFR', ['001', '004', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['009', '010'])
    features = [featureSources.release]
  } else if (id.startsWith('ADM-OV')) {
    product = ids('PRD-FR', ['090', '091', '092'])
    release = ids('SCP-FR', ['012', '014', '015'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '003', '004', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['010'])
    features = [featureSources.operations]
  } else if (id.startsWith('ADM-PER')) {
    product = ids('PRD-FR', ['010', '011', '012', '013', '090', '091', '092'])
    release = ids('SCP-FR', ['012', '014'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '003', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['001', '002', '010'])
    features = ['ADM-PER-05', 'ADM-PER-06'].includes(id)
      ? [featureSources.verification]
      : [featureSources.source]
  } else if (id.startsWith('ADM-TAX')) {
    product = ids('PRD-FR', ['020', '021', '022', '023', '090', '091', '092'])
    release = ids('SCP-FR', ['012', '030'])
    nonFunctional = ids('PRD-NFR', ['001', '003', '004', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['002', '009', '010'])
    features = [featureSources.taxonomy]
  } else if (id.startsWith('ADM-REC')) {
    product = ids('PRD-FR', ['020', '021', '022', '023', '090', '091', '092'])
    release = ids('SCP-FR', ['012', '030'])
    nonFunctional = ids('PRD-NFR', ['001', '003', '004', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['002', '010'])
    features = [featureSources.recommendation]
  } else if (id.startsWith('ADM-MSG')) {
    product = ids('PRD-FR', ['050', '051', '052', '053', '054', '055', '056', '090', '091', '092'])
    release = ids('SCP-FR', ['007', '008', '012', '015'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '003', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['004', '005', '010', '011'])
    features = [featureSources.messaging]
  } else if (id.startsWith('ADM-SAF')) {
    product = ids('PRD-FR', ['032', '080', '081', '082', '090', '091', '092'])
    release = ids('SCP-FR', ['012', '015'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '003', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['002', '005', '010'])
    features = [featureSources.safety]
  } else if (id.startsWith('ADM-MBR')) {
    product = ids('PRD-FR', ['060', '061', '062', '063', '064', '065', '066', '090', '091', '092'])
    release = ids('SCP-FR', ['004', '005', '005B', '012', '030'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '003', '004', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['007', '009', '011'])
    features = [featureSources.membership]
  } else if (id.startsWith('ADM-WAL')) {
    product = ids('PRD-FR', ['070', '071', '074', '090', '091', '092'])
    release = ids('SCP-FR', ['010', '012'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '003', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['006', '010'])
    features = [featureSources.wallet]
  } else if (id.startsWith('ADM-NTF')) {
    product = ids('PRD-FR', ['080', '081', '090', '091', '092'])
    release = ids('SCP-FR', ['009', '012'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '003', '004', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['010'])
    features = [featureSources.notification]
  } else if (id.startsWith('ADM-AUD')) {
    product = ids('PRD-FR', ['090', '091', '092'])
    release = ids('SCP-FR', ['012'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '003', '004', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['006', '010'])
    features = [featureSources.operations]
  }

  const unique = values => [...new Set(values)]
  product = unique(product)
  release = unique(release)
  nonFunctional = unique(nonFunctional)
  acceptance = unique(acceptance)
  features = [...new Map(features.map(feature => [feature.feature, feature])).values()]
  if (!product.length || !release.length || !features.length) {
    throw new Error(`${id} 缺少需求追踪映射`)
  }

  const featureGroups = features.map(feature => `${feature.feature}/${feature.requirementGroup}`)
  return {
    product,
    release,
    nonFunctional,
    acceptance,
    features,
    traceKey: `${id} → ${product.join(',')} → ${release.join(',')} → ${featureGroups.join(',')}`
  }
}

function groupFor(page) {
  return catalog.groups.find(group => {
    const prefixes = [group.prefix, ...(group.extraPrefixes || [])]
    return group.platform === page.platform && prefixes.some(prefix => page.id.startsWith(prefix))
  })
}

function rolesFor(page) {
  if (['APP-MSG-05', 'APP-MSG-06'].includes(page.id)) {
    return '已登录观看者、会员、受限账号（按服务端可见范围）'
  }
  const mappings = [
    ['APP-AUTH', '游客、观看者'],
    ['APP-DSC', '观看者'],
    ['APP-INT', '已登录观看者'],
    ['APP-MSG', '有效会员、受限状态下的已登录观看者'],
    ['APP-MBR', '已登录观看者、会员'],
    ['APP-WAL', '已登录观看者'],
    ['APP-SET', '已登录观看者'],
    ['APP-SYS', '游客、观看者、会员'],
    ['ADM-OV', 'Owner、运营主管、安全主管'],
    ['ADM-PER', '内容编辑、合规审核、发布者、Owner'],
    ['ADM-TAX', '内容运营、标签管理员、推荐运营'],
    ['ADM-REC', '推荐运营、数据分析、Owner'],
    ['ADM-MSG', '话题运营、运营主管、质检人员'],
    ['ADM-SAF', '安全专员、独立申诉复核人、Owner'],
    ['ADM-MBR', '会员运营、独立复核人、Owner'],
    ['ADM-WAL', '财务运营、独立复核人、Owner'],
    ['ADM-NTF', '通知运营、模板审核人、Owner'],
    ['ADM-AUD', '审计员、Owner']
  ]
  return mappings.find(([prefix]) => page.id.startsWith(prefix))?.[1] || '具备对应 capability 和对象范围的管理员'
}

function preconditionsFor(page) {
  if (['APP-MSG-05', 'APP-MSG-06'].includes(page.id)) {
    return '用户已登录；通知可见范围、必要性、已读状态和目标当前状态均由服务端确认。'
  }
  if (page.id.startsWith('APP-AUTH')) return '客户端已取得远程配置；涉及账号写操作时必须通过服务端验证、频控和风险校验。'
  if (page.id.startsWith('APP-DSC')) return '推荐目录可用；真人资料必须处于认证有效、授权有效、已发布且未被安全隐藏状态。'
  if (page.id.startsWith('APP-INT')) return '用户已登录；目标真人资料仍可访问；操作额度和对象状态由服务端重新校验。'
  if (page.id.startsWith('APP-MSG')) return '用户已登录；发送或新建话题时具有有效会员资格；目标资料与会话未被冻结或关闭。'
  if (page.id.startsWith('APP-MBR')) return '用户已登录；会员目录版本可用；申请结果不直接产生权限，必须等待管理员 grant 生效。'
  if (page.id.startsWith('APP-WAL')) return '用户已登录；余额与明细来自服务端有效分录投影，离线缓存只用于只读展示。'
  if (page.id.startsWith('APP-SET')) return '用户已登录；敏感操作需重新验证；账号限制和数据权利状态以服务端为准。'
  if (page.id.startsWith('APP-SYS')) return '客户端已取得或尝试取得远程配置、会话和业务状态；缓存不得冒充最新事实。'
  return '管理员已登录，并同时满足角色 capability、对象范围、数据版本和必要的独立复核条件。'
}

function ruleFor(page) {
  if (['APP-MSG-05', 'APP-MSG-06'].includes(page.id)) {
    return 'HTTP 查询是通知权威，实时事件只触发刷新；账号、安全、会员、金币和数据权利等必要通知不可被营销开关屏蔽。'
  }
  if (page.id.startsWith('APP-AUTH')) return '注册和登录只处理观看者账号，不创建公开真人资料。'
  if (page.id.startsWith('APP-DSC')) return '只展示认证有效、已发布、授权有效且未被安全隐藏的真人资料。'
  if (page.id.startsWith('APP-INT')) return '喜欢、关注和收藏互相独立，不产生匹配、通知对方或双向关系。'
  if (page.id.startsWith('APP-MSG')) return '话题由平台管理员接收与处理；只有有效会员可以新建和发送。'
  if (page.id.startsWith('APP-MBR')) return 'App 1.0 不提供在线支付；提交申请不产生权限，管理员 grant 生效后才获得会员权益。'
  if (page.id.startsWith('APP-WAL')) return '金币不具现金价值；客户端只读余额和有效分录，不出现购买、充值、消费、兑换、转账或提现。'
  if (page.id.startsWith('APP-SET')) return '账号设置不改变公开真人资料；敏感操作需要服务端重新验证。'
  if (page.id.startsWith('APP-SYS')) return '缓存不能冒充最新事实；必须提供可理解原因和安全返回路径。'
  if (page.id.startsWith('ADM-MSG')) return '管理员只能以固定平台运营身份发送，正文读取按租约和对象范围控制。'
  if (page.id.startsWith('ADM-WAL')) return '余额只允许通过追加分录变化；高风险申请必须由不同管理员复核。'
  if (page.id.startsWith('ADM-MBR')) return '等级名称配置化，权限使用 rank 与稳定 entitlement key，不硬编码会员名称。'
  if (page.id.startsWith('ADM-PER')) return '只有管理员创建或导入真人资料；认证、授权、审核和发布状态必须可追溯。'
  return '后台写操作必须经过 capability、对象范围、版本检查和不可删除审计。'
}

function dataPermissionFor(page) {
  if (page.platform === 'mobile') {
    if (['APP-MSG-05', 'APP-MSG-06'].includes(page.id)) {
      return '只读取当前账号可见的用户安全通知；摘要不得包含完整话题正文、内部备注、证件、访问凭证或其他敏感数据。'
    }
    if (page.id.startsWith('APP-MSG')) return '读取当前账号可见的话题摘要或会话；发送动作由服务端校验会员、会话状态、额度和内容安全策略。'
    if (page.id.startsWith('APP-WAL')) return '只读取余额与有效分录；客户端不得直接修改余额，申诉只创建独立案件。'
    if (page.id.startsWith('APP-MBR')) return '读取会员目录、当前 grant 与申请状态；申请写入不等同于权限生效。'
    if (page.id.startsWith('APP-DSC')) return '只读取公开投影和经授权媒体凭证；受保护媒体凭证由服务端短期签发。'
    return '只读取当前账号范围内的必要数据；所有写操作均由服务端鉴权、校验并返回权威状态。'
  }
  if (page.id.startsWith('ADM-AUD')) return '仅允许具备审计 capability 的管理员按授权范围读取脱敏事件；导出必须申请、复核、短期授权并记录审计。'
  if (page.id.startsWith('ADM-WAL') || page.id.startsWith('ADM-MBR')) return '高风险写操作采用申请—独立复核—执行状态机；申请人不得复核本人操作，所有阶段写入审计。'
  if (page.id.startsWith('ADM-MSG')) return '正文访问受领取租约、对象范围和最小必要原则限制；发送身份固定为平台运营。'
  return '管理员 API 与公开 API 分离；读取和写入同时校验 capability、对象范围、版本与审计要求。'
}

function interactionFor(page) {
  const overrides = {
    'APP-MSG-05': '用户从推荐页铃铛或消息页通知入口进入。首次进入、切换分类和回到前台均以 HTTP 拉取权威列表；实时事件只触发重新拉取。点击通知先提交幂等已读，再读取目标当前状态并进入 APP-MSG-06；“全部已读”成功后必须服务端回读，多设备差异不得仅靠本地清零。分页失败保留已有列表，实时离线保留缓存并提示新鲜度。',
    'APP-MSG-06': '用户从通知列表进入。页面展示事件时间、用户安全正文、目标当前状态和当前可执行动作；点击主操作前重新校验目标、账号和 entitlement。目标失效时保留安全历史说明并返回列表；无权限时进入当前权益或安全出口；未知能力需要升级时不渲染不可执行入口。',
    'APP-WAL-01': '用户从“我的金币卡”进入。页面先读取权威余额投影和最近有效分录，再展示同步时间与只读规则；点击“查看金币明细”进入 APP-WAL-02。离线时只展示带时间戳缓存，同步失败不把余额改成 0，也不生成补偿分录；页面始终不出现充值、消费、转账、兑换或提现入口。',
    'APP-WAL-02': '用户从钱包页进入。默认按时间倒序读取有效分录，可切换全部、增加和扣减筛选；切换筛选会重置服务端游标，加载更多复用 nextCursor 并按 entryId 去重。分页失败或维护状态保留已验证历史，不修改、隐藏或重新计算原分录。',
    'APP-WAL-03': '用户从金币明细进入。页面展示方向、数量、原因、时间、安全业务单号、执行结果和冲正关系；复制只包含用户安全业务引用。提交申诉只创建独立案件并进入 APP-SET-08，不直接改余额；冲正通过新分录表达，原分录始终保留且不可编辑删除。'
  }
  if (overrides[page.id]) return overrides[page.id]
  const secondary = page.secondary.length ? page.secondary.join('、') : '返回上一页'
  const next = catalog.pages.find(item => item.id === page.next)
  return `用户从“${page.entry}”进入。主要操作为“${page.primary}”，执行时显示处理中状态；服务端确认成功后刷新权威数据${next ? `并可进入 ${next.id}「${next.name}」` : ''}。次要操作包括：${secondary}。失败时保留已输入内容，展示可理解原因，并提供重试、返回或帮助入口。`
}

function chooseKeyState(page) {
  if (page.priority !== 'P0') return null
  const candidates = page.states.slice(1)
  if (!candidates.length) return page.states[0]
  const patterns = [
    { score: 500, pattern: /无权限|无会员|受限|冻结|冲突|限制|门槛|锁定|已有处理中|争议|隔离|负余额/ },
    { score: 470, pattern: /同步失败/ },
    { score: 400, pattern: /失败|错误|异常|不可用|不足|失效|拒绝|无结果|离线|超时/ },
    { score: 300, pattern: /到期|下架|额度尽|维护|升级|过期|撤销|关闭|只读|安全审核/ },
    { score: 200, pattern: /处理中|审核中|待补充|待生效|恢复中|刷新|延迟/ }
  ]
  return candidates
    .map((state, index) => ({
      state,
      index,
      score: patterns.find(item => item.pattern.test(state))?.score || 100
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)[0].state
}

function acceptanceFor(page) {
  return [
    `从“${page.entry}”能够进入，页面明确显示 ${page.id}、页面名称、设计路由和返回路径。`,
    `主要操作“${page.primary}”具有处理中、成功和失败反馈，重复提交不会产生不可控的重复业务结果。`,
    `页面覆盖“${page.states.join('、')}”状态，并在空、错误、受限或冲突时提供安全下一步。`,
    `服务端状态变化后不会继续展示过期权限、过期余额、失效认证或不可访问内容。`,
    `${ruleFor(page)}`
  ]
}

function screenshotBaseName(page) {
  return page.pageId.toLowerCase()
}

function sourceUrl(page, state) {
  const search = new URLSearchParams({
    page: page.pageId,
    state,
    capture: 'doc'
  })
  return `pages.html?${search.toString()}`
}

const enrichedPages = catalog.pages.map((page, index) => {
  const group = groupFor(page)
  const keyState = chooseKeyState(page)
  return {
    order: index + 1,
    pageId: page.id,
    platform: page.platform,
    module: group?.name || '页面设计',
    priority: page.priority,
    route: page.route,
    pageName: page.name,
    purpose: page.purpose,
    userValue: page.purpose,
    roles: rolesFor(page),
    preconditions: preconditionsFor(page),
    entry: page.entry,
    structure: layoutDescriptions[page.template] || `${page.name}采用与当前业务任务匹配的独立布局，突出事实、主操作和状态反馈。`,
    interaction: interactionFor(page),
    primaryAction: page.primary,
    secondaryActions: page.secondary,
    rule: ruleFor(page),
    states: page.states,
    dataPermission: dataPermissionFor(page),
    nextPageId: page.next || null,
    keyState,
    figmaStates: detailedFigmaStateSpecs[page.id] || [],
    acceptance: acceptanceFor(page),
    requirements: requirementTraceFor(page)
  }
})

const captures = []
const legacyKeyStateCaptureIndexes = new Map([
  ['APP-MSG-05', 3],
  ['APP-WAL-02', 4]
])
for (const page of enrichedPages) {
  const platformDirectory = page.platform === 'mobile' ? 'mobile' : 'admin'
  const defaultState = page.states[0]
  captures.push({
    pageId: page.pageId,
    platform: page.platform,
    module: page.module,
    priority: page.priority,
    route: page.route,
    pageName: page.pageName,
    state: defaultState,
    stateIndex: 1,
    variant: 'default',
    image: `${platformDirectory}/${screenshotBaseName(page)}__default.png`,
    sourceUrl: sourceUrl(page, defaultState),
    alt: `${page.pageId} ${page.pageName}默认状态“${defaultState}”原型`,
    expectedWidth: 1600,
    expectedHeight: 1000,
    sha256: null,
    bytes: null
  })

  if (page.priority === 'P0') {
    const stateIndex = page.states.indexOf(page.keyState) + 1
    // 新增细化状态前，部分基础关键态已使用旧序号生成并进入追踪清单。
    // 路径继续保持稳定；视觉验收由同 Page ID、同状态的 Figma 最终图覆盖。
    const captureFileIndex = legacyKeyStateCaptureIndexes.get(page.pageId) || stateIndex
    captures.push({
      pageId: page.pageId,
      platform: page.platform,
      module: page.module,
      priority: page.priority,
      route: page.route,
      pageName: page.pageName,
      state: page.keyState,
      stateIndex,
      variant: 'key-state',
      image: `${platformDirectory}/${screenshotBaseName(page)}__state-${String(captureFileIndex).padStart(2, '0')}.png`,
      sourceUrl: sourceUrl(page, page.keyState),
      alt: `${page.pageId} ${page.pageName}关键状态“${page.keyState}”原型`,
      expectedWidth: 1600,
      expectedHeight: 1000,
      sha256: null,
      bytes: null
    })
  }
}

const figmaStateCaptures = enrichedPages.flatMap(page => {
  if (!page.figmaStates.length) return []
  const catalogStates = page.states.join('|')
  const figmaStates = page.figmaStates.map(item => item.state).join('|')
  if (catalogStates !== figmaStates) {
    throw new Error(
      `${page.pageId} 的页面状态与 Figma 最终状态顺序不一致：`
      + `${catalogStates} != ${figmaStates}`
    )
  }
  return page.figmaStates.map((item, index) => ({
    pageId: page.pageId,
    platform: page.platform,
    module: page.module,
    priority: page.priority,
    route: page.route,
    pageName: page.pageName,
    state: item.state,
    stateIndex: index + 1,
    stateCount: page.figmaStates.length,
    variant: 'figma-final',
    screen: item.screen,
    frameId: item.frameId,
    image: item.image,
    sourceUrl: item.prototypeUrl,
    prototypeUrl: item.prototypeUrl,
    trigger: item.trigger,
    interaction: item.interaction,
    expected: item.expected,
    authority: item.authority,
    alt: `${page.pageId} ${page.pageName} Figma 最终状态“${item.state}”原型`,
    expectedWidth: 874,
    expectedHeight: 1792,
    sha256: null,
    bytes: null
  }))
})

const counts = {
  pages: enrichedPages.length,
  mobilePages: enrichedPages.filter(page => page.platform === 'mobile').length,
  adminPages: enrichedPages.filter(page => page.platform === 'admin').length,
  p0Pages: enrichedPages.filter(page => page.priority === 'P0').length,
  p1Pages: enrichedPages.filter(page => page.priority === 'P1').length,
  p2Pages: enrichedPages.filter(page => page.priority === 'P2').length,
  defaultCaptures: captures.filter(capture => capture.variant === 'default').length,
  keyStateCaptures: captures.filter(capture => capture.variant === 'key-state').length,
  totalCaptures: captures.length,
  detailedFigmaPages: enrichedPages.filter(page => page.figmaStates.length).length,
  detailedFigmaStateCaptures: figmaStateCaptures.length,
  documentPrototypeMappings: captures.length + figmaStateCaptures.length,
  groups: catalog.groups.length
}

const expectedCounts = {
  pages: 92,
  mobilePages: 49,
  adminPages: 43,
  p0Pages: 54,
  p1Pages: 31,
  p2Pages: 7,
  defaultCaptures: 92,
  keyStateCaptures: 54,
  totalCaptures: 146,
  detailedFigmaPages: 5,
  detailedFigmaStateCaptures: 23,
  documentPrototypeMappings: 169,
  groups: 14
}

for (const [key, expected] of Object.entries(expectedCounts)) {
  if (counts[key] !== expected) {
    throw new Error(`${key} 数量错误：期望 ${expected}，实际 ${counts[key]}`)
  }
}

const pageIds = enrichedPages.map(page => page.pageId)
if (new Set(pageIds).size !== pageIds.length) {
  throw new Error('Page ID 存在重复')
}

const expectedProductRequirements = ids('PRD-FR', [
  '001', '002', '003', '004',
  '010', '011', '012', '013',
  '020', '021', '022', '023',
  '030', '031', '032',
  '040', '041', '042',
  '050', '051', '052', '053', '054', '055', '056',
  '060', '061', '062', '063', '064', '065', '066',
  '070', '071', '074',
  '080', '081', '082',
  '090', '091', '092'
])
const mappedProductRequirements = new Set(
  enrichedPages.flatMap(page => page.requirements.product)
)
const missingProductRequirements = expectedProductRequirements.filter(
  requirement => !mappedProductRequirements.has(requirement)
)
if (missingProductRequirements.length) {
  throw new Error(`产品需求未映射到页面：${missingProductRequirements.join('、')}`)
}

const manifest = {
  schemaVersion: 3,
  appVersion: '1.0',
  generatedAt: '2026-07-30',
  source: 'docs/app/interactive-prototype/page-catalog.js',
  captureViewport: { width: 1600, height: 1000 },
  figmaFinal: {
    fileKey: FIGMA_FILE_KEY,
    pageId: FIGMA_PAGE_ID,
    scope: 'APP-MSG-05/06、APP-WAL-01/02/03',
    status: 'visual-and-interaction-audited',
    audit: {
      pageCoverage: '49/49',
      nodeConnections: 161,
      missingDestinations: 0,
      undersizedTapTargets: 0,
      layoutIssues: 0
    }
  },
  counts,
  pages: enrichedPages,
  captures,
  figmaStateCaptures
}

function imagePathFor(capture) {
  return `./assets/page-prototypes/${capture.image}`
}

function figmaCaptureFor(pageId, state) {
  return figmaStateCaptures.find(
    capture => capture.pageId === pageId && capture.state === state
  )
}

function preferredCaptureFor(page, capture) {
  return figmaCaptureFor(page.pageId, capture.state) || capture
}

function detailedFigmaStateLines(page) {
  const pageCaptures = figmaStateCaptures.filter(
    capture => capture.pageId === page.pageId
  )
  if (!pageCaptures.length) return []
  const lines = [
    `**Figma 最终交互状态：** 本页已完成 ${pageCaptures.length} 个独立状态设计；`
      + '以下 Frame、触发条件、操作结果和权威边界共同构成实现与验收基线。',
    ''
  ]
  for (const capture of pageCaptures) {
    lines.push(
      `**状态 ${capture.stateIndex}｜${capture.state}｜\`${capture.frameId}\`**`,
      '',
      `- 触发条件：${capture.trigger}`,
      `- 关键交互：${capture.interaction}`,
      `- 预期结果：${capture.expected}`,
      `- 权威边界：${capture.authority}`,
      `- [打开 Figma 交互原型](${capture.prototypeUrl})`,
      '',
      `![${capture.alt}](${imagePathFor(capture)})`,
      ''
    )
  }
  return lines
}

function markdownForPage(page) {
  const defaultCapture = captures.find(capture => capture.pageId === page.pageId && capture.variant === 'default')
  const keyCapture = captures.find(capture => capture.pageId === page.pageId && capture.variant === 'key-state')
  const preferredDefault = preferredCaptureFor(page, defaultCapture)
  const preferredKey = keyCapture ? preferredCaptureFor(page, keyCapture) : null
  const lines = [
    `### ${page.pageId} ${page.pageName}`,
    '',
    `**平台与模块：** ${page.platform === 'mobile' ? '移动端' : '管理后台'} · ${page.module}　　**优先级：** ${page.priority}　　**设计路由：** \`${page.route}\``,
    '',
    `**用户价值：** ${page.userValue}`,
    '',
    `**适用角色：** ${page.roles}`,
    '',
    `**前置条件：** ${page.preconditions}`,
    '',
    `**进入路径：** ${page.entry}`,
    '',
    `**页面结构：** ${page.structure}`,
    '',
    `**详细交互：** ${page.interaction}`,
    '',
    `**业务规则：** ${page.rule}`,
    '',
    `**数据与权限：** ${page.dataPermission}`,
    '',
    `**需求追踪：** \`${page.requirements.traceKey}\``,
    '',
    `**模块 PRD：** ${page.requirements.features.map(feature => `[${feature.feature} ${feature.title}](${feature.document})（${feature.requirementGroup}）`).join('；')}`,
    '',
    `**页面状态：** ${page.states.join('、')}`,
    '',
    '**页面级验收：**',
    ''
  ]
  for (const item of page.acceptance) lines.push(`- ${item}`)
  if (page.figmaStates.length) {
    lines.push('', ...detailedFigmaStateLines(page))
  } else {
    lines.push('', `![${preferredDefault.alt}](${imagePathFor(preferredDefault)})`, '')
    if (keyCapture) {
      lines.push(`**P0 关键状态：** ${page.keyState}`, '', `![${preferredKey.alt}](${imagePathFor(preferredKey)})`, '')
    }
  }
  lines.push(
    '**客户确认：**',
    '',
    '- [ ] 确认',
    '- [ ] 需修改',
    '- [ ] 暂缓',
    '',
    '意见：____________________________________________________________',
    '',
    '---',
    ''
  )
  return lines
}

function requirementLines(source, prefix) {
  return source
    .split(/\r?\n/)
    .filter(line => new RegExp(`^- \\*\\*${prefix}-`).test(line))
}

function developmentMarkdownForPage(page) {
  const defaultCapture = captures.find(capture => capture.pageId === page.pageId && capture.variant === 'default')
  const keyCapture = captures.find(capture => capture.pageId === page.pageId && capture.variant === 'key-state')
  const preferredDefault = preferredCaptureFor(page, defaultCapture)
  const preferredKey = keyCapture ? preferredCaptureFor(page, keyCapture) : null
  const lines = [
    `#### ${page.pageId} ${page.pageName}`,
    '',
    `**平台与模块：** ${page.platform === 'mobile' ? '移动端' : '管理后台'} · ${page.module}　　**优先级：** ${page.priority}　　**设计路由：** \`${page.route}\``,
    '',
    `**用户价值：** ${page.userValue}`,
    '',
    `**适用角色：** ${page.roles}`,
    '',
    `**前置条件：** ${page.preconditions}`,
    '',
    `**进入路径：** ${page.entry}`,
    '',
    `**页面结构：** ${page.structure}`,
    '',
    `**详细交互：** ${page.interaction}`,
    '',
    `**业务规则：** ${page.rule}`,
    '',
    `**数据与权限：** ${page.dataPermission}`,
    '',
    `**页面状态：** ${page.states.join('、')}`,
    '',
    '**实现追踪：**',
    '',
    `- 追踪键：\`${page.requirements.traceKey}\``,
    `- 产品需求：${page.requirements.product.map(item => `\`${item}\``).join('、')}`,
    `- 发布范围：${page.requirements.release.map(item => `\`${item}\``).join('、')}`,
    `- 非功能要求：${page.requirements.nonFunctional.map(item => `\`${item}\``).join('、')}`,
    `- 产品级验收：${page.requirements.acceptance.map(item => `\`${item}\``).join('、')}`,
    `- 模块 PRD：${page.requirements.features.map(feature => `[${feature.feature} ${feature.title}](${feature.document})（${feature.requirementGroup}）`).join('；')}`,
    '',
    '**开发验收：**',
    ''
  ]
  for (const item of page.acceptance) lines.push(`- ${item}`)
  lines.push(
    '- UI 层、状态层、数据层和服务端契约不得使用页面展示名称替代稳定 ID、rank、entitlement 或状态枚举。',
    '- 加载、空、错误、离线、无权限、对象失效和服务端状态变化必须按本页状态集合安全收敛。',
    ''
  )
  if (page.figmaStates.length) {
    lines.push(...detailedFigmaStateLines(page))
  } else {
    lines.push(`![${preferredDefault.alt}](${imagePathFor(preferredDefault)})`, '')
    if (keyCapture) {
      lines.push(`**P0 关键状态：** ${page.keyState}`, '', `![${preferredKey.alt}](${imagePathFor(preferredKey)})`, '')
    }
  }
  lines.push('---', '')
  return lines
}

const markdown = [
  '# MeiGallery App 1.0 详细功能与逐页原型说明',
  '',
  'App 版本：1.0',
  '',
  '更新日期：2026-07-30',
  '',
  '状态：需求讨论中，待客户确认',
  '',
  '## 1. 文档用途',
  '',
  '本文是 92 个页面级功能对象的详细说明和原型映射基线。每个 Page ID 独立描述用户价值、角色、前置条件、进入路径、页面结构、详细交互、业务规则、页面状态、数据权限、需求追踪、验收标准和客户确认项。',
  '',
  '基础逐页原型包含 92 张默认状态和 54 张 P0 关键状态，共 146 张；通知与金币 5 个页面另完成 23 张经视觉与交互审计的 Figma 最终状态原型。清单共维护 169 个确定性原型映射，最终状态原型优先于对应的基础占位状态，所有图片均通过 Page ID、状态与 Frame ID 关联，不通过章节位置猜测。',
  '',
  '## 2. 覆盖统计',
  '',
  '| 指标 | 数量 |',
  '|---|---:|',
  `| 页面总数 | ${counts.pages} |`,
  `| 移动端页面 | ${counts.mobilePages} |`,
  `| 管理后台页面 | ${counts.adminPages} |`,
  `| P0 页面 | ${counts.p0Pages} |`,
  `| 默认状态原型 | ${counts.defaultCaptures} |`,
  `| P0 关键状态原型 | ${counts.keyStateCaptures} |`,
  `| 基础逐页原型 | ${counts.totalCaptures} |`,
  `| Figma 最终细化页面 | ${counts.detailedFigmaPages} |`,
  `| Figma 最终状态原型 | ${counts.detailedFigmaStateCaptures} |`,
  `| 清单原型映射总数 | ${counts.documentPrototypeMappings} |`,
  `| 已建立需求追踪的页面 | ${enrichedPages.filter(page => page.requirements.traceKey).length} |`,
  '',
  '## 3. 逐页详细设计',
  ''
]

for (const group of catalog.groups) {
  const groupPages = enrichedPages.filter(page => page.platform === group.platform && page.module === group.name)
  if (!groupPages.length) continue
  markdown.push(
    `## ${group.platform === 'mobile' ? '移动端' : '管理后台'} · ${group.name}`,
    '',
    `本组共 ${groupPages.length} 个页面，按 Page ID 逐页确认。`,
    ''
  )
  for (const page of groupPages) markdown.push(...markdownForPage(page))
}

fs.mkdirSync(path.join(OUTPUT_DIR, 'mobile'), { recursive: true })
fs.mkdirSync(path.join(OUTPUT_DIR, 'admin'), { recursive: true })
const productRequirementsSource = fs.readFileSync(PRODUCT_REQUIREMENTS_PATH, 'utf8')
const releaseScopeSource = fs.readFileSync(RELEASE_SCOPE_PATH, 'utf8')
const productFunctionalRequirements = requirementLines(productRequirementsSource, 'PRD-FR')
const productNonFunctionalRequirements = requirementLines(productRequirementsSource, 'PRD-NFR')
const productAcceptanceRequirements = requirementLines(productRequirementsSource, 'PRD-AC')
const releaseFunctionalRequirements = requirementLines(releaseScopeSource, 'SCP-FR')
const releaseNonFunctionalRequirements = requirementLines(releaseScopeSource, 'SCP-NFR')
const releaseAcceptanceRequirements = requirementLines(releaseScopeSource, 'SCP-AC')
const futureProductIds = new Set(['PRD-FR-072', 'PRD-FR-073', 'PRD-FR-075'])
const futureReleaseIds = new Set([
  'SCP-FR-020',
  'SCP-FR-021',
  'SCP-FR-022',
  'SCP-FR-023',
  'SCP-FR-024'
])
const currentProductFunctionalRequirements = productFunctionalRequirements.filter(
  line => ![...futureProductIds].some(id => line.includes(`**${id}**`))
)
const futureProductFunctionalRequirements = productFunctionalRequirements.filter(
  line => [...futureProductIds].some(id => line.includes(`**${id}**`))
)
const currentReleaseFunctionalRequirements = releaseFunctionalRequirements.filter(
  line => ![...futureReleaseIds].some(id => line.includes(`**${id}**`))
)
const futureReleaseFunctionalRequirements = releaseFunctionalRequirements.filter(
  line => [...futureReleaseIds].some(id => line.includes(`**${id}**`))
)
const developmentMarkdown = [
  '# MeiGallery App 1.0 开发需求规格',
  '',
  'App 版本：1.0',
  '',
  '更新日期：2026-07-30',
  '',
  '状态：需求讨论中；客户确认结论同步后作为开发排期与实现验收基线',
  '',
  '> 本文由产品总需求、App 1.0 发布范围和统一页面目录确定性生成。DOCX 只用于客户阅读与确认；研发、测试、接口设计和任务拆分统一引用本 Markdown、需求编号和 Page ID。',
  '',
  '## 1. 文档定位与使用规则',
  '',
  '1. 本文是 App 1.0 面向开发的单一入口，覆盖产品范围、需求编号、技术边界、92 个页面级实现对象、146 张基础逐页原型、23 张 Figma 最终状态原型和开发验收。',
  '2. 客户意见先同步到产品总需求、发布范围、Feature PRD 和页面目录，再重新生成本文与客户 DOCX；不得直接在 DOCX 中维护独立需求。',
  '3. 开发任务、接口、测试用例、缺陷和变更必须至少引用一个 `PRD/SCP` 编号和一个 Page ID；纯后端门禁可引用需求编号并标注“无独立页面”。',
  '4. 原型用于确认信息层级、交互和状态表达，不替代服务端权限、数据状态机、API 契约或安全门禁。',
  '5. 发生冲突时按“客户已确认结论 → App 1.0 发布范围 → 产品总需求 → Feature PRD → 本文逐页规格 → 原型”处理，并先修订上游再重新生成下游。',
  '',
  '## 2. 开发交付基线',
  '',
  '| 指标 | 基线 |',
  '|---|---:|',
  '| App 版本 | 1.0 |',
  `| 页面总数 | ${counts.pages} |`,
  `| 移动端页面 | ${counts.mobilePages} |`,
  `| Nuxt 管理后台页面 | ${counts.adminPages} |`,
  `| P0 / P1 / P2 | ${counts.p0Pages} / ${counts.p1Pages} / ${counts.p2Pages} |`,
  `| 默认状态原型 | ${counts.defaultCaptures} |`,
  `| P0 关键状态原型 | ${counts.keyStateCaptures} |`,
  `| 基础逐页原型 | ${counts.totalCaptures} |`,
  `| Figma 最终细化页面 | ${counts.detailedFigmaPages} |`,
  `| Figma 最终状态原型 | ${counts.detailedFigmaStateCaptures} |`,
  `| 清单原型映射总数 | ${counts.documentPrototypeMappings} |`,
  `| 已建立需求追踪的页面 | ${enrichedPages.length} |`,
  '',
  '### 2.1 App 1.0 实现范围',
  '',
  '- Android/iOS 观看者客户端：KMP + Compose Multiplatform，共享业务、状态、网络、缓存和主要 UI。',
  '- 桌面运营端：现有 Nuxt 管理后台，覆盖真人供给、认证发布、推荐运营、平台话题、会员申请与发放、金币调整、安全审核和审计。',
  '- 后端与数据：复用现有 MeiGallery 数据并通过共享业务平台渐进迁移；App 不直接读取 legacy 表。',
  '- 商业能力：只做五级会员展示、站内申请、管理员手动发放、金币余额与追加式明细。',
  '- 通知：站内拉取和实时刷新完成全部核心流程，不依赖系统推送。',
  '',
  '### 2.2 App 1.0 明确不实现',
  '',
  '- 在线支付、自动续订、金币充值、礼物、头像框、主页皮肤、聊天皮肤、订单和退款。',
  '- 系统推送、图片消息、音视频通话、直播、公开评论和用户上传公开媒体。',
  '- 普通用户公开真人资料、双向匹配、普通用户间聊天、真人认领后的本人运营和普通用户桌面客户端。',
  '- 未来能力不得生成可点击入口、占位按钮、伪价格或可执行状态；需要新增页面、SDK、权限或审核声明时正常升级 App。',
  '',
  '## 3. 不可违反的业务与安全边界',
  '',
  '- 注册只创建观看者 `Account`；只有管理员认证且发布的真人资料进入公开列表。',
  '- 未认领真人相关话题由平台运营接收与处理，入口、列表和会话持续披露平台身份；不得伪装本人在线、输入、已读或回复。',
  '- 只有有效会员 entitlement 才能创建或发送平台话题；会员申请通过但 grant 未生效时仍无权限。',
  '- 五级会员的名称只用于展示，授权统一使用数值 `rank`、稳定 entitlement key、有效期和额度。',
  '- 喜欢、关注、收藏是互相独立的单向关系，不创建匹配。',
  '- 金币不可提现、转账或兑换法币；管理员加扣币和冲正只追加账本分录，历史不可编辑删除。',
  '- 受保护媒体、对象级授权、会员有效期、会话资格、余额和后台写操作全部由服务端判定。',
  '- 所有后台写操作记录操作者、原因、前后状态、请求链和时间；高风险会员/调币操作执行职责分离。',
  '',
  '## 4. 技术实现基线与规范性文档',
  '',
  '| 主题 | 约束 | 规范性文档 |',
  '|---|---|---|',
  '| 客户端 | KMP + Compose Multiplatform；App 1.0 发布 Android/iOS | [KMP 技术栈](./KMP_CLIENT_TECH_STACK.md)、[KMP 模块设计](./KMP_CLIENT_MODULE_DESIGN.md) |',
  '| 管理后台 | Nuxt 管理后台；不建设普通用户桌面客户端 | [后台交互规格](./ADMIN_CONSOLE_INTERACTION_SPEC.md)、[后台 RBAC](./ADMIN_RBAC_AND_WORKFLOW_DESIGN.md) |',
  '| 后端 | Cloudflare Workers + Hono，共享核心平台和领域边界 | [技术架构](./TECHNICAL_ARCHITECTURE.md)、[Cloudflare 后端模块](./CLOUDFLARE_BACKEND_MODULE_DESIGN.md) |',
  '| 数据迁移 | App 通过新契约访问；MeiGallery legacy 数据渐进映射和迁移 | [数据与迁移](./DATA_AND_MIGRATION.md) |',
  '| API/事件 | OpenAPI、JSON Schema、幂等键、版本化枚举和安全未知值处理 | [API 与实时契约](./API_AND_REALTIME_CONTRACT.md)、[契约冻结计划](./API_DATA_CONTRACT_FREEZE_PLAN.md) |',
  '| UI/文案/埋点 | Page ID、状态 key、文案 key 和事件 key 稳定 | [UI/UX](./UI_UX_DESIGN.md)、[状态文案与埋点](./UI_STATE_COPY_AND_ANALYTICS_CATALOG.md) |',
  '| 信任与合规 | 认证、授权、运营披露、举报申诉和数据权利为上线门禁 | [信任、安全、隐私与合规](./TRUST_SAFETY_PRIVACY_COMPLIANCE.md) |',
  '',
  '## 5. 产品功能需求',
  '',
  '以下需求文本从 `PRODUCT_REQUIREMENTS.md` 同步生成。未来能力保留建模与兼容方向，但不得进入 App 1.0 页面或实现排期。',
  '',
  '### 5.1 App 1.0 功能需求',
  '',
  ...currentProductFunctionalRequirements,
  '',
  '### 5.2 未来能力需求',
  '',
  ...futureProductFunctionalRequirements,
  '',
  '### 5.3 App 1.0 发布范围要求',
  '',
  ...currentReleaseFunctionalRequirements,
  '',
  '### 5.4 未来发布范围与版本升级要求',
  '',
  ...futureReleaseFunctionalRequirements,
  '',
  '## 6. 非功能要求与产品级验收',
  '',
  '### 6.1 产品非功能要求',
  '',
  ...productNonFunctionalRequirements,
  '',
  '### 6.2 发布范围非功能要求',
  '',
  ...releaseNonFunctionalRequirements,
  '',
  '### 6.3 产品级验收',
  '',
  ...productAcceptanceRequirements,
  '',
  '### 6.4 发布范围验收',
  '',
  ...releaseAcceptanceRequirements,
  '',
  '## 7. 全局实现规则',
  '',
  '- 每页使用 Page ID 作为设计、导航、埋点、测试和缺陷追踪的稳定键；展示标题可以调整，但 Page ID 不得复用。',
  '- 页面至少实现默认、加载、空、错误、离线、无权限、对象失效和服务端状态变化后的安全收敛；具体状态以逐页规格为准。',
  '- 写操作必须具备处理中、成功、失败、防重复提交和服务端权威回读；消息、账本和批量任务必须使用幂等语义。',
  '- 权限下降、会员到期、真人暂停/撤销、拉黑或安全处置后，客户端不得继续展示过期能力或受保护内容。',
  '- 未知 capability、entitlement、商品类型、状态枚举或字段必须安全忽略，不崩溃、不扩大权限、不显示伪入口。',
  '- Android/iOS 支持屏幕阅读器、动态字体、高对比度和减少动态效果；Nuxt 后台支持键盘操作和 200% 缩放。',
  '- 日志、崩溃报告和埋点不得记录平台话题正文、完整证件、精确位置、访问令牌或其他直接敏感信息。',
  '',
  '## 8. 逐页开发规格',
  ''
]

for (const group of catalog.groups) {
  const groupPages = enrichedPages.filter(page => page.platform === group.platform && page.module === group.name)
  if (!groupPages.length) continue
  developmentMarkdown.push(
    `### ${group.platform === 'mobile' ? '移动端' : '管理后台'} · ${group.name}`,
    '',
    `本组共 ${groupPages.length} 个页面。实现、接口、测试和缺陷均按 Page ID 追踪。`,
    ''
  )
  for (const page of groupPages) developmentMarkdown.push(...developmentMarkdownForPage(page))
}

developmentMarkdown.push(
  '## 9. 开发启动门禁（Definition of Ready）',
  '',
  '- 客户 C-01～C-08 的选择、会员额度、Beta 门槛和运营服务参数已记录；未关闭项有 Owner、截止点和安全默认值。',
  '- P0 页面、路由、状态集合、文案身份披露和原型已经评审；任何业务变化已同步 PRD/SCP/Feature PRD。',
  '- OpenAPI、事件 Schema、错误模型、幂等规则和未知枚举策略已冻结到可实现版本。',
  '- Account、Person、PersonProfile、Gallery、会员、会话、账本和 legacy 映射已完成数据所有权与 migration 评审。',
  '- 管理后台 capability、scope、强认证、复核与审计规则已定义，测试账号和最小样例数据可用。',
  '- P0 端到端旅程的测试计划、可观测性、降级、恢复和回滚证据要求已确认。',
  '',
  '## 10. 完成定义（Definition of Done）',
  '',
  '- 每个实现任务引用需求编号和 Page ID，满足逐页开发验收与关联 Feature PRD 的 Given/When/Then。',
  '- 客户端与后台覆盖本页声明的全部状态；P0 页面完成关键受限/异常状态视觉回归。',
  '- 所有对象级授权、会员、媒体、消息、账本和后台写操作通过服务端验证；越权与过期用例有自动化测试。',
  '- API/DTO/事件与冻结 Schema 一致，未知字段和枚举兼容测试通过，重试不产生重复业务结果。',
  '- 关键操作具备审计、最小化日志、指标和告警；敏感字段未进入日志、埋点或崩溃报告。',
  '- Android/iOS 无支付 SDK、无推送 SDK 时 P0 E2E 通过；Nuxt 后台关键工作流、键盘操作和 200% 缩放通过。',
  '- 未来能力没有出现在 1.0 页面、菜单、远程配置可执行入口或上线验收中。',
  '- 需求一致性、原型、DOCX 映射、类型检查和 Web 构建校验全部通过。',
  '',
  '## 11. 维护与生成',
  '',
  '- 编辑上游：`PRODUCT_REQUIREMENTS.md`、App 1.0 发布范围、Feature PRD、`page-catalog.js` 和开放问题清单。',
  '- 重新生成：`node scripts/generate_app_page_spec.mjs`。',
  '- 一致性校验：`python scripts/verify_app_requirement_consistency.py`、`python scripts/verify_app_page_prototypes.py --skip-contact-sheets`。',
  '- 客户文档：上游同步后运行 `python scripts/generate_app_product_docs.py`，DOCX 不作为需求源手工分叉。',
  ''
)

const traceability = [
  '# MeiGallery App 1.0 需求追踪矩阵',
  '',
  'App 版本：1.0',
  '',
  '更新时间：2026-07-30',
  '',
  '状态：需求讨论中，待客户确认',
  '',
  '## 1. 文档目的',
  '',
  '本文把产品总需求、App 1.0 发布范围、Feature PRD、92 个 Page ID、146 张基础逐页原型与 23 张 Figma 最终状态原型建立确定性映射，并作为开发需求规格的追踪索引。任何页面或原型不得脱离需求编号单独成为实现依据；任何 App 1.0 用户可见需求也不得在没有 Page ID、明确非 UI 验收或未来范围说明的情况下进入开发。',
  '',
  '## 2. 基线与冲突处理',
  '',
  '1. 客户确认前，以产品总需求、App 1.0 发布范围和开放问题清单的当前结论共同约束下游设计。',
  '2. 客户签署产品需求确认书后，以签署结论作为业务范围基线，再同步产品总需求、发布范围、Feature PRD、页面设计和原型。',
  '3. Feature PRD 细化业务规则；Page ID 细化用户任务、状态和交互；原型图只证明视觉与状态表达，不自行增加功能。',
  '4. 发生冲突时必须先修订上游需求并重新生成本矩阵，不允许开发、设计或测试自行选择较旧口径。',
  '',
  '## 3. 覆盖统计',
  '',
  '| 指标 | 数量 |',
  '|---|---:|',
  `| 产品页面 | ${counts.pages} |`,
  `| 移动端页面 | ${counts.mobilePages} |`,
  `| 管理后台页面 | ${counts.adminPages} |`,
  `| P0 / P1 / P2 | ${counts.p0Pages} / ${counts.p1Pages} / ${counts.p2Pages} |`,
  `| 默认状态原型 | ${counts.defaultCaptures} |`,
  `| P0 关键状态原型 | ${counts.keyStateCaptures} |`,
  `| 基础逐页原型 | ${counts.totalCaptures} |`,
  `| Figma 最终细化页面 | ${counts.detailedFigmaPages} |`,
  `| Figma 最终状态原型 | ${counts.detailedFigmaStateCaptures} |`,
  `| 清单原型映射总数 | ${counts.documentPrototypeMappings} |`,
  `| 已建立需求追踪的页面 | ${enrichedPages.length} |`,
  '',
  '## 4. App 1.0 无页面范围',
  '',
  '| 需求 | 处理方式 |',
  '|---|---|',
  '| PRD-FR-072、PRD-FR-073、PRD-FR-075 | 礼物、装扮和未来订单能力只保留长期需求，不创建 App 1.0 页面或可点击入口。 |',
  '| SCP-FR-020～SCP-FR-024 | 在线商业化、系统推送、媒体消息、真人认领和普通用户桌面端属于未来阶段，不纳入 1.0 页面验收。 |',
  '| SCP-FR-014 | 限量 Beta 供给门禁属于数据与运营验收，通过后台总览、供给清单和发布检查联合验证，不创建独立移动端页面。 |',
  '',
  '## 5. 逐页需求追踪',
  ''
]

for (const group of catalog.groups) {
  const groupPages = enrichedPages.filter(page => page.platform === group.platform && page.module === group.name)
  if (!groupPages.length) continue
  traceability.push(
    `### ${group.platform === 'mobile' ? '移动端' : '管理后台'} · ${group.name}`,
    '',
    '| Page ID | 页面 | 优先级 | 产品总需求 | 发布范围 | Feature PRD |',
    '|---|---|---|---|---|---|'
  )
  for (const page of groupPages) {
    const featureLinks = page.requirements.features
      .map(feature => `[${feature.feature} ${feature.title}](${feature.document})（${feature.requirementGroup}）`)
      .join('；')
    traceability.push(
      `| ${page.pageId} | ${page.pageName} | ${page.priority} | ${page.requirements.product.join('、')} | ${page.requirements.release.join('、')} | ${featureLinks} |`
    )
  }
  traceability.push('')
}

traceability.push(
  '## 6. 逐页同步验收',
  '',
  '- 每个 Page ID 必须同时存在页面目录、详细功能说明、默认状态原型和需求追踪键。',
  '- 54 个 P0 页面必须额外存在一张关键异常、受限、冲突或处理中状态原型。',
  '- `APP-MSG-05`、`APP-MSG-06`、`APP-WAL-01`、`APP-WAL-02`、`APP-WAL-03` 必须完整包含 23 个 Figma 最终状态；每个状态都具备唯一 Frame ID、触发条件、关键交互、预期结果、权威边界和本地导出图。',
  '- Page ID、页面名称、优先级、默认状态、关键状态、图片文件名和需求追踪键由同一清单生成并自动校验。',
  '- `ADM-AUD-03` 的完整可视化页面属于 P2；审计完整性的最小自动校验与告警属于 P0 后端门禁，两者不得混为同一页面优先级。',
  '- 客户意见、设计修改、研发任务和测试用例必须引用 Page ID；涉及业务规则变化时还必须引用对应 PRD/SCP 需求编号。',
  '- 最终开发入口为 `MEIGALLERY_APP_1_0_DEVELOPMENT_REQUIREMENTS.md`；其 Page ID、需求追踪和原型引用必须与本矩阵及 `manifest.json` 完全一致。',
  ''
)

fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
fs.writeFileSync(MARKDOWN_PATH, `${markdown.join('\n').trimEnd()}\n`)
fs.writeFileSync(DEVELOPMENT_MARKDOWN_PATH, `${developmentMarkdown.join('\n').trimEnd()}\n`)
fs.writeFileSync(TRACEABILITY_PATH, `${traceability.join('\n').trimEnd()}\n`)

console.log(`已生成：${path.relative(ROOT, MANIFEST_PATH)}`)
console.log(`已生成：${path.relative(ROOT, MARKDOWN_PATH)}`)
console.log(`已生成：${path.relative(ROOT, DEVELOPMENT_MARKDOWN_PATH)}`)
console.log(`已生成：${path.relative(ROOT, TRACEABILITY_PATH)}`)
console.log(JSON.stringify(counts))
