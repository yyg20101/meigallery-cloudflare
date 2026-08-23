#!/usr/bin/env node

/**
 * 从逐页交互目录生成详细功能说明、截图映射清单和捕获计划。
 *
 * 本脚本不启动浏览器，也不写入 App 业务代码。截图由浏览器按照
 * manifest.json 中的 sourceUrl 与 image 字段生成。
 */

import fs from 'node:fs'
import { createHash } from 'node:crypto'
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
  discover: '44dp 地区、搜索和筛选入口位于顶部；推荐/地区/热门/最新频道、横向重点真人卡和双列推荐卡按 Figma 首屏顺序展开。',
  selection: '460dp 底部弹层依次展示隐私说明、当前地区、地区范围、常用城市和应用动作；遮罩、关闭和所有选项均具有独立 44dp 热区。',
  categories: '顶部返回与页面标题下依次展示本周主题、内容主题、职业身份、风格特质、地区四个分类组和统一目录说明；空分类、加载与目录失效均使用独立 Figma 状态。',
  search: '搜索输入、历史、建议、结果和无结果解释围绕同一搜索任务组织。',
  filter: '基础筛选、高级权益门槛、预计结果数和应用动作处于同一工作面。',
  saved: '已保存条件、额度、目录变化和管理动作按可恢复性组织。',
  profile: '媒体主视觉、认证事实、单向互动、平台维护披露和资料正文依次展开。',
  media: '媒体画布、页码、说明、缩放和举报动作保持清晰分层。',
  verification: '核验范围、更新时间、失效条件和平台责任边界集中披露。',
  feed: '关注更新按时间组织，不使用匹配、在线或关系暗示。',
  'people-list': '真人列表与移除、筛选或解除动作并列，资料不可用时解释原因。',
  folders: '收藏夹、额度和管理动作按文件夹层级呈现。',
  'favorite-assignment': '固定标题、服务端事实说明、收藏夹归属列表、规则说明与完成操作；最后一项移出使用独立底部确认层。',
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
  export: '范围、目的、独立复核、短期凭证和过期状态形成受控导出闭环。',
  'search-audit': '就绪指标、运行配置、跨域版本依赖和不可变策略版本共同构成只读核查工作区；页面不提供启用运行配置的捷径。',
  'membership-review-queue': '复核资格摘要、状态与类型筛选、最小化队列和职责分离提示共同组成会员变更复核入口。',
  'audit-registry': '观察事实、正式口径、治理阻断、候选编辑、历史影响预览和独立复核申请形成 Action 口径治理闭环。',
  'audit-registry-review': '候选口径、提交时影响快照、当前 Registry、职责分离、复核说明和不可变结论双栏呈现。',
  'privacy-queue': '申请类型、脱敏账号、负责人、当前状态和策略时限构成最小化数据权利队列；加载、失败、空队列、治理门禁和逾期均使用独立状态。',
  'privacy-detail': '脱敏申请事实、策略快照、不可变时间线和处置检查清单双栏呈现；领取、Privacy-2 门禁、失败与只读终态具有独立反馈。'
}

const FIGMA_FILE_KEY = 'LaNSwwGsznwcpV8msj7BQC'
const FIGMA_FILE_SLUG = 'Peachmote-UI-%E5%80%9F%E9%89%B4%E5%AE%A1%E6%9F%A5%E6%9D%BF---MeiGallery'
const FIGMA_PAGE_ID = '9:8'
const FIGMA_MOBILE_PAGE_ID = '145:57041'
const FIGMA_ADMIN_PAGE_ID = '145:57042'
const FIGMA_FINAL_VERSION_ID = '2381987656588552168'
const FIGMA_DESIGN_URL = `https://www.figma.com/design/${FIGMA_FILE_KEY}/${FIGMA_FILE_SLUG}`
const FIGMA_FINAL_DELIVERY = Object.freeze({
  designedPages: 99,
  designedStates: 408,
  mobileStates: 208,
  adminStates: 200,
  flowPreviews: 99,
  mobilePageActions: 914,
  mobileFlowActions: 180,
  adminPageActions: 2043,
  adminFlowActions: 434,
  historicalActionBaseline: 3571,
  missingDestinations: 0,
  undersizedMobileTouchTargets: 0,
  unstyledText: 0,
  rawFills: 0,
  rawStrokes: 0,
  missingFonts: 0,
  textOverflow: 0
})

const NEW_ADMIN_FIGMA_FRAMES = Object.freeze({
  'ADM-SRC-01': Object.freeze({
    normal: '965:17409',
    states: Object.freeze({
      正常: '965:17409', 加载中: '965:17620', 加载失败: '965:17834',
      尚未就绪: '965:18048', 无策略版本: '965:18259'
    })
  }),
  'ADM-MBR-07': Object.freeze({
    normal: '966:17714',
    states: Object.freeze({
      待复核: '966:17714', 加载中: '966:17928', 加载失败: '966:18145',
      空队列: '966:18364', 仅本人发起: '966:18550', 账号已变化: '966:18764'
    })
  }),
  'ADM-AUD-05': Object.freeze({
    normal: '967:18080',
    states: Object.freeze({
      正常: '967:18080', 加载中: '967:18297', 加载失败: '967:18517',
      '未登记 Action': '967:18739', 治理阻断: '967:18956', 候选编辑: '967:19176', 提交失败: '967:19383'
    })
  }),
  'ADM-AUD-06': Object.freeze({
    normal: '969:18507',
    states: Object.freeze({
      待复核: '969:18507', 加载中: '969:18673', 加载失败: '969:18842',
      申请人冲突: '969:19013', 基线变化: '969:19177', 终态只读: '969:19341'
    })
  })
})

function figmaPrototypeUrl(frameId, pageId = FIGMA_PAGE_ID) {
  const nodeId = frameId.replace(':', '-')
  return `https://www.figma.com/proto/${FIGMA_FILE_KEY}/${FIGMA_FILE_SLUG}?node-id=${nodeId}&scaling=min-zoom&content-scaling=fixed&starting-point-node-id=${encodeURIComponent(frameId)}&show-proto-sidebar=1&page-id=${encodeURIComponent(pageId)}`
}

function figmaDesignNodeUrl(frameId) {
  return `${FIGMA_DESIGN_URL}?node-id=${frameId.replace(':', '-')}`
}

function figmaState({
  state,
  screen,
  frameId,
  image,
  imageDirectory = 'phase14',
  expectedWidth = 874,
  expectedHeight = 1792,
  figmaPageId = FIGMA_PAGE_ID,
  trigger,
  interaction,
  expected,
  authority
}) {
  return {
    state,
    screen,
    frameId,
    image: `figma-final/${imageDirectory}/${image}`,
    expectedWidth,
    expectedHeight,
    trigger,
    interaction,
    expected,
    authority,
    prototypeUrl: figmaPrototypeUrl(frameId, figmaPageId)
  }
}

function supplementalFigmaState({
  state,
  frameId,
  image,
  trigger,
  interaction,
  expected,
  authority
}) {
  return {
    state,
    frameId,
    image,
    trigger,
    interaction,
    expected,
    authority
  }
}

// 已完成逐状态 Figma 复核、但除默认态外不扩充客户文档注册映射的页面。
// 这些图片直接嵌入 MD，避免后续重新生成时退回旧 HTML 原型或遗漏独立状态。
const supplementalFigmaStateSpecs = Object.freeze({
  'APP-DSC-01': [
    supplementalFigmaState({
      state: '正常',
      frameId: '159:61979',
      image: 'mobile/app-dsc-01__default.png',
      trigger: '推荐目录、推荐会话和首屏数据同步成功。',
      interaction: '可切换推荐、地区、热门、最新频道；点击地区、搜索、筛选、卡片主体或独立喜欢热区进入对应任务。',
      expected: '首屏按 Figma 顺序展示顶部入口、频道、横向重点真人和双列推荐卡，所有交互目标不小于 44dp。',
      authority: '卡片、推荐理由、排序和地区结果均来自服务端当前推荐投影。'
    }),
    supplementalFigmaState({
      state: '首次空',
      frameId: '159:62126',
      image: 'mobile/app-dsc-01__state-02.png',
      trigger: '当前推荐模式、排序和地区条件查询成功，但没有可展示真人。',
      interaction: '保留顶部入口和底部导航，用户可切换频道、扩大地区范围或清除筛选。',
      expected: '空结果具有明确原因和恢复动作，不使用虚构真人或历史结果冒充当前结果。',
      authority: '空状态来自成功响应的空集合，不与网络失败或目录失效混淆。'
    }),
    supplementalFigmaState({
      state: '骨架',
      frameId: '159:62283',
      image: 'mobile/app-dsc-01__state-03.png',
      trigger: '首次进入或条件切换后尚未取得可展示的权威首屏。',
      interaction: '地区、搜索和筛选入口保持可识别；骨架卡不响应资料或喜欢操作。',
      expected: '骨架尺寸与最终卡片一致，加载完成后不产生明显布局跳动。',
      authority: '骨架不承载真人、认证、推荐理由或互动状态等业务事实。'
    }),
    supplementalFigmaState({
      state: '分页',
      frameId: '159:62441',
      image: 'mobile/app-dsc-01__state-04.png',
      trigger: '接近列表末尾且服务端仍返回 nextCursor。',
      interaction: '自动加载下一页并防重复请求；失败时保留已有卡片、当前位置和原游标，提供非阻断重试。',
      expected: '成功后按稳定 profileId 去重追加，nextCursor 为空后停止请求。',
      authority: '分页游标、排序和去重键均由当前服务端响应决定，客户端不推算页码。'
    }),
    supplementalFigmaState({
      state: '离线缓存',
      frameId: '159:62597',
      image: 'mobile/app-dsc-01__state-05.png',
      trigger: '当前离线，且存在与 sort、推荐模式和地区 code 完全一致的本次运行缓存。',
      interaction: '显示缓存时间与重试入口；允许只读浏览已缓存卡片，禁用喜欢和依赖联网的筛选提交。',
      expected: '明确结果并非最新；网络恢复后重新读取权威首屏并移除离线提示。',
      authority: '缓存只读且不得跨条件复用，不能证明真人、认证或授权仍然有效。'
    }),
    supplementalFigmaState({
      state: '规则刷新',
      frameId: '159:62753',
      image: 'mobile/app-dsc-01__state-06.png',
      trigger: '推荐会话、规则版本或目录版本变化，现有排序不再代表当前结果。',
      interaction: '页面进入显式刷新态并重新请求首屏；刷新失败提供安全重试，不把旧排序继续标记为当前。',
      expected: '刷新成功后以新 session/version 原子替换列表、理由和游标。',
      authority: '推荐规则版本和会话由服务端签发，客户端不得拼接新旧页。'
    })
  ],
  'APP-DSC-02': [
    supplementalFigmaState({
      state: '正常',
      frameId: '159:62911',
      image: 'mobile/app-dsc-02__default.png',
      trigger: '用户点击推荐页顶部地区入口或“地区”频道，且地区目录可用。',
      interaction: '在 460dp 底部弹层内选择地区范围或常用城市；选择只修改草稿，点击应用后才提交。',
      expected: '当前地区、范围、城市和主按钮按 Figma 层级展示，遮罩、关闭和每个选项均有独立 44dp 热区。',
      authority: '提交只使用服务端稳定地区 code；“全国”使用 null，展示名称不作为查询键。'
    }),
    supplementalFigmaState({
      state: '定位未使用',
      frameId: '159:63100',
      image: 'mobile/app-dsc-02__state-02.png',
      trigger: '客户端未申请持续定位，用户仍通过目录手动选择模糊地区。',
      interaction: '说明定位未使用后继续选择范围或城市；不触发系统定位授权，不显示精确距离。',
      expected: '用户可完整完成地区筛选，且清楚该选择仅用于内容范围。',
      authority: '地区偏好来自用户显式选择，不从设备定位或第三方画像推断。'
    }),
    supplementalFigmaState({
      state: '目录更新',
      frameId: '159:63298',
      image: 'mobile/app-dsc-02__state-03.png',
      trigger: '已保存地区 code 在新目录版本中被重命名、合并、下线或失效。',
      interaction: '展示目录更新说明并要求用户重新确认有效范围；不静默映射为同名字符串。',
      expected: '仅有效稳定 code 可被应用，失效选择不会继续影响推荐。',
      authority: '服务端目录版本、词条状态和替代关系是唯一权威。'
    }),
    supplementalFigmaState({
      state: '无结果',
      frameId: '159:63496',
      image: 'mobile/app-dsc-02__state-04.png',
      trigger: '当前地区条件有效，但推荐查询成功且没有可展示真人。',
      interaction: '提示卡与弹层保持 24dp 间距；用户可选择更大范围、其他城市或全国后重新应用。',
      expected: '保留当前草稿和完整选择能力，不自动扩大范围或展示其他地区结果。',
      authority: '无结果不改变用户选择；只有用户点击应用后才提交新的地区 code。'
    })
  ],
  'APP-DSC-03': [
    supplementalFigmaState({
      state: '正常',
      frameId: '159:63697',
      image: 'mobile/app-dsc-03__default.png',
      trigger: '服务端分类目录版本有效，且存在当前可公开浏览的分类组与稳定词条。',
      interaction: '点击本周主题直接以稳定 term ID 进入结果；内容主题、职业身份、风格特质进入对应筛选面板，地区进入 APP-DSC-02。',
      expected: '分类层级、推荐主题和统一目录说明按 Figma 展示，各卡片及返回、底部导航热区均不小于 44dp。',
      authority: '顺序、展示名、稳定 ID、目录版本和词条状态均由服务端目录决定。'
    }),
    supplementalFigmaState({
      state: '空分类',
      frameId: '159:63800',
      image: 'mobile/app-dsc-03__state-02.png',
      trigger: '目录请求成功，但当前可用范围内没有可公开展示的分类或真人。',
      interaction: '用户可重新读取分类，或进入热门推荐；页面不自动创建分类、扩大范围或伪造结果。',
      expected: '空状态明确区分“请求成功但无内容”与网络失败，主次恢复路径均可达。',
      authority: '可公开分类与可展示真人集合由服务端权威响应决定。'
    }),
    supplementalFigmaState({
      state: '目录失效',
      frameId: '159:63865',
      image: 'mobile/app-dsc-03__state-03.png',
      trigger: '已保存的分类 stable ID 因合并、下线、重定向或目录版本变更而不再可用。',
      interaction: '页面提供重新读取当前目录、返回分类页和查看目录变化说明；不按展示名猜测映射。',
      expected: '重读成功后只使用新版本有效 ID；无法安全重定向的词条停止使用并等待用户重选。',
      authority: '合并关系、替代 ID、下线状态和版本均以服务端目录为准。'
    })
  ],
  'APP-DSC-04': [
    supplementalFigmaState({
      state: '初始',
      frameId: '159:63946',
      image: 'mobile/app-dsc-04__default.png',
      trigger: '用户从推荐页搜索入口进入，搜索能力可用且尚未提交本次查询。',
      interaction: '可进入输入态、筛选、已保存条件、全部分类，复用最近搜索或热门发现，并通过“管理历史”进入逐条删除、清空全部或关闭记录。',
      expected: '搜索入口、最近搜索、热门发现和底部导航按 Figma 层级展示，所有可见操作均具有不小于 44dp 的独立热区。',
      authority: '最近搜索只来自当前账号的权威历史设置与记录；热门词仅作为显式搜索入口，不代表人物事实。'
    }),
    supplementalFigmaState({
      state: '输入中',
      frameId: '159:64061',
      image: 'mobile/app-dsc-04__state-02.png',
      trigger: '用户聚焦搜索框并输入展示名、地区、职业或已审核标签。',
      interaction: '可清空输入、进入筛选或已保存条件、选择公开索引建议，或提交规范化后的搜索词。',
      expected: '输入内容始终可见，清空和提交动作独立；建议不包含法定姓名、内部备注或其他非公开字段。',
      authority: '查询长度、可搜索字段、建议来源和可用排序由服务端 capability 与公开索引约束。'
    }),
    supplementalFigmaState({
      state: '有结果',
      frameId: '159:64147',
      image: 'mobile/app-dsc-04__state-03.png',
      trigger: '搜索请求成功并返回至少一条当前可公开展示的人物资料。',
      interaction: '可修改搜索、调整筛选、打开已保存条件、进入人物详情或查看平台认证规则；接近末尾时使用服务端游标分页。',
      expected: '结果卡展示当前公开投影、命中原因和认证标识，加载更多按稳定 profileId 去重且不重排已有卡片。',
      authority: '结果集合、命中原因、认证状态、排序和 nextCursor 均以当前服务端响应为准。'
    }),
    supplementalFigmaState({
      state: '无结果',
      frameId: '159:64252',
      image: 'mobile/app-dsc-04__state-04.png',
      trigger: '关键词与筛选组合请求成功，但当前公开快照返回空集合。',
      interaction: '保留关键词和条件，用户可修改搜索词、进入筛选主动放宽，或返回热门推荐。',
      expected: '明确区分成功空结果与请求失败，不自动扩大范围，也不用未认证资料补位。',
      authority: '空结果由当前公开快照决定；只有用户显式修改关键词或筛选后才执行新查询。'
    }),
    supplementalFigmaState({
      state: '历史关闭',
      frameId: '159:64339',
      image: 'mobile/app-dsc-04__state-05.png',
      trigger: '当前账号的搜索历史记录开关处于关闭状态。',
      interaction: '页面不展示最近搜索，仍允许基础搜索、筛选和已保存条件，并提供显式“开启搜索历史”动作；不以历史关闭阻断搜索。',
      expected: '关闭状态具有明确隐私说明，后续成功搜索不写入账号历史，底部导航保持可用。',
      authority: '记录开关、保留天数和历史条目由服务端账号设置决定，客户端不私自创建本地历史。'
    })
  ],
  'APP-DSC-05': [
    supplementalFigmaState({
      state: '正常',
      frameId: '159:64428',
      image: 'mobile/app-dsc-05__default.png',
      trigger: '筛选目录、当前账号筛选能力和当前条件预估均已成功读取。',
      interaction: '以稳定 term ID 选择地区、风格、职业身份等条件；同组条件取并集、跨组取交集，400ms 防抖后更新预估；可清空、保存或应用。',
      expected: '弹层顶部提供保存与清空，底部同时展示已选数量、服务端预估和主操作；所有选项具有独立 44dp 热区。',
      authority: '目录版本、词条状态、会员门槛、预估数量和最终结果均来自服务端，展示名称不作为查询键。'
    }),
    supplementalFigmaState({
      state: '权益门槛',
      frameId: '159:64628',
      image: 'mobile/app-dsc-05__state-02.png',
      trigger: '当前账号选择了基础或完整会员等级才能使用的筛选条件。',
      interaction: '保留所有已选条件；受限条件进入会员权益页，基础条件仍可调整；无权条件不得应用或保存。',
      expected: '明确说明风格、职业、场景等等级门槛，摘要不显示虚假人数，主操作改为查看会员权益。',
      authority: '客户端只解释 capability 与 requiredRank，是否可用仍由服务端 entitlement 校验。'
    }),
    supplementalFigmaState({
      state: '目录冲突',
      frameId: '159:64837',
      image: 'mobile/app-dsc-05__state-03.png',
      trigger: 'catalogVersionId 变化，所选 term ID 被合并、重定向、下线或失效。',
      interaction: '保留仍有效的选择和冲突上下文；重新加载目录后按服务端重定向结果等待用户确认，不按展示名猜测映射。',
      expected: '摘要明确保留数量与目录刷新要求，应用按钮改为重新加载目录，保存动作禁用。',
      authority: '有效词条、替代关系和新目录版本以服务端目录响应为唯一权威。'
    }),
    supplementalFigmaState({
      state: '无结果',
      frameId: '159:65046',
      image: 'mobile/app-dsc-05__state-04.png',
      trigger: '当前条件合法且预估请求成功，但可展示人物数量为 0。',
      interaction: '保持当前条件不变；用户可逐项调整、清空后查看全部人物，或保存当前条件稍后使用。',
      expected: '状态卡、摘要和主按钮统一显示 0 结果语义，不使用旧人数、扩大范围或未认证资料补位。',
      authority: '0 结果来自当前服务端公开投影；只有用户主动修改条件后才重新预估。'
    })
  ],
  'APP-DSC-06': [
    supplementalFigmaState({
      state: '正常',
      frameId: '159:65258',
      image: 'mobile/app-dsc-06__default.png',
      trigger: '当前账号保存条件列表、最新 taxonomy 解释、会员权限与额度均读取成功。',
      interaction: '每张卡可先重新复核再使用、进入编辑条件流程或打开删除确认；底部导航和返回动作保持独立。',
      expected: '卡片只展示名称、当前有效条件摘要和默认排序，不展示持久化或过期的结果数量；顶部显示权威额度。',
      authority: '名称、版本、stable term ID、目录解释、默认排序和额度均来自本人账号的服务端响应。'
    }),
    supplementalFigmaState({
      state: '空',
      frameId: '159:65411',
      image: 'mobile/app-dsc-06__state-02.png',
      trigger: '列表请求成功且当前账号没有有效保存条件。',
      interaction: '用户可返回搜索和筛选创建第一组条件，也可通过底部导航离开；页面不创建本地示例条件。',
      expected: '额度明确显示 0 / 当前上限，空态与加载失败可区分，主操作进入搜索而不是直接生成保存条件。',
      authority: '空集合和当前上限以服务端账号作用域列表为准。'
    }),
    supplementalFigmaState({
      state: '额度满',
      frameId: '159:65477',
      image: 'mobile/app-dsc-06__state-03.png',
      trigger: '创建新条件时服务端返回当前已用数量达到会员额度。',
      interaction: '既有条件继续允许复核、编辑和删除；用户可删除不常用条件或查看会员权益，不在 App 内购买。',
      expected: '未成功创建的新条件不进入列表，现有条件保持不变，额度与会员授予边界清晰可见。',
      authority: '上限、已用数量和是否可创建由服务端 entitlement 与原子额度校验决定。'
    }),
    supplementalFigmaState({
      state: '标签已合并',
      frameId: '159:65577',
      image: 'mobile/app-dsc-06__state-04.png',
      trigger: '保存条件引用的 stable term ID 已被当前目录显式重定向到合并目标。',
      interaction: '页面提示目录解释已更新；使用前仍重新 preview，编辑或删除均携带当前版本，不按展示名猜测替代项。',
      expected: '卡片显示新的安全展示名称但保留来源关系，合并不会扩大查询，也不自动覆盖另一设备修改。',
      authority: '重定向目标、当前目录版本和 canonical 条件由服务端 taxonomy closure 响应决定。'
    })
  ],
  'APP-DSC-07': [
    supplementalFigmaState({
      state: '正常',
      frameId: '159:65741',
      image: 'mobile/app-dsc-07__default.png',
      trigger: '人物仍为管理员认证并发布，当前账号可读取公开资料，相关 capability 已通过客户端契约校验。',
      interaction: '顶部返回、分享和更多操作相互独立；资料正文、公开图库、平台接收披露和认证范围按当前权威数据展示；喜欢、关注、收藏为单向关系，发起话题前先展示平台运营接收说明。',
      expected: '只展示服务端当前公开投影，不暗示本人在线、本人回复或双方匹配；所有主要操作具有至少 44dp 热区，并在提交、失败与成功状态之间保持明确出口。',
      authority: '人物发布资格、认证标签、媒体可见性、互动状态、会员权益、平台接收主体和安全原因均由服务端响应决定。'
    }),
    supplementalFigmaState({
      state: '下架',
      frameId: '159:65841',
      image: 'mobile/app-dsc-07__state-02.png',
      trigger: '人物被下架、撤回展示授权、暂停公开或已不存在，服务端不再返回可展示详情。',
      interaction: '立即停止展示缓存资料、图片和互动入口；只保留返回发现、查看帮助和当前状态说明。',
      expected: '页面明确区分下架与网络失败，不使用历史缓存绕过当前服务端状态，也不保留可继续操作的热区。',
      authority: '下架原因和是否恢复公开完全由服务端状态决定，客户端不得自行猜测或延长缓存可见期。'
    }),
    supplementalFigmaState({
      state: '受限',
      frameId: '159:65952',
      image: 'mobile/app-dsc-07__state-03.png',
      trigger: '人物仍存在，但当前账号、地区或访问策略不允许读取该资料详情。',
      interaction: '不展示资料正文和媒体，只提供返回发现、查看帮助与服务端访问限制说明。',
      expected: '受限状态不泄露被保护内容，不把登录、升级或客户端隐藏按钮当作绕过权限的方式。',
      authority: '访问资格由服务端按当前账号和策略校验；客户端仅解释结果，不硬编码会员名称或地区白名单。'
    }),
    supplementalFigmaState({
      state: '离线摘要',
      frameId: '159:66063',
      image: 'mobile/app-dsc-07__state-04.png',
      trigger: '本次运行曾安全读取同一人物资料，随后发生网络或服务暂不可用。',
      interaction: '只展示本次会话内最近一次安全摘要与同步说明；喜欢、关注、收藏、分享、媒体和发起话题均暂停，用户可重新连接或查看帮助。',
      expected: '离线摘要带新鲜度说明且不落盘，不把旧资料标记为当前事实，不写入任何本地假互动。',
      authority: '仅网络或服务暂不可用可使用同 profileId 的会话内摘要；下架、受限或校验失败必须清除缓存。'
    }),
    supplementalFigmaState({
      state: '媒体不可用',
      frameId: '159:66172',
      image: 'mobile/app-dsc-07__state-05.png',
      trigger: '人物公开资料仍可读取，但公开图库 capability、媒体清单或短期访问授权暂不可用。',
      interaction: '保留人物资料、认证、平台披露和允许的互动；媒体区单独显示错误与重试，不清空整页或复用旧媒体授权。',
      expected: '媒体失败与人物下架分离；重试只重新请求媒体，受保护媒体凭证不进入 UI、Domain 或持久化存储。',
      authority: '媒体清单、requiredRank、公开状态和短期访问授权均由 Media API 逐次校验。'
    })
  ],
  'APP-DSC-08': [
    supplementalFigmaState({
      state: '正常',
      frameId: '159:66285',
      image: 'mobile/app-dsc-08__default.png',
      trigger: '人物与当前图片仍满足公开资格，媒体字节已通过 Worker 安全返回并仅存在于当前页面内存。',
      interaction: '用户可返回人物详情、查看媒体说明、双指或按钮缩放、查看下一张、举报当前图片和打开资料认证范围；最后一张存在 nextCursor 时先进入分页加载。',
      expected: '全屏图片、页码、标题、授权说明和底部动作与 Figma 一致；不虚构媒体总量、更新时间、会员名称或长期资源地址。',
      authority: '人物资格、媒体清单、访问类型、会员权限、短期凭证和图片内容均由服务端逐次校验。'
    }),
    supplementalFigmaState({
      state: '访问凭证刷新',
      frameId: '159:66346',
      image: 'mobile/app-dsc-08__state-02.png',
      trigger: '受保护图片的短期访问窗口到期，当前人物、账号和媒体仍停留在同一查看任务。',
      interaction: '短暂保留当前内存图片并自动重新请求一次授权；刷新期间禁止重复翻页或把旧 URL 写入缓存，用户仍可返回。',
      expected: '刷新成功后恢复同一图片；会员、会话或资料资格变化时进入对应登录、权益不足或内容隐藏状态。',
      authority: '访问凭证、有效期、账号会话、会员 rank 和媒体可见性以服务端当前响应为准。'
    }),
    supplementalFigmaState({
      state: '图片加载失败',
      frameId: '159:66400',
      image: 'mobile/app-dsc-08__state-03.png',
      trigger: '当前图片内容请求发生网络、服务、凭证或可重试响应错误，且尚未得到可安全展示的字节。',
      interaction: '仅重新加载当前媒体，或返回人物详情、查看帮助；不会重放人物互动、改变会员或使用历史资源地址。',
      expected: '失败原因使用用户安全文案；重试只影响当前图片，既有列表和人物位置不被无关清空。',
      authority: '错误类型、是否可重试和重新授权结果由 Media API 返回，客户端未知错误安全拒绝。'
    }),
    supplementalFigmaState({
      state: '内容隐藏',
      frameId: '159:66437',
      image: 'mobile/app-dsc-08__state-04.png',
      trigger: '人物暂停公开、授权撤回、安全隐藏或当前服务端资格谓词不再通过。',
      interaction: '停止刷新并清理当前媒体状态，只保留返回人物详情、查看公开推荐、举报问题或帮助出口。',
      expected: '不展示历史图片、人物正文或内部下架原因，也不把登录或升级作为绕过方式。',
      authority: '是否可展示由服务端统一人物公开资格谓词决定；客户端只呈现通用不可用状态。'
    })
  ],
  'APP-DSC-09': [
    supplementalFigmaState({
      state: '正常',
      frameId: '159:66476',
      image: 'mobile/app-dsc-09__default.png',
      trigger: '人物仍满足公开资格，认证记录与当前资料版本一致且四项公开核验完整有效。',
      interaction: '展示认证范围、最近核验与资料版本；可返回真人详情、查看平台认证规则或举报认证问题。',
      expected: '四项核验和平台代运营边界按 Figma 完整展示；认证不被解释为本人运营、本人回复或平台背书。',
      authority: '认证范围、版本、时间、运营模式和责任边界均来自服务端当前认证说明。'
    }),
    supplementalFigmaState({
      state: '认证失效',
      frameId: '159:66553',
      image: 'mobile/app-dsc-09__state-02.png',
      trigger: '进入说明后服务端确认人物已停止公开，或认证、授权、发布、安全门禁不再有效。',
      interaction: '停止使用旧认证事实，只保留返回真人详情、查看规则和举报或申诉说明出口。',
      expected: '旧认证不再用于搜索、推荐、媒体凭证或新平台话题；页面不泄漏内部撤回原因。',
      authority: '认证是否仍有效和公开入口是否收敛由服务端当前资格谓词决定。'
    }),
    supplementalFigmaState({
      state: '资料变化',
      frameId: '159:66636',
      image: 'mobile/app-dsc-09__state-03.png',
      trigger: '当前会话曾读取认证说明，后续服务端返回了不同的资料版本。',
      interaction: '保留最近一次已知摘要并明确等待刷新；用户可重新读取认证信息、返回真人详情或查看规则。',
      expected: '刷新中、失败和成功都有独立状态；旧摘要不被继续标记为当前有效认证事实。',
      authority: '版本变化由稳定 profileId 与服务端 profileVersion 比较得出，展示文案不替代版本号。'
    })
  ],
  'APP-INT-06': [
    supplementalFigmaState({
      state: '正常',
      frameId: '894:3616',
      image: 'mobile/app-int-06__default.png',
      trigger: '人物收藏状态与收藏夹摘要均已从服务端读取成功。',
      interaction: '点击任意收藏夹立即提交单项归属变更；页面完成或返回时不再重复提交。',
      expected: '展示当前权威勾选、收藏夹人数和类型；喜欢与关注状态不受影响。',
      authority: '勾选状态、收藏状态和人数均以服务端响应为准。'
    }),
    supplementalFigmaState({
      state: '加载中',
      frameId: '896:3614',
      image: 'figma-final/phase15/app-int-06-loading.png',
      trigger: '首次进入或读取失败后重新加载收藏归属。',
      interaction: '保持返回可用，禁用完成和收藏夹选择，不使用旧勾选冒充当前结果。',
      expected: '等高骨架保持布局稳定，读取完成后整体切换到权威结果。',
      authority: '加载态不承载收藏归属、人数或资料可用性事实。'
    }),
    supplementalFigmaState({
      state: '读取失败',
      frameId: '896:3677',
      image: 'figma-final/phase15/app-int-06-load-failed.png',
      trigger: '收藏夹或当前人物收藏状态读取失败。',
      interaction: '允许重新加载或安全返回，失败前不执行任何归属修改。',
      expected: '明确说明未修改数据，不展示不完整列表或缓存勾选。',
      authority: '只有完整读取成功后才允许编辑。'
    }),
    supplementalFigmaState({
      state: '更新中',
      frameId: '896:3740',
      image: 'figma-final/phase15/app-int-06-updating.png',
      trigger: '用户选择加入或移出某个收藏夹并已发起服务端请求。',
      interaction: '只标记目标行并锁定其他选择、完成与返回后的重复提交。',
      expected: '服务端确认前保留旧勾选，不进行乐观更新。',
      authority: '归属变化只在服务端返回成功后生效。'
    }),
    supplementalFigmaState({
      state: '更新失败',
      frameId: '898:3616',
      image: 'figma-final/phase15/app-int-06-update-failed.png',
      trigger: '单个收藏夹归属更新被网络、权限、版本或业务规则拒绝。',
      interaction: '保留原权威勾选并标出失败目标，可只重试该行或完成返回。',
      expected: '失败不影响其他收藏夹，也不把本地意图显示为已保存。',
      authority: '失败后继续展示服务端旧结果。'
    }),
    supplementalFigmaState({
      state: '成功反馈',
      frameId: '898:3679',
      image: 'figma-final/phase15/app-int-06-success.png',
      trigger: '服务端确认加入或移出某个非最后收藏夹。',
      interaction: '刷新收藏状态和收藏夹摘要，继续允许下一次单项调整或完成返回。',
      expected: '成功提示指出具体结果，勾选和人数同步为最新权威值。',
      authority: '成功反馈来自本次响应与后续权威摘要，不由客户端推算。'
    }),
    supplementalFigmaState({
      state: '资料不可用',
      frameId: '898:3746',
      image: 'figma-final/phase15/app-int-06-unavailable.png',
      trigger: '人物资料已失效，但当前账号仍存在历史收藏归属。',
      interaction: '只允许从已加入收藏夹移出，禁止新增到其他收藏夹。',
      expected: '最小披露资料不可用状态，不恢复历史封面、地区或标签。',
      authority: '资料资格与允许动作由服务端当前状态决定。'
    }),
    supplementalFigmaState({
      state: '移出最后收藏夹确认',
      frameId: '898:3809',
      image: 'figma-final/phase15/app-int-06-last-removal-confirm.png',
      trigger: '用户尝试移出唯一剩余的收藏夹归属。',
      interaction: '底部确认层阻止背景点击穿透；取消保留原值，确认才提交取消收藏。',
      expected: '明确说明将取消收藏，但喜欢与关注不会改变。',
      authority: '确认动作只提交移出请求，最终结果仍以服务端为准。'
    }),
    supplementalFigmaState({
      state: '移出最后一项中',
      frameId: '899:3616',
      image: 'figma-final/phase15/app-int-06-last-removal-processing.png',
      trigger: '用户确认移出唯一剩余的收藏夹。',
      interaction: '关闭确认层并锁定所有重复操作，原勾选保留到服务端确认。',
      expected: '处理中明确提示原收藏状态尚未改变。',
      authority: '客户端不预先将 favorited 改为 false。'
    }),
    supplementalFigmaState({
      state: '已取消收藏',
      frameId: '899:3681',
      image: 'figma-final/phase15/app-int-06-unfavorited.png',
      trigger: '服务端确认人物已不属于任何收藏夹。',
      interaction: '显示取消收藏结果；用户仍可重新选择任意收藏夹或完成返回。',
      expected: '收藏状态变为未收藏，喜欢与关注维持各自权威状态。',
      authority: 'favorited=false 与空 folderIds 必须来自服务端返回。'
    })
  ],
  'ADM-PRI-01': [
    supplementalFigmaState({
      state: '正常',
      frameId: '939:15995',
      image: 'admin/adm-pri-01__default.png',
      trigger: '服务端返回当前管理员有权查看的数据权利申请、负责人和策略时限。',
      interaction: '可按类型、状态和负责人筛选，刷新权威队列或打开首条申请；列表不展示导出内容、私密正文或内部凭证。',
      expected: '显示脱敏账号、稳定申请编号、当前状态和时限；所有筛选与分页继续使用服务端结果。',
      authority: '申请状态、负责人、SLA 与可见范围均由服务端当前策略和对象范围决定。'
    }),
    supplementalFigmaState({
      state: '加载中',
      frameId: '942:16120',
      image: 'figma-final/phase16/adm-pri-01-loading.png',
      trigger: '首次进入、切换筛选或重新加载队列。',
      interaction: '保留侧栏和安全返回路径，禁用重复刷新，不使用旧统计或缓存列表冒充当前结果。',
      expected: '表格结构保持稳定，事实字段使用读取占位，完成后整体切换到服务端权威列表。',
      authority: '加载态不承载申请数量、负责人或处理时限事实。'
    }),
    supplementalFigmaState({
      state: '加载失败',
      frameId: '942:16342',
      image: 'figma-final/phase16/adm-pri-01-load-failure.png',
      trigger: '队列或治理策略读取失败。',
      interaction: '只允许重新加载、切换后台模块或安全返回；失败期间不执行领取和处置。',
      expected: '明确说明未执行任何处置，不展示过期队列或推断申请终态。',
      authority: '完整读取成功前所有写操作保持关闭。'
    }),
    supplementalFigmaState({
      state: '空队列',
      frameId: '942:16556',
      image: 'figma-final/phase16/adm-pri-01-empty.png',
      trigger: '当前筛选查询成功但没有可见申请。',
      interaction: '可调整筛选、刷新或进入其他后台模块，不创建虚构待办。',
      expected: '空结果与加载失败严格区分，申请数量显示为零。',
      authority: '空队列来自成功响应的空集合。'
    }),
    supplementalFigmaState({
      state: '治理门禁关闭',
      frameId: '942:16770',
      image: 'admin/adm-pri-01__state-02.png',
      trigger: 'Privacy-1 保留策略、负责人、SLA 或地区规则尚未全部获批。',
      interaction: '允许查看策略和脱敏申请事实，但不允许开始真实数据导出或账号删除。',
      expected: '门禁原因、影响和安全下一步可理解，不以客户端开关绕过治理。',
      authority: '门禁由服务端已批准治理策略共同决定。'
    }),
    supplementalFigmaState({
      state: '已逾期',
      frameId: '942:16984',
      image: 'figma-final/phase16/adm-pri-01-overdue.png',
      trigger: '至少一条申请超过当前策略计算的处理时限。',
      interaction: '突出逾期行和升级记录入口，可进入申请详情核对负责人和不可变时间线。',
      expected: '逾期只改变优先级与提示，不自动完成申请或执行不可逆动作。',
      authority: '逾期由服务端策略快照、提交时间和当前时间计算。'
    })
  ],
  'ADM-PRI-02': [
    supplementalFigmaState({
      state: '正常',
      frameId: '944:16747',
      image: 'admin/adm-pri-02__default.png',
      trigger: '申请已由当前管理员领取，权威事实、策略快照和时间线读取成功。',
      interaction: '核对脱敏账号与检查清单后尝试开始受控处置；返回队列不改变申请状态。',
      expected: '当前仅呈现控制面事实，并明确真实导出包与不可逆删除仍由 Privacy-2 门禁控制。',
      authority: '领取人、版本、策略和允许动作由服务端重新校验。'
    }),
    supplementalFigmaState({
      state: '加载中',
      frameId: '945:16842',
      image: 'figma-final/phase16/adm-pri-02-loading.png',
      trigger: '首次进入申请详情或失败后重新读取。',
      interaction: '保留返回队列，禁用处置，不展示旧策略快照或过期 capability。',
      expected: '详情和检查清单保持等高结构，事实字段仅显示读取占位。',
      authority: '加载态不代表申请已领取、已完成或可执行。'
    }),
    supplementalFigmaState({
      state: '加载失败',
      frameId: '945:17043',
      image: 'figma-final/phase16/adm-pri-02-load-failure.png',
      trigger: '申请事实、策略快照或时间线读取失败。',
      interaction: '允许重新加载或返回队列，不开放领取、导出和删除动作。',
      expected: '保留最小脱敏标识，明确未发生任何写操作，也不推断申请终态。',
      authority: '只有完整读取成功后才允许进入下一状态。'
    }),
    supplementalFigmaState({
      state: '待领取',
      frameId: '945:17245',
      image: 'figma-final/phase16/adm-pri-02-unclaimed.png',
      trigger: '申请仍未分配负责人，且当前管理员具备领取 capability 与对象范围。',
      interaction: '领取时重新校验权限和申请版本，并写入负责人、原因与不可删除审计；领取本身不执行导出或删除。',
      expected: '页面明确区分领取控制面和真实数据处置。',
      authority: '领取结果只在服务端条件更新成功后生效。'
    }),
    supplementalFigmaState({
      state: 'Privacy-2 门禁关闭',
      frameId: '945:17448',
      image: 'admin/adm-pri-02__state-02.png',
      trigger: '管理员尝试进入真实导出或不可逆删除，但 Privacy-2 治理与执行器尚未开放。',
      interaction: '只允许查看开放条件、策略快照和审计时间线，禁止生成导出包或删除账号。',
      expected: '不提供伪完成按钮，不以客户端状态模拟真实副作用。',
      authority: 'Privacy-2 capability、治理策略和执行器状态由服务端共同决定。'
    }),
    supplementalFigmaState({
      state: '操作失败',
      frameId: '945:17651',
      image: 'figma-final/phase16/adm-pri-02-operation-failure.png',
      trigger: '领取或受控动作未取得服务端事实变更确认。',
      interaction: '保留失败事件、请求版本和原因，重新读取最新版本后才允许重试。',
      expected: '失败不显示为完成，不隐藏原申请，也不删除失败审计。',
      authority: '申请状态只有服务端确认更新后才变化。'
    }),
    supplementalFigmaState({
      state: '终态只读',
      frameId: '945:17853',
      image: 'figma-final/phase16/adm-pri-02-terminal-readonly.png',
      trigger: '用户在可取消窗口内撤回，或申请已进入当前策略定义的只读终态。',
      interaction: '只允许查看脱敏事实、策略快照、审计时间线并返回队列，主操作保持禁用。',
      expected: '明确本例未生成导出包、未执行删除；终态事实不可由管理员在页面内改写。',
      authority: '终态、取消事实和副作用证据来自服务端不可变时间线。'
    })
  ]
})

const supplementalFigmaDelivery = Object.freeze({
  'APP-DSC-01': {
    formalActions: 67,
    supportSectionId: '581:2',
    supportFrames: 11,
    supportActions: 75
  },
  'APP-DSC-02': {
    formalActions: 45,
    supportSectionId: '603:2326',
    supportFrames: 6,
    supportActions: 60
  },
  'APP-DSC-03': {
    formalActions: 25,
    supportSectionId: '627:2770',
    supportFrames: 3,
    supportActions: 21,
    supportScreens: [
      {
        title: '加载中',
        frameId: '630:2770',
        image: 'mobile/app-dsc-03__loading.png',
        description: '首次读取目录时的等高骨架，不承载分类、数量或真人事实。'
      },
      {
        title: '目录变化说明',
        frameId: '627:2771',
        image: 'mobile/app-dsc-03__catalog-explanation.png',
        description: '说明 stable ID、合并重定向、下线和未知词条的安全处理规则。'
      },
      {
        title: '加载失败',
        frameId: '634:2',
        image: 'mobile/app-dsc-03__load-failed.png',
        description: '网络或服务暂不可用时保留页面与既有选择，提供重载、返回推荐和帮助中心三条安全路径。'
      }
    ]
  },
  'APP-DSC-04': {
    formalActions: 56,
    supportSectionId: '645:2770',
    supportFrames: 12,
    supportActions: 95,
    supportScreens: [
      {
        title: '搜索中',
        frameId: '645:2771',
        image: 'mobile/app-dsc-04__loading.png',
        description: '提交后保留关键词与筛选，用等高骨架等待当前公开结果，不显示旧结果冒充本次查询。'
      },
      {
        title: '搜索失败',
        frameId: '645:2876',
        image: 'mobile/app-dsc-04__load-failed.png',
        description: '网络或服务失败时保留输入与筛选，提供重新搜索、修改搜索词和帮助入口。'
      },
      {
        title: '分页中',
        frameId: '645:2965',
        image: 'mobile/app-dsc-04__pagination-loading.png',
        description: '已有结果保持可用，下一页返回后按稳定 profileId 去重追加。'
      },
      {
        title: '分页失败',
        frameId: '645:3069',
        image: 'mobile/app-dsc-04__pagination-failed.png',
        description: '分页失败不清空或重排现有列表，用户可复用原 nextCursor 重新加载。'
      },
      {
        title: '历史加载中',
        frameId: '645:3174',
        image: 'mobile/app-dsc-04__history-loading.png',
        description: '只为账号最近搜索显示骨架，热门发现和基础搜索保持可用。'
      },
      {
        title: '历史加载失败',
        frameId: '645:3288',
        image: 'mobile/app-dsc-04__history-load-failed.png',
        description: '历史读取失败不阻断搜索，提供独立重读动作且不伪造本地记录。'
      },
      {
        title: '历史为空',
        frameId: '645:3403',
        image: 'mobile/app-dsc-04__history-empty.png',
        description: '记录功能已开启但尚无成功搜索时，说明写入条件，并保留搜索与显式关闭记录入口。'
      },
      {
        title: '清空历史确认',
        frameId: '645:3489',
        image: 'mobile/app-dsc-04__history-clear-confirm.png',
        description: '模态确认区分“仅清空”和“清空并关闭记录”，遮罩下控件不可点击穿透。'
      },
      {
        title: '平台认证规则',
        frameId: '645:3619',
        image: 'mobile/app-dsc-04__verification-rules.png',
        description: '解释搜索结果认证标识的核验范围、展示授权、发布安全状态与非本人运营边界。'
      },
      {
        title: '历史管理',
        frameId: '651:2',
        image: 'mobile/app-dsc-04__history-management.png',
        description: '独立管理当前账号的搜索历史，支持逐条删除、清空全部、关闭后续记录或返回搜索。'
      },
      {
        title: '历史删除中',
        frameId: '651:157',
        image: 'mobile/app-dsc-04__history-deleting.png',
        description: '单条删除提交后只锁定本次操作，其他历史保持可见，不提前伪造删除成功。'
      },
      {
        title: '历史删除失败',
        frameId: '651:306',
        image: 'mobile/app-dsc-04__history-delete-failed.png',
        description: '删除失败时保留全部权威记录，并为失败条目提供定向重试，不影响其他记录。'
      }
    ]
  },
  'APP-DSC-05': {
    formalActions: 67,
    supportSectionId: '666:2782',
    supportFrames: 9,
    supportActions: 48,
    supportScreens: [
      {
        title: '筛选加载中',
        frameId: '667:2781',
        image: 'mobile/app-dsc-05__loading.png',
        description: '首次读取目录和账号筛选能力时禁用条件与应用，加载完成后自动进入正常态。'
      },
      {
        title: '筛选加载失败',
        frameId: '667:2907',
        image: 'mobile/app-dsc-05__load-failed.png',
        description: '目录读取失败时保留当前选择，提供重新加载和清空，不显示伪造目录。'
      },
      {
        title: '结果预估中',
        frameId: '667:3033',
        image: 'mobile/app-dsc-05__preview-loading.png',
        description: '选择变化经 400ms 防抖后进入预估态，期间保留条件并禁用应用与保存。'
      },
      {
        title: '结果预估失败',
        frameId: '668:3003',
        image: 'mobile/app-dsc-05__preview-failed.png',
        description: '预估失败不清空当前条件，可定向重试、继续调整或返回；重新验证前不得保存。'
      },
      {
        title: '已清空',
        frameId: '668:3129',
        image: 'mobile/app-dsc-05__cleared.png',
        description: '清空后所有条件恢复未选视觉，摘要显示全部人物，不保留旧预估。'
      },
      {
        title: '应用中',
        frameId: '668:3255',
        image: 'mobile/app-dsc-05__applying.png',
        description: '应用时锁定当前条件并进入搜索加载态，防止重复提交或新旧条件混用。'
      },
      {
        title: '保存条件命名',
        frameId: '669:3225',
        image: 'mobile/app-dsc-05__save-naming.png',
        description: '仅保存结构化条件与排序，要求输入可识别名称，不保存自由搜索词和预估数量。'
      },
      {
        title: '保存中',
        frameId: '669:3351',
        image: 'mobile/app-dsc-05__saving.png',
        description: '保存提交期间锁定名称和条件，成功后进入 APP-DSC-06 权威列表。'
      },
      {
        title: '保存失败',
        frameId: '669:3477',
        image: 'mobile/app-dsc-05__save-failed.png',
        description: '保存失败保留名称与当前条件，可重新保存或取消，不提前占用服务端额度。'
      }
    ]
  },
  'APP-DSC-06': {
    formalActions: 44,
    supportSectionId: '696:3472',
    supportFrames: 15,
    supportActions: 47,
    supportScreens: [
      {
        title: '列表加载中',
        frameId: '696:3473',
        image: 'mobile/app-dsc-06__loading.png',
        description: '读取账号私有条件、当前目录、会员权限与额度时禁用卡片操作，不展示缓存或示例业务事实。'
      },
      {
        title: '列表加载失败',
        frameId: '696:3625',
        image: 'mobile/app-dsc-06__load-failed.png',
        description: '失败不会清除服务端条件，页面明确不展示本地缓存或示例条件，并提供重新加载。'
      },
      {
        title: '使用前复核中',
        frameId: '696:3689',
        image: 'mobile/app-dsc-06__revalidating.png',
        description: '点击使用后按当前目录、会员权限和默认排序重新 preview，期间锁定其他卡片操作。'
      },
      {
        title: '使用前复核失败',
        frameId: '696:3841',
        image: 'mobile/app-dsc-06__revalidation-failed.png',
        description: '复核失败不应用任何条件，也不改变既有搜索结果；可定向重试或返回列表。'
      },
      {
        title: '会员降级',
        frameId: '696:3938',
        image: 'mobile/app-dsc-06__membership-downgraded.png',
        description: '保存条件继续保留，但受限高级项不能被忽略后执行；可查看权益、编辑为基础条件或删除。'
      },
      {
        title: '条件失效',
        frameId: '696:4035',
        image: 'mobile/app-dsc-06__invalid.png',
        description: '已下线且无安全重定向的 stable term ID 明确标记失效，移除并重新预估前不能使用。'
      },
      {
        title: '编辑条件',
        frameId: '696:4132',
        image: 'mobile/app-dsc-06__editing.png',
        expectedWidth: 453,
        expectedHeight: 912,
        description: '复用 APP-DSC-05 筛选组件编辑结构化条件，下一步才进入名称与默认排序确认。'
      },
      {
        title: '确认更新',
        frameId: '696:4273',
        image: 'mobile/app-dsc-06__update-confirm.png',
        description: '同一确认卡内复核名称、热门优先默认排序与结构化条件，并携带当前 version 提交。'
      },
      {
        title: '确认更新｜最新优先',
        frameId: '703:3555',
        image: 'mobile/app-dsc-06__update-latest-sort.png',
        description: '默认排序可在热门优先与最新优先间显式切换，不保存自由搜索词或预估结果数。'
      },
      {
        title: '更新中',
        frameId: '696:4425',
        image: 'mobile/app-dsc-06__updating.png',
        description: '更新期间锁定名称、排序和条件，乐观版本未确认前不提前修改列表。'
      },
      {
        title: '更新失败',
        frameId: '696:4577',
        image: 'mobile/app-dsc-06__update-failed.png',
        description: '普通失败保留全部输入并允许重新保存；列表仍显示最后一次服务端确认版本。'
      },
      {
        title: '删除确认',
        frameId: '696:4729',
        image: 'mobile/app-dsc-06__delete-confirm.png',
        description: '删除必须二次确认并明确目标名称，不改变当前已经应用的搜索结果。'
      },
      {
        title: '删除中',
        frameId: '696:4881',
        image: 'mobile/app-dsc-06__deleting.png',
        description: '提交当前 version 后锁定确认卡，成功或 deleted=false 都收敛为列表移除终态。'
      },
      {
        title: '删除失败',
        frameId: '696:5033',
        image: 'mobile/app-dsc-06__delete-failed.png',
        description: '失败时条件仍保留，可使用同一目标重新删除或取消，不伪造成功反馈。'
      },
      {
        title: '版本冲突',
        frameId: '696:5185',
        image: 'mobile/app-dsc-06__version-conflict.png',
        description: '另一设备已更新时禁止覆盖，先读取最新名称、排序、条件和 version，再由用户重新确认。'
      }
    ]
  },
  'APP-DSC-07': {
    formalActions: 33,
    supportSectionId: '718:3555',
    supportFrames: 25,
    supportActions: 144,
    supportScreens: [
      {
        title: '资料加载中',
        frameId: '718:3556',
        image: 'mobile/app-dsc-07__loading.png',
        description: '读取当前公开资格、资料、认证、媒体与互动状态时只显示骨架，不回填示例人物或旧业务事实。'
      },
      {
        title: '资料加载失败',
        frameId: '718:3655',
        image: 'mobile/app-dsc-07__load-failed.png',
        description: '无法确认当前公开状态时不展示详情，提供重新加载和返回发现两条安全路径。'
      },
      {
        title: '已喜欢',
        frameId: '718:3754',
        image: 'mobile/app-dsc-07__liked.png',
        description: '服务端确认单向喜欢后更新按钮状态，不创建匹配、互相喜欢或真人可见名单。'
      },
      {
        title: '已关注',
        frameId: '718:3853',
        image: 'mobile/app-dsc-07__followed.png',
        description: '服务端确认关注后更新按钮状态；关注只影响观看者账号的更新与列表。'
      },
      {
        title: '已收藏',
        frameId: '718:3952',
        image: 'mobile/app-dsc-07__favorited.png',
        description: '默认收藏状态以服务端收藏关系为准，喜欢、关注和收藏彼此独立。'
      },
      {
        title: '单向动作处理中',
        frameId: '718:4051',
        image: 'mobile/app-dsc-07__action-processing.png',
        description: '喜欢、关注或收藏提交期间锁定相应动作并显示处理中反馈，避免重复提交。'
      },
      {
        title: '单向动作失败',
        frameId: '718:4150',
        image: 'mobile/app-dsc-07__action-failed.png',
        description: '失败时恢复服务端确认前状态，保留详情并提供定向重试，不伪造已保存结果。'
      },
      {
        title: '分享面板',
        frameId: '718:4249',
        image: 'mobile/app-dsc-07__share.png',
        description: '复制链接与系统分享都先要求服务端提供可验证的当前资料链接。'
      },
      {
        title: '分享不可用',
        frameId: '718:4348',
        image: 'mobile/app-dsc-07__share-unavailable.png',
        description: '服务端没有安全链接时明确不可用，不由客户端拼接可能继续暴露下架内容的地址。'
      },
      {
        title: '运营接收说明',
        frameId: '718:4447',
        image: 'mobile/app-dsc-07__operation-disclosure.png',
        description: '发起话题前持续说明接收方是平台运营、并非本人收件箱，回复由平台决定且不保证。'
      },
      {
        title: '更多操作',
        frameId: '718:4546',
        image: 'mobile/app-dsc-07__more.png',
        description: '举报与屏蔽按独立 capability 展示；未开放能力保持不可操作，不通过隐藏状态绕过服务端。'
      },
      {
        title: '举报原因选择',
        frameId: '718:4645',
        image: 'mobile/app-dsc-07__report-reason.png',
        description: '原因来自服务端安全目录，选择稳定 reason code 后才允许提交。'
      },
      {
        title: '举报提交中',
        frameId: '718:4744',
        image: 'mobile/app-dsc-07__report-submitting.png',
        description: '提交期间锁定按钮并使用请求 token 防重，不提前生成本地举报记录。'
      },
      {
        title: '举报提交失败',
        frameId: '718:4843',
        image: 'mobile/app-dsc-07__report-failed.png',
        description: '失败保留原因选择，可重新提交或返回详情；会话失效时不继续重放旧请求。'
      },
      {
        title: '举报已提交',
        frameId: '718:4942',
        image: 'mobile/app-dsc-07__report-submitted.png',
        description: '服务端确认后可完成或直接进入安全中心举报记录，处理状态不在客户端推断。'
      },
      {
        title: '屏蔽确认',
        frameId: '718:5041',
        image: 'mobile/app-dsc-07__block-confirm.png',
        description: '二次确认明确屏蔽将影响推荐、关系、历史和关联话题，取消不会提交。'
      },
      {
        title: '屏蔽处理中',
        frameId: '718:5140',
        image: 'mobile/app-dsc-07__block-processing.png',
        description: '等待服务端完成屏蔽及关联清理；成功后退出当前详情，失败时保留可重试结果。'
      },
      {
        title: '离线操作受限',
        frameId: '728:3570',
        image: 'mobile/app-dsc-07__offline-blocked.png',
        description: '离线点击互动、分享、媒体或话题入口时说明必须联网，不写入本地假状态。'
      },
      {
        title: '媒体重试中',
        frameId: '728:3670',
        image: 'mobile/app-dsc-07__media-retrying.png',
        description: '只重新请求当前人物的媒体清单与权限，资料正文和已确认互动保持可用。'
      },
      {
        title: '媒体重试失败',
        frameId: '728:3768',
        image: 'mobile/app-dsc-07__media-retry-failed.png',
        description: '媒体失败继续收敛在媒体区，不把整个人物误判为下架，也不复用过期授权。'
      },
      {
        title: '举报原因：隐私',
        frameId: '729:3585',
        image: 'mobile/app-dsc-07__report-reason-privacy.png',
        description: '隐私问题选中态与其他原因互斥，提交稳定 code 而非展示文案。'
      },
      {
        title: '举报原因：不适宜内容',
        frameId: '729:3707',
        image: 'mobile/app-dsc-07__report-reason-content.png',
        description: '不适宜内容选中态使用服务端当前原因目录，不在客户端硬编码处置结论。'
      },
      {
        title: '举报原因：其他',
        frameId: '729:3829',
        image: 'mobile/app-dsc-07__report-reason-other.png',
        description: '其他原因仍使用服务端 reason code；首期不增加未设计的自由文本输入。'
      },
      {
        title: '关注处理中',
        frameId: '729:3951',
        image: 'mobile/app-dsc-07__follow-processing.png',
        description: '关注动作单独锁定并等待服务端确认，不影响喜欢和收藏的权威状态。'
      },
      {
        title: '收藏处理中',
        frameId: '729:4059',
        image: 'mobile/app-dsc-07__favorite-processing.png',
        description: '收藏动作单独锁定并等待服务端确认，失败时恢复原收藏关系。'
      }
    ]
  },
  'APP-DSC-08': {
    formalActions: 14,
    supportSectionId: '750:3580',
    supportFrames: 19,
    supportActions: 69,
    supportScreens: [
      {
        title: '首次加载',
        frameId: '750:3581',
        image: 'mobile/app-dsc-08__loading.png',
        description: '首次进入时确认人物资格、媒体清单和授权状态，不回填旧图片或示例媒体。'
      },
      {
        title: '暂无可查看媒体',
        frameId: '750:3633',
        image: 'mobile/app-dsc-08__empty.png',
        description: '当前权威清单为空时提供返回详情和公开推荐，不把空集合误报为网络失败。'
      },
      {
        title: '当前图片加载中',
        frameId: '750:3667',
        image: 'mobile/app-dsc-08__image-loading.png',
        description: '只加载当前媒体；受保护字节尚未返回前不显示模糊预览或历史 URL。'
      },
      {
        title: '登录后查看',
        frameId: '750:3719',
        image: 'mobile/app-dsc-08__sign-in-required.png',
        description: '受保护图片要求有效 App 会话；登录后重新请求，不创建匿名授权。'
      },
      {
        title: '会员权益不足',
        frameId: '750:3753',
        image: 'mobile/app-dsc-08__membership-required.png',
        description: '服务端拒绝当前 rank 时进入权益说明，不硬编码会员名称或提前展示图片。'
      },
      {
        title: '访问凭证过期',
        frameId: '750:3787',
        image: 'mobile/app-dsc-08__access-expired.png',
        description: '短期凭证到期后仅刷新当前图片；旧凭证和 URL 不进入持久缓存。'
      },
      {
        title: '单张媒体不可用',
        frameId: '751:3590',
        image: 'mobile/app-dsc-08__media-unavailable.png',
        description: '单图停止公开只影响当前项，可继续下一张，不把整个人物误判为下架。'
      },
      {
        title: '缩放查看',
        frameId: '751:3624',
        image: 'mobile/app-dsc-08__zoomed.png',
        description: '双指与显式按钮共用 1–5 倍内存缩放状态，切换媒体时复位。'
      },
      {
        title: '翻页加载中',
        frameId: '751:3684',
        image: 'mobile/app-dsc-08__page-transition.png',
        description: '短暂保留上一张内存图，下一张通过安全加载后才切换。'
      },
      {
        title: '分页加载中',
        frameId: '751:3736',
        image: 'mobile/app-dsc-08__pagination-loading.png',
        description: '使用同一人物版本和 nextCursor 读取下一批，不混合两个查询版本。'
      },
      {
        title: '分页加载失败',
        frameId: '751:3788',
        image: 'mobile/app-dsc-08__pagination-failed.png',
        description: '保留当前图片、位置和已验证列表，可只重试分页或继续查看当前图片。'
      },
      {
        title: '媒体说明',
        frameId: '751:3822',
        image: 'mobile/app-dsc-08__media-info.png',
        description: '只说明授权来源、公开或实时权益核验以及内存缓存边界，不展示内部存储键。'
      },
      {
        title: '举报原因选择',
        frameId: '752:3596',
        image: 'mobile/app-dsc-08__report-reason.png',
        description: '原因来自服务端 Safety 目录且默认不预选，选择稳定 code 后才允许提交。'
      },
      {
        title: '举报提交中',
        frameId: '752:3656',
        image: 'mobile/app-dsc-08__report-submitting.png',
        description: '提交期间锁定重复动作并等待服务端确认，不提前生成本地举报记录。'
      },
      {
        title: '举报提交失败',
        frameId: '752:3716',
        image: 'mobile/app-dsc-08__report-failed.png',
        description: '失败保留原因选择，可定向重试或返回媒体；会话失效时进入登录。'
      },
      {
        title: '举报已提交',
        frameId: '752:3776',
        image: 'mobile/app-dsc-08__report-submitted.png',
        description: '服务端确认后提供完成和举报记录出口，处理状态不由客户端推断。'
      },
      {
        title: '媒体列表已更新',
        frameId: '752:3836',
        image: 'mobile/app-dsc-08__list-updated.png',
        description: '游标失效时丢弃旧列表并从首批重新读取，不拼接新旧媒体版本。'
      },
      {
        title: '当前图片加载失败',
        frameId: '752:3870',
        image: 'mobile/app-dsc-08__image-failed.png',
        description: '普通加载失败只重试当前图片，返回详情与帮助仍可用。'
      },
      {
        title: '举报原因：隐私',
        frameId: '760:3600',
        image: 'mobile/app-dsc-08__report-reason-privacy.png',
        description: '隐私原因选中态与其他原因互斥，提交稳定 code 而不是展示文案。'
      }
    ]
  },
  'APP-DSC-09': {
    formalActions: 12,
    supportSectionId: '783:3600',
    supportFrames: 13,
    supportActions: 50,
    supportScreens: [
      {
        title: '认证说明加载中',
        frameId: '784:3600',
        image: 'mobile/app-dsc-09__loading.png',
        description: '首次进入只读取服务端当前认证说明，不显示旧认证详情或内部审核证据。'
      },
      {
        title: '认证说明加载失败',
        frameId: '784:3697',
        image: 'mobile/app-dsc-09__load-failed.png',
        description: '失败只重试认证说明；返回人物详情与帮助入口保持可用，不把网络失败误报为认证失效。'
      },
      {
        title: '平台认证规则',
        frameId: '784:3803',
        image: 'mobile/app-dsc-09__verification-rules.png',
        description: '弹层集中说明四项公开核验、失效条件和平台代运营边界，不披露证据或审核员。'
      },
      {
        title: '举报认证问题',
        frameId: '784:3898',
        image: 'mobile/app-dsc-09__report-reason.png',
        description: '原因来自服务端 Safety 目录且默认不预选；举报由平台管理员接收。'
      },
      {
        title: '举报原因：资料不实',
        frameId: '785:3605',
        image: 'mobile/app-dsc-09__report-reason-false-info.png',
        description: '资料问题选中态与其他原因互斥，提交时使用服务端稳定 reason code。'
      },
      {
        title: '举报提交中',
        frameId: '785:3707',
        image: 'mobile/app-dsc-09__report-submitting.png',
        description: '提交期间锁定重复操作并等待服务端确认，不提前创建本地成功记录。'
      },
      {
        title: '举报提交失败',
        frameId: '785:3798',
        image: 'mobile/app-dsc-09__report-failed.png',
        description: '失败保留当前原因，可直接重试或返回认证说明；会话失效时由账号状态收敛。'
      },
      {
        title: '举报已提交',
        frameId: '785:3889',
        image: 'mobile/app-dsc-09__report-submitted.png',
        description: '服务端确认后提供完成和举报记录出口，处理结果仍以安全中心为准。'
      },
      {
        title: '认证信息刷新中',
        frameId: '786:3609',
        image: 'mobile/app-dsc-09__refreshing.png',
        description: '资料版本变化后重新核验授权、资料一致性和素材权利；返回前保留当前已知摘要。'
      },
      {
        title: '认证信息刷新失败',
        frameId: '786:3666',
        image: 'mobile/app-dsc-09__refresh-failed.png',
        description: '刷新失败不会覆盖最近已知记录，可定向重试、返回详情或查看认证规则。'
      },
      {
        title: '举报原因：授权问题',
        frameId: '787:3613',
        image: 'mobile/app-dsc-09__report-reason-authorization.png',
        description: '授权问题使用独立选中反馈，提交稳定 code，不在客户端推断审核结论。'
      },
      {
        title: '举报原因：隐私问题',
        frameId: '787:3715',
        image: 'mobile/app-dsc-09__report-reason-privacy.png',
        description: '隐私问题与其他原因互斥，仍由平台管理员按当前规则核查。'
      },
      {
        title: '举报原因：其他',
        frameId: '787:3817',
        image: 'mobile/app-dsc-09__report-reason-other.png',
        description: '其他问题沿用服务端原因目录，不创建无契约的本地分类或处置结果。'
      }
    ]
  },
  'APP-INT-06': {
    formalActions: 36,
    supportSectionId: '159:66694',
    supportFrames: 0,
    supportActions: 0
  },
  'ADM-PRI-01': {
    formalActions: 56,
    supportSectionId: '936:15995',
    supportFrames: 0,
    supportActions: 0
  },
  'ADM-PRI-02': {
    formalActions: 69,
    supportSectionId: '936:15995',
    supportFrames: 0,
    supportActions: 0
  }
})

const directFigmaCaptureSpecs = new Map([
  ['APP-AUTH-04::等待', { frameId: '159:61148', width: 437, height: 896 }],
  ['APP-AUTH-06::正常', { frameId: '159:61658', width: 437, height: 896 }],
  ['APP-AUTH-06::加载失败', { frameId: '159:61703', width: 437, height: 896 }],
  ['APP-DSC-01::正常', { frameId: '159:61979', width: 453, height: 912 }],
  ['APP-DSC-01::离线缓存', { frameId: '159:62597', width: 453, height: 912 }],
  ['APP-DSC-02::正常', { frameId: '159:62911', width: 453, height: 912 }],
  ['APP-DSC-02::无结果', { frameId: '159:63496', width: 453, height: 912 }],
  ['APP-DSC-03::正常', { frameId: '159:63697', width: 437, height: 896 }],
  ['APP-DSC-04::初始', { frameId: '159:63946', width: 437, height: 896 }],
  ['APP-DSC-04::输入中', { frameId: '159:64061', width: 437, height: 896 }],
  ['APP-DSC-04::有结果', { frameId: '159:64147', width: 437, height: 896 }],
  ['APP-DSC-04::无结果', { frameId: '159:64252', width: 437, height: 896 }],
  ['APP-DSC-04::历史关闭', { frameId: '159:64339', width: 437, height: 896 }],
  ['APP-DSC-05::正常', { frameId: '159:64428', width: 453, height: 912 }],
  ['APP-DSC-05::权益门槛', { frameId: '159:64628', width: 453, height: 912 }],
  ['APP-DSC-05::目录冲突', { frameId: '159:64837', width: 453, height: 912 }],
  ['APP-DSC-05::无结果', { frameId: '159:65046', width: 453, height: 912 }],
  ['APP-DSC-06::正常', { frameId: '159:65258', width: 437, height: 896 }],
  ['APP-DSC-06::空', { frameId: '159:65411', width: 437, height: 896 }],
  ['APP-DSC-06::额度满', { frameId: '159:65477', width: 437, height: 896 }],
  ['APP-DSC-06::标签已合并', { frameId: '159:65577', width: 437, height: 896 }],
  ['APP-DSC-07::正常', { frameId: '159:65741', width: 453, height: 912 }],
  ['APP-DSC-07::下架', { frameId: '159:65841', width: 453, height: 912 }],
  ['APP-DSC-07::受限', { frameId: '159:65952', width: 453, height: 912 }],
  ['APP-DSC-07::离线摘要', { frameId: '159:66063', width: 453, height: 912 }],
  ['APP-DSC-07::媒体不可用', { frameId: '159:66172', width: 453, height: 912 }],
  ['APP-DSC-08::正常', { frameId: '159:66285', width: 437, height: 896 }],
  ['APP-DSC-08::访问凭证刷新', { frameId: '159:66346', width: 437, height: 896 }],
  ['APP-DSC-08::图片加载失败', { frameId: '159:66400', width: 437, height: 896 }],
  // 页面目录沿用“加载失败”作为 P0 关键态名称，对应 Figma 的“图片加载失败”正式稿。
  ['APP-DSC-08::加载失败', { frameId: '159:66400', width: 437, height: 896 }],
  ['APP-DSC-08::内容隐藏', { frameId: '159:66437', width: 437, height: 896 }],
  ['APP-DSC-09::正常', { frameId: '159:66476', width: 437, height: 896 }],
  ['APP-DSC-09::认证失效', { frameId: '159:66553', width: 437, height: 896 }],
  ['APP-DSC-09::资料变化', { frameId: '159:66636', width: 437, height: 896 }],
  ['APP-INT-01::正常', { frameId: '159:66700', width: 461, height: 920 }],
  ['APP-INT-01::资料下架', { frameId: '801:3685', width: 461, height: 920 }],
  ['APP-INT-02::正常', { frameId: '159:66943', width: 461, height: 920 }],
  ['APP-INT-02::资料不可用', { frameId: '159:67067', width: 461, height: 920 }],
  ['APP-INT-06::正常', { frameId: '894:3616', width: 461, height: 920 }],
  ['ADM-PRI-01::正常', { frameId: '939:15995', width: 1440, height: 960 }],
  ['ADM-PRI-01::治理门禁关闭', { frameId: '942:16770', width: 1440, height: 960 }],
  ['ADM-PRI-02::正常', { frameId: '944:16747', width: 1440, height: 960 }],
  ['ADM-PRI-02::Privacy-2 门禁关闭', { frameId: '945:17448', width: 1440, height: 960 }]
])

function directFigmaCaptureSpec(pageId, state) {
  const spec = directFigmaCaptureSpecs.get(`${pageId}::${state}`)
  if (!spec) return null
  return {
    ...spec,
    sourceUrl: figmaDesignNodeUrl(spec.frameId)
  }
}

function localCaptureMetadata(image) {
  const filePath = path.join(OUTPUT_DIR, image)
  if (!fs.existsSync(filePath)) {
    return { sha256: null, bytes: null }
  }
  const data = fs.readFileSync(filePath)
  const pngSignature = '89504e470d0a1a0a'
  const isPng = data.length >= 24
    && data.subarray(0, 8).toString('hex') === pngSignature
  return {
    ...(isPng
      ? { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
      : {}),
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
    status: 'captured'
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
      state: '扣减',
      screen: 'APP-WAL-03｜金币分录详情｜扣减',
      frameId: '159:72195',
      image: 'app-wal-03-debit.png',
      imageDirectory: 'phase17',
      expectedWidth: 437,
      expectedHeight: 896,
      figmaPageId: FIGMA_MOBILE_PAGE_ID,
      trigger: '当前有效分录方向为扣减，且服务端已返回用户可见的完整分录事实。',
      interaction: '展示扣减数量、调整原因、发生时间、安全业务单号、执行结果和冲正关系；用户可提出疑问或复制业务单号。',
      expected: '扣减方向与负向数量清晰呈现，原分录保持不可编辑删除；提出疑问只创建独立申诉，不直接修改余额。',
      authority: '分录方向、数量、原因、执行结果与冲正关系均以服务端有效账本返回为准。'
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
  } else if (id.startsWith('ADM-SRC')) {
    product = ids('PRD-FR', ['020', '021', '022', '023', '090', '091', '092'])
    release = ids('SCP-FR', ['012', '030'])
    nonFunctional = ids('PRD-NFR', ['001', '003', '004', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['002', '009', '010'])
    features = [featureSources.discovery, featureSources.taxonomy, featureSources.operations]
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
  } else if (id.startsWith('ADM-PRI')) {
    product = ids('PRD-FR', ['080', '081', '082', '090', '091', '092'])
    release = ids('SCP-FR', ['012', '013'])
    nonFunctional = ids('PRD-NFR', ['001', '002', '003', '004', '005', '006', '007', '008'])
    acceptance = ids('PRD-AC', ['001', '006', '010'])
    features = [featureSources.privacy, featureSources.operations]
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
    ['ADM-SRC', 'Owner、搜索运营、数据治理人员'],
    ['ADM-REC', '推荐运营、数据分析、Owner'],
    ['ADM-MSG', '话题运营、运营主管、质检人员'],
    ['ADM-SAF', '安全专员、独立申诉复核人、Owner'],
    ['ADM-PRI', '隐私运营、合规管理员、Owner'],
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
  if (page.id.startsWith('ADM-SRC')) return '页面只核查权威配置和聚合健康，不展示搜索词、条件名称或用户明细，也不提供隐式启用入口。'
  if (page.id.startsWith('ADM-AUD-05') || page.id.startsWith('ADM-AUD-06')) return '正式 Action 口径只能通过候选预览、职责分离和不可变复核结论追加；不得自动登记或改写历史事实。'
  if (page.id.startsWith('ADM-WAL')) return '余额只允许通过追加分录变化；高风险申请必须由不同管理员复核。'
  if (page.id.startsWith('ADM-MBR')) return '等级名称配置化，权限使用 rank 与稳定 entitlement key，不硬编码会员名称。'
  if (page.id === 'ADM-PER-04') return 'ZIP 只导入 Gallery 内容，不自动创建 Person/Profile 或推荐资格；真人候选必须由管理员显式关联来源并完成授权、认证和发布门禁。'
  if (page.id.startsWith('ADM-PER')) return '只有管理员创建或导入真人资料；认证、授权、审核和发布状态必须可追溯。'
  if (page.id.startsWith('ADM-PRI')) return 'Privacy-1 只交付数据权利控制面；没有真实导出包、删除执行器和不可变副作用证据时，不允许把申请标记为已完成。'
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
  if (page.id.startsWith('ADM-SRC')) return '只读取聚合就绪状态、不可变策略版本与稳定引用；不得返回用户搜索词、保存条件名称或账号明细。'
  if (page.id.startsWith('ADM-AUD-05') || page.id.startsWith('ADM-AUD-06')) return '仅有效 Owner 可读取候选、观察事实和治理引用；申请人不得复核本人操作，批准或驳回必须写入不可变时间线。'
  if (page.id.startsWith('ADM-AUD')) return '仅允许具备审计 capability 的管理员按授权范围读取脱敏事件；导出必须申请、复核、短期授权并记录审计。'
  if (page.id.startsWith('ADM-PRI')) return '仅展示脱敏账号、申请事实、策略快照和不可变时间线；领取与处置同时校验 capability、对象范围、版本、治理门禁和审计原因。'
  if (page.id.startsWith('ADM-WAL') || page.id.startsWith('ADM-MBR')) return '高风险写操作采用申请—独立复核—执行状态机；申请人不得复核本人操作，所有阶段写入审计。'
  if (page.id.startsWith('ADM-MSG')) return '正文访问受领取租约、对象范围和最小必要原则限制；发送身份固定为平台运营。'
  return '管理员 API 与公开 API 分离；读取和写入同时校验 capability、对象范围、版本与审计要求。'
}

function interactionFor(page) {
  const overrides = {
    'ADM-PER-04': '管理员从真人列表的批量导入入口进入，但当前 ZIP schema 是 Gallery 内容包。选择 256 MiB 以内 ZIP 后，浏览器按服务端计划分片上传，原包完成前不允许执行；点击“执行导入”后进入服务端校验和 Queue 逐项处理，离开页面不终止任务。列表持续回读权威进度，单项失败保留其他成功结果；只有 retryable 失败可在原任务重试，修正原包的永久失败必须新建任务，运行时故障可从暂停态继续。成功项进入 Gallery 编辑，不自动生成真人身份、公开资料或推荐资格；若要进入 ADM-PER-03，管理员必须另行显式选择 Gallery 作为候选来源并完成授权、认证和发布流程。',
    'APP-DSC-01': '用户从登录完成、底部“推荐”或返回首页进入。顶部地区入口打开 APP-DSC-02；搜索和筛选分别进入 APP-DSC-04/05。推荐、热门、最新切换服务端排序，地区频道打开地区弹层；切换后重置游标并保留当前页面直到新请求进入明确加载态。卡片主体进入 APP-DSC-07，44dp 喜欢按钮与卡片点击区分离；允许乐观反馈，但服务端拒绝时必须回滚并显示原因。接近列表末尾自动分页，分页失败以非阻断浮层重试且保留已有卡片。只允许复用当前 sort、推荐模式和地区 code 完全一致的本次运行缓存；离线缓存禁用喜欢和筛选。推荐会话或规则版本变化时进入规则刷新态，不把旧排序继续标记为当前结果。',
    'APP-DSC-02': '用户点击推荐页顶部地区或“地区”频道后，以 460dp 底部弹层进入。点击范围或常用城市只修改弹层草稿，不立即刷新推荐；选项触控区统一为 44dp，列表超出首屏时横向滚动。选择更高范围时清除不兼容的城市选中，选择城市时只提交该城市稳定 code；“全国”提交 null。点击“应用地区”关闭弹层并以权威 code 重新请求 APP-DSC-01，重复选择当前值只关闭弹层。点击关闭或遮罩放弃草稿。页面不申请持续定位、不显示精确距离，也不得把“华东、杭州”等展示文案当作查询键；定位未使用、目录更新和无结果分别使用 Figma 独立状态提示。',
    'APP-DSC-03': '用户从推荐频道或搜索入口进入。首次读取时展示 Figma 等高骨架；目录可用后展示本周主题和内容主题、职业身份、风格特质、地区四个分类组。点击本周主题使用服务端稳定 term ID 直接执行搜索；点击前三组进入 APP-DSC-05 对应类型筛选，点击地区进入 APP-DSC-02。空分类可重读或进入热门推荐。目录失效时仅按服务端重定向关系处理；无安全替代时停止使用旧 ID，并提供重读、返回分类和目录变化说明。',
    'APP-DSC-04': '用户从推荐页搜索入口进入。初始态可使用最近搜索、热门发现、全部分类、筛选或已保存条件；输入时仅使用公开索引建议，清空与提交具有独立 44dp 热区。提交后保留关键词和筛选并进入等高骨架，成功结果展示当前公开投影、匹配原因和认证标识，分页按服务端 nextCursor 与稳定 profileId 去重。成功空集合进入无结果态，不自动扩大筛选或用未认证资料补位；首屏或分页失败均保留当前任务与已有结果并提供定向重试。搜索历史由账号设置决定，可独立重读、清空或清空并关闭，关闭后不写入新的账号历史。',
    'APP-DSC-06': '用户从筛选保存成功、搜索页或“我的”进入。列表先读取账号私有条件、当前 taxonomy 解释、会员权限与原子额度；卡片只显示名称、当前有效条件摘要和默认排序，不持久化或展示旧结果数。点击使用必须先以完整来源条件重新 preview，只有 canApply=true 才进入搜索；会员降级或失效项不会被忽略后扩大结果。编辑流程复用 APP-DSC-05，随后确认名称、热门/最新默认排序和当前结构化条件；更新与删除均携带乐观 version，删除先二次确认。409 时不覆盖另一设备版本，先读取最新条件再由用户重新确认。',
    'APP-DSC-07': '用户从推荐、搜索、关注、喜欢、收藏或浏览历史进入。页面先读取人物当前公开资格，再分别读取互动、收藏、安全与媒体状态；人物下架或受限时立即停止展示正文和缓存，网络暂不可用仅允许复用同一人物在本次会话内的最近安全摘要。喜欢、关注、收藏均为单向关系；发起话题前必须展示“由平台运营接收、并非本人收件箱、不保证回复”的持续披露。媒体失败只收敛媒体区并允许定向重试；分享在服务端尚无可验证资料链接时明确不可用。举报、屏蔽和解除屏蔽均等待服务端结果，举报成功可直接进入安全中心的举报记录。',
    'APP-DSC-08': '用户从 APP-DSC-07 公开图库进入。首次读取当前人物媒体清单；选择下一张时先保留当前内存图片并安全加载目标，最后一张存在 nextCursor 时进入分页。受保护图片只在内存显示，短期凭证到期后重新核验；登录、会员不足、单图失效和人物隐藏分别进入独立状态。媒体说明只披露授权与访问边界。举报原因使用服务端稳定 code，默认不预选，提交中防止重复操作，成功后可进入举报记录。',
    'APP-INT-06': '用户从真人详情收藏入口或收藏夹详情进入。页面并行读取当前人物收藏状态与收藏夹摘要，完整成功后才允许操作；每次选择只提交目标收藏夹的一次加入或移出请求，服务端确认前保留旧勾选并锁定其他操作。失败保留原权威状态并允许定向重试，成功后刷新收藏状态和文件夹摘要。资料不可用时只允许移出现有归属。移出唯一剩余收藏夹前必须二次确认，确认后独立显示处理中和已取消收藏结果；喜欢与关注始终不随收藏变化。',
    'APP-MSG-05': '用户从推荐页铃铛或消息页通知入口进入。首次进入、切换分类和回到前台均以 HTTP 拉取权威列表；实时事件只触发重新拉取。点击通知先提交幂等已读，再读取目标当前状态并进入 APP-MSG-06；“全部已读”成功后必须服务端回读，多设备差异不得仅靠本地清零。分页失败保留已有列表，实时离线保留缓存并提示新鲜度。',
    'APP-MSG-06': '用户从通知列表进入。页面展示事件时间、用户安全正文、目标当前状态和当前可执行动作；点击主操作前重新校验目标、账号和 entitlement。目标失效时保留安全历史说明并返回列表；无权限时进入当前权益或安全出口；未知能力需要升级时不渲染不可执行入口。',
    'APP-WAL-01': '用户从“我的金币卡”进入。页面先读取权威余额投影和最近有效分录，再展示同步时间与只读规则；点击“查看金币明细”进入 APP-WAL-02。离线时只展示带时间戳缓存，同步失败不把余额改成 0，也不生成补偿分录；页面始终不出现充值、消费、转账、兑换或提现入口。',
    'APP-WAL-02': '用户从钱包页进入。默认按时间倒序读取有效分录，可切换全部、增加和扣减筛选；切换筛选会重置服务端游标，加载更多复用 nextCursor 并按 entryId 去重。分页失败或维护状态保留已验证历史，不修改、隐藏或重新计算原分录。',
    'APP-WAL-03': '用户从金币明细进入。页面展示方向、数量、原因、时间、安全业务单号、执行结果和冲正关系；复制只包含用户安全业务引用。提交申诉只创建独立案件并进入 APP-SET-08，不直接改余额；冲正通过新分录表达，原分录始终保留且不可编辑删除。',
    'APP-SET-08': '用户从账号限制、举报记录或金币分录详情进入。页面只匹配入口对应的业务对象；无指定入口时按 updatedAt 展示最近更新案件。创建与补充使用幂等请求标识，显式重试复用同一标识；冲突时优先恢复服务端现有案件。处理中可补充必要说明，升级复核与终态禁止补充。维持原结论、申诉成立、已关闭分别进入独立结果页，展示服务端用户可见说明并通过“返回我的”退出；任何申诉结果都不直接改写原业务对象。',
    'ADM-PRI-01': '管理员从后台“数据权利”导航进入。页面先读取治理门禁、可见申请和负责人范围，再按类型、状态与负责人筛选；所有列表项只展示脱敏账号、稳定申请编号、当前状态和策略时限。首屏、筛选和刷新均具有独立加载、失败与空态；治理未批准时保持控制面只读，逾期只触发升级提示和详情核对，不自动完成申请。',
    'ADM-PRI-02': '管理员从数据权利队列进入。页面读取申请当前版本、脱敏账号、策略快照与不可变时间线；未领取时先以条件更新建立负责人和审计原因。开始处置前重新校验 capability、对象范围、版本与 Privacy-2 门禁；当前阶段不得生成真实导出包或执行不可逆删除。操作失败保留原事实并记录失败事件；已取消等终态只读，不能从页面改写。',
    'ADM-SRC-01': '管理员从“搜索运营”进入。页面并行读取运行配置、不可变搜索策略、Taxonomy 与会员目录稳定引用及隐私聚合健康；加载和失败时不展示残留快照。点击策略、隐私或阻断指标只进入只读解释，目录治理跳转 ADM-TAX-01。本页不存在一键启用搜索、迁移或生产切换动作。',
    'ADM-MBR-07': '管理员从会员与金币导航或会员变更提交结果进入。页面按状态和变更类型读取最小化复核队列，并根据当前管理员与发起人关系计算 canReview；本人发起项只允许查看。进入 ADM-MBR-05 前再次读取账号与申请基线；账号变化后的申请保持失效，不允许继续批准。',
    'ADM-AUD-05': '有效 Owner 从审计完整性或导航进入。页面对照真实审计事实、当前 Registry 与待复核申请，筛选未登记、冲突和未就绪 Action。登记或修订前填写稳定引用并预览历史影响；预览不会写入数据库，提交后必须由另一位 Owner 在 ADM-AUD-06 独立复核。加载、筛选或提交失败均不得自动登记、退休或修改历史事实。',
    'ADM-AUD-06': '另一位有效 Owner 从 Action 口径治理的待复核申请进入。页面重新核对候选定义、提交时基线、当前 Registry、观察事实与职责分离；申请人本人只读等待，基线变化使原申请安全失效。批准后只追加正式版本，驳回或终态均形成不可变结论与时间线，不能改写历史申请。'
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
    { score: 500, pattern: /无权限|无会员|受限|冻结|冲突|限制|门槛|门禁|锁定|已有处理中|争议|隔离|负余额/ },
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
    `从“${page.entry}”能够进入正确页面，并提供清晰页面名称和安全返回路径；Page ID、设计路由、Figma Node ID 与状态 key 仅用于设计、开发和测试追踪，真实 UI 不渲染这些交付标注。`,
    `主要操作“${page.primary}”具有处理中、成功和失败反馈，重复提交不会产生不可控的重复业务结果。`,
    `页面覆盖“${page.states.join('、')}”状态，并在空、错误、受限或冲突时提供安全下一步。`,
    `服务端状态变化后不会继续展示过期权限、过期余额、失效认证或不可访问内容。`,
    `${ruleFor(page)}`
  ]
}

function screenshotBaseName(page) {
  return page.pageId.toLowerCase()
}

function newAdminFigmaCaptureSpec(pageId, state) {
  const frameId = NEW_ADMIN_FIGMA_FRAMES[pageId]?.states?.[state]
  if (!frameId) return null
  return {
    frameId,
    sourceUrl: figmaDesignNodeUrl(frameId),
    width: 1440,
    height: 960
  }
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
    figmaDesignPage: page.platform === 'mobile'
      ? '10｜Mobile Pages'
      : '20｜Admin Pages',
    figmaDesignedStateCount: page.states.length,
    acceptance: acceptanceFor(page),
    requirements: requirementTraceFor(page)
  }
})

for (const page of enrichedPages) {
  if (!Array.isArray(page.states) || page.states.length === 0) {
    throw new Error(`${page.pageId} 缺少正式状态`)
  }
  if (page.states.some(state => (
    typeof state !== 'string'
    || state.length === 0
    || state.trim() !== state
  ))) {
    throw new Error(`${page.pageId} 存在空白或未规范化的正式状态名称`)
  }
  if (new Set(page.states).size !== page.states.length) {
    throw new Error(`${page.pageId} 存在重复正式状态`)
  }
}

const derivedFigmaStateCounts = Object.freeze({
  designedPages: enrichedPages.length,
  designedStates: enrichedPages.reduce(
    (total, page) => total + page.states.length,
    0
  ),
  mobileStates: enrichedPages
    .filter(page => page.platform === 'mobile')
    .reduce((total, page) => total + page.states.length, 0),
  adminStates: enrichedPages
    .filter(page => page.platform === 'admin')
    .reduce((total, page) => total + page.states.length, 0)
})

for (const key of ['designedPages', 'designedStates', 'mobileStates', 'adminStates']) {
  if (derivedFigmaStateCounts[key] !== FIGMA_FINAL_DELIVERY[key]) {
    throw new Error(
      `页面目录实际 ${key} 与 Figma 最终交付不一致：`
      + `${derivedFigmaStateCounts[key]} != ${FIGMA_FINAL_DELIVERY[key]}`
    )
  }
}

const captures = []
const legacyKeyStateCaptureIndexes = new Map([
  ['APP-MSG-05', 3],
  ['APP-WAL-02', 4],
  ['ADM-PRI-01', 2],
  ['ADM-PRI-02', 2]
])
for (const page of enrichedPages) {
  const platformDirectory = page.platform === 'mobile' ? 'mobile' : 'admin'
  const defaultState = page.states[0]
  const defaultFigmaCapture = newAdminFigmaCaptureSpec(page.pageId, defaultState)
    || directFigmaCaptureSpec(page.pageId, defaultState)
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
    sourceUrl: defaultFigmaCapture?.sourceUrl || sourceUrl(page, defaultState),
    alt: `${page.pageId} ${page.pageName}默认状态“${defaultState}”原型`,
    expectedWidth: defaultFigmaCapture?.width || 1600,
    expectedHeight: defaultFigmaCapture?.height || 1000,
    sha256: null,
    bytes: null
  })

  if (page.priority === 'P0') {
    const stateIndex = page.states.indexOf(page.keyState) + 1
    const keyFigmaCapture = newAdminFigmaCaptureSpec(page.pageId, page.keyState)
      || directFigmaCaptureSpec(page.pageId, page.keyState)
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
      sourceUrl: keyFigmaCapture?.sourceUrl || sourceUrl(page, page.keyState),
      alt: `${page.pageId} ${page.pageName}关键状态“${page.keyState}”原型`,
      expectedWidth: keyFigmaCapture?.width || 1600,
      expectedHeight: keyFigmaCapture?.height || 1000,
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
    expectedWidth: item.expectedWidth,
    expectedHeight: item.expectedHeight,
    sha256: null,
    bytes: null
  }))
})

const registeredCaptureImages = new Set(
  [...captures, ...figmaStateCaptures].map(capture => capture.image)
)
const supplementalFigmaCaptures = enrichedPages.flatMap(page => {
  const delivery = supplementalFigmaDelivery[page.pageId]
  if (!delivery) return []
  const dimensions = page.pageId.startsWith('ADM-PRI')
    ? { expectedWidth: 1440, expectedHeight: 960 }
    : page.pageId === 'APP-INT-06'
      ? { expectedWidth: 461, expectedHeight: 920 }
      : ['APP-DSC-03', 'APP-DSC-04', 'APP-DSC-06', 'APP-DSC-08', 'APP-DSC-09'].includes(page.pageId)
        ? { expectedWidth: 437, expectedHeight: 896 }
        : { expectedWidth: 453, expectedHeight: 912 }
  const stateCaptures = (supplementalFigmaStateSpecs[page.pageId] || [])
    .filter(item => !registeredCaptureImages.has(item.image))
    .map(item => ({
      pageId: page.pageId,
      platform: page.platform,
      module: page.module,
      route: page.route,
      pageName: page.pageName,
      state: item.state,
      variant: 'figma-supplemental-state',
      frameId: item.frameId,
      image: item.image,
      sourceUrl: figmaDesignNodeUrl(item.frameId),
      prototypeUrl: figmaPrototypeUrl(
        item.frameId,
        page.platform === 'mobile' ? FIGMA_MOBILE_PAGE_ID : FIGMA_ADMIN_PAGE_ID
      ),
      alt: `${page.pageId} ${page.pageName} Figma 补充状态“${item.state}”原型`,
      ...dimensions,
      sha256: null,
      bytes: null
    }))
  const supportCaptures = (delivery.supportScreens || []).map(item => ({
    pageId: page.pageId,
    platform: page.platform,
    module: page.module,
    route: page.route,
    pageName: page.pageName,
    state: item.title,
    variant: 'figma-interaction-support',
    frameId: item.frameId,
    image: item.image,
    sourceUrl: figmaDesignNodeUrl(item.frameId),
    alt: `${page.pageId} ${page.pageName} ${item.title}交互支持稿`,
    expectedWidth: item.expectedWidth || dimensions.expectedWidth,
    expectedHeight: item.expectedHeight || dimensions.expectedHeight,
    sha256: null,
    bytes: null
  }))
  return [...stateCaptures, ...supportCaptures]
})

for (const capture of [
  ...captures,
  ...figmaStateCaptures,
  ...supplementalFigmaCaptures
]) {
  Object.assign(capture, localCaptureMetadata(capture.image))
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
  detailedFigmaPages: enrichedPages.filter(page => page.figmaStates.length).length,
  detailedFigmaStateCaptures: figmaStateCaptures.length,
  documentPrototypeMappings: captures.length + figmaStateCaptures.length,
  supplementalFigmaCaptures: supplementalFigmaCaptures.length,
  figmaDesignedPages: derivedFigmaStateCounts.designedPages,
  figmaDesignedStates: derivedFigmaStateCounts.designedStates,
  figmaMobileStates: derivedFigmaStateCounts.mobileStates,
  figmaAdminStates: derivedFigmaStateCounts.adminStates,
  figmaFlowPreviews: FIGMA_FINAL_DELIVERY.flowPreviews,
  figmaHistoricalPageActionBaseline:
    FIGMA_FINAL_DELIVERY.mobilePageActions
    + FIGMA_FINAL_DELIVERY.adminPageActions,
  figmaHistoricalFlowActionBaseline:
    FIGMA_FINAL_DELIVERY.mobileFlowActions
    + FIGMA_FINAL_DELIVERY.adminFlowActions,
  figmaHistoricalActionBaseline: FIGMA_FINAL_DELIVERY.historicalActionBaseline,
  groups: catalog.groups.length
}

const expectedCounts = {
  pages: 99,
  mobilePages: 50,
  adminPages: 49,
  p0Pages: 57,
  p1Pages: 32,
  p2Pages: 10,
  defaultCaptures: 99,
  keyStateCaptures: 57,
  totalCaptures: 156,
  detailedFigmaPages: 5,
  detailedFigmaStateCaptures: 23,
  documentPrototypeMappings: 179,
  supplementalFigmaCaptures: 136,
  figmaDesignedPages: 99,
  figmaDesignedStates: 408,
  figmaMobileStates: 208,
  figmaAdminStates: 200,
  figmaFlowPreviews: 99,
  figmaHistoricalPageActionBaseline: 2957,
  figmaHistoricalFlowActionBaseline: 614,
  figmaHistoricalActionBaseline: 3571,
  groups: 15
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

const captureArtifacts = [
  ...captures,
  ...figmaStateCaptures,
  ...supplementalFigmaCaptures
]
const captureHashes = captureArtifacts
  .map(capture => capture.sha256)
  .filter(Boolean)
const captureArtifactsVerified = captureArtifacts.every(capture => (
  capture.sha256
  && capture.bytes > 0
  && capture.width === capture.expectedWidth
  && capture.height === capture.expectedHeight
)) && new Set(captureHashes).size === captureArtifacts.length

const manifest = {
  schemaVersion: 5,
  appVersion: '1.0',
  generatedAt: '2026-08-14',
  figmaAuditAt: '2026-08-14',
  status: captureArtifactsVerified ? 'verified' : 'capture-pending',
  ...(captureArtifactsVerified ? { verifiedAt: '2026-08-14' } : {}),
  source: 'docs/app/interactive-prototype/page-catalog.js',
  captureViewport: { width: 1600, height: 1000 },
  figmaFinal: {
    fileKey: FIGMA_FILE_KEY,
    fileUrl: FIGMA_DESIGN_URL,
    finalVersionId: FIGMA_FINAL_VERSION_ID,
    versionNote: '该版本 ID 为历史冻结点；当前事实源为同一 fileKey 的实时文件，2026-08-14 已完成 408 个正式状态登记；APP-SET-08 已补齐补充、升级和三个终态结果页。全量交互统计留待开发结束后统一重算。',
    scope: '移动端 50 页、管理后台 49 页及全部 408 个需求状态',
    status: 'final-deliverable',
    officialPages: {
      mobile: '10｜Mobile Pages',
      admin: '20｜Admin Pages',
      flows: '30｜Prototype Flows',
      deliveryIndex: '40｜Delivery Index',
      qaHandoff: '50｜QA & Handoff'
    },
    audit: {
      pageCoverage: '99/99',
      stateCoverage: '408/408',
      mobileStateCoverage: '208/208',
      adminStateCoverage: '200/200',
      flowPreviews: FIGMA_FINAL_DELIVERY.flowPreviews,
      historicalActionBaseline: {
        scope: 'APP-SET-08 增量六态前',
        pageActions:
          FIGMA_FINAL_DELIVERY.mobilePageActions
          + FIGMA_FINAL_DELIVERY.adminPageActions,
        flowActions:
          FIGMA_FINAL_DELIVERY.mobileFlowActions
          + FIGMA_FINAL_DELIVERY.adminFlowActions,
        totalActions: FIGMA_FINAL_DELIVERY.historicalActionBaseline,
        missingDestinations: FIGMA_FINAL_DELIVERY.missingDestinations
      },
      undersizedMobileTouchTargets:
        FIGMA_FINAL_DELIVERY.undersizedMobileTouchTargets,
      unstyledText: FIGMA_FINAL_DELIVERY.unstyledText,
      rawFills: FIGMA_FINAL_DELIVERY.rawFills,
      rawStrokes: FIGMA_FINAL_DELIVERY.rawStrokes,
      missingFonts: FIGMA_FINAL_DELIVERY.missingFonts,
      textOverflow: FIGMA_FINAL_DELIVERY.textOverflow
    }
  },
  counts,
  pages: enrichedPages,
  captures,
  figmaStateCaptures,
  supplementalFigmaCaptures
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

function supplementalFigmaStateLines(page) {
  const pageCaptures = supplementalFigmaStateSpecs[page.pageId] || []
  if (!pageCaptures.length) return []
  const delivery = supplementalFigmaDelivery[page.pageId]
  const hasSupportFrames = delivery.supportFrames > 0
  const deliverySummary = hasSupportFrames
    ? `正式稿共 ${delivery.formalActions} 个有效动作，支持 Section \`${delivery.supportSectionId}\` 含 ${delivery.supportFrames} 张交互支持稿和 ${delivery.supportActions} 个有效动作，失效目标与不足 44dp 热区均为 0。`
    : `正式稿共 ${delivery.formalActions} 个有效动作，位于正式页面 Section \`${delivery.supportSectionId}\`；失效目标与不足 44dp 热区均为 0。`
  const lines = [
    `**Figma 逐状态交付：** 本页 ${pageCaptures.length} 个正式需求状态均已完成独立 Frame、交互和截图复核；${deliverySummary}`,
    '',
    `- [打开 Figma ${hasSupportFrames ? '交互支持' : '正式页面'} Section](${figmaDesignNodeUrl(delivery.supportSectionId)})`,
    ''
  ]
  for (const [index, capture] of pageCaptures.entries()) {
    const prototypeUrl = figmaPrototypeUrl(
      capture.frameId,
      page.platform === 'mobile' ? FIGMA_MOBILE_PAGE_ID : FIGMA_ADMIN_PAGE_ID
    )
    lines.push(
      `**状态 ${index + 1}｜${capture.state}｜\`${capture.frameId}\`**`,
      '',
      `- 触发条件：${capture.trigger}`,
      `- 关键交互：${capture.interaction}`,
      `- 预期结果：${capture.expected}`,
      `- 权威边界：${capture.authority}`,
      `- [打开 Figma 交互原型](${prototypeUrl})`,
      '',
      `![${page.pageId} ${page.pageName} Figma 状态“${capture.state}”原型](./assets/page-prototypes/${capture.image})`,
      ''
    )
  }
  if (delivery.supportScreens?.length) {
    lines.push('**交互支持稿（不新增正式需求状态）：**', '')
    for (const screen of delivery.supportScreens) {
      lines.push(
        `**${screen.title}｜\`${screen.frameId}\`**`,
        '',
        `- ${screen.description}`,
        `- [打开 Figma 设计节点](${figmaDesignNodeUrl(screen.frameId)})`,
        '',
        `![${page.pageId} ${page.pageName} ${screen.title}交互支持稿](./assets/page-prototypes/${screen.image})`,
        ''
      )
    }
  }
  return lines
}

function figmaFinalMappingLine(page) {
  if (page.pageId === 'APP-SET-08') {
    return '**Figma 最终稿映射：** `10｜Mobile Pages` → `APP-SET-08`，共 9 个需求状态：'
      + '正常 `159:73873`、已有处理中 `159:73925`、提交失败 `159:73978`、'
      + '补充说明 `1118:3615`、补充提交失败 `1123:3616`、升级处理中 `1123:3668`、'
      + '维持原结论 `1130:3617`、申诉成立 `1132:3618`、已关闭 `1132:3670`。'
  }
  return `**Figma 最终稿映射：** \`${page.figmaDesignPage}\` → `
    + `\`${page.pageId}\`，共 ${page.figmaDesignedStateCount} 个需求状态；`
    + `在 [Figma 最终设计文件](${FIGMA_DESIGN_URL}) 中按 Page ID 定位。`
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
    figmaFinalMappingLine(page),
    '',
    '**页面级验收：**',
    ''
  ]
  for (const item of page.acceptance) lines.push(`- ${item}`)
  if (page.pageId === 'APP-SET-08') {
    lines.push(
      '- 创建与补充必须幂等；网络失败的显式重试复用请求标识，并发已创建案件恢复现有案件。',
      '- 举报结论、账号限制与金币分录按入口上下文隔离；无上下文时按 `updatedAt` 展示最新案件。',
      '- 升级复核与终态禁止补充；三个终态必须使用各自 Figma 结果页，申诉不会直接改写原业务对象。'
    )
  }
  if (page.figmaStates.length) {
    lines.push('', ...detailedFigmaStateLines(page))
  } else if (supplementalFigmaStateSpecs[page.pageId]?.length) {
    lines.push('', ...supplementalFigmaStateLines(page))
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
    figmaFinalMappingLine(page),
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
  if (page.pageId === 'APP-SET-08') {
    lines.push(
      '- 创建与补充必须幂等；网络失败的显式重试复用请求标识，并发已创建案件恢复现有案件。',
      '- 举报结论、账号限制与金币分录按入口上下文隔离；无上下文时按 `updatedAt` 展示最新案件。',
      '- 升级复核与终态禁止补充；三个终态必须使用各自 Figma 结果页，申诉不会直接改写原业务对象。'
    )
  }
  lines.push(
    '- UI 层、状态层、数据层和服务端契约不得使用页面展示名称替代稳定 ID、rank、entitlement 或状态枚举。',
    '- 加载、空、错误、离线、无权限、对象失效和服务端状态变化必须按本页状态集合安全收敛。',
    ''
  )
  if (page.figmaStates.length) {
    lines.push(...detailedFigmaStateLines(page))
  } else if (supplementalFigmaStateSpecs[page.pageId]?.length) {
    lines.push(...supplementalFigmaStateLines(page))
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
  '更新日期：2026-08-14',
  '',
  '状态：需求讨论中，待客户确认',
  '',
  '## 1. 文档用途',
  '',
  `本文是 ${counts.pages} 个页面级功能对象的详细说明和原型映射基线。每个 Page ID 独立描述用户价值、角色、前置条件、进入路径、页面结构、详细交互、业务规则、页面状态、数据权限、需求追踪、验收标准和客户确认项。`,
  '',
  'Page ID、设计路由、Figma Node ID 和状态 key 是设计交付、实现映射与测试追踪元数据，不是真实产品 UI 文案；除非产品需求另行定义面向用户的业务编号，否则 KMP 与 Nuxt 页面不得可见渲染这些标注。',
  '',
  `Figma 最终设计已覆盖移动端 ${counts.mobilePages} 页、管理后台 ${counts.adminPages} 页和全部 ${counts.figmaDesignedStates} 个正式需求状态，并建立 ${counts.figmaFlowPreviews} 个流程预览。${counts.figmaHistoricalActionBaseline.toLocaleString('en-US')} 个有效交互动作是 APP-SET-08 增量六态前的历史基线，开发结束后统一重算。客户文档保留 ${counts.defaultCaptures} 张默认状态、${counts.keyStateCaptures} 张 P0 关键状态和通知/金币 23 张逐状态注册导出，共 ${counts.documentPrototypeMappings} 个 manifest 确定性图片映射；APP-DSC-01 至 APP-DSC-09、APP-INT-06 与 ADM-PRI-01/02 的逐状态 Figma 图直接进入本 MD。图片均通过 Page ID、状态与 Frame ID 关联，不通过章节位置猜测。`,
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
  `| Figma 最终设计页面 | ${counts.figmaDesignedPages} |`,
  `| Figma 最终设计状态 | ${counts.figmaDesignedStates}（移动端 ${counts.figmaMobileStates} / 后台 ${counts.figmaAdminStates}） |`,
  `| Figma 流程预览 | ${counts.figmaFlowPreviews} |`,
  `| Figma 有效交互动作（APP-SET-08 增量前历史基线） | ${counts.figmaHistoricalActionBaseline} |`,
  `| 通知与金币逐状态本地导出 | ${counts.detailedFigmaPages} 页 / ${counts.detailedFigmaStateCaptures} 张 |`,
  '| 发现页逐状态 MD 直嵌 | 9 页 / 38 正式状态（16 张注册图 + 22 张补充图） |',
  '| 发现页交互支持稿 | 7 页 / 96 张（不新增正式需求状态） |',
  `| 客户文档图片映射总数 | ${counts.documentPrototypeMappings} |`,
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
  '更新日期：2026-08-14',
  '',
  '状态：需求讨论中；客户确认结论同步后作为开发排期与实现验收基线',
  '',
  '> 本文由产品总需求、App 1.0 发布范围和统一页面目录确定性生成。DOCX 只用于客户阅读与确认；研发、测试、接口设计和任务拆分统一引用本 Markdown、需求编号和 Page ID。',
  '',
  '## 1. 文档定位与使用规则',
  '',
  `1. 本文是 App 1.0 面向开发的单一入口，覆盖产品范围、需求编号、技术边界、${counts.pages} 个页面级实现对象、${counts.figmaDesignedStates} 个 Figma 正式设计状态、${counts.documentPrototypeMappings} 个客户文档 manifest 图片映射、APP-DSC-01 至 APP-DSC-09、APP-INT-06 与 ADM-PRI-01/02 的逐状态 Figma 图和开发验收。`,
  '2. 客户意见先同步到产品总需求、发布范围、Feature PRD 和页面目录，再重新生成本文与客户 DOCX；不得直接在 DOCX 中维护独立需求。',
  '3. 开发任务、接口、测试用例、缺陷和变更必须至少引用一个 `PRD/SCP` 编号和一个 Page ID；纯后端门禁可引用需求编号并标注“无独立页面”。',
  '4. 原型用于确认信息层级、交互和状态表达，不替代服务端权限、数据状态机、API 契约或安全门禁。',
  '5. Page ID、设计路由、Figma Node ID 和状态 key 仅用于交付与追踪，不得作为可见文案渲染到 KMP 或 Nuxt 真实 UI；面向用户的业务编号必须由独立产品需求定义。',
  '6. 发生冲突时按“客户已确认结论 → App 1.0 发布范围 → 产品总需求 → Feature PRD → 本文逐页规格 → 原型”处理，并先修订上游再重新生成下游。',
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
  `| Figma 最终设计页面 | ${counts.figmaDesignedPages} |`,
  `| Figma 最终设计状态 | ${counts.figmaDesignedStates}（移动端 ${counts.figmaMobileStates} / 后台 ${counts.figmaAdminStates}） |`,
  `| Figma 页面内 / 流程动作（APP-SET-08 增量前历史基线） | ${counts.figmaHistoricalPageActionBaseline} / ${counts.figmaHistoricalFlowActionBaseline} |`,
  `| Figma 有效交互动作总数（APP-SET-08 增量前历史基线） | ${counts.figmaHistoricalActionBaseline} |`,
  `| 通知与金币逐状态本地导出 | ${counts.detailedFigmaPages} 页 / ${counts.detailedFigmaStateCaptures} 张 |`,
  '| 发现页逐状态 MD 直嵌 | 9 页 / 38 正式状态（16 张注册图 + 22 张补充图） |',
  '| 发现页交互支持稿 | 7 页 / 96 张（不新增正式需求状态） |',
  `| 客户文档图片映射总数 | ${counts.documentPrototypeMappings} |`,
  `| 已建立需求追踪的页面 | ${enrichedPages.length} |`,
  '',
  '### 2.1 Figma 最终设计交付',
  '',
  `- 最终文件：[Peachmote UI 借鉴审查板 - MeiGallery](${FIGMA_DESIGN_URL})；最终版本 ID：\`${FIGMA_FINAL_VERSION_ID}\`。`,
  `- \`10｜Mobile Pages\` 覆盖 ${counts.mobilePages} 个 Page ID、${counts.figmaMobileStates} 个状态；\`20｜Admin Pages\` 覆盖 ${counts.adminPages} 个 Page ID、${counts.figmaAdminStates} 个状态。`,
  `- \`30｜Prototype Flows\` 覆盖 ${counts.figmaFlowPreviews} 个流程预览；${counts.figmaHistoricalActionBaseline} 个页面内与流程动作及缺失目标 0 只代表 APP-SET-08 增量六态前的历史基线，当前动作总数待开发结束后统一重算。`,
  '- `40｜Delivery Index` 按 Page ID 提供页面索引和需求追踪；`50｜QA & Handoff` 提供视觉、交互、边界和交付门禁。',
  '- 最终 QA 中未发现未绑定文字样式、原始填充/描边、缺失字体、文字溢出或移动端不足 44dp 的关键点击热区。',
  `- 开发以 Page ID、状态名称和需求追踪键定位设计；客户文档中的 ${counts.documentPrototypeMappings} 张图用于离线逐页确认，不替代 Figma 中 ${counts.figmaDesignedStates} 个最终状态。`,
  '- **Figma-first 门禁**：任何新增或变更的用户可见页面、弹层、状态和跨页流程，必须先在正式 Figma 页面完成独立 Frame、Prototype 目标、Delivery Index 映射与交付审计，再进入 KMP/Nuxt 实现；设计缺口不得由代码临时发明。',
  '',
  '### 2.2 App 1.0 实现范围',
  '',
  '- Android/iOS 观看者客户端：KMP + Compose Multiplatform，共享业务、状态、网络、缓存和主要 UI。',
  '- 桌面运营端：现有 Nuxt 管理后台，覆盖真人供给、认证发布、推荐运营、平台话题、会员申请与发放、金币调整、安全审核和审计。',
  '- 后端与数据：复用现有 MeiGallery 数据并通过共享业务平台渐进迁移；App 不直接读取 legacy 表。',
  '- 商业能力：只做五级会员展示、站内申请、管理员手动发放、金币余额与追加式明细。',
  '- 通知：站内拉取和实时刷新完成全部核心流程，不依赖系统推送。',
  '',
  '### 2.3 App 1.0 明确不实现',
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
  '- 客户端与后台覆盖本页声明的全部状态；实现截图与 Figma 同一 Page ID、同一状态在相同视口下完成视觉回归。',
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
  '更新时间：2026-08-14',
  '',
  '状态：需求讨论中，待客户确认',
  '',
  '## 1. 文档目的',
  '',
  `本文把产品总需求、App 1.0 发布范围、Feature PRD、${counts.pages} 个 Page ID、${counts.figmaDesignedStates} 个 Figma 最终设计状态与 ${counts.documentPrototypeMappings} 个客户文档图片映射建立确定性关系，并作为开发需求规格的追踪索引。任何页面或原型不得脱离需求编号单独成为实现依据；任何 App 1.0 用户可见需求也不得在没有 Page ID、明确非 UI 验收或未来范围说明的情况下进入开发。`,
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
  `| Figma 最终设计页面 | ${counts.figmaDesignedPages} |`,
  `| Figma 最终设计状态 | ${counts.figmaDesignedStates} |`,
  `| Figma 流程预览 / 历史动作基线 | ${counts.figmaFlowPreviews} / ${counts.figmaHistoricalActionBaseline}（APP-SET-08 增量前） |`,
  `| 通知与金币逐状态本地导出 | ${counts.detailedFigmaPages} 页 / ${counts.detailedFigmaStateCaptures} 张 |`,
  `| 客户文档图片映射总数 | ${counts.documentPrototypeMappings} |`,
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
  `- ${counts.p0Pages} 个 P0 页面必须额外存在一张关键异常、受限、冲突或处理中状态原型。`,
  `- ${counts.pages} 个 Page ID 的 ${counts.figmaDesignedStates} 个需求状态必须全部存在于 Figma 最终页，并按 Page ID、状态名称、模块和需求追踪键定位；\`30｜Prototype Flows\` 必须覆盖 ${counts.figmaFlowPreviews} 个流程预览。`,
  `- ${counts.figmaHistoricalActionBaseline.toLocaleString('en-US')} 个页面内与流程动作是 APP-SET-08 增量六态前的历史基线；开发结束后必须重算，增量期间每个新增状态单独核对缺失目标和 44dp 移动端关键热区。`,
  '- `APP-MSG-05`、`APP-MSG-06`、`APP-WAL-01`、`APP-WAL-02`、`APP-WAL-03` 另外保留 23 张逐状态本地导出图；每张图都具备唯一 Frame ID、触发条件、关键交互、预期结果和权威边界。',
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
