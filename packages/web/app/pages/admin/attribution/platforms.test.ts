import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AttributionCredentialEditor from '~/components/admin/attribution/AttributionCredentialEditor.vue'
import AttributionEventBindingEditor from '~/components/admin/attribution/AttributionEventBindingEditor.vue'
import AttributionPlatformConnectionEditor from '~/components/admin/attribution/AttributionPlatformConnectionEditor.vue'
import {
  attributionConnectionPayload,
  attributionPlatformDefinition,
  emptyAttributionPlatformConnectionDraft,
} from '~/utils/attributionPlatforms'

describe('三平台连接 Schema', () => {
  it('Google Ads 渲染全部公开配置、事件目标和 Service Account 文件输入', () => {
    const platform = attributionPlatformDefinition('google')
    const draft = emptyAttributionPlatformConnectionDraft(platform)
    const connection = mount(AttributionPlatformConnectionEditor, {
      props: { platform, modelValue: draft, connection: null, isOwner: true },
    })
    const bindings = mount(AttributionEventBindingEditor, {
      props: { platform, modelValue: draft.eventBindings },
    })
    const credential = mount(AttributionCredentialEditor, {
      props: { platform, modelValue: '', configured: false },
    })

    for (const label of ['Tag ID', 'Customer ID', 'Manager Account ID（可选）', 'Cloud Project']) {
      expect(connection.text()).toContain(label)
    }
    for (const label of ['有效联系 Label', '完成注册 Label', '有效联系 Conversion Action ID', '完成注册 Conversion Action ID']) {
      expect(bindings.text()).toContain(label)
    }
    expect(credential.get('input[type="file"]').attributes('accept')).toContain('.json')
    expect(connection.text()).not.toContain('Access Token')
    expect(connection.get('[data-connection-controls]').findAll('input[type="checkbox"]')).toHaveLength(2)
  })

  it('凭证明文不进入可见文本，空的可选 Manager ID 不进入请求', () => {
    const platform = attributionPlatformDefinition('google')
    const draft = emptyAttributionPlatformConnectionDraft(platform)
    draft.publicConfig = {
      tagId: 'AW-123456789',
      customerId: '1234567890',
      loginCustomerId: '',
      cloudProjectId: 'meigallery-ads',
    }
    draft.eventBindings = draft.eventBindings.map((binding, index) => ({
      ...binding,
      browserDestination: `AW-123456789/Label${index}`,
      serverDestination: `123456789${index}`,
    }))
    const secret = '{"private_key":"TOP_SECRET"}'
    const credential = mount(AttributionCredentialEditor, {
      props: { platform, modelValue: secret, configured: false },
    })
    const payload = attributionConnectionPayload(platform, draft, secret)

    expect(credential.text()).not.toContain('TOP_SECRET')
    expect(payload.publicConfig).not.toHaveProperty('loginCustomerId')
    expect(payload.credential).toEqual({ type: 'service_account_json', plaintext: secret })
  })

  it('Meta 与 TikTok 使用固定事件目标且凭证类型一致', () => {
    const meta = attributionPlatformDefinition('meta')
    const tiktok = attributionPlatformDefinition('tiktok')
    expect(meta.eventBindings.map(item => [item.browser.defaultValue, item.server.defaultValue])).toEqual([
      ['meta_pixel', 'meta_capi'],
      ['meta_pixel', 'meta_capi'],
    ])
    expect(tiktok.eventBindings.map(item => [item.browser.defaultValue, item.server.defaultValue])).toEqual([
      ['tiktok_pixel', 'tiktok_events_api'],
      ['tiktok_pixel', 'tiktok_events_api'],
    ])
    expect(meta.credential.type).toBe('access_token')
    expect(tiktok.credential.type).toBe('access_token')
  })

  it('重新选择有效凭证文件时清除上一次文件错误', async () => {
    const platform = attributionPlatformDefinition('google')
    const credential = mount(AttributionCredentialEditor, {
      props: { platform, modelValue: '', configured: false },
    })
    const input = credential.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['not-json'], 'invalid.json', { type: 'application/json' })],
    })
    await input.trigger('change')
    await flushPromises()
    expect(credential.emitted('error')?.at(-1)).toEqual(['Service Account 文件不是有效 JSON'])

    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new File(['{"client_email":"ads@example.com"}'], 'valid.json', { type: 'application/json' })],
    })
    await input.trigger('change')
    await flushPromises()
    expect(credential.emitted('error')?.at(-1)).toEqual([''])
    expect(credential.emitted('update:modelValue')?.at(-1)).toEqual(['{"client_email":"ads@example.com"}'])
  })
})
