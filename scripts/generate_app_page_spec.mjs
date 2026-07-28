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

function groupFor(page) {
  return catalog.groups.find(group => {
    const prefixes = [group.prefix, ...(group.extraPrefixes || [])]
    return group.platform === page.platform && prefixes.some(prefix => page.id.startsWith(prefix))
  })
}

function rolesFor(page) {
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
    acceptance: acceptanceFor(page)
  }
})

const captures = []
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
      image: `${platformDirectory}/${screenshotBaseName(page)}__state-${String(stateIndex).padStart(2, '0')}.png`,
      sourceUrl: sourceUrl(page, page.keyState),
      alt: `${page.pageId} ${page.pageName}关键状态“${page.keyState}”原型`,
      expectedWidth: 1600,
      expectedHeight: 1000,
      sha256: null,
      bytes: null
    })
  }
}

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
  groups: 14
}

for (const [key, expected] of Object.entries(expectedCounts)) {
  if (counts[key] !== expected) {
    throw new Error(`${key} 数量错误：期望 ${expected}，实际 ${counts[key]}`)
  }
}

const ids = enrichedPages.map(page => page.pageId)
if (new Set(ids).size !== ids.length) {
  throw new Error('Page ID 存在重复')
}

const manifest = {
  schemaVersion: 1,
  appVersion: '1.0',
  generatedAt: '2026-07-28',
  source: 'docs/app/interactive-prototype/page-catalog.js',
  captureViewport: { width: 1600, height: 1000 },
  counts,
  pages: enrichedPages,
  captures
}

function imagePathFor(capture) {
  return `./assets/page-prototypes/${capture.image}`
}

function markdownForPage(page) {
  const defaultCapture = captures.find(capture => capture.pageId === page.pageId && capture.variant === 'default')
  const keyCapture = captures.find(capture => capture.pageId === page.pageId && capture.variant === 'key-state')
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
    `**页面状态：** ${page.states.join('、')}`,
    '',
    '**页面级验收：**',
    ''
  ]
  for (const item of page.acceptance) lines.push(`- ${item}`)
  lines.push('', `![${defaultCapture.alt}](${imagePathFor(defaultCapture)})`, '')
  if (keyCapture) {
    lines.push(`**P0 关键状态：** ${page.keyState}`, '', `![${keyCapture.alt}](${imagePathFor(keyCapture)})`, '')
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

const markdown = [
  '# MeiGallery App 1.0 详细功能与逐页原型说明',
  '',
  '更新日期：2026-07-28',
  '',
  '状态：需求确认版',
  '',
  '## 1. 文档用途',
  '',
  '本文是 92 个页面级功能对象的详细说明和原型映射基线。每个 Page ID 独立描述用户价值、角色、前置条件、进入路径、页面结构、详细交互、业务规则、页面状态、数据权限、验收标准和客户确认项。',
  '',
  '默认状态原型共 92 张；54 个 P0 页面各补充 1 张关键异常、受限或处理中状态原型，共 146 张。所有截图由同一页面目录与同一映射清单生成，不通过章节位置猜测图片。',
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
  `| 原型图总数 | ${counts.totalCaptures} |`,
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
fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
fs.writeFileSync(MARKDOWN_PATH, `${markdown.join('\n').trimEnd()}\n`)

console.log(`已生成：${path.relative(ROOT, MANIFEST_PATH)}`)
console.log(`已生成：${path.relative(ROOT, MARKDOWN_PATH)}`)
console.log(JSON.stringify(counts))
