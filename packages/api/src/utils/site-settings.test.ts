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
})
