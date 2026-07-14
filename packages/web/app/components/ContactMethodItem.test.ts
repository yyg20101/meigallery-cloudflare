import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ContactMethodItem from './ContactMethodItem.vue'

const platformIconStub = { template: '<span />' }

function mountItem(
  linkUrl: string | null,
  qrCodeUrl: string | null = null,
  platform = 'telegram',
) {
  return mount(ContactMethodItem, {
    props: {
      method: {
        id: 'contact-1',
        platform,
        label: 'Telegram',
        value: '@example',
        linkUrl,
        qrCodeUrl,
        sortOrder: 0,
      },
    },
    global: { stubs: { PlatformIcon: platformIconStub } },
  })
}

describe('ContactMethodItem', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('激活通过安全校验的原生聊天链接后发出 open_link', async () => {
    const wrapper = mountItem('https://t.me/example')
    const link = wrapper.get('a[data-contact-action]')

    expect(link.attributes('href')).toBe('https://t.me/example')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
    expect(link.attributes('referrerpolicy')).toBe('no-referrer')
    link.element.addEventListener('click', event => event.preventDefault(), { capture: true })
    await link.trigger('click')

    expect(wrapper.emitted('activate')).toEqual([['telegram', 'open_link']])
  })

  it('原样使用 telegram.me 链接且不访问外网', async () => {
    const wrapper = mountItem('https://telegram.me/example')
    const link = wrapper.get('a[data-contact-action]')
    link.element.addEventListener('click', event => event.preventDefault(), { capture: true })

    expect(link.attributes('href')).toBe('https://telegram.me/example')
    await link.trigger('click')
    expect(wrapper.emitted('activate')).toEqual([['telegram', 'open_link']])
  })

  it('URL 未通过安全校验时不渲染聊天链接且不发出 open_link', () => {
    const wrapper = mountItem('javascript:alert(1)')

    expect(wrapper.find('a[data-contact-action]').exists()).toBe(false)
    expect(wrapper.emitted('activate')).toBeUndefined()
  })

  it('Clipboard API resolve 后只发出一次 copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const wrapper = mountItem(null, null, 'custom')

    await wrapper.get('button[data-contact-action]').trigger('click')

    expect(writeText).toHaveBeenCalledWith('@example')
    expect(wrapper.emitted('activate')).toEqual([['custom', 'copy']])
  })

  it('Clipboard API reject 时不发出 activate', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const wrapper = mountItem(null, null, 'custom')

    await wrapper.get('button[data-contact-action]').trigger('click')

    expect(wrapper.emitted('activate')).toBeUndefined()
  })

  it('fallback copy 返回 false 时不把复制视为成功', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const execCommand = vi.fn().mockReturnValue(false)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    const wrapper = mountItem(null, null, 'custom')

    await wrapper.get('button[data-contact-action]').trigger('click')

    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(wrapper.emitted('activate')).toBeUndefined()
  })

  it('二维码按钮与主动作是兄弟节点且只发出 qr_expand 分析事件', async () => {
    const wrapper = mountItem('https://t.me/example', '/api/contact-methods/contact-1/qrcode')
    const action = wrapper.get('[data-contact-action]')
    const qrButton = wrapper.get('button[data-qr-action]')

    expect(action.element.parentElement).toBe(qrButton.element.parentElement)
    expect(wrapper.find('a button').exists()).toBe(false)
    await qrButton.trigger('click')

    expect(wrapper.emitted('inspect')).toEqual([['telegram', 'qr_expand']])
    expect(wrapper.emitted('activate')).toBeUndefined()
    expect(wrapper.get('img').attributes('referrerpolicy')).toBe('no-referrer')
  })

  it('不渲染未通过安全校验的二维码图片', () => {
    const wrapper = mountItem('https://t.me/example', 'https://127.0.0.1/qrcode.png')

    expect(wrapper.find('button[data-qr-action]').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
  })
})
