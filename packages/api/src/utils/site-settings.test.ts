import { describe, expect, it } from 'vitest'
import { ADMIN_SETTING_KEYS, PUBLIC_SETTING_KEYS } from './site-settings'

describe('site settings keys', () => {
  it('allows about page settings in admin and public settings', () => {
    const aboutKeys = ['about_title', 'about_summary', 'about_content']

    for (const key of aboutKeys) {
      expect(ADMIN_SETTING_KEYS).toContain(key)
      expect(PUBLIC_SETTING_KEYS).toContain(key)
    }
  })

  it('allows homepage editorial settings in admin and public settings', () => {
    const homepageKeys = [
      'home_hero_title',
      'home_hero_subtitle',
      'home_hero_cta_label',
      'home_hero_cta_url',
      'home_featured_region_slugs',
      'home_hot_tag_limit',
    ]

    for (const key of homepageKeys) {
      expect(ADMIN_SETTING_KEYS).toContain(key)
      expect(PUBLIC_SETTING_KEYS).toContain(key)
    }
  })
})
