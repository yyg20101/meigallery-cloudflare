import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ContactQrCodeCell from './ContactQrCodeCell.vue'

function mountCell(qrCodeUrl: string | null) {
  return mount(ContactQrCodeCell, {
    props: {
      contactId: 'contact-1',
      qrCodeUrl,
    },
  })
}

describe('ContactQrCodeCell', () => {
  it('显示安全的站内二维码预览，并发出上传和删除事件', async () => {
    const wrapper = mountCell('/api/contact-methods/contact-1/qrcode')

    expect(wrapper.get('img').attributes('src')).toBe('/api/contact-methods/contact-1/qrcode')
    expect(wrapper.get('img').attributes('referrerpolicy')).toBe('no-referrer')

    const buttons = wrapper.findAll('button')
    await buttons[0]!.trigger('click')
    await buttons[1]!.trigger('click')

    expect(wrapper.emitted('upload')).toEqual([['contact-1']])
    expect(wrapper.emitted('remove')).toEqual([['contact-1']])
  })

  it('隐藏不安全二维码预览，但保留更换和删除入口', () => {
    const wrapper = mountCell('https://127.0.0.1/qrcode.png')

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('预览已隐藏')
    expect(wrapper.text()).toContain('更换')
    expect(wrapper.text()).toContain('删除')
  })

  it('没有二维码时只显示上传入口', () => {
    const wrapper = mountCell(null)

    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('上传')
    expect(wrapper.text()).not.toContain('删除')
    expect(wrapper.text()).not.toContain('预览已隐藏')
  })
})
