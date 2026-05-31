import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ContactMethodItem from './ContactMethodItem.vue'

const platformIconStub = {
  template: '<span />',
}

function mountItem(linkUrl: string | null) {
  return mount(ContactMethodItem, {
    props: {
      method: {
        id: 'contact-1',
        platform: 'custom',
        label: '站长',
        value: 'meigallery',
        linkUrl,
        qrCodeUrl: null,
        sortOrder: 0,
      },
    },
    global: { stubs: { PlatformIcon: platformIconStub } },
  })
}

describe('ContactMethodItem', () => {
  it('点击安全链接时打开新窗口', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const wrapper = mountItem('https://example.com/contact')

    await wrapper.get('[role="button"]').trigger('click')

    expect(open).toHaveBeenCalledWith('https://example.com/contact', '_blank', 'noopener,noreferrer')
    open.mockRestore()
  })

  it('危险链接不会被当作外链打开', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const wrapper = mountItem('javascript:alert(1)')

    await wrapper.get('[role="button"]').trigger('click')

    expect(open).not.toHaveBeenCalled()
    expect(writeText).toHaveBeenCalledWith('meigallery')
    open.mockRestore()
  })
})
