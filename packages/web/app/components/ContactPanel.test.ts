import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Suspense, computed, h, ref } from 'vue'
import ContactPanel from './ContactPanel.vue'

const nuxtLinkStub = {
  props: ['to'],
  template: '<a :href="to"><slot /></a>',
}

const contactMethodItemStub = {
  props: ['method'],
  emits: ['activate'],
  template: '<button class="contact-method" type="button" @click="$emit(\'activate\', method.platform, \'open_link\')">{{ method.label }}</button>',
}

async function mountPanel() {
  const contactMethods = ref([
    {
      id: 'contact-1',
      platform: 'telegram',
      label: 'Telegram',
      value: '@meigallery',
      linkUrl: 'https://t.me/meigallery',
      qrCodeUrl: null,
      sortOrder: 0,
    },
  ])
  const trackContactClick = vi.fn()
  const track = vi.fn()

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
  vi.stubGlobal('useFacebookPixel', () => ({ trackContactClick }))
  vi.stubGlobal('useAnalytics', () => ({ track }))

  const wrapper = mount({
    render: () => h(Suspense, null, { default: () => h(ContactPanel) }),
  }, {
    global: {
      stubs: {
        ContactMethodItem: contactMethodItemStub,
        NuxtLink: nuxtLinkStub,
      },
    },
  })

  await flushPromises()
  return { wrapper, trackContactClick, track }
}

describe('ContactPanel', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('突出展示服务流程和有新消息入口', async () => {
    const { wrapper } = await mountPanel()

    expect(wrapper.text()).toContain('服务流程')
    expect(wrapper.text()).toContain('看规则')
    expect(wrapper.text()).toContain('联系站长')
    expect(wrapper.text()).toContain('开通访问')
    expect(wrapper.text()).toContain('有新消息')
    expect(wrapper.text()).toContain('Telegram · 1 种方式 · 站长在线回复')
  })

  it('点击入口后展示对应弹层并记录站内联系入口', async () => {
    const { wrapper, trackContactClick, track } = await mountPanel()

    await wrapper.get('button[aria-label="打开服务流程"]').trigger('click')
    expect(wrapper.text()).toContain('查看完整规则')
    expect(track).toHaveBeenCalledWith('rules_panel_open', expect.objectContaining({
      props: { location: 'floating_rules_panel' },
    }))

    await wrapper.get('button[aria-label="打开联系方式"]').trigger('click')
    expect(wrapper.text()).toContain('站长在线回复')
    expect(wrapper.text()).toContain('Telegram')
    expect(trackContactClick).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith('contact_panel_open', expect.objectContaining({
      props: { location: 'floating_contact_panel' },
    }))
  })

  it('点击联系方式才记录 Meta 有效联系点击，且不记录联系值', async () => {
    const { wrapper, trackContactClick, track } = await mountPanel()

    await wrapper.get('button[aria-label="打开联系方式"]').trigger('click')
    await wrapper.get('.contact-method').trigger('click')

    expect(trackContactClick).toHaveBeenCalledWith({
      location: 'floating_contact_panel',
      methodType: 'telegram',
      actionType: 'open_link',
    })
    expect(track).toHaveBeenCalledWith('contact_method_click', expect.objectContaining({
      entityType: 'contact',
      props: {
        method_type: 'telegram',
        action_type: 'open_link',
        location: 'floating_contact_panel',
      },
    }))
    expect(JSON.stringify(trackContactClick.mock.calls)).not.toContain('@meigallery')
    expect(JSON.stringify(track.mock.calls)).not.toContain('@meigallery')
  })
})
