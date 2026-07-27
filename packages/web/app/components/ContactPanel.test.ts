import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Suspense, computed, h, ref } from 'vue'
import ContactPanel from './ContactPanel.vue'

const nuxtLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

const contactMethodItemStub = {
  props: ['method'],
  emits: ['activate', 'inspect'],
  template: `
    <div>
      <button class="contact-method" type="button" @click="$emit('activate', method.id, method.platform, 'open_link')">{{ method.label }}</button>
      <button class="contact-copy" type="button" @click="$emit('activate', method.id, method.platform, 'copy')">复制</button>
      <button class="contact-qr" type="button" @click="$emit('inspect', method.id, method.platform, 'qr_expand')">二维码</button>
    </div>
  `,
}

async function mountPanel() {
  const contactMethods = ref([{
    id: 'contact-1',
    platform: 'telegram',
    label: 'Telegram',
    value: '@meigallery',
    linkUrl: 'https://t.me/meigallery',
    qrCodeUrl: '/api/contact-methods/contact-1/qrcode',
    sortOrder: 0,
  }])
  const trackContact = vi.fn()
  const trackAnalytics = vi.fn()

  vi.stubGlobal('useContactMethods', () => ({
    contactMethods,
    fetchContactMethods: vi.fn().mockResolvedValue(undefined),
    hasContactMethods: computed(() => contactMethods.value.length > 0),
  }))
  vi.stubGlobal('useSiteSettings', () => ({
    rulesEntryEnabled: ref(true),
    rulesEntryTitle: ref('入站规则'),
    rulesEntrySummary: ref('查看内容规则、会员说明和联系前须知。'),
    rulesModalContent: ref('## 服务流程\n\n- 看规则\n- 联系站长\n- 开通访问'),
    rulesPageUrl: ref('/rules'),
  }))
  vi.stubGlobal('useTracking', () => ({ trackContact, trackAnalytics }))

  const wrapper = mount({
    render: () => h(Suspense, null, { default: () => h(ContactPanel) }),
  }, {
    global: { stubs: { ContactMethodItem: contactMethodItemStub, NuxtLink: nuxtLinkStub } },
  })

  await flushPromises()
  return { wrapper, trackContact, trackAnalytics }
}

describe('ContactPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('保留服务流程与联系入口的可见信息', async () => {
    const { wrapper } = await mountPanel()

    expect(wrapper.text()).toContain('服务流程')
    expect(wrapper.text()).toContain('看规则')
    expect(wrapper.text()).toContain('联系站长')
    expect(wrapper.text()).toContain('开通访问')
    expect(wrapper.text()).toContain('有新消息')
    expect(wrapper.text()).toContain('Telegram · 1 种方式 · 站长在线回复')
  })

  it('移动端收起态使用紧凑入口，展开时才恢复面板宽度', async () => {
    const { wrapper } = await mountPanel()
    const panel = wrapper.get('div.fixed')
    const contactButton = wrapper.get('button[aria-label="打开联系方式"]')
    const rulesButton = wrapper.get('button[aria-label="打开服务流程"]')

    expect(panel.classes()).toContain('w-auto')
    expect(contactButton.classes()).toContain('h-12')
    expect(contactButton.classes()).toContain('w-12')
    expect(rulesButton.classes()).toContain('hidden')
    expect(rulesButton.classes()).toContain('lg:flex')

    await contactButton.trigger('click')

    expect(panel.classes()).toContain('w-[min(calc(100vw-1.5rem),24rem)]')
    expect(wrapper.get('button[aria-label="查看服务流程"]').isVisible()).toBe(true)
  })

  it('移动端可从联系面板切换到服务流程', async () => {
    const { wrapper } = await mountPanel()

    await wrapper.get('button[aria-label="打开联系方式"]').trigger('click')
    await wrapper.get('button[aria-label="查看服务流程"]').trigger('click')

    expect(wrapper.find('button[aria-label="关闭联系方式"]').exists()).toBe(false)
    expect(wrapper.get('button[aria-label="关闭规则说明"]').isVisible()).toBe(true)
  })

  it('打开联系面板只记录面板分析，不创建 Contact', async () => {
    const { wrapper, trackContact, trackAnalytics } = await mountPanel()

    await wrapper.get('button[aria-label="打开联系方式"]').trigger('click')

    expect(trackContact).not.toHaveBeenCalled()
    expect(trackAnalytics).toHaveBeenCalledWith('contact_panel_open', expect.objectContaining({
      props: { location: 'floating_contact_panel' },
    }))
  })

  it('收到已确认的原生链接 activation 后才创建 Contact', async () => {
    const { wrapper, trackContact } = await mountPanel()

    await wrapper.get('button[aria-label="打开联系方式"]').trigger('click')
    await wrapper.get('.contact-method').trigger('click')

    expect(trackContact).toHaveBeenCalledWith({
      contactMethodId: 'contact-1',
      methodType: 'telegram',
      actionType: 'open_link',
    })
    expect(JSON.stringify(trackContact.mock.calls)).not.toContain('@meigallery')
  })

  it('复制只记录 contact_value_copy 且不创建 Contact', async () => {
    const { wrapper, trackContact, trackAnalytics } = await mountPanel()

    await wrapper.get('button[aria-label="打开联系方式"]').trigger('click')
    await wrapper.get('.contact-copy').trigger('click')

    expect(trackContact).not.toHaveBeenCalled()
    expect(trackAnalytics).toHaveBeenCalledWith('contact_value_copy', {
      entityType: 'contact',
      props: {
        contact_method_id: 'contact-1',
        method_type: 'telegram',
        action_type: 'copy',
        location: 'floating_contact_panel',
      },
    })
  })

  it('二维码展开只记录分析且不创建 Contact', async () => {
    const { wrapper, trackContact, trackAnalytics } = await mountPanel()

    await wrapper.get('button[aria-label="打开联系方式"]').trigger('click')
    await wrapper.get('.contact-qr').trigger('click')

    expect(trackAnalytics).toHaveBeenCalledWith('contact_qr_expand', {
      entityType: 'contact',
      props: {
        contact_method_id: 'contact-1',
        method_type: 'telegram',
        action_type: 'qr_expand',
        location: 'floating_contact_panel',
      },
    })
    expect(trackContact).not.toHaveBeenCalled()
  })

  it('Contact 上报 reject 时调用方不会抛出未处理异常', async () => {
    const { wrapper, trackContact } = await mountPanel()
    trackContact.mockRejectedValueOnce(new Error('conversion api failed'))

    await wrapper.get('button[aria-label="打开联系方式"]').trigger('click')
    await expect(wrapper.get('.contact-method').trigger('click')).resolves.toBeUndefined()
    await flushPromises()

    expect(trackContact).toHaveBeenCalledOnce()
  })
})
