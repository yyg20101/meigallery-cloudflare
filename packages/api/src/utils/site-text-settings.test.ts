import { describe, expect, it } from 'vitest'
import { isSiteTextSettingKey, normalizeSiteTextSetting, safeSiteTextSetting } from './site-text-settings'

describe('站点文本设置校验', () => {
  it('识别会进入 SEO 和前台 UI 的短文本设置', () => {
    expect(isSiteTextSettingKey('site_name')).toBe(true)
    expect(isSiteTextSettingKey('seo_title')).toBe(true)
    expect(isSiteTextSettingKey('seo_keywords')).toBe(true)
    expect(isSiteTextSettingKey('home_ad_title')).toBe(false)
    expect(isSiteTextSettingKey('rules_page_content')).toBe(false)
  })

  it('归一化空白并保留合法文本', () => {
    expect(normalizeSiteTextSetting('site_name', '  测试   图库站  ')).toBe('测试 图库站')
    expect(normalizeSiteTextSetting('seo_title', '测试站点 - 精选图库')).toBe('测试站点 - 精选图库')
    expect(normalizeSiteTextSetting('rules_entry_icon', 'letter_01')).toBe('letter_01')
    expect(normalizeSiteTextSetting('unknown_key', '  原样  ')).toBe('  原样  ')
  })

  it('归一化 SEO 关键词池，支持中英文分隔、去重和去除话题符号', () => {
    expect(normalizeSiteTextSetting('seo_keywords', ' 授权图库, 写真\n#时尚写真，授权图库、生活方式 ')).toBe('授权图库,写真,时尚写真,生活方式')
  })

  it('拒绝控制字符、超长文本和非法图标值', () => {
    expect(() => normalizeSiteTextSetting('site_name', '测试\u0001图库')).toThrow('站点名称不能包含控制字符')
    expect(() => normalizeSiteTextSetting('seo_title', 'x'.repeat(81))).toThrow('SEO 标题不能超过 80 个字符')
    expect(() => normalizeSiteTextSetting('seo_keywords', Array.from({ length: 31 }, (_, index) => `关键词${index}`).join(','))).toThrow('SEO 关键词不能超过 30 个')
    expect(() => normalizeSiteTextSetting('seo_keywords', `授权图库,${'x'.repeat(25)}`)).toThrow('单个 SEO 关键词不能超过 24 个字符')
    expect(() => normalizeSiteTextSetting('home_hero_subtitle', 'x'.repeat(181))).toThrow('首页副标题不能超过 180 个字符')
    expect(() => normalizeSiteTextSetting('rules_entry_icon', '<svg>')).toThrow('规则入口图标仅允许字母、数字、短横线和下划线')
  })

  it('安全读取历史异常文本时清空', () => {
    expect(safeSiteTextSetting('site_name', '测试图库')).toBe('测试图库')
    expect(safeSiteTextSetting('site_name', '测试\u0001图库')).toBe('')
    expect(safeSiteTextSetting('seo_title', 'x'.repeat(81))).toBe('')
    expect(safeSiteTextSetting('seo_keywords', '授权图库，写真,授权图库')).toBe('授权图库,写真')
    expect(safeSiteTextSetting('rules_entry_icon', '<svg>')).toBe('')
  })
})
