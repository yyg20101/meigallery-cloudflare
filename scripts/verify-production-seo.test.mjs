import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareSeo,
  expectedSeo,
  extractSeo,
  parseArgs,
  resolveWebUrls,
  validateExpectedSeo,
} from './verify-production-seo.mjs'

describe('生产 SEO 校验脚本', () => {
  it('解析显式期望值和允许默认 SEO 参数', () => {
    const args = parseArgs([
      '--',
      '--api',
      'https://api.example.com/',
      '--web',
      'https://example.com/',
      '--expect-site-name',
      '星耀传媒',
      '--expect-title',
      '星耀传媒',
      '--expect-description',
      '用专业服务点亮每一次相遇.',
      '--allow-default-seo',
    ])

    assert.equal(args.api, 'https://api.example.com/')
    assert.deepEqual(args.web, ['https://example.com/'])
    assert.equal(args.expectSiteName, '星耀传媒')
    assert.equal(args.expectTitle, '星耀传媒')
    assert.equal(args.expectDescription, '用专业服务点亮每一次相遇.')
    assert.equal(args.allowDefaultSeo, true)
  })

  it('从环境变量解析 Web 地址并去除尾部斜杠', () => {
    assert.deepEqual(resolveWebUrls([], {
      SEO_VERIFY_WEB_URLS: ' https://616618.xyz/ , https://www.616618.xyz/// ',
    }), ['https://616618.xyz', 'https://www.616618.xyz'])
  })

  it('API 仍返回脚手架默认 SEO 时会失败', () => {
    const settings = {
      site_name: 'MeiGallery',
      seo_title: 'MeiGallery - 精选写真图库',
      site_description: '',
    }
    const failures = validateExpectedSeo(settings, expectedSeo(settings), {}, { allowDefaultSeo: false })

    assert.equal(failures.length, 2)
    assert.match(failures[0], /site_name 仍为脚手架默认值/)
    assert.match(failures[1], /SEO 标题仍为脚手架默认值/)
  })

  it('显式允许默认 SEO 时不拦截脚手架默认值', () => {
    const settings = {
      site_name: 'MeiGallery',
      seo_title: 'MeiGallery - 精选写真图库',
      site_description: '',
    }
    const failures = validateExpectedSeo(settings, expectedSeo(settings), {}, { allowDefaultSeo: true })

    assert.deepEqual(failures, [])
  })

  it('期望值不一致时指出 API 侧字段', () => {
    const settings = {
      site_name: '星耀传媒',
      seo_title: '星耀传媒',
      site_description: '用专业服务点亮每一次相遇.',
    }
    const failures = validateExpectedSeo(settings, expectedSeo(settings), {
      siteName: '星耀传媒',
      title: '星耀传媒',
      description: '另一段描述',
    }, { allowDefaultSeo: false })

    assert.equal(failures.length, 2)
    assert.match(failures[0], /解析后的首页 description 不一致/)
    assert.match(failures[1], /site_description 不一致/)
  })

  it('提取 SSR HTML 中的 SEO 并识别旧默认标题残留', () => {
    const actual = extractSeo(`
      <html>
        <head>
          <title>星耀传媒</title>
          <meta name="description" content="用专业服务点亮每一次相遇.">
          <meta property="og:title" content="星耀传媒">
          <meta property="og:description" content="MeiGallery - 精选写真图库">
        </head>
      </html>
    `)

    assert.equal(actual.title, '星耀传媒')
    assert.equal(actual.description, '用专业服务点亮每一次相遇.')
    assert.equal(actual.ogTitle, '星耀传媒')
    assert.equal(actual.ogDescription, 'MeiGallery - 精选写真图库')
    assert.equal(actual.hasOldDefaultTitle, true)
  })

  it('Web head 与 API 期望不一致或残留旧标题时会失败', () => {
    const failures = compareSeo('https://616618.xyz', {
      title: '星耀传媒',
      description: '用专业服务点亮每一次相遇.',
      ogTitle: '星耀传媒',
      ogDescription: '用专业服务点亮每一次相遇.',
    }, {
      title: '星耀传媒',
      description: '旧描述',
      ogTitle: '星耀传媒',
      ogDescription: '用专业服务点亮每一次相遇.',
      hasOldDefaultTitle: true,
    })

    assert.equal(failures.length, 2)
    assert.match(failures[0], /description 不一致/)
    assert.match(failures[1], /仍包含旧默认标题/)
  })
})
