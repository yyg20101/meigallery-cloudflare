/**
 * 后台 49 个正式页面与 Figma 主状态节点的唯一代码侧映射。
 *
 * 可见后台页面必须从这里取得 Page ID、路由和节点；禁止在页面里另造未设计路由。
 * 动态路由使用 `{param}` 表示设计契约，页面运行时可通过 AppPageHeader.route 展示实际路径。
 */
export const ADMIN_FIGMA_PAGES = {
  'ADM-OV-01': { route: '/admin/app', title: '运营总览', nodeId: '159:85816' },
  'ADM-OV-02': { route: '/admin/app/incidents', title: '异常中心', nodeId: '159:86604' },
  'ADM-OV-03': { route: '/admin/app/incidents/{id}', title: '异常详情', nodeId: '159:87418' },
  'ADM-PER-01': { route: '/admin/app/persons', title: '真人列表', nodeId: '159:88177' },
  'ADM-PER-02': { route: '/admin/app/persons/new', title: '手动新建真人', nodeId: '159:89400' },
  'ADM-PER-03': { route: '/admin/app/persons/{id}', title: '真人工作台', nodeId: '159:90083' },
  'ADM-PER-04': { route: '/admin/app/imports', title: '导入任务', nodeId: '159:90838' },
  'ADM-PER-05': { route: '/admin/app/verifications/{id}', title: '认证审核', nodeId: '159:91858' },
  'ADM-PER-06': { route: '/admin/app/publications/{id}', title: '发布审核', nodeId: '159:92613' },
  'ADM-TAX-01': { route: '/admin/app/taxonomy', title: 'Taxonomy 目录树', nodeId: '159:93370' },
  'ADM-TAX-02': { route: '/admin/app/taxonomy/{termId}', title: '词条详情', nodeId: '159:94009' },
  'ADM-TAX-03': { route: '/admin/app/taxonomy/releases/{id}', title: '目录发布', nodeId: '159:94763' },
  'ADM-REC-01': { route: '/admin/app/recommendation/rules', title: '推荐规则版本', nodeId: '159:95447' },
  'ADM-REC-02': { route: '/admin/app/recommendation/rules/{id}', title: '推荐规则编辑', nodeId: '159:96261' },
  'ADM-REC-03': { route: '/admin/app/recommendation/rules/{id}/preview', title: '推荐 Dry-run', nodeId: '159:96907' },
  'ADM-REC-04': { route: '/admin/app/recommendation/placements', title: '运营精选', nodeId: '159:97389' },
  'ADM-SRC-01': { route: '/admin/app/search', title: '搜索运营核查', nodeId: '965:17409' },
  'ADM-MSG-01': { route: '/admin/app/conversations', title: '会话队列', nodeId: '159:98003' },
  'ADM-MSG-02': { route: '/admin/app/conversations/{id}', title: '会话工作台', nodeId: '159:99023' },
  'ADM-MSG-03': { route: '/admin/app/conversation-groups', title: '分组与班次', nodeId: '159:99896' },
  'ADM-MSG-04': { route: '/admin/app/conversation-quality', title: '会话质量与抽检', nodeId: '159:100543' },
  'ADM-SAF-01': { route: '/admin/app/reviews', title: '安全审核队列', nodeId: '159:101158' },
  'ADM-SAF-02': { route: '/admin/app/reviews/{caseId}', title: '安全案件详情', nodeId: '159:101913' },
  'ADM-SAF-03': { route: '/admin/app/appeals', title: '申诉队列', nodeId: '159:102667' },
  'ADM-SAF-04': { route: '/admin/app/appeals/{id}', title: '申诉详情', nodeId: '159:103279' },
  'ADM-MBR-01': { route: '/admin/app/membership/catalogs', title: '五级会员目录', nodeId: '159:103849' },
  'ADM-MBR-02': { route: '/admin/app/entitlements', title: 'Entitlement 定义', nodeId: '159:104928' },
  'ADM-MBR-03': { route: '/admin/app/membership/applications', title: '会员申请与发放队列', nodeId: '159:105413' },
  'ADM-MBR-04': { route: '/admin/app/membership/grants/new', title: '会员发放申请', nodeId: '159:106385' },
  'ADM-MBR-05': { route: '/admin/app/membership/reviews/{id}', title: '会员发放复核', nodeId: '159:107031' },
  'ADM-MBR-06': { route: '/admin/app/membership/migrations', title: '旧会员映射', nodeId: '159:107597' },
  'ADM-MBR-07': { route: '/admin/app/membership/reviews', title: '会员变更复核队列', nodeId: '966:17714' },
  'ADM-WAL-01': { route: '/admin/app/wallets', title: '钱包查询', nodeId: '159:108208' },
  'ADM-WAL-02': { route: '/admin/app/wallets/{accountId}', title: '钱包详情', nodeId: '159:108819' },
  'ADM-WAL-03': { route: '/admin/app/coin-adjustments/new', title: '调币申请', nodeId: '159:109337' },
  'ADM-WAL-04': { route: '/admin/app/coin-adjustments/{id}/review', title: '调币复核', nodeId: '159:109984' },
  'ADM-WAL-05': { route: '/admin/app/coin-adjustment-batches', title: '批量调币任务', nodeId: '159:110550' },
  'ADM-WAL-06': { route: '/admin/app/reconciliation', title: '钱包对账差异', nodeId: '159:111365' },
  'ADM-NTF-01': { route: '/admin/app/notifications/events', title: '通知事件定义', nodeId: '159:111978' },
  'ADM-NTF-02': { route: '/admin/app/notifications/templates/{id}', title: '通知模板版本', nodeId: '159:112464' },
  'ADM-NTF-03': { route: '/admin/app/notifications/deliveries', title: '通知生成结果', nodeId: '159:113146' },
  'ADM-AUD-01': { route: '/admin/app/audit', title: '审计查询', nodeId: '159:113963' },
  'ADM-AUD-02': { route: '/admin/app/audit/{eventId}', title: '审计详情', nodeId: '159:114575' },
  'ADM-AUD-03': { route: '/admin/app/audit/integrity', title: '审计完整性状态', nodeId: '159:115142' },
  'ADM-AUD-04': { route: '/admin/app/audit/exports', title: '受控导出', nodeId: '159:115754' },
  'ADM-AUD-05': { route: '/admin/app/audit/registry', title: 'Action 口径治理', nodeId: '967:18080' },
  'ADM-AUD-06': { route: '/admin/app/audit/registry/requests/{requestId}', title: 'Action 口径申请复核', nodeId: '969:18507' },
  'ADM-PRI-01': { route: '/admin/app/data-rights', title: '数据权利队列', nodeId: '939:15995' },
  'ADM-PRI-02': { route: '/admin/app/data-rights/{requestId}', title: '数据权利申请处置', nodeId: '944:16747' },
} as const

export type AdminFigmaPageId = keyof typeof ADMIN_FIGMA_PAGES

export function getAdminFigmaPage(pageId: AdminFigmaPageId) {
  return ADMIN_FIGMA_PAGES[pageId]
}
