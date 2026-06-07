import { describe, expect, it } from 'vitest'
import {
  isAnalyticsEntityType,
  isAnalyticsEventName,
  isAnalyticsSourceChannel,
  sanitizeAnalyticsProps,
  truncateAnalyticsString,
} from './analytics-events'

describe('analytics-events', () => {
  it('识别白名单事件、实体和来源渠道', () => {
    expect(isAnalyticsEventName('page_view')).toBe(true)
    expect(isAnalyticsEventName('unknown_event')).toBe(false)
    expect(isAnalyticsEntityType('gallery')).toBe(true)
    expect(isAnalyticsEntityType('private_bucket')).toBe(false)
    expect(isAnalyticsSourceChannel('invite')).toBe(true)
    expect(isAnalyticsSourceChannel('paid_secret')).toBe(false)
  })

  it('按事件白名单清洗 props', () => {
    const props = sanitizeAnalyticsProps('gallery_detail_view', {
      gallery_id: 'gal_1',
      required_rank: 10,
      tag_slugs: ['outdoor', 'fresh'],
      password: 'secret',
      failure_code: 'NOT_ALLOWED_FOR_THIS_EVENT',
    })
    expect(props).toEqual({
      gallery_id: 'gal_1',
      required_rank: 10,
      tag_slugs: ['outdoor', 'fresh'],
    })
  })

  it('丢弃非标量和无效数字 props', () => {
    const props = sanitizeAnalyticsProps('search_submit', {
      has_query: true,
      query_length: Number.NaN,
      tag_count: 2,
      nested: { value: 1 },
      sort: 'newest',
    })
    expect(props).toEqual({
      has_query: true,
      tag_count: 2,
      sort: 'newest',
    })
  })

  it('截断字符串和数组项', () => {
    const long = 'x'.repeat(200)
    const props = sanitizeAnalyticsProps('gallery_detail_view', {
      gallery_id: long,
      tag_slugs: ['a'.repeat(100), 123, 'ok'],
    })
    expect(String(props.gallery_id)).toHaveLength(160)
    expect(props.tag_slugs).toEqual(['a'.repeat(80), 'ok'])
    expect(truncateAnalyticsString('  abc  ', 10)).toBe('abc')
  })
})
