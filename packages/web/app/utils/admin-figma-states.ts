import type { AdminFigmaPageId } from './admin-figma-pages'
import { ADMIN_FIGMA_PAGES } from './admin-figma-pages'

/**
 * Figma `11｜Admin Pages` 八个正式模块 Section 中的完整 200 个状态。
 *
 * 状态名与节点 ID 直接来自 Figma 文件 `LaNSwwGsznwcpV8msj7BQC`。页面可以额外显示
 * 加载提示等运行微状态，但页面构图必须绑定到这里的一个正式状态，禁止把临时文案当成新画板。
 */
export interface AdminFigmaStateSpec {
  pageId: AdminFigmaPageId
  stateName: string
  nodeId: string
}

const state = (pageId: AdminFigmaPageId, stateName: string, nodeId: string): AdminFigmaStateSpec => ({
  pageId,
  stateName,
  nodeId,
})

export const ADMIN_FIGMA_STATES: readonly AdminFigmaStateSpec[] = [
  state('ADM-OV-01', '正常', '159:85816'),
  state('ADM-OV-01', '数据延迟', '159:86013'),
  state('ADM-OV-01', '质量异常', '159:86212'),
  state('ADM-OV-01', '部分无权限', '159:86408'),
  state('ADM-OV-02', '正常', '159:86604'),
  state('ADM-OV-02', 'P0/P1', '159:86808'),
  state('ADM-OV-02', '未分配', '159:87011'),
  state('ADM-OV-02', '已缓解', '159:87215'),
  state('ADM-OV-03', '正常', '159:87418'),
  state('ADM-OV-03', '影响扩大', '159:87607'),
  state('ADM-OV-03', '并发更新', '159:87796'),
  state('ADM-OV-03', '证据不足', '159:87985'),
  state('ADM-PER-01', '正常', '159:88177'),
  state('ADM-PER-01', '草稿', '159:88381'),
  state('ADM-PER-01', '待审', '159:88585'),
  state('ADM-PER-01', '已发布', '159:88789'),
  state('ADM-PER-01', '已暂停', '159:88992'),
  state('ADM-PER-01', '争议', '159:89196'),
  state('ADM-PER-02', '正常', '159:89400'),
  state('ADM-PER-02', '缺少来源', '159:89571'),
  state('ADM-PER-02', '重复候选', '159:89742'),
  state('ADM-PER-02', '媒体失败', '159:89913'),
  state('ADM-PER-03', '正常', '159:90083'),
  state('ADM-PER-03', '认证待审', '159:90272'),
  state('ADM-PER-03', '发布待审', '159:90461'),
  state('ADM-PER-03', '授权过期', '159:90650'),
  state('ADM-PER-04', '正常', '159:90838'),
  state('ADM-PER-04', '校验中', '159:91042'),
  state('ADM-PER-04', '部分失败', '159:91248'),
  state('ADM-PER-04', '已暂停', '159:91451'),
  state('ADM-PER-04', '已完成', '159:91655'),
  state('ADM-PER-05', '正常', '159:91858'),
  state('ADM-PER-05', '证据不足', '159:92047'),
  state('ADM-PER-05', '版本冲突', '159:92236'),
  state('ADM-PER-05', '需要复核', '159:92424'),
  state('ADM-PER-06', '正常', '159:92613'),
  state('ADM-PER-06', '未认证', '159:92802'),
  state('ADM-PER-06', '授权失效', '159:92991'),
  state('ADM-PER-06', '投影失败', '159:93179'),
  state('ADM-REC-01', '正常', '159:95447'),
  state('ADM-REC-01', '当前生效', '159:95651'),
  state('ADM-REC-01', '灰度中', '159:95854'),
  state('ADM-REC-01', '已回滚', '159:96058'),
  state('ADM-REC-02', '正常', '159:96261'),
  state('ADM-REC-02', 'Schema 错误', '159:96423'),
  state('ADM-REC-02', '触碰安全过滤', '159:96584'),
  state('ADM-REC-02', '并发冲突', '159:96746'),
  state('ADM-REC-03', '正常', '159:96907'),
  state('ADM-REC-03', '样本不足', '159:97067'),
  state('ADM-REC-03', '数据延迟', '159:97227'),
  state('ADM-REC-04', '正常', '159:97389'),
  state('ADM-REC-04', '时间冲突', '159:97593'),
  state('ADM-REC-04', '资料下架', '159:97796'),
  state('ADM-SRC-01', '正常', '965:17409'),
  state('ADM-SRC-01', '加载中', '965:17620'),
  state('ADM-SRC-01', '加载失败', '965:17834'),
  state('ADM-SRC-01', '尚未就绪', '965:18048'),
  state('ADM-SRC-01', '无策略版本', '965:18259'),
  state('ADM-TAX-01', '正常', '159:93370'),
  state('ADM-TAX-01', '草稿目录', '159:93530'),
  state('ADM-TAX-01', '生效目录', '159:93690'),
  state('ADM-TAX-01', '归档目录', '159:93849'),
  state('ADM-TAX-02', '正常', '159:94009'),
  state('ADM-TAX-02', '被引用', '159:94198'),
  state('ADM-TAX-02', '合并冲突', '159:94387'),
  state('ADM-TAX-02', '版本过期', '159:94575'),
  state('ADM-TAX-03', '正常', '159:94763'),
  state('ADM-TAX-03', '未知引用', '159:94934'),
  state('ADM-TAX-03', '客户端不兼容', '159:95105'),
  state('ADM-TAX-03', '待复核', '159:95276'),
  state('ADM-MSG-01', '正常', '159:98003'),
  state('ADM-MSG-01', '待分配', '159:98207'),
  state('ADM-MSG-01', '待平台', '159:98411'),
  state('ADM-MSG-01', '待用户', '159:98615'),
  state('ADM-MSG-01', '安全审核', '159:98819'),
  state('ADM-MSG-02', '正常', '159:99023'),
  state('ADM-MSG-02', '租约冲突', '159:99198'),
  state('ADM-MSG-02', '只读', '159:99372'),
  state('ADM-MSG-02', '冻结', '159:99547'),
  state('ADM-MSG-02', '关闭', '159:99721'),
  state('ADM-MSG-03', '无值班', '159:100058'),
  state('ADM-MSG-03', '过载', '159:100220'),
  state('ADM-MSG-03', '配置冲突', '159:100382'),
  state('ADM-MSG-03', '正常', '159:99896'),
  state('ADM-MSG-04', '正常', '159:100543'),
  state('ADM-MSG-04', '无正文授权', '159:100747'),
  state('ADM-MSG-04', '披露缺失', '159:100951'),
  state('ADM-SAF-01', '正常', '159:101158'),
  state('ADM-SAF-01', 'P0', '159:101347'),
  state('ADM-SAF-01', '超时', '159:101535'),
  state('ADM-SAF-01', '未分配', '159:101724'),
  state('ADM-SAF-02', '正常', '159:101913'),
  state('ADM-SAF-02', '证据受限', '159:102102'),
  state('ADM-SAF-02', '并发冲突', '159:102291'),
  state('ADM-SAF-02', '已冻结', '159:102479'),
  state('ADM-SAF-03', '正常', '159:102667'),
  state('ADM-SAF-03', '原审核人隔离', '159:102871'),
  state('ADM-SAF-03', '逾期', '159:103075'),
  state('ADM-SAF-04', '正常', '159:103279'),
  state('ADM-SAF-04', '证据不足', '159:103468'),
  state('ADM-SAF-04', '需要升级', '159:103657'),
  state('ADM-MBR-01', '正常', '159:103849'),
  state('ADM-MBR-01', '草稿', '159:104119'),
  state('ADM-MBR-01', '生效', '159:104389'),
  state('ADM-MBR-01', '待回滚', '159:104658'),
  state('ADM-MBR-02', '正常', '159:104928'),
  state('ADM-MBR-02', '未知客户端', '159:105090'),
  state('ADM-MBR-02', '合并冲突', '159:105252'),
  state('ADM-MBR-03', '待处理', '159:105413'),
  state('ADM-MBR-03', '处理中', '159:105575'),
  state('ADM-MBR-03', '待补充', '159:105739'),
  state('ADM-MBR-03', '已通过', '159:105901'),
  state('ADM-MBR-03', '已拒绝', '159:106062'),
  state('ADM-MBR-03', '直接发放', '159:106224'),
  state('ADM-MBR-04', '正常', '159:106385'),
  state('ADM-MBR-04', '账号错误', '159:106547'),
  state('ADM-MBR-04', '高风险', '159:106708'),
  state('ADM-MBR-04', '重复业务单', '159:106869'),
  state('ADM-MBR-05', '正常', '159:107031'),
  state('ADM-MBR-05', '发起人冲突', '159:107220'),
  state('ADM-MBR-05', '账号状态已变', '159:107408'),
  state('ADM-MBR-06', '正常', '159:107597'),
  state('ADM-MBR-06', '证据不足', '159:107801'),
  state('ADM-MBR-06', '映射冲突', '159:108005'),
  state('ADM-MBR-07', '待复核', '966:17714'),
  state('ADM-MBR-07', '加载中', '966:17928'),
  state('ADM-MBR-07', '加载失败', '966:18145'),
  state('ADM-MBR-07', '空队列', '966:18364'),
  state('ADM-MBR-07', '仅本人发起', '966:18550'),
  state('ADM-MBR-07', '账号已变化', '966:18764'),
  state('ADM-WAL-01', '正常', '159:108208'),
  state('ADM-WAL-01', '账号受限', '159:108412'),
  state('ADM-WAL-01', '对账异常', '159:108616'),
  state('ADM-WAL-02', '正常', '159:108819'),
  state('ADM-WAL-02', '余额锁定', '159:108992'),
  state('ADM-WAL-02', 'Sequence 异常', '159:109165'),
  state('ADM-WAL-03', '正常', '159:109337'),
  state('ADM-WAL-03', '预计负余额', '159:109499'),
  state('ADM-WAL-03', '高风险', '159:109661'),
  state('ADM-WAL-03', '重复业务单', '159:109822'),
  state('ADM-WAL-04', '正常', '159:109984'),
  state('ADM-WAL-04', '余额已变化', '159:110173'),
  state('ADM-WAL-04', '发起人冲突', '159:110362'),
  state('ADM-WAL-05', '正常', '159:110550'),
  state('ADM-WAL-05', '部分成功', '159:110754'),
  state('ADM-WAL-05', '重复项', '159:110958'),
  state('ADM-WAL-05', '总额异常', '159:111162'),
  state('ADM-WAL-06', '正常', '159:111365'),
  state('ADM-WAL-06', '钱包冻结', '159:111569'),
  state('ADM-WAL-06', '差异未解释', '159:111772'),
  state('ADM-AUD-01', '正常', '159:113963'),
  state('ADM-AUD-01', '范围过大', '159:114167'),
  state('ADM-AUD-01', '完整性告警', '159:114371'),
  state('ADM-AUD-02', '正常', '159:114575'),
  state('ADM-AUD-02', '关联缺失', '159:114764'),
  state('ADM-AUD-02', '敏感字段受限', '159:114953'),
  state('ADM-AUD-03', '正常', '159:115142'),
  state('ADM-AUD-03', 'Sequence 缺口', '159:115346'),
  state('ADM-AUD-03', '业务无审计', '159:115550'),
  state('ADM-AUD-04', '正常', '159:115754'),
  state('ADM-AUD-04', '待批准', '159:115916'),
  state('ADM-AUD-04', '已过期', '159:116078'),
  state('ADM-AUD-04', '范围变化', '159:116239'),
  state('ADM-AUD-05', '正常', '967:18080'),
  state('ADM-AUD-05', '加载中', '967:18297'),
  state('ADM-AUD-05', '加载失败', '967:18517'),
  state('ADM-AUD-05', '未登记 Action', '967:18739'),
  state('ADM-AUD-05', '治理阻断', '967:18956'),
  state('ADM-AUD-05', '候选编辑', '967:19176'),
  state('ADM-AUD-05', '提交失败', '967:19383'),
  state('ADM-AUD-06', '待复核', '969:18507'),
  state('ADM-AUD-06', '加载中', '969:18673'),
  state('ADM-AUD-06', '加载失败', '969:18842'),
  state('ADM-AUD-06', '申请人冲突', '969:19013'),
  state('ADM-AUD-06', '基线变化', '969:19177'),
  state('ADM-AUD-06', '终态只读', '969:19341'),
  state('ADM-NTF-01', '正常', '159:111978'),
  state('ADM-NTF-01', '未登记', '159:112140'),
  state('ADM-NTF-01', '已停用', '159:112302'),
  state('ADM-NTF-02', '正常', '159:112464'),
  state('ADM-NTF-02', '变量缺失', '159:112635'),
  state('ADM-NTF-02', '地区冲突', '159:112806'),
  state('ADM-NTF-02', '语言冲突', '159:112976'),
  state('ADM-NTF-03', '正常', '159:113146'),
  state('ADM-NTF-03', '积压', '159:113350'),
  state('ADM-NTF-03', '模板失败', '159:113556'),
  state('ADM-NTF-03', '重复抑制', '159:113759'),
  state('ADM-PRI-01', '正常', '939:15995'),
  state('ADM-PRI-01', '加载中', '942:16120'),
  state('ADM-PRI-01', '加载失败', '942:16342'),
  state('ADM-PRI-01', '空队列', '942:16556'),
  state('ADM-PRI-01', '治理门禁关闭', '942:16770'),
  state('ADM-PRI-01', '已逾期', '942:16984'),
  state('ADM-PRI-02', '正常', '944:16747'),
  state('ADM-PRI-02', '加载中', '945:16842'),
  state('ADM-PRI-02', '加载失败', '945:17043'),
  state('ADM-PRI-02', '待领取', '945:17245'),
  state('ADM-PRI-02', 'Privacy-2 门禁关闭', '945:17448'),
  state('ADM-PRI-02', '操作失败', '945:17651'),
  state('ADM-PRI-02', '终态只读', '945:17853'),
]

const stateByKey = new Map(
  ADMIN_FIGMA_STATES.map(item => [`${item.pageId}:${item.stateName}`, item] as const),
)

const missingPrimaryPages = (Object.entries(ADMIN_FIGMA_PAGES) as Array<[
  AdminFigmaPageId,
  (typeof ADMIN_FIGMA_PAGES)[AdminFigmaPageId],
]>).filter(([pageId, page]) => (
  !ADMIN_FIGMA_STATES.some(item => item.pageId === pageId && item.nodeId === page.nodeId)
))
if (missingPrimaryPages.length) {
  throw new Error(`后台页面主节点未登记到 Figma 正式状态清单：${missingPrimaryPages.map(([pageId]) => pageId).join('、')}`)
}

if (ADMIN_FIGMA_STATES.length !== 200 || stateByKey.size !== ADMIN_FIGMA_STATES.length) {
  throw new Error('后台 Figma 正式状态必须保持 200 个，且同一页面内状态名不得重复。')
}

export function getAdminFigmaState(pageId: AdminFigmaPageId, stateName: string) {
  return stateByKey.get(`${pageId}:${stateName}`)
}

/**
 * 可见后台页面必须显式绑定一个正式 Figma 状态。
 *
 * 运行提示可以继续使用独立文案，但调用方必须通过 `figmaState` 明确声明当前构图采用的
 * 正式状态；状态名拼写错误或跨页面复用会立即失败，不允许静默回落到主状态。
 */
export function requireAdminFigmaState(pageId: AdminFigmaPageId, stateName: string) {
  const exactState = getAdminFigmaState(pageId, stateName)
  if (exactState) {
    return exactState
  }

  const availableStates = ADMIN_FIGMA_STATES
    .filter(item => item.pageId === pageId)
    .map(item => item.stateName)
    .join('、')
  throw new Error(`后台页面 ${pageId} 未登记 Figma 状态“${stateName}”。可用状态：${availableStates}`)
}
