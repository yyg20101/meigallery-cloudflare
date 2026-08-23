import { describe, expect, it } from 'vitest'
import { getAppDataRightsExportCategoryContract } from './app-data-rights-exports'

const PRIVACY_2A_CATEGORY_CODES = [
  'account',
  'identity_methods',
  'consents',
  'devices',
  'realtime_connection_tickets',
  'account_preferences',
  'notification_preferences',
  'view_history_preferences',
  'search_history_preferences',
  'conversation_settings',
  'interactions',
  'favorite_folders',
  'favorite_items',
  'view_history',
  'search_history',
  'saved_filters',
  'membership_grants',
  'membership_revocations',
  'membership_applications',
  'wallet',
  'wallet_entries',
  'conversations',
  'conversation_messages',
  'notifications',
  'safety_reports',
  'safety_report_events',
  'report_appeals',
  'report_appeal_events',
  'report_appeal_review_events',
  'report_appeal_supplements',
  'service_appeals',
  'service_appeal_events',
  'service_appeal_supplements',
  'data_rights_requests',
  'data_rights_events',
] as const

const PRIVACY_2C_CATEGORY_CODES = [
  'recommendation_preferences',
  'profile_blocks',
  'profile_block_events',
  'legacy_gallery_likes',
  'recommendation_sessions',
  'recommendation_session_items',
] as const

describe('App 个人数据副本分类契约', () => {
  it('保持 Privacy-2A 已持久化的前 35 个序号并只在末尾追加', () => {
    const contract = getAppDataRightsExportCategoryContract()

    expect(contract.slice(0, PRIVACY_2A_CATEGORY_CODES.length).map(item => item.code))
      .toEqual(PRIVACY_2A_CATEGORY_CODES)
    expect(contract.slice(PRIVACY_2A_CATEGORY_CODES.length).map(item => item.code))
      .toEqual(PRIVACY_2C_CATEGORY_CODES)
    expect(contract).toHaveLength(41)
    expect(new Set(contract.map(item => item.code)).size).toBe(contract.length)
  })

  it('只用账号 HMAC 定位推荐解释证据', () => {
    const hmacCategories = getAppDataRightsExportCategoryContract()
      .filter(item => item.accountSelector === 'recommendation_hash')
      .map(item => item.code)

    expect(hmacCategories).toEqual([
      'recommendation_sessions',
      'recommendation_session_items',
    ])
  })
})
