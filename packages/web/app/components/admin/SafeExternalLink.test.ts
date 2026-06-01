import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SafeExternalLink from './SafeExternalLink.vue'

function mountLink(href: string | null) {
  return mount(SafeExternalLink, {
    props: { href },
  })
}

describe('SafeExternalLink', () => {
  it('安全 HTTPS 外链使用新窗口打开并归一化地址', () => {
    const wrapper = mountLink(' HTTPS://example.com/source?next="x" ')
    const link = wrapper.get('a')

    expect(link.attributes('href')).toBe('https://example.com/source?next=%22x%22')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer nofollow')
    expect(link.attributes('referrerpolicy')).toBe('no-referrer')
    expect(link.text()).toBe('HTTPS://example.com/source?next="x"')
  })

  it('拒绝 http、本机、非公网 IP 和歧义外链', () => {
    for (const href of [
      'http://example.com/source',
      'https://localhost/source',
      'https://127.0.0.1/source',
      'https://192.168.1.10/source',
      'https://198.51.100.10/source',
      'https://legacy.local/source',
      'https://user:pass@example.com/source',
      'https://example.com\\@evil.test/source',
      'https://example.com/%5Csource',
    ]) {
      const wrapper = mountLink(href)

      expect(wrapper.find('a').exists()).toBe(false)
      expect(wrapper.text()).toBe('链接已隐藏')
      expect(wrapper.get('span').attributes('title')).toBe(href)
    }
  })

  it('拒绝包含普通或编码空白控制字符的外链', () => {
    for (const href of [
      'https://example.com/source next',
      'https://example.com/source%20next',
      'https://example.com/%0Ajavascript:alert(1)',
    ]) {
      const wrapper = mountLink(href)

      expect(wrapper.find('a').exists()).toBe(false)
      expect(wrapper.text()).toBe('链接已隐藏')
    }
  })

  it('空链接显示占位文本', () => {
    const wrapper = mountLink(null)

    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).toBe('-')
  })
})
