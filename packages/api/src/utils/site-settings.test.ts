import { describe, expect, it } from 'vitest'
import { ADMIN_SETTING_KEYS, PUBLIC_SETTING_KEYS } from './site-settings'

describe('site settings keys', () => {
  it('does not expose removed about page settings', () => {
    const aboutKeys = ['about_title', 'about_summary', 'about_content']

    for (const key of aboutKeys) {
      expect(ADMIN_SETTING_KEYS).not.toContain(key)
      expect(PUBLIC_SETTING_KEYS).not.toContain(key)
    }
  })

  it('allows homepage editorial settings in admin and public settings', () => {
    const homepageKeys = [
      'home_hero_title',
      'home_hero_subtitle',
      'home_featured_region_slugs',
      'home_hot_tag_limit',
    ]

    for (const key of homepageKeys) {
      expect(ADMIN_SETTING_KEYS).toContain(key)
      expect(PUBLIC_SETTING_KEYS).toContain(key)
    }
  })

  it('allows rules entry settings in admin and public settings', () => {
    const rulesKeys = [
      'rules_entry_enabled',
      'rules_entry_title',
      'rules_entry_summary',
      'rules_entry_icon',
      'rules_modal_content',
      'rules_page_title',
      'rules_page_summary',
      'rules_page_content',
      'rules_page_url',
    ]

    for (const key of rulesKeys) {
      expect(ADMIN_SETTING_KEYS).toContain(key)
      expect(PUBLIC_SETTING_KEYS).toContain(key)
    }
  })

  it('allows homepage ad settings in admin and public settings', () => {
    const homeAdKeys = [
      'home_ad_enabled',
      'home_ad_eyebrow',
      'home_ad_title',
      'home_ad_summary',
      'home_ad_cta_label',
      'home_ad_url',
      'home_ad_sponsor',
      'home_ad_starts_at',
      'home_ad_ends_at',
    ]

    for (const key of homeAdKeys) {
      expect(ADMIN_SETTING_KEYS).toContain(key)
      expect(PUBLIC_SETTING_KEYS).toContain(key)
    }
  })

  it('allows Facebook Pixel settings in admin and public settings', () => {
    const pixelKeys = [
      'facebook_pixel_enabled',
      'facebook_pixel_id',
      'facebook_pixel_debug_enabled',
    ]

    for (const key of pixelKeys) {
      expect(ADMIN_SETTING_KEYS).toContain(key)
      expect(PUBLIC_SETTING_KEYS).toContain(key)
    }
  })
})
